/**
 * One load, start to finish (td-eec7db Phase 2): pick the window from GBIF's
 * latest good copy, read the 2024 counties, count and place, then send the
 * chunks and the manifest. A heartbeat runs throughout; a lost lease stops
 * the load without calling fail (the app has already moved on).
 */
import { monthEndBefore, windowStartFor } from '$server/external-sources/contract';
import { BIRDS_TAXON_KEY, DATASET_KEY, GBIF_CONCURRENCY, GROUP_CACHE_MAX, GROUP_CACHE_MS, HEARTBEAT_EVERY_MS, MIN_STATE_RECORDS } from './config';
import { GbifClient, GbifError, type DatasetCopy, type SpeciesInfo } from './gbif';
import { GroupAggregate, buildRegionPayload, normalizeState, sharedRecords, type Window } from './aggregate';
import { fetchGroup, planGroups, pool, type FetchProgress } from './fetch';
import { IngestCallError, IngestClient, type ClaimedLoad, type Progress } from './ingest';
import { buildChunks, buildManifest, filterFingerprint } from './payload';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** A load the connector can't do (no retry will help). */
export class LoadError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'LoadError';
	}
}

/**
 * The window: the latest end the load allows that GBIF's latest good copy
 * fully covers (the last complete month before the copy), 24 months back,
 * and on through today for recent reports.
 */
export function chooseWindow(load: Pick<ClaimedLoad, 'window_ends' | 'window_months'>, copy: DatasetCopy, today: string): Window {
	const copyEnd = monthEndBefore(new Date(copy.crawledAt), 1);
	const end = [...load.window_ends].sort().reverse().find((e) => e <= copyEnd);
	if (!end) {
		throw new LoadError(
			`GBIF's latest good copy (${copy.crawledAt.slice(0, 10)}) only covers through ${copyEnd}; this load needs ${load.window_ends.join(' or ')}`,
			false
		);
	}
	return { start: windowStartFor(end, load.window_months), end, through: today };
}

/** Counted 2024-county results, reused for a day (plan step 5). Raw records are never cached. */
export class GroupCache {
	private readonly entries = new Map<string, { agg: GroupAggregate; at: number }>();
	constructor(
		private readonly ttlMs = GROUP_CACHE_MS,
		private readonly max = GROUP_CACHE_MAX
	) {}
	get(key: string, now = Date.now()): { agg: GroupAggregate; at: number } | null {
		const e = this.entries.get(key);
		if (!e) return null;
		if (now - e.at > this.ttlMs) {
			this.entries.delete(key);
			return null;
		}
		return e;
	}
	set(key: string, agg: GroupAggregate, now = Date.now()): void {
		this.entries.delete(key);
		this.entries.set(key, { agg, at: now });
		while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
	}
	delete(key: string): void {
		this.entries.delete(key);
	}
	get size(): number {
		return this.entries.size;
	}
}

export interface RunDeps {
	gbif: GbifClient;
	ingest: IngestClient;
	cache: GroupCache;
	log: Log;
	now?: () => Date;
	heartbeatMs?: number;
	/** Test seam: smaller GBIF pages and cap. */
	fetchOpts?: Parameters<typeof fetchGroup>[5];
}

export type RunOutcome = 'done' | 'failed' | 'lease_lost' | 'stopped';

export async function runLoad(deps: RunDeps, load: ClaimedLoad, stop: AbortSignal): Promise<RunOutcome> {
	const { gbif, ingest, cache, log } = deps;
	const now = deps.now ?? (() => new Date());
	const started = Date.now();
	const ctl = new AbortController();
	const onStop = () => ctl.abort(new LoadError('The connector was stopped; the load goes back to the queue.', true));
	if (stop.aborted) onStop();
	else stop.addEventListener('abort', onStop, { once: true });
	const signal = ctl.signal;

	const progress: Progress = { phase: 'planning', done: 0, total: 0 };
	const pages: FetchProgress = { pagesDone: 0, pagesTotal: 0 };
	let leaseLost: IngestCallError | null = null;
	let beating = false;
	const beat = async () => {
		if (beating || signal.aborted) return;
		beating = true;
		try {
			if (progress.phase === 'fetching') {
				progress.done = pages.pagesDone;
				progress.total = Math.max(pages.pagesTotal, pages.pagesDone);
			}
			await ingest.heartbeat(load, { ...progress }, signal);
		} catch (err) {
			if (err instanceof IngestCallError && err.leaseLost) {
				leaseLost = err;
				ctl.abort(err);
			} else if (!signal.aborted) {
				log('heartbeat_failed', { load: load.id, error: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			beating = false;
		}
	};
	const timer = setInterval(() => void beat(), deps.heartbeatMs ?? HEARTBEAT_EVERY_MS);
	const region = load.region_code;
	log('load_started', { load: load.id, region, attempt: load.attempt });

	try {
		await beat();
		const copy = await gbif.latestGoodCopy(signal);
		const window = chooseWindow(load, copy, now().toISOString().slice(0, 10));
		const groups = await planGroups(gbif, region, window, signal);
		// No group means GBIF answered with nothing for the county. Publishing
		// that would replace its rows with zeros, so the load fails instead.
		if (groups.length === 0) {
			throw new LoadError(`GBIF lists no 2024 county with ${MIN_STATE_RECORDS} or more of ${region}'s records in ${window.start}–${window.through}`, false);
		}
		log('load_planned', { load: load.id, region, window, copy, groups: groups.map((g) => `${g.name} (${g.inRegion})`) });

		// No heartbeat here: the page count is known only once the slices are
		// planned, and "0 of 0" would show in Admin → Sources until the next one.
		progress.phase = 'fetching';
		const aggs: GroupAggregate[] = [];
		const cacheKeys: string[] = [];
		let retrievedAt = Date.now();
		for (const g of groups) {
			const key = `${normalizeState(g.name)}|${g.variants.join('|')}|${window.start}|${window.end}|${copy.crawledAt}`;
			cacheKeys.push(key);
			const hit = cache.get(key);
			if (hit) {
				aggs.push(hit.agg);
				retrievedAt = Math.min(retrievedAt, hit.at);
				log('group_reused', { load: load.id, group: g.name });
				continue;
			}
			const before = { requests: gbif.requests, bytes: gbif.bytes, throttles: gbif.throttles, at: Date.now() };
			const agg = await fetchGroup(gbif, g, window, pages, signal, deps.fetchOpts);
			cache.set(key, agg);
			aggs.push(agg);
			log('group_fetched', {
				load: load.id,
				group: g.name,
				records: agg.stats.records,
				requests: gbif.requests - before.requests,
				throttled: gbif.throttles - before.throttles,
				mb: Math.round((gbif.bytes - before.bytes) / 1e5) / 10,
				seconds: Math.round((Date.now() - before.at) / 1000),
				heap_mb: Math.round(process.memoryUsage().heapUsed / 1e6),
				rss_mb: Math.round(process.memoryUsage().rss / 1e6)
			});
		}

		for (let i = 0; i < aggs.length; i++) {
			for (let j = i + 1; j < aggs.length; j++) {
				const shared = sharedRecords(aggs[i], aggs[j]);
				if (shared === 0) continue;
				// Read both again on the retry rather than count records twice.
				for (const k of cacheKeys) cache.delete(k);
				throw new LoadError(`${shared} records moved between ${aggs[i].name} and ${aggs[j].name} while GBIF was read; reading again`, true);
			}
		}

		progress.phase = 'naming species';
		const keys = [...new Set(aggs.flatMap((a) => [...a.speciesKeys]))];
		progress.done = 0;
		progress.total = keys.length;
		const species = new Map<number, SpeciesInfo>();
		await pool(keys, GBIF_CONCURRENCY, async (k, sig) => {
			species.set(k, await gbif.speciesInfo(k, sig));
			progress.done++;
		}, signal);

		const payload = buildRegionPayload(aggs, region, species);
		const chunks = buildChunks(region, payload);
		progress.phase = 'sending';
		progress.done = 0;
		progress.total = chunks.length;
		await beat();
		for (const c of chunks) {
			await ingest.chunk(load, { chunk_id: c.chunk_id, kind: c.kind, sha256: c.sha256, rows: c.rowData }, signal);
			progress.done++;
		}
		const manifest = buildManifest(payload, chunks, {
			window_start: window.start,
			window_end: window.end,
			retrieved_at: new Date(retrievedAt).toISOString(),
			source_snapshot: { dataset_key: DATASET_KEY, pub_date: copy.pubDate, crawled_at: copy.crawledAt },
			filter_fingerprint: filterFingerprint({
				dataset_key: DATASET_KEY,
				taxon_key: BIRDS_TAXON_KEY,
				occurrence_status: 'PRESENT',
				state_provinces: groups.flatMap((g) => g.variants).sort(),
				window_start: window.start,
				window_end: window.end,
				placement: 'option-b/v1'
			})
		});
		progress.phase = 'finishing';
		progress.done = 0;
		progress.total = 1;
		await beat();
		const result = await ingest.finish(load, manifest, signal);
		log('load_done', {
			load: load.id,
			region,
			stats: payload.stats,
			rows: manifest.counts,
			chunks: chunks.length,
			gbif_requests: gbif.requests,
			seconds: Math.round((Date.now() - started) / 1000),
			rss_mb: Math.round(process.memoryUsage().rss / 1e6),
			result
		});
		return 'done';
	} catch (err) {
		// Nothing still queued at GBIF keeps running for a load that is over.
		if (!signal.aborted) ctl.abort(err);
		const lost = leaseLost ?? (err instanceof IngestCallError && err.leaseLost ? err : null);
		if (lost) {
			log('lease_lost', { load: load.id, region, error: lost.message });
			return 'lease_lost';
		}
		const stopped = stop.aborted;
		const retryable = stopped || (err instanceof LoadError || err instanceof GbifError || err instanceof IngestCallError ? err.retryable : false);
		const reason = stopped
			? 'The connector was stopped; the load goes back to the queue.'
			: err instanceof Error
				? err.message
				: String(err);
		log('load_failed', { load: load.id, region, retryable, error: reason });
		try {
			await ingest.fail(load, reason, retryable, AbortSignal.timeout(10_000));
		} catch (failErr) {
			log('fail_not_sent', { load: load.id, error: failErr instanceof Error ? failErr.message : String(failErr) });
		}
		return stopped ? 'stopped' : 'failed';
	} finally {
		clearInterval(timer);
		stop.removeEventListener('abort', onStop);
	}
}

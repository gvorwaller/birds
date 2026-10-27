/**
 * One load, start to finish (td-eec7db Phase 2 rev B): read the county from
 * Artskart, count it, then send the chunks and the manifest. A heartbeat
 * runs throughout; a lost lease stops the load without calling fail (the app
 * has already moved on).
 */
import { windowStartFor } from '$server/external-sources/contract';
import { BIRDS_TAXON_GROUP, COLLECTION, HEARTBEAT_EVERY_MS, REGION_TO_COUNTY } from './config';
import { ArtskartError, type ArtskartClient } from './artskart';
import type { Window } from './aggregate';
import { readCounty, type FetchOptions, type FetchProgress } from './fetch';
import { IngestCallError, type ClaimedLoad, type IngestClient, type Progress } from './ingest';
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
 * The window: the latest end the load allows (Artskart is live, so every end
 * before today is covered), window_months back, and on through today for
 * recent reports.
 */
export function chooseWindow(load: Pick<ClaimedLoad, 'window_ends' | 'window_months'>, today: string): Window {
	const end = [...load.window_ends].sort().reverse().find((e) => e < today);
	if (!end) throw new LoadError(`None of this load's window ends (${load.window_ends.join(', ')}) is before today`, false);
	return { start: windowStartFor(end, load.window_months), end, through: today };
}

export interface RunDeps {
	artskart: ArtskartClient;
	ingest: IngestClient;
	log: Log;
	now?: () => Date;
	heartbeatMs?: number;
	/** Test seam: smaller Artskart pages. */
	fetchOpts?: FetchOptions;
}

export type RunOutcome = 'done' | 'failed' | 'lease_lost' | 'stopped';

export async function runLoad(deps: RunDeps, load: ClaimedLoad, stop: AbortSignal): Promise<RunOutcome> {
	const { artskart, ingest, log } = deps;
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
		const county = REGION_TO_COUNTY[region];
		if (county === undefined) throw new LoadError(`${region} is not a Norwegian county this connector reads`, false);
		const window = chooseWindow(load, now().toISOString().slice(0, 10));
		log('load_planned', { load: load.id, region, county, window });

		progress.phase = 'fetching';
		const retrievedAt = new Date();
		const before = { requests: artskart.requests, bytes: artskart.bytes, at: Date.now() };
		const agg = await readCounty(artskart, region, county, window, pages, signal, deps.fetchOpts);
		log('county_fetched', {
			load: load.id,
			region,
			records: agg.stats.records,
			requests: artskart.requests - before.requests,
			mb: Math.round((artskart.bytes - before.bytes) / 1e5) / 10,
			seconds: Math.round((Date.now() - before.at) / 1000),
			heap_mb: Math.round(process.memoryUsage().heapUsed / 1e6),
			rss_mb: Math.round(process.memoryUsage().rss / 1e6)
		});
		const payload = agg.payload();
		if (payload.stats.records === 0) {
			// Artskart answering with nothing for a whole county is a broken
			// answer; publishing it would replace the county's rows with zeros.
			throw new LoadError(`Artskart returned no bird reports for ${region} in ${window.start}–${window.end}; try again later`, true);
		}

		const chunks = buildChunks(region, payload);
		progress.phase = 'sending';
		progress.done = 0;
		progress.total = chunks.length;
		await beat();
		for (const c of chunks) {
			await ingest.chunk(load, { chunk_id: c.chunk_id, kind: c.kind, sha256: c.sha256, rows: c.rowData }, signal);
			progress.done++;
		}
		const filters = {
			api: 'artskart-publicapi-v1',
			collection: COLLECTION,
			taxon_group: BIRDS_TAXON_GROUP,
			county
		};
		const manifest = buildManifest(payload, chunks, {
			window_start: window.start,
			window_end: window.end,
			retrieved_at: retrievedAt.toISOString(),
			source_snapshot: { ...filters, through: window.through },
			filter_fingerprint: filterFingerprint({ ...filters, window_start: window.start, window_end: window.end, placement: 'artskart-municipality/v1' })
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
			artskart_requests: artskart.requests - before.requests,
			seconds: Math.round((Date.now() - started) / 1000),
			rss_mb: Math.round(process.memoryUsage().rss / 1e6),
			result
		});
		return 'done';
	} catch (err) {
		if (!signal.aborted) ctl.abort(err);
		const lost = leaseLost ?? (err instanceof IngestCallError && err.leaseLost ? err : null);
		if (lost) {
			log('lease_lost', { load: load.id, region, error: lost.message });
			return 'lease_lost';
		}
		const stopped = stop.aborted;
		const retryable =
			stopped || (err instanceof LoadError || err instanceof ArtskartError || err instanceof IngestCallError ? err.retryable : false);
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

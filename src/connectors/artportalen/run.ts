/**
 * One Swedish load, start to finish (td-99eebf): read the county from SOS,
 * count it, check the whole load fits the app's limits, then send the chunks
 * and the manifest. A heartbeat runs throughout; a lost lease stops the load
 * without calling fail (the app has already moved on).
 *
 * The shape follows the Norway runner (artsobs/run.ts) on purpose, with its
 * own client, errors and evidence; only the wire and spool primitives are
 * shared (plan [C1-7]).
 */
import {
	MAX_FINISH_BODY_BYTES,
	MAX_LOAD_BYTES,
	MAX_LOAD_ROWS,
	validateChunkRows,
	windowStartFor,
	type ManifestChunk
} from '$server/external-sources/contract';
import type { Window } from '../shared/aggregate';
import { IngestCallError, chunkCallBody, finishCallBody, type ClaimedLoad, type IngestClient, type Progress } from '../shared/ingest';
import { CHUNK_TARGET_BYTES, HEARTBEAT_EVERY_MS } from '../shared/limits';
import { buildChunks, buildManifest, filterFingerprint } from '../shared/payload';
import { RecordSpool } from '../shared/spool';
import { BIRDS_TAXON, DATA_PROVIDER, REGION_TO_COUNTY } from './config';
import { readCounty, type FetchOptions, type FetchProgress, type SliceEvidence } from './fetch';
import { SosError, selectionFingerprintInput, type SosClient } from './sos';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** A load the connector can't do as asked. */
export class LoadError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'LoadError';
	}
}

/** The latest window end before today, window_months back, and on through today for recent reports. */
export function chooseWindow(load: Pick<ClaimedLoad, 'window_ends' | 'window_months'>, today: string): Window {
	const end = [...load.window_ends].sort().reverse().find((e) => e < today);
	if (!end) throw new LoadError(`None of this load's window ends (${load.window_ends.join(', ')}) is before today`, false);
	return { start: windowStartFor(end, load.window_months), end, through: today };
}

/**
 * Plan [C1-3], exact (CODEX1 R6): the load's real row count, the bytes of
 * every chunk call body as the client will send it, and the fenced finish
 * body, against the app's limits. Throws a non-retryable LoadError on any
 * overflow; the window is never shortened to make a load fit.
 */
export function checkLimits(m: { rows: number; bytes: number; finishBytes: number }): void {
	if (m.rows > MAX_LOAD_ROWS) throw new LoadError(`This load has ${m.rows} rows, over the app's ${MAX_LOAD_ROWS} per load`, false);
	if (m.bytes > MAX_LOAD_BYTES) throw new LoadError(`This load sends ${m.bytes} bytes, over the app's ${MAX_LOAD_BYTES} per load`, false);
	if (m.finishBytes > MAX_FINISH_BODY_BYTES) {
		throw new LoadError(`This load's finish call is ${m.finishBytes} bytes, over the app's ${MAX_FINISH_BODY_BYTES}-byte limit`, false);
	}
}

export interface RunDeps {
	sos: SosClient;
	ingest: IngestClient;
	log: Log;
	now?: () => Date;
	heartbeatMs?: number;
	/** Test seam: smaller SOS pages. */
	fetchOpts?: FetchOptions;
	/** Test seam: where the record spool's folder goes (default: the OS temp folder). */
	spoolDir?: string;
}

export type RunOutcome = 'done' | 'failed' | 'lease_lost' | 'stopped';

export async function runLoad(deps: RunDeps, load: ClaimedLoad, stop: AbortSignal): Promise<RunOutcome> {
	const { sos, ingest, log } = deps;
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
	let spool: RecordSpool | null = null;
	let peakRss = 0;
	const sample = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));
	const sampler = setInterval(sample, 2000);

	try {
		await beat();
		const county = REGION_TO_COUNTY[region];
		if (county === undefined) throw new LoadError(`${region} is not a Swedish county this connector reads`, false);
		const window = chooseWindow(load, now().toISOString().slice(0, 10));
		log('load_planned', { load: load.id, region, county, window });

		progress.phase = 'fetching';
		const retrievedAt = new Date();
		const before = { requests: sos.requests, bytes: sos.bytes, at: Date.now() };
		spool = new RecordSpool(deps.spoolDir);
		const { agg, evidence } = await readCounty(sos, region, county, window, pages, signal, deps.fetchOpts, spool);
		sample();
		log('county_fetched', {
			load: load.id,
			region,
			records: agg.stats.records,
			requests: sos.requests - before.requests,
			mb: Math.round((sos.bytes - before.bytes) / 1e5) / 10,
			seconds: Math.round((Date.now() - before.at) / 1000),
			record_rows: spool.rows,
			spool_mb: Math.round(spool.bytes / 1e5) / 10,
			heap_mb: Math.round(process.memoryUsage().heapUsed / 1e6),
			rss_mb: Math.round(process.memoryUsage().rss / 1e6),
			months: evidence.map(summarize)
		});
		const payload = agg.payload();
		if (payload.stats.records === 0) {
			// SOS answering with nothing for a whole county is a broken answer;
			// publishing it would replace the county's rows with zeros.
			throw new LoadError(`Artportalen returned no bird reports for ${region} in ${window.start}–${window.end}; try again later`, true);
		}

		const chunks = buildChunks(region, payload, true);
		// Preflight (CODEX1 R6): every chunk, records included, measured as the
		// exact body the client will send, and validated with the app's own
		// validator, BEFORE anything is uploaded.
		const plan: ManifestChunk[] = [];
		let rows = 0;
		let bytes = 0;
		const measure = (c: { chunk_id: string; kind: ManifestChunk['kind']; rows: number; sha256: string; rowData: unknown[] }) => {
			plan.push({ chunk_id: c.chunk_id, kind: c.kind, rows: c.rows, sha256: c.sha256 });
			rows += c.rows;
			bytes += Buffer.byteLength(JSON.stringify(chunkCallBody(load, { chunk_id: c.chunk_id, kind: c.kind, sha256: c.sha256, rows: c.rowData })));
		};
		for (const c of chunks) measure(c);
		for await (const c of spool.chunks(CHUNK_TARGET_BYTES)) {
			validateChunkRows('records', c.rowData, c.sha256, { region, storeObservers: true });
			measure(c);
		}
		const truncated = payload.stats.recentTruncated;
		const manifest = buildManifest(payload, plan, {
			window_start: window.start,
			window_end: window.end,
			retrieved_at: retrievedAt.toISOString(),
			// The recent span is what the "Latest reports" caption states (plan [A4-6]).
			source_snapshot: {
				api: 'sos-v1',
				data_provider: DATA_PROVIDER,
				taxon: BIRDS_TAXON,
				county,
				through: window.through,
				// The span of the rows actually kept, newest first (CODEX1 round 2).
				recent_from: payload.recent.at(-1)?.observed_on ?? null,
				recent_to: payload.recent[0]?.observed_on ?? null,
				recent_truncated: truncated
			},
			filter_fingerprint: filterFingerprint({
				selection: selectionFingerprintInput(county),
				window_start: window.start,
				window_end: window.end,
				placement: 'sos-municipality/v1',
				privacy: 'diffused-no-point/v1'
			})
		});
		const finishBytes = Buffer.byteLength(JSON.stringify(finishCallBody(load, manifest)));
		checkLimits({ rows, bytes, finishBytes });
		log('preflight', { load: load.id, region, rows, bytes, chunks: plan.length, finish_bytes: finishBytes });

		const sendStarted = Date.now();
		progress.phase = 'sending';
		progress.done = 0;
		progress.total = plan.length;
		await beat();
		let i = 0;
		const send = async (c: { chunk_id: string; kind: string; sha256: string; rowData: unknown[] }) => {
			// The second pass must be the chunks measured (same spool, same order).
			const want = plan[i++];
			if (!want || want.chunk_id !== c.chunk_id || want.sha256 !== c.sha256) {
				throw new LoadError(`Chunk ${c.chunk_id} changed between preflight and sending`, true);
			}
			await ingest.chunk(load, { chunk_id: c.chunk_id, kind: c.kind, sha256: c.sha256, rows: c.rowData }, signal);
			progress.done++;
		};
		for (const c of chunks) await send(c);
		for await (const c of spool.chunks(CHUNK_TARGET_BYTES)) await send(c);
		if (i !== plan.length) throw new LoadError(`Sent ${i} chunks of the ${plan.length} measured`, true);
		sample();
		const sendSeconds = Math.round((Date.now() - sendStarted) / 1000);
		progress.phase = 'finishing';
		progress.done = 0;
		progress.total = 1;
		await beat();
		const finishStarted = Date.now();
		const result = await ingest.finish(load, manifest, signal);
		sample();
		log('load_done', {
			load: load.id,
			region,
			stats: payload.stats,
			rows: manifest.counts,
			chunks: plan.length,
			finish_bytes: finishBytes,
			send_seconds: sendSeconds,
			finish_seconds: Math.round((Date.now() - finishStarted) / 1000),
			sos_requests: sos.requests - before.requests,
			seconds: Math.round((Date.now() - started) / 1000),
			peak_rss_mb: Math.round(peakRss / 1e6),
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
		// Errors this connector didn't classify are retried: a later attempt
		// may well succeed, and MAX_ATTEMPTS bounds it (plan [C1-7]).
		const retryable =
			stopped ||
			(err instanceof LoadError || err instanceof SosError || err instanceof IngestCallError ? err.retryable : true);
		const reason = stopped ? 'The connector was stopped; the load goes back to the queue.' : err instanceof Error ? err.message : String(err);
		log('load_failed', { load: load.id, region, retryable, error: reason });
		try {
			await ingest.fail(load, reason, retryable, AbortSignal.timeout(10_000));
		} catch (failErr) {
			log('fail_not_sent', { load: load.id, error: failErr instanceof Error ? failErr.message : String(failErr) });
		}
		return stopped ? 'stopped' : 'failed';
	} finally {
		spool?.close();
		clearInterval(timer);
		clearInterval(sampler);
		stop.removeEventListener('abort', onStop);
	}
}

function summarize(e: SliceEvidence): string {
	return `${e.from.slice(0, 7)} count=${e.count} total=${e.total} pages=${e.pages} reads=${e.reads}${e.repeats ? ` repeats=${e.repeats}` : ''}${e.absent ? ` absent=${e.absent}` : ''}`;
}

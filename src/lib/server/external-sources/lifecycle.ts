/**
 * The load lifecycle for external sightings sources (td-eec7db Phase 1).
 * Plan: docs/2026-10-21-external-sources-plan-CC.md → "Load lifecycle".
 *
 *   queue → claim (lease + fencing) → heartbeat / chunks → finish | fail
 *
 * Fencing [C-P1-1]: every load-scoped call carries the load id, its
 * lease_token and its attempt; they must match the authenticated connector's
 * source and the live lease, or the call gets a 409. A connector whose lease
 * expired or whose token was revoked can never publish.
 *
 * Finish [C-P1-2] verifies the manifest against the chunks received, checks
 * the totals, matches the taxa and replaces every published row of the
 * (source, region) in ONE transaction holding the load's row lock. Until
 * then the previous good data stays published.
 */
import type pg from 'pg';
import { query, withTransaction } from '$lib/db';
import type { Connector } from './auth';
import {
	allowedWindowEnds,
	CHUNK_KINDS,
	ContractError,
	MAX_LOAD_BYTES,
	MAX_LOAD_ROWS,
	parseManifest,
	sanitizeReason,
	validateChunkRows,
	type ChunkBody,
	type ChunkKind,
	type Fence,
	type Manifest,
	type Progress,
	type RowsByKind
} from './contract';
import { deriveSpecies, lockSourceDerived } from './taxa';

export const LEASE_MINUTES = 10;
export const MAX_ATTEMPTS = 3;
/** Requeue backoff after a lost or failed attempt: attempt × this. */
const BACKOFF_MINUTES = 2;
/** Abandoned staging is swept after this long without a chunk. */
export const STAGING_TTL_DAYS = 7;

/** Maps to an HTTP status in the route layer. */
export class IngestError extends Error {
	constructor(
		readonly status: 401 | 403 | 404 | 409 | 413 | 422 | 429,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'IngestError';
	}
}

export interface LoadRow {
	id: string;
	source_id: string;
	region_code: string;
	requested_by: number | null;
	status: 'queued' | 'leased' | 'staging' | 'done' | 'failed' | 'superseded';
	attempt: number;
	max_attempts: number;
	lease_token: string | null;
	claim_idempotency_key: string | null;
	lease_expires_at: Date | null;
	heartbeat_at: Date | null;
	not_before: Date;
	connector_id: string | null;
	window_months: number;
	window_start: string | null;
	window_end: string | null;
	retrieved_at: Date | null;
	filter_fingerprint: string | null;
	source_snapshot: Record<string, unknown> | null;
	progress: Progress | null;
	error: string | null;
	result: LoadResult | null;
	created_at: Date;
	started_at: Date | null;
	finished_at: Date | null;
	updated_at: Date;
	lease_live: boolean;
}

export interface LoadResult {
	counts: Partial<Record<ChunkKind, number>>;
	places: number;
	species: number;
	unmatched_taxa: number;
	unmatched_reports: number;
	/** Place-months whose matched species + unkeyed fall short of the total. */
	gaps: { place_months: number; reports: number };
	/** Exact per-code totals; every note is kept in external_load_diagnostics. */
	diagnostics: { code: string; notes: number; count: number }[];
	window: { start: string; end: string };
}

export interface ClaimedLoad {
	id: string;
	region_code: string;
	attempt: number;
	lease_token: string;
	lease_expires_at: string;
	window_months: number;
	/**
	 * The window ends this load accepts, latest first, frozen when it was
	 * queued (allowedWindowEnds). The connector picks the latest one its
	 * source copy fully covers and starts window_months − 1 months earlier.
	 */
	window_ends: string[];
}

type Db = pg.PoolClient;

const LOAD_COLUMNS = `l.*, (l.lease_expires_at IS NOT NULL AND l.lease_expires_at > now()) AS lease_live`;

// ── Staging tables, per kind ───────────────────────────────────────────────

interface StageSpec {
	table: string;
	/** Row fields in insert order (after load_id, chunk_id, region_code). */
	fields: string[];
	/** Published table and its columns (same names), or null (diagnostics). */
	published: string | null;
	/** Fields sent to PostgreSQL as JSON text (JSONB columns). */
	json?: string[];
}

const STAGE: Record<ChunkKind, StageSpec> = {
	places: {
		table: 'external_stage_places',
		fields: ['place_key', 'name', 'level', 'parent_key', 'lat', 'lon', 'upstream_place_id'],
		published: 'external_places'
	},
	totals: {
		table: 'external_stage_totals',
		fields: ['place_key', 'month', 'reports', 'unkeyed'],
		published: 'external_place_month_totals'
	},
	taxon_month: {
		table: 'external_stage_taxon_month',
		fields: ['place_key', 'upstream_taxon_id', 'month', 'canonical_name', 'raw_name', 'reports'],
		published: 'external_taxon_month'
	},
	localities: {
		table: 'external_stage_localities',
		fields: ['place_key', 'rank', 'locality', 'reports', 'lat', 'lon', 'uncertainty_m', 'placement'],
		published: 'external_top_localities'
	},
	recent: {
		table: 'external_stage_recent',
		fields: [
			'upstream_record_id',
			'place_key',
			'upstream_taxon_id',
			'canonical_name',
			'observed_on',
			'count',
			'locality',
			'lat',
			'lon',
			'uncertainty_m',
			'generalized',
			'record_url',
			'observer'
		],
		published: 'external_recent_reports'
	},
	diagnostics: { table: 'external_stage_diagnostics', fields: ['code', 'detail', 'count'], published: null },
	observers: {
		table: 'external_stage_observers',
		fields: ['place_key', 'rank', 'observer', 'days', 'species', 'localities', 'reports'],
		published: 'external_top_observers'
	},
	// Source-wide: upserted at finish, never swapped per region (upsertTaxa).
	taxa: {
		table: 'external_stage_taxa',
		fields: ['upstream_taxon_id', 'canonical_name', 'raw_name', 'rank', 'local_name', 'red_list', 'red_list_url'],
		published: 'external_taxa'
	},
	records: {
		table: 'external_stage_records',
		fields: [
			'upstream_record_id',
			'place_key',
			'upstream_taxon_id',
			'canonical_name',
			'observed_on',
			'count',
			'locality',
			'lat',
			'lon',
			'uncertainty_m',
			'observers',
			'behaviour',
			'activity',
			'validation',
			'notes',
			'sex',
			'photos',
			'dataset',
			'record_url',
			'upstream_modified_at'
		],
		published: 'external_records',
		json: ['photos']
	}
};

/** Published tables in delete order (children before external_places). */
const PUBLISHED_DELETE_ORDER = [
	'external_records',
	'external_place_month_species',
	'external_unmatched',
	'external_recent_reports',
	'external_top_observers',
	'external_top_localities',
	'external_taxon_month',
	'external_place_month_totals',
	'external_places'
];

async function clearStaging(db: Pick<Db, 'query'>, loadIds: string[]): Promise<void> {
	if (loadIds.length === 0) return;
	for (const kind of CHUNK_KINDS) {
		await db.query(`DELETE FROM ${STAGE[kind].table} WHERE load_id = ANY($1::uuid[])`, [loadIds]);
	}
	await db.query(`DELETE FROM external_load_chunks WHERE load_id = ANY($1::uuid[])`, [loadIds]);
}

// ── Queue ──────────────────────────────────────────────────────────────────

/**
 * Queue a load for one region. One active load per (source, region): a
 * second request returns the active one instead of a duplicate.
 */
export async function queueExternalLoad(opts: {
	sourceId: string;
	regionCode: string;
	requestedBy: number | null;
	/** Test seam only: runs between a conflicting INSERT and the follow-up SELECT. */
	afterConflictForTest?: () => Promise<void>;
}): Promise<{ loadId: string; created: boolean }> {
	return withTransaction(async (c) => {
		const src = await c.query<{ active: boolean; window_months: number; mapped: boolean }>(
			`SELECT s.active, s.window_months,
			        EXISTS (SELECT 1 FROM external_region_map m WHERE m.source_id = s.id AND m.region_code = $2) AS mapped
			   FROM external_sources s WHERE s.id = $1`,
			[opts.sourceId, opts.regionCode]
		);
		const s = src.rows[0];
		if (!s) throw new IngestError(404, 'unknown_source', 'Unknown source.');
		if (!s.active) throw new IngestError(409, 'inactive_source', 'This source is switched off.');
		if (!s.mapped) throw new IngestError(422, 'unmapped_region', 'This source has no data for that region.');
		// The active load we collided with can finish between the INSERT and the
		// SELECT (READ COMMITTED); then the insert is simply tried again.
		for (let tries = 0; tries < 5; tries++) {
			const ins = await c.query<{ id: string }>(
				`INSERT INTO external_loads (source_id, region_code, requested_by, max_attempts, window_months)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (source_id, region_code) WHERE status IN ('queued', 'leased', 'staging') DO NOTHING
				 RETURNING id`,
				[opts.sourceId, opts.regionCode, opts.requestedBy, MAX_ATTEMPTS, s.window_months]
			);
			if (ins.rows[0]) return { loadId: ins.rows[0].id, created: true };
			if (opts.afterConflictForTest) await opts.afterConflictForTest();
			const active = await c.query<{ id: string }>(
				`SELECT id FROM external_loads
				  WHERE source_id = $1 AND region_code = $2 AND status IN ('queued', 'leased', 'staging')`,
				[opts.sourceId, opts.regionCode]
			);
			if (active.rows[0]) return { loadId: active.rows[0].id, created: false };
		}
		throw new IngestError(409, 'queue_busy', 'The region is being loaded and finished at the same moment; try again.');
	});
}

// ── Lease expiry ───────────────────────────────────────────────────────────

/**
 * Leases past their expiry go back to the queue with a backoff, or fail
 * after max_attempts; their staging is discarded. Loads locked by a running
 * finish are skipped (SKIP LOCKED) — finish re-checks the lease itself.
 */
export async function expireLeases(db: Pick<Db, 'query'>, sourceId: string | null): Promise<number> {
	const r = await db.query<{ id: string }>(
		`WITH expired AS (
		   SELECT id FROM external_loads
		    WHERE status IN ('leased', 'staging') AND lease_expires_at <= now()
		      AND ($1::text IS NULL OR source_id = $1)
		    FOR UPDATE SKIP LOCKED
		 )
		 UPDATE external_loads l
		    SET status = CASE WHEN l.attempt >= l.max_attempts THEN 'failed' ELSE 'queued' END,
		        error = CASE WHEN l.attempt >= l.max_attempts
		                     THEN 'The connector stopped responding on ' || l.attempt || ' attempts; the load was given up.'
		                     ELSE l.error END,
		        finished_at = CASE WHEN l.attempt >= l.max_attempts THEN now() ELSE NULL END,
		        not_before = now() + l.attempt * interval '${BACKOFF_MINUTES} minutes',
		        lease_token = CASE WHEN l.attempt >= l.max_attempts THEN l.lease_token ELSE NULL END,
		        claim_idempotency_key = NULL,
		        lease_expires_at = NULL,
		        heartbeat_at = NULL,
		        progress = NULL,
		        updated_at = now()
		   FROM expired WHERE l.id = expired.id
		 RETURNING l.id`,
		[sourceId]
	);
	await clearStaging(db, r.rows.map((x) => x.id));
	return r.rowCount ?? 0;
}

// ── Connector check inside the writing transaction ─────────────────────────

/**
 * Authentication happens before the body is read, so a token can be revoked
 * (or the source switched off) while a call is in flight. Every writing
 * transaction re-checks under FOR SHARE: a revoke or deactivate that commits
 * first is seen here (401), and one that arrives later waits for this
 * transaction, so it takes effect from the next call [CODEX1 Phase 1 P2].
 *
 * Returns the source's store_observers flag as read under that lock: chunk
 * validation and finish use it, never the flag seen at authentication, so
 * switching it off takes effect for the very next write (CODEX1 rev B
 * finding 2).
 */
async function assertConnectorLive(db: Pick<Db, 'query'>, connector: Connector): Promise<{ storeObservers: boolean }> {
	const r = await db.query<{ revoked: boolean; active: boolean; store_observers: boolean }>(
		`SELECT c.revoked_at IS NOT NULL AS revoked, s.active, s.store_observers
		   FROM external_connectors c JOIN external_sources s ON s.id = c.source_id
		  WHERE c.id = $1 AND c.source_id = $2
		    FOR SHARE OF c, s`,
		[connector.connectorId, connector.sourceId]
	);
	const row = r.rows[0];
	if (!row || row.revoked) throw new IngestError(401, 'revoked', 'This token has been revoked.');
	if (!row.active) throw new IngestError(401, 'inactive', 'This source is switched off.');
	return { storeObservers: row.store_observers };
}

// ── Claim ──────────────────────────────────────────────────────────────────

function claimed(row: LoadRow): ClaimedLoad {
	return {
		id: row.id,
		region_code: row.region_code,
		attempt: row.attempt,
		lease_token: row.lease_token!,
		lease_expires_at: row.lease_expires_at!.toISOString(),
		window_months: row.window_months,
		window_ends: allowedWindowEnds(row.created_at)
	};
}

/**
 * Claim the next queued load of the connector's source. Repeating the same
 * idempotency key returns the same lease, so a claim whose response was lost
 * never takes a second load [C-P3-1].
 */
export async function claimLoad(connector: Connector, idempotencyKey: string): Promise<ClaimedLoad | null> {
	return withTransaction(async (c) => {
		// Two retries of one claim run one at a time, so a key never leases two loads.
		await c.query(`SELECT pg_advisory_xact_lock(hashtext('external-claim:' || $1::text || ':' || $2))`, [
			connector.connectorId,
			idempotencyKey
		]);
		await assertConnectorLive(c, connector);
		await expireLeases(c, connector.sourceId);
		const again = await c.query<LoadRow>(
			`SELECT ${LOAD_COLUMNS} FROM external_loads l
			  WHERE l.source_id = $1 AND l.claim_idempotency_key = $2 AND l.connector_id = $3
			    AND l.status IN ('leased', 'staging') AND l.lease_expires_at > now()`,
			[connector.sourceId, idempotencyKey, connector.connectorId]
		);
		if (again.rows[0]) return claimed(again.rows[0]);
		const r = await c.query<LoadRow>(
			`UPDATE external_loads l
			    SET status = 'leased', attempt = l.attempt + 1, lease_token = gen_random_uuid(),
			        claim_idempotency_key = $2, lease_expires_at = now() + interval '${LEASE_MINUTES} minutes',
			        heartbeat_at = now(), connector_id = $3, started_at = COALESCE(l.started_at, now()),
			        error = NULL, progress = NULL, updated_at = now()
			  WHERE l.id = (
			    SELECT id FROM external_loads
			     WHERE source_id = $1 AND status = 'queued' AND not_before <= now() AND attempt < max_attempts
			     ORDER BY created_at, id
			     FOR UPDATE SKIP LOCKED
			     LIMIT 1)
			 RETURNING ${LOAD_COLUMNS}`,
			[connector.sourceId, idempotencyKey, connector.connectorId]
		);
		return r.rows[0] ? claimed(r.rows[0]) : null;
	});
}

// ── Fencing ────────────────────────────────────────────────────────────────

async function lockLoad(db: Db, connector: Connector, loadId: string): Promise<LoadRow & { storeObservers: boolean }> {
	const r = await db.query<LoadRow>(`SELECT ${LOAD_COLUMNS} FROM external_loads l WHERE l.id = $1 FOR UPDATE`, [loadId]);
	const load = r.rows[0];
	if (!load) throw new IngestError(404, 'unknown_load', 'No such load.');
	if (load.source_id !== connector.sourceId) {
		throw new IngestError(403, 'wrong_source', 'This load belongs to another source.');
	}
	const { storeObservers } = await assertConnectorLive(db, connector);
	return { ...load, storeObservers };
}

function sameLease(load: LoadRow, fence: Fence): boolean {
	return load.lease_token === fence.lease_token && load.attempt === fence.attempt;
}

/** The live-lease check every writing call makes. */
function assertLiveLease(load: LoadRow, fence: Fence): void {
	if (load.status !== 'leased' && load.status !== 'staging') {
		throw new IngestError(409, 'not_leased', `The load is ${load.status}; it is not held by a lease.`);
	}
	if (!sameLease(load, fence)) throw new IngestError(409, 'fenced', 'The lease token or attempt does not match the live lease.');
	if (!load.lease_live) throw new IngestError(409, 'lease_expired', 'The lease has expired.');
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

export async function heartbeatLoad(
	connector: Connector,
	loadId: string,
	fence: Fence,
	progress: Progress
): Promise<{ lease_expires_at: string }> {
	return withTransaction(async (c) => {
		const load = await lockLoad(c, connector, loadId);
		assertLiveLease(load, fence);
		const r = await c.query<{ lease_expires_at: Date }>(
			`UPDATE external_loads
			    SET lease_expires_at = now() + interval '${LEASE_MINUTES} minutes', heartbeat_at = now(),
			        progress = $2::jsonb, updated_at = now()
			  WHERE id = $1 RETURNING lease_expires_at`,
			[loadId, JSON.stringify(progress)]
		);
		return { lease_expires_at: r.rows[0].lease_expires_at.toISOString() };
	});
}

// ── Chunks ─────────────────────────────────────────────────────────────────

function pgCode(err: unknown): string | undefined {
	return (err as { code?: string } | null)?.code;
}

async function insertStageRows<K extends ChunkKind>(
	db: Db,
	kind: K,
	loadId: string,
	chunkId: string,
	region: string,
	rows: RowsByKind[K][]
): Promise<void> {
	const spec = STAGE[kind];
	const withRegion = kind !== 'diagnostics';
	const cols = ['load_id', 'chunk_id', ...(withRegion ? ['region_code'] : []), ...spec.fields];
	const batch = Math.max(1, Math.floor(60000 / cols.length));
	for (let i = 0; i < rows.length; i += batch) {
		const slice = rows.slice(i, i + batch);
		const params: unknown[] = [];
		const values = slice.map((row) => {
			const rec = row as unknown as Record<string, unknown>;
			const vals = [
				loadId,
				chunkId,
				...(withRegion ? [region] : []),
				...spec.fields.map((f) => (spec.json?.includes(f) && rec[f] !== null ? JSON.stringify(rec[f]) : rec[f]))
			];
			const start = params.length;
			params.push(...vals);
			return `(${vals.map((_, j) => `$${start + j + 1}`).join(',')})`;
		});
		await db.query(`INSERT INTO ${spec.table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
	}
}

/**
 * Store one chunk. The same chunk id with the same digest is a no-op
 * ("duplicate"); with a different digest it is a 409 [C-P1-2].
 */
export async function putChunk(
	connector: Connector,
	loadId: string,
	fence: Fence,
	chunk: ChunkBody,
	bodyBytes: number
): Promise<{ status: 'stored' | 'duplicate' }> {
	return withTransaction(async (c) => {
		const load = await lockLoad(c, connector, loadId);
		assertLiveLease(load, fence);
		const prior = await c.query<{ sha256: string; kind: string }>(
			`SELECT sha256, kind FROM external_load_chunks WHERE load_id = $1 AND chunk_id = $2`,
			[loadId, chunk.chunk_id]
		);
		if (prior.rows[0]) {
			if (prior.rows[0].sha256 === chunk.sha256 && prior.rows[0].kind === chunk.kind) return { status: 'duplicate' as const };
			throw new IngestError(409, 'chunk_conflict', 'A chunk with this id was already stored with different content.');
		}
		const rows = validateChunkRows(chunk.kind, chunk.rows, chunk.sha256, {
			region: load.region_code,
			storeObservers: load.storeObservers
		});
		const totals = await c.query<{ rows: string; bytes: string }>(
			`SELECT COALESCE(SUM(rows), 0) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM external_load_chunks WHERE load_id = $1`,
			[loadId]
		);
		if (Number(totals.rows[0].rows) + rows.length > MAX_LOAD_ROWS || Number(totals.rows[0].bytes) + bodyBytes > MAX_LOAD_BYTES) {
			throw new IngestError(413, 'load_too_large', 'This load is over its total row or byte limit.');
		}
		try {
			await c.query('SAVEPOINT stage_rows');
			await insertStageRows(c, chunk.kind, loadId, chunk.chunk_id, load.region_code, rows);
			await c.query('RELEASE SAVEPOINT stage_rows');
		} catch (err) { // stale-safe: ingest web request, never under a worker job claim; maps row errors, rethrows the rest
			const code = pgCode(err);
			if (code === '23505') throw new IngestError(422, 'duplicate_row', 'A row in this chunk repeats a row from an earlier chunk.');
			if (code === '23514' || code === '22P02' || code === '22007' || code === '22008' || code === '22003') {
				throw new IngestError(422, 'invalid_row', 'A row in this chunk failed a database check.');
			}
			throw err;
		}
		await c.query(
			`INSERT INTO external_load_chunks (load_id, chunk_id, kind, sha256, rows, bytes) VALUES ($1, $2, $3, $4, $5, $6)`,
			[loadId, chunk.chunk_id, chunk.kind, chunk.sha256, rows.length, bodyBytes]
		);
		if (load.status === 'leased') {
			await c.query(`UPDATE external_loads SET status = 'staging', updated_at = now() WHERE id = $1`, [loadId]);
		}
		return { status: 'stored' as const };
	});
}

// ── Finish ─────────────────────────────────────────────────────────────────

/** Compare the manifest with what was actually received. */
async function verifyManifest(c: Db, load: LoadRow, m: Manifest): Promise<void> {
	const got = await c.query<{ chunk_id: string; kind: ChunkKind; rows: number; sha256: string }>(
		`SELECT chunk_id, kind, rows, sha256 FROM external_load_chunks WHERE load_id = $1`,
		[load.id]
	);
	const received = new Map(got.rows.map((r) => [r.chunk_id, r]));
	for (const mc of m.chunks) {
		const r = received.get(mc.chunk_id);
		if (!r) throw new IngestError(422, 'manifest_mismatch', `Chunk ${mc.chunk_id} is in the manifest but was never received.`);
		if (r.kind !== mc.kind || r.rows !== mc.rows || r.sha256 !== mc.sha256) {
			throw new IngestError(422, 'manifest_mismatch', `Chunk ${mc.chunk_id} differs from the one received.`);
		}
	}
	if (received.size !== m.chunks.length) {
		const listed = new Set(m.chunks.map((x) => x.chunk_id));
		const extra = [...received.keys()].find((id) => !listed.has(id));
		throw new IngestError(422, 'manifest_mismatch', `Chunk ${extra} was received but is not in the manifest.`);
	}
	for (const kind of CHUNK_KINDS) {
		const sum = got.rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.rows, 0);
		if ((m.counts[kind] ?? 0) !== sum) {
			throw new IngestError(422, 'manifest_mismatch', `The manifest counts ${m.counts[kind] ?? 0} ${kind} rows; ${sum} were received.`);
		}
	}
	const staged = await c.query<{ place_key: string }>(`SELECT place_key FROM external_stage_places WHERE load_id = $1`, [load.id]);
	const stagedPlaces = new Set(staged.rows.map((r) => r.place_key));
	if (stagedPlaces.size !== m.places.length || m.places.some((p) => !stagedPlaces.has(p))) {
		throw new IngestError(422, 'manifest_mismatch', 'The manifest places differ from the places received.');
	}
	const orphan = await c.query<{ place_key: string; kind: string }>(
		`SELECT place_key, kind FROM (
		   SELECT place_key, 'totals' AS kind FROM external_stage_totals WHERE load_id = $1
		   UNION ALL SELECT place_key, 'taxon_month' FROM external_stage_taxon_month WHERE load_id = $1
		   UNION ALL SELECT place_key, 'localities' FROM external_stage_localities WHERE load_id = $1
		   UNION ALL SELECT place_key, 'recent' FROM external_stage_recent WHERE load_id = $1
		   UNION ALL SELECT place_key, 'observers' FROM external_stage_observers WHERE load_id = $1
		   UNION ALL SELECT place_key, 'records' FROM external_stage_records WHERE load_id = $1
		 ) x
		 WHERE NOT EXISTS (SELECT 1 FROM external_stage_places p WHERE p.load_id = $1 AND p.place_key = x.place_key)
		 LIMIT 1`,
		[load.id]
	);
	if (orphan.rows[0]) {
		throw new IngestError(422, 'unknown_place', `A ${orphan.rows[0].kind} row names place "${orphan.rows[0].place_key}", which was never sent.`);
	}
	// Every record's taxon arrives in this load's taxa rows (td-769300).
	const untaxed = await c.query<{ upstream_record_id: string }>(
		`SELECT r.upstream_record_id FROM external_stage_records r
		  WHERE r.load_id = $1
		    AND NOT EXISTS (SELECT 1 FROM external_stage_taxa t
		                     WHERE t.load_id = $1 AND t.upstream_taxon_id = r.upstream_taxon_id AND t.canonical_name = r.canonical_name)
		  LIMIT 1`,
		[load.id]
	);
	if (untaxed.rows[0]) {
		throw new IngestError(422, 'unknown_taxon', `Record ${untaxed.rows[0].upstream_record_id} names a taxon that was never sent.`);
	}
	// Every place has a total for every month, empty months as 0: a share is
	// then never computed against a missing denominator.
	const missing = await c.query<{ n: string }>(
		`SELECT COUNT(*) AS n FROM external_stage_places p CROSS JOIN generate_series(1, 12) AS mo(month)
		  WHERE p.load_id = $1
		    AND NOT EXISTS (SELECT 1 FROM external_stage_totals t
		                     WHERE t.load_id = $1 AND t.place_key = p.place_key AND t.month = mo.month)`,
		[load.id]
	);
	if (Number(missing.rows[0].n) > 0) {
		throw new IngestError(422, 'totals_incomplete', `${missing.rows[0].n} place-months have no total; send 0 for empty months.`);
	}
}

/** Species + unkeyed may fall short of a total (a gap), never exceed it. */
async function checkTotals(c: Db, loadId: string): Promise<{ place_months: number; reports: number }> {
	const r = await c.query<{ over: string; gap_n: string; gap_reports: string }>(
		`WITH s AS (
		   SELECT place_key, month, SUM(reports)::bigint AS species
		     FROM external_stage_taxon_month WHERE load_id = $1 GROUP BY place_key, month
		 )
		 SELECT COUNT(*) FILTER (WHERE COALESCE(s.species, 0) + t.unkeyed > t.reports) AS over,
		        COUNT(*) FILTER (WHERE COALESCE(s.species, 0) + t.unkeyed < t.reports) AS gap_n,
		        COALESCE(SUM(t.reports - COALESCE(s.species, 0) - t.unkeyed)
		                 FILTER (WHERE COALESCE(s.species, 0) + t.unkeyed < t.reports), 0) AS gap_reports
		   FROM external_stage_totals t
		   LEFT JOIN s ON s.place_key = t.place_key AND s.month = t.month
		  WHERE t.load_id = $1`,
		[loadId]
	);
	if (Number(r.rows[0].over) > 0) {
		throw new IngestError(422, 'totals_inconsistent', `${r.rows[0].over} place-months have more species reports than their total.`);
	}
	return { place_months: Number(r.rows[0].gap_n), reports: Number(r.rows[0].gap_reports) };
}

/**
 * Observer names are published only while the source stores them: staged
 * names from before the flag was switched off are refused, not copied into
 * the published tables (CODEX1 rev B finding 2).
 */
async function checkObserverPolicy(c: Db, load: LoadRow & { storeObservers: boolean }): Promise<void> {
	if (load.storeObservers) return;
	const r = await c.query<{ named: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM external_stage_observers WHERE load_id = $1)
		     OR EXISTS (SELECT 1 FROM external_stage_recent WHERE load_id = $1 AND observer IS NOT NULL)
		     OR EXISTS (SELECT 1 FROM external_stage_records WHERE load_id = $1 AND cardinality(observers) > 0)
		     OR EXISTS (SELECT 1 FROM external_stage_records
		                 WHERE load_id = $1 AND photos IS NOT NULL AND jsonb_path_exists(photos, '$[*] ? (@.by != null)')) AS named`,
		[load.id]
	);
	if (r.rows[0].named) {
		throw new IngestError(422, 'observer', 'This source no longer stores observer names; the load carries some and is not published.');
	}
}

/**
 * One upstream taxon id must carry one name across the whole load. A genus
 * or hybrid (taxa rank OTHER) is never matched to a species, so only the
 * species-level taxa rows take part.
 */
async function checkTaxonNames(c: Db, loadId: string): Promise<void> {
	const r = await c.query<{ upstream_taxon_id: string }>(
		`SELECT upstream_taxon_id FROM (
		   SELECT upstream_taxon_id, canonical_name FROM external_stage_taxon_month WHERE load_id = $1
		   UNION SELECT upstream_taxon_id, canonical_name FROM external_stage_recent WHERE load_id = $1
		   UNION SELECT upstream_taxon_id, canonical_name FROM external_stage_taxa WHERE load_id = $1 AND rank <> 'OTHER'
		 ) x GROUP BY upstream_taxon_id HAVING COUNT(DISTINCT canonical_name) > 1 LIMIT 1`,
		[loadId]
	);
	if (r.rows[0]) {
		throw new IngestError(422, 'taxon_name_conflict', `Upstream taxon ${r.rows[0].upstream_taxon_id} is sent under two names.`);
	}
}

/**
 * Taxa are source-wide (td-769300): a load adds or refreshes its own and
 * never removes another county's. A value the source left out this time
 * keeps the one already known. Species codes are deriveSpecies's.
 */
async function upsertTaxa(c: Db, load: LoadRow): Promise<void> {
	await c.query(
		`INSERT INTO external_taxa (source_id, upstream_taxon_id, canonical_name, raw_name, rank, local_name, red_list, red_list_url, load_id)
		 SELECT $2, upstream_taxon_id, canonical_name, raw_name, rank, local_name, red_list, red_list_url, load_id
		   FROM external_stage_taxa WHERE load_id = $1
		 ON CONFLICT (source_id, upstream_taxon_id, canonical_name) DO UPDATE
		    SET raw_name = EXCLUDED.raw_name, rank = EXCLUDED.rank,
		        local_name = COALESCE(EXCLUDED.local_name, external_taxa.local_name),
		        red_list = COALESCE(EXCLUDED.red_list, external_taxa.red_list),
		        red_list_url = COALESCE(EXCLUDED.red_list_url, external_taxa.red_list_url),
		        load_id = EXCLUDED.load_id, updated_at = now()`,
		[load.id, load.source_id]
	);
}

async function publish(c: Db, load: LoadRow): Promise<void> {
	const scope = [load.source_id, load.region_code];
	for (const table of PUBLISHED_DELETE_ORDER) {
		await c.query(`DELETE FROM ${table} WHERE source_id = $1 AND region_code = $2`, scope);
	}
	await upsertTaxa(c, load);
	// Records go in after the taxa they reference.
	for (const kind of ['places', 'totals', 'taxon_month', 'localities', 'recent', 'observers', 'records'] as const) {
		const spec = STAGE[kind];
		const cols = spec.fields.join(', ');
		await c.query(
			`INSERT INTO ${spec.published} (source_id, region_code, load_id, ${cols})
			 SELECT $2, region_code, load_id, ${cols} FROM ${spec.table} WHERE load_id = $1`,
			[load.id, load.source_id]
		);
	}
	await deriveSpecies(c, load.source_id, load.region_code);
}

export interface FinishOptions {
	/** Test seam only (never reachable over HTTP): throw after the swap, before commit. */
	failAfterSwapForTest?: boolean;
}

export async function finishLoad(
	connector: Connector,
	loadId: string,
	fence: Fence,
	rawManifest: unknown,
	opts: FinishOptions = {}
): Promise<{ status: 'done'; result: LoadResult }> {
	return withTransaction(async (c) => {
		const load = await lockLoad(c, connector, loadId);
		// A finish repeated after a lost response returns the stored result.
		if ((load.status === 'done' || load.status === 'superseded') && sameLease(load, fence) && load.result) {
			return { status: 'done' as const, result: load.result };
		}
		assertLiveLease(load, fence);
		await lockSourceDerived(c, load.source_id);
		let manifest: Manifest;
		try {
			manifest = parseManifest(rawManifest, {
				windowMonths: load.window_months,
				region: load.region_code,
				now: new Date(),
				allowedEnds: allowedWindowEnds(load.created_at)
			});
		} catch (err) { // stale-safe: ingest web request, never under a worker job claim; maps contract errors, rethrows the rest
			if (err instanceof ContractError) throw new IngestError(err.code === 'region' ? 403 : 422, 'invalid_manifest', err.message);
			throw err;
		}
		await verifyManifest(c, load, manifest);
		await checkObserverPolicy(c, load);
		await checkTaxonNames(c, load.id);
		const gaps = await checkTotals(c, load.id);

		await publish(c, load);
		if (opts.failAfterSwapForTest) throw new Error('test: failure in the middle of the swap');

		const summary = await c.query<{ species: string; unmatched_taxa: string; unmatched_reports: string }>(
			`SELECT (SELECT COUNT(DISTINCT species_code) FROM external_place_month_species WHERE source_id = $1 AND region_code = $2) AS species,
			        (SELECT COUNT(*) FROM external_unmatched WHERE source_id = $1 AND region_code = $2) AS unmatched_taxa,
			        (SELECT COALESCE(SUM(reports), 0) FROM external_unmatched WHERE source_id = $1 AND region_code = $2) AS unmatched_reports`,
			[load.source_id, load.region_code]
		);
		await c.query(
			`INSERT INTO external_load_diagnostics (load_id, code, detail, count)
			 SELECT load_id, code, detail, count FROM external_stage_diagnostics WHERE load_id = $1`,
			[load.id]
		);
		const diag = await c.query<{ code: string; notes: number; count: string }>(
			`SELECT code, COUNT(*)::int AS notes, SUM(count) AS count FROM external_load_diagnostics
			  WHERE load_id = $1 GROUP BY code ORDER BY code`,
			[load.id]
		);
		const result: LoadResult = {
			counts: Object.fromEntries(CHUNK_KINDS.map((k) => [k, manifest.counts[k] ?? 0])),
			places: manifest.places.length,
			species: Number(summary.rows[0].species),
			unmatched_taxa: Number(summary.rows[0].unmatched_taxa),
			unmatched_reports: Number(summary.rows[0].unmatched_reports),
			gaps,
			diagnostics: diag.rows.map((d) => ({ code: d.code, notes: d.notes, count: Number(d.count) })),
			window: { start: manifest.window_start, end: manifest.window_end }
		};
		await c.query(
			`UPDATE external_loads SET status = 'superseded', updated_at = now()
			  WHERE source_id = $1 AND region_code = $2 AND status = 'done' AND id <> $3`,
			[load.source_id, load.region_code, load.id]
		);
		await c.query(
			`UPDATE external_loads
			    SET status = 'done', result = $2::jsonb, window_start = $3, window_end = $4, retrieved_at = $5,
			        filter_fingerprint = $6, source_snapshot = $7::jsonb, lease_expires_at = NULL,
			        claim_idempotency_key = NULL, error = NULL, finished_at = now(), updated_at = now()
			  WHERE id = $1`,
			[
				load.id,
				JSON.stringify(result),
				manifest.window_start,
				manifest.window_end,
				manifest.retrieved_at,
				manifest.filter_fingerprint,
				JSON.stringify(manifest.source_snapshot)
			]
		);
		await clearStaging(c, [load.id]);
		return { status: 'done' as const, result };
	});
}

// ── Fail ───────────────────────────────────────────────────────────────────

export async function failLoad(
	connector: Connector,
	loadId: string,
	fence: Fence,
	reason: unknown,
	retryable: boolean
): Promise<{ status: 'done' | 'failed' | 'queued' }> {
	return withTransaction(async (c) => {
		const load = await lockLoad(c, connector, loadId);
		if (load.status === 'done' || load.status === 'superseded') return { status: 'done' as const };
		if (load.status === 'failed' && sameLease(load, fence)) return { status: 'failed' as const };
		if (load.status !== 'leased' && load.status !== 'staging') {
			throw new IngestError(409, 'not_leased', `The load is ${load.status}; it is not held by a lease.`);
		}
		// An expired lease may still be released by its own holder.
		if (!sameLease(load, fence)) throw new IngestError(409, 'fenced', 'The lease token or attempt does not match the live lease.');
		const text = sanitizeReason(reason) || 'The connector reported a failure without a reason.';
		const requeue = retryable && load.attempt < load.max_attempts;
		await c.query(
			`UPDATE external_loads
			    SET status = $2, error = $3, lease_expires_at = NULL, heartbeat_at = NULL, progress = NULL,
			        claim_idempotency_key = NULL,
			        lease_token = CASE WHEN $2 = 'queued' THEN NULL ELSE lease_token END,
			        not_before = now() + attempt * interval '${BACKOFF_MINUTES} minutes',
			        finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
			        updated_at = now()
			  WHERE id = $1`,
			[load.id, requeue ? 'queued' : 'failed', text]
		);
		await clearStaging(c, [load.id]);
		return { status: requeue ? ('queued' as const) : ('failed' as const) };
	});
}

// ── Sweeper ────────────────────────────────────────────────────────────────

/**
 * Expire overdue leases, then remove staging that no live lease holds and
 * that has had no chunk for STAGING_TTL_DAYS. Staging under a live lease is
 * never touched. `loadIds` scopes it (tests); the worker calls it unscoped.
 */
export async function sweepExternalStaging(loadIds?: readonly string[]): Promise<number> {
	return withTransaction(async (c) => {
		if (!loadIds) await expireLeases(c, null);
		const r = await c.query<{ load_id: string }>(
			`SELECT ch.load_id FROM external_load_chunks ch
			   JOIN external_loads l ON l.id = ch.load_id
			  WHERE NOT (l.status IN ('leased', 'staging') AND l.lease_expires_at > now())
			    AND ($1::uuid[] IS NULL OR ch.load_id = ANY($1::uuid[]))
			  GROUP BY ch.load_id
			 HAVING MAX(ch.received_at) < now() - interval '${STAGING_TTL_DAYS} days'`,
			[loadIds ? [...loadIds] : null]
		);
		const ids = r.rows.map((x) => x.load_id);
		await clearStaging(c, ids);
		return ids.length;
	});
}

/** Count rows of the published tables for a (source, region): tests and admin. */
export async function publishedCounts(sourceId: string, regionCode: string): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const table of PUBLISHED_DELETE_ORDER) {
		const r = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id = $1 AND region_code = $2`, [
			sourceId,
			regionCode
		]);
		out[table] = Number(r.rows[0].n);
	}
	return out;
}

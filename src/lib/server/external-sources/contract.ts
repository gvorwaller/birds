/**
 * Ingest contract v1 for external sightings sources (td-eec7db Phase 1).
 * Plan: docs/2026-10-21-external-sources-plan-CC.md → "Ingest contract v1".
 *
 * Pure validation: no database, no I/O. Every field a connector sends is
 * checked here before anything is written; unknown fields are rejected, and
 * every field is required unless the contract marks it `|null`.
 */
import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 1;
/** Request body cap for every ingest call, enforced before JSON parsing. */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_ROWS_PER_CHUNK = 5000;
/**
 * Caps for one whole load (every chunk of every kind). Since every report is
 * sent (td-769300): a real Nordland load sent 153,066 records at about 603
 * bytes each (2026-10-28), so Rogaland, the largest county (425,924 reports
 * in 24 months), needs about 265 MB; the byte cap leaves room for that.
 */
export const MAX_LOAD_ROWS = 1_000_000;
export const MAX_LOAD_BYTES = 1024 * 1024 * 1024;
const INT4_MAX = 2_147_483_647;

export const CHUNK_KINDS = ['places', 'totals', 'taxon_month', 'localities', 'recent', 'diagnostics', 'observers', 'taxa', 'records'] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export interface PlaceRow {
	place_key: string;
	name: string;
	level: 'region' | 'subregion';
	parent_key: string | null;
	lat: number | null;
	lon: number | null;
	/** The source's own id for the place (Artskart's municipality number), which survives renames. */
	upstream_place_id: string | null;
}
export interface TotalsRow {
	place_key: string;
	month: number;
	reports: number;
	unkeyed: number;
}
export interface TaxonMonthRow {
	place_key: string;
	month: number;
	upstream_taxon_id: string;
	canonical_name: string;
	raw_name: string;
	/** SUBSPECIES (Phase 2 rev B): an infraspecific name, matched through eBird's report_as. */
	rank: 'SPECIES' | 'SUBSPECIES';
	reports: number;
}
export interface LocalityRow {
	place_key: string;
	rank: number;
	locality: string;
	reports: number;
	lat: number | null;
	lon: number | null;
	uncertainty_m: number | null;
	placement: 'pin' | 'text';
}
export interface RecentRow {
	upstream_record_id: string;
	place_key: string;
	upstream_taxon_id: string;
	canonical_name: string;
	observed_on: string;
	count: number | null;
	locality: string;
	lat: number | null;
	lon: number | null;
	uncertainty_m: number | null;
	generalized: boolean;
	record_url: string;
	observer: string | null;
}
export interface DiagnosticRow {
	code: string;
	detail: string;
	count: number;
}
/**
 * The most active observers of a place (Phase 2 rev B, owner 2026-10-26).
 * Accepted only from a source with store_observers on. A "report" is one
 * species at one place on one day, so `days` leads the ranking.
 */
export interface ObserverRow {
	place_key: string;
	rank: number;
	observer: string;
	days: number;
	species: number;
	localities: number;
	reports: number;
}
/**
 * One upstream taxon (td-769300): its local name and Red List status.
 * Upserted into the source-wide external_taxa; OTHER is a genus, family or
 * hybrid report, which never gets a species code.
 */
export interface TaxonRow {
	upstream_taxon_id: string;
	canonical_name: string;
	raw_name: string;
	rank: 'SPECIES' | 'SUBSPECIES' | 'OTHER';
	local_name: string | null;
	red_list: string | null;
	red_list_url: string | null;
}
export interface RecordPhoto {
	url: string;
	by: string | null;
}
/** One report, every detail the source gives (td-769300). */
export interface RecordRow {
	upstream_record_id: string;
	place_key: string;
	upstream_taxon_id: string;
	canonical_name: string;
	observed_on: string;
	count: number | null;
	locality: string | null;
	lat: number | null;
	lon: number | null;
	uncertainty_m: number | null;
	/** Empty unless the source stores observer names. */
	observers: string[];
	behaviour: string[];
	activity: string | null;
	validation: string | null;
	notes: string | null;
	sex: string | null;
	photos: RecordPhoto[] | null;
	dataset: string | null;
	record_url: string | null;
	/** When the source last changed the report, as it states it (no zone). */
	upstream_modified_at: string | null;
}
export type RowsByKind = {
	places: PlaceRow;
	totals: TotalsRow;
	taxon_month: TaxonMonthRow;
	localities: LocalityRow;
	recent: RecentRow;
	diagnostics: DiagnosticRow;
	observers: ObserverRow;
	taxa: TaxonRow;
	records: RecordRow;
};

export interface ManifestChunk {
	chunk_id: string;
	kind: ChunkKind;
	rows: number;
	sha256: string;
}
export interface Manifest {
	window_start: string;
	window_end: string;
	retrieved_at: string;
	source_snapshot: Record<string, string | number | null>;
	filter_fingerprint: string;
	chunks: ManifestChunk[];
	counts: Partial<Record<ChunkKind, number>>;
	places: string[];
	months: number[];
}

/** A validation failure: becomes HTTP 422 (or 403 for `region`). */
export class ContractError extends Error {
	constructor(
		message: string,
		readonly code: 'invalid' | 'region' | 'observer' = 'invalid'
	) {
		super(message);
		this.name = 'ContractError';
	}
}

// ── Canonical JSON + digest ────────────────────────────────────────────────

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
		.join(',')}}`;
}

export function rowsDigest(rows: unknown[]): string {
	return createHash('sha256').update(canonicalJson(rows)).digest('hex');
}

// ── Field checks ───────────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u001f\u007f]/;
const UPSTREAM_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CHUNK_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REGION_CODE = /^[A-Z]{2}-[A-Z0-9]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[], where: string): void {
	for (const k of Object.keys(row)) {
		if (!keys.includes(k)) throw new ContractError(`${where}: unknown field "${k}"`);
	}
	for (const k of keys) {
		if (!(k in row)) throw new ContractError(`${where}: missing field "${k}"`);
	}
}

function text(v: unknown, where: string, max: number): string {
	if (typeof v !== 'string' || v.trim().length === 0 || v.length > max || CONTROL.test(v)) {
		throw new ContractError(`${where}: expected text of 1–${max} characters`);
	}
	return v;
}

function count(v: unknown, where: string): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > INT4_MAX) {
		throw new ContractError(`${where}: expected a whole number from 0 to ${INT4_MAX}`);
	}
	return v;
}

function intIn(v: unknown, where: string, min: number, max: number): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
		throw new ContractError(`${where}: expected a whole number from ${min} to ${max}`);
	}
	return v;
}

function upstreamId(v: unknown, where: string): string {
	if (typeof v !== 'string' || !UPSTREAM_ID.test(v)) {
		throw new ContractError(`${where}: expected an id of letters, digits and . _ : -`);
	}
	return v;
}

function coord(v: unknown, where: string, limit: number): number | null {
	if (v === null) return null;
	if (typeof v !== 'number' || !Number.isFinite(v) || v < -limit || v > limit) {
		throw new ContractError(`${where}: expected null or a number from -${limit} to ${limit}`);
	}
	return v;
}

function coords(row: Record<string, unknown>, where: string): { lat: number | null; lon: number | null } {
	const lat = coord(row.lat, `${where}.lat`, 90);
	const lon = coord(row.lon, `${where}.lon`, 180);
	if ((lat === null) !== (lon === null)) throw new ContractError(`${where}: lat and lon must both be set or both null`);
	return { lat, lon };
}

function uncertainty(v: unknown, where: string): number | null {
	return v === null ? null : count(v, where);
}

function optionalText(v: unknown, where: string, max: number): string | null {
	return v === null ? null : text(v, where, max);
}

function httpsUrl(v: unknown, where: string): string {
	const url = text(v, where, 500);
	if (!/^https:\/\/[^\s]+$/.test(url)) throw new ContractError(`${where}: expected an https link`);
	return url;
}

function textList(v: unknown, where: string, maxItems: number, check: (item: unknown, at: string) => string): string[] {
	if (!Array.isArray(v) || v.length > maxItems) throw new ContractError(`${where}: expected a list of at most ${maxItems}`);
	const out = v.map((item, i) => check(item, `${where}[${i}]`));
	if (new Set(out).size !== out.length) throw new ContractError(`${where}: an entry is listed twice`);
	return out;
}

const BEHAVIOUR = /^[a-z][a-z0-9_ -]{0,39}$/;
const RED_LIST = /^[A-Z]{2}$/;

function photos(v: unknown, where: string): RecordPhoto[] | null {
	if (v === null) return null;
	if (!Array.isArray(v) || v.length === 0 || v.length > 20) throw new ContractError(`${where}: expected null or 1–20 photos`);
	return v.map((p, i) => {
		const at = `${where}[${i}]`;
		if (!isRecord(p)) throw new ContractError(`${at}: expected an object`);
		exactKeys(p, ['url', 'by'], at);
		return { url: httpsUrl(p.url, `${at}.url`), by: optionalText(p.by, `${at}.by`, 200) };
	});
}

/** A local date-time with no zone (the source states none), at most microseconds. */
function localTimestamp(v: unknown, where: string): string | null {
	if (v === null) return null;
	const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/.exec(v) : null;
	if (!m || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) {
		throw new ContractError(`${where}: expected null or YYYY-MM-DDTHH:MM:SS[.ffffff] with no zone`);
	}
	isoDate(m[1], where);
	return v as string;
}

/**
 * A place key is the load's region code ("NO-18") or "<region>:<name>"
 * ("NO-18:Nesna"). A key under another region is a 403, not a 422: the
 * connector is writing outside the load it holds.
 */
export function placeKey(v: unknown, where: string, region: string): string {
	const key = text(v, where, 140);
	if (key !== region && !(key.startsWith(`${region}:`) && key.length > region.length + 1)) {
		throw new ContractError(`${where}: place "${key}" is not in region ${region}`, 'region');
	}
	const sub = key.slice(region.length + 1);
	if (sub && sub.trim() !== sub) throw new ContractError(`${where}: place name has surrounding spaces`);
	return key;
}

/** Years 1900 through next year (plan: CHECK constraints), so PostgreSQL never sees year 0. */
const MIN_YEAR = 1900;

function isoDate(v: unknown, where: string): string {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ContractError(`${where}: expected YYYY-MM-DD`);
	const d = new Date(`${v}T00:00:00Z`);
	if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
		throw new ContractError(`${where}: not a calendar date`);
	}
	const year = d.getUTCFullYear();
	const maxYear = new Date().getUTCFullYear() + 1;
	if (year < MIN_YEAR || year > maxYear) throw new ContractError(`${where}: the year must be ${MIN_YEAR}–${maxYear}`);
	return v;
}

// ── Rows ───────────────────────────────────────────────────────────────────

const KEYS: Record<ChunkKind, readonly string[]> = {
	places: ['place_key', 'name', 'level', 'parent_key', 'lat', 'lon', 'upstream_place_id'],
	totals: ['place_key', 'month', 'reports', 'unkeyed'],
	taxon_month: ['place_key', 'month', 'upstream_taxon_id', 'canonical_name', 'raw_name', 'rank', 'reports'],
	localities: ['place_key', 'rank', 'locality', 'reports', 'lat', 'lon', 'uncertainty_m', 'placement'],
	recent: [
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
	diagnostics: ['code', 'detail', 'count'],
	observers: ['place_key', 'rank', 'observer', 'days', 'species', 'localities', 'reports'],
	taxa: ['upstream_taxon_id', 'canonical_name', 'raw_name', 'rank', 'local_name', 'red_list', 'red_list_url'],
	records: [
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
	]
};

export interface RowContext {
	region: string;
	storeObservers: boolean;
}

export function validateRow<K extends ChunkKind>(kind: K, raw: unknown, i: number, ctx: RowContext): RowsByKind[K] {
	const where = `rows[${i}]`;
	if (!isRecord(raw)) throw new ContractError(`${where}: expected an object`);
	exactKeys(raw, KEYS[kind], where);
	switch (kind) {
		case 'places': {
			const key = placeKey(raw.place_key, `${where}.place_key`, ctx.region);
			const level = raw.level;
			if (level !== 'region' && level !== 'subregion') throw new ContractError(`${where}.level: expected region or subregion`);
			if ((level === 'region') !== (key === ctx.region)) {
				throw new ContractError(`${where}: only the place "${ctx.region}" is the region; every other place is a subregion`);
			}
			let parent: string | null = null;
			if (level === 'region') {
				if (raw.parent_key !== null) throw new ContractError(`${where}.parent_key: the region has no parent`);
			} else {
				if (raw.parent_key !== ctx.region) {
					throw new ContractError(`${where}.parent_key: a subregion's parent must be "${ctx.region}"`, 'region');
				}
				parent = ctx.region;
			}
			const row: PlaceRow = {
				place_key: key,
				name: text(raw.name, `${where}.name`, 120),
				level,
				parent_key: parent,
				...coords(raw, where),
				upstream_place_id: raw.upstream_place_id === null ? null : upstreamId(raw.upstream_place_id, `${where}.upstream_place_id`)
			};
			return row as RowsByKind[K];
		}
		case 'totals': {
			const reports = count(raw.reports, `${where}.reports`);
			const unkeyed = count(raw.unkeyed, `${where}.unkeyed`);
			if (unkeyed > reports) throw new ContractError(`${where}: unkeyed is larger than reports`);
			const row: TotalsRow = {
				place_key: placeKey(raw.place_key, `${where}.place_key`, ctx.region),
				month: intIn(raw.month, `${where}.month`, 1, 12),
				reports,
				unkeyed
			};
			return row as RowsByKind[K];
		}
		case 'taxon_month': {
			if (raw.rank !== 'SPECIES' && raw.rank !== 'SUBSPECIES') {
				throw new ContractError(`${where}.rank: only SPECIES and SUBSPECIES rows are accepted`);
			}
			const row: TaxonMonthRow = {
				place_key: placeKey(raw.place_key, `${where}.place_key`, ctx.region),
				month: intIn(raw.month, `${where}.month`, 1, 12),
				upstream_taxon_id: upstreamId(raw.upstream_taxon_id, `${where}.upstream_taxon_id`),
				canonical_name: text(raw.canonical_name, `${where}.canonical_name`, 200),
				raw_name: text(raw.raw_name, `${where}.raw_name`, 300),
				rank: raw.rank,
				reports: count(raw.reports, `${where}.reports`)
			};
			return row as RowsByKind[K];
		}
		case 'localities': {
			const placement = raw.placement;
			if (placement !== 'pin' && placement !== 'text') throw new ContractError(`${where}.placement: expected pin or text`);
			const c = coords(raw, where);
			if (placement === 'pin' && c.lat === null) throw new ContractError(`${where}: a pin needs coordinates`);
			const row: LocalityRow = {
				place_key: placeKey(raw.place_key, `${where}.place_key`, ctx.region),
				rank: intIn(raw.rank, `${where}.rank`, 1, 1000),
				locality: text(raw.locality, `${where}.locality`, 300),
				reports: count(raw.reports, `${where}.reports`),
				...c,
				uncertainty_m: uncertainty(raw.uncertainty_m, `${where}.uncertainty_m`),
				placement
			};
			return row as RowsByKind[K];
		}
		case 'recent': {
			if (typeof raw.generalized !== 'boolean') throw new ContractError(`${where}.generalized: expected true or false`);
			const url = text(raw.record_url, `${where}.record_url`, 500);
			if (!/^https:\/\/[^\s]+$/.test(url)) throw new ContractError(`${where}.record_url: expected an https link`);
			if (raw.observer !== null) {
				if (!ctx.storeObservers) {
					throw new ContractError(`${where}.observer: this source does not store observer names`, 'observer');
				}
				text(raw.observer, `${where}.observer`, 200);
			}
			const row: RecentRow = {
				upstream_record_id: upstreamId(raw.upstream_record_id, `${where}.upstream_record_id`),
				place_key: placeKey(raw.place_key, `${where}.place_key`, ctx.region),
				upstream_taxon_id: upstreamId(raw.upstream_taxon_id, `${where}.upstream_taxon_id`),
				canonical_name: text(raw.canonical_name, `${where}.canonical_name`, 200),
				observed_on: isoDate(raw.observed_on, `${where}.observed_on`),
				count: raw.count === null ? null : count(raw.count, `${where}.count`),
				locality: text(raw.locality, `${where}.locality`, 300),
				...coords(raw, where),
				uncertainty_m: uncertainty(raw.uncertainty_m, `${where}.uncertainty_m`),
				generalized: raw.generalized,
				record_url: url,
				observer: raw.observer as string | null
			};
			return row as RowsByKind[K];
		}
		case 'diagnostics': {
			if (typeof raw.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.code)) {
				throw new ContractError(`${where}.code: expected a lower_snake_case code`);
			}
			if (typeof raw.detail !== 'string' || raw.detail.length > 300 || CONTROL.test(raw.detail)) {
				throw new ContractError(`${where}.detail: expected text of up to 300 characters`);
			}
			const row: DiagnosticRow = { code: raw.code, detail: raw.detail, count: count(raw.count, `${where}.count`) };
			return row as RowsByKind[K];
		}
		case 'observers': {
			if (!ctx.storeObservers) {
				throw new ContractError(`${where}: this source does not store observer names`, 'observer');
			}
			const reports = count(raw.reports, `${where}.reports`);
			const days = count(raw.days, `${where}.days`);
			const species = count(raw.species, `${where}.species`);
			const localities = count(raw.localities, `${where}.localities`);
			if (reports < 1 || days < 1) throw new ContractError(`${where}: an observer has at least one report on one day`);
			if (days > reports || species > reports || localities > reports) {
				throw new ContractError(`${where}: days, species and localities can't exceed reports`);
			}
			const row: ObserverRow = {
				place_key: placeKey(raw.place_key, `${where}.place_key`, ctx.region),
				rank: intIn(raw.rank, `${where}.rank`, 1, 1000),
				observer: text(raw.observer, `${where}.observer`, 200),
				days,
				species,
				localities,
				reports
			};
			return row as RowsByKind[K];
		}
		case 'taxa': {
			const rank = raw.rank;
			if (rank !== 'SPECIES' && rank !== 'SUBSPECIES' && rank !== 'OTHER') {
				throw new ContractError(`${where}.rank: expected SPECIES, SUBSPECIES or OTHER`);
			}
			if (raw.red_list !== null && (typeof raw.red_list !== 'string' || !RED_LIST.test(raw.red_list))) {
				throw new ContractError(`${where}.red_list: expected null or a two-letter category`);
			}
			const row: TaxonRow = {
				upstream_taxon_id: upstreamId(raw.upstream_taxon_id, `${where}.upstream_taxon_id`),
				canonical_name: text(raw.canonical_name, `${where}.canonical_name`, 200),
				raw_name: text(raw.raw_name, `${where}.raw_name`, 300),
				rank,
				local_name: optionalText(raw.local_name, `${where}.local_name`, 200),
				red_list: raw.red_list as string | null,
				red_list_url: raw.red_list_url === null ? null : httpsUrl(raw.red_list_url, `${where}.red_list_url`)
			};
			return row as RowsByKind[K];
		}
		case 'records': {
			const observers = textList(raw.observers, `${where}.observers`, 50, (o, at) => text(o, at, 200));
			if (observers.length > 0 && !ctx.storeObservers) {
				throw new ContractError(`${where}.observers: this source does not store observer names`, 'observer');
			}
			const photoList = photos(raw.photos, `${where}.photos`);
			// A photo credit names a person too (CODEX1 td-769300 F2).
			if (!ctx.storeObservers && photoList?.some((p) => p.by !== null)) {
				throw new ContractError(`${where}.photos: this source does not store observer names, so photos carry no credit`, 'observer');
			}
			if (raw.notes !== null && (typeof raw.notes !== 'string' || raw.notes.length > 500 || CONTROL.test(raw.notes))) {
				throw new ContractError(`${where}.notes: expected null or text of up to 500 characters`);
			}
			const row: RecordRow = {
				upstream_record_id: upstreamId(raw.upstream_record_id, `${where}.upstream_record_id`),
				place_key: placeKey(raw.place_key, `${where}.place_key`, ctx.region),
				upstream_taxon_id: upstreamId(raw.upstream_taxon_id, `${where}.upstream_taxon_id`),
				canonical_name: text(raw.canonical_name, `${where}.canonical_name`, 200),
				observed_on: isoDate(raw.observed_on, `${where}.observed_on`),
				count: raw.count === null ? null : count(raw.count, `${where}.count`),
				locality: optionalText(raw.locality, `${where}.locality`, 300),
				...coords(raw, where),
				uncertainty_m: uncertainty(raw.uncertainty_m, `${where}.uncertainty_m`),
				observers,
				behaviour: textList(raw.behaviour, `${where}.behaviour`, 10, (b, at) => {
					if (typeof b !== 'string' || !BEHAVIOUR.test(b)) throw new ContractError(`${at}: expected a short lower-case word`);
					return b;
				}),
				activity: optionalText(raw.activity, `${where}.activity`, 100),
				validation: optionalText(raw.validation, `${where}.validation`, 100),
				notes: raw.notes as string | null,
				sex: optionalText(raw.sex, `${where}.sex`, 50),
				photos: photoList,
				dataset: optionalText(raw.dataset, `${where}.dataset`, 200),
				record_url: raw.record_url === null ? null : httpsUrl(raw.record_url, `${where}.record_url`),
				upstream_modified_at: localTimestamp(raw.upstream_modified_at, `${where}.upstream_modified_at`)
			};
			return row as RowsByKind[K];
		}
	}
	throw new ContractError(`unknown kind`);
}

// ── Request bodies ─────────────────────────────────────────────────────────

export interface Fence {
	lease_token: string;
	attempt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(v: unknown): v is string {
	return typeof v === 'string' && UUID.test(v);
}

/** The fields every load-scoped body carries; `extra` names the call's own fields. */
export function parseFenced(body: unknown, extra: readonly string[]): { fence: Fence; body: Record<string, unknown> } {
	if (!isRecord(body)) throw new ContractError('body: expected a JSON object');
	exactKeys(body, ['contract_version', 'lease_token', 'attempt', ...extra], 'body');
	if (body.contract_version !== CONTRACT_VERSION) {
		throw new ContractError(`body.contract_version: this server speaks contract ${CONTRACT_VERSION}`);
	}
	if (!isUuid(body.lease_token)) throw new ContractError('body.lease_token: expected a lease token');
	return { fence: { lease_token: body.lease_token, attempt: intIn(body.attempt, 'body.attempt', 1, 10) }, body };
}

export function parseClaim(body: unknown): { idempotency_key: string } {
	if (!isRecord(body)) throw new ContractError('body: expected a JSON object');
	exactKeys(body, ['contract_version', 'idempotency_key'], 'body');
	if (body.contract_version !== CONTRACT_VERSION) {
		throw new ContractError(`body.contract_version: this server speaks contract ${CONTRACT_VERSION}`);
	}
	const key = body.idempotency_key;
	if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
		throw new ContractError('body.idempotency_key: expected 8–100 letters, digits or . _ : -');
	}
	return { idempotency_key: key };
}

export interface Progress {
	phase: string;
	done: number;
	total: number;
}

export function parseProgress(v: unknown): Progress {
	if (!isRecord(v)) throw new ContractError('body.progress: expected an object');
	exactKeys(v, ['phase', 'done', 'total'], 'body.progress');
	if (typeof v.phase !== 'string' || !/^[a-z][a-z0-9_ -]{0,39}$/.test(v.phase)) {
		throw new ContractError('body.progress.phase: expected a short lower-case phase name');
	}
	const done = count(v.done, 'body.progress.done');
	const total = count(v.total, 'body.progress.total');
	if (done > total) throw new ContractError('body.progress: done is larger than total');
	return { phase: v.phase, done, total };
}

export interface ChunkBody {
	chunk_id: string;
	kind: ChunkKind;
	sha256: string;
	rows: unknown[];
}

export function parseChunkEnvelope(body: Record<string, unknown>): ChunkBody {
	if (typeof body.chunk_id !== 'string' || !CHUNK_ID.test(body.chunk_id)) {
		throw new ContractError('body.chunk_id: expected 1–64 letters, digits or . _ : -');
	}
	if (!CHUNK_KINDS.includes(body.kind as ChunkKind)) throw new ContractError(`body.kind: expected one of ${CHUNK_KINDS.join(', ')}`);
	if (typeof body.sha256 !== 'string' || !HEX64.test(body.sha256)) throw new ContractError('body.sha256: expected 64 hex digits');
	if (!Array.isArray(body.rows)) throw new ContractError('body.rows: expected an array');
	if (body.rows.length > MAX_ROWS_PER_CHUNK) throw new ContractError(`body.rows: at most ${MAX_ROWS_PER_CHUNK} rows per chunk`);
	return { chunk_id: body.chunk_id, kind: body.kind as ChunkKind, sha256: body.sha256, rows: body.rows };
}

/**
 * Validate a chunk's rows: digest first (a corrupted body is never
 * half-read), then every row, then duplicates inside the chunk.
 */
export function validateChunkRows<K extends ChunkKind>(kind: K, rows: unknown[], sha256: string, ctx: RowContext): RowsByKind[K][] {
	if (rowsDigest(rows) !== sha256) throw new ContractError('body.sha256: does not match the rows sent');
	const out = rows.map((r, i) => validateRow(kind, r, i, ctx));
	const seen = new Set<string>();
	for (let i = 0; i < out.length; i++) {
		const key = rowIdentity(kind, out[i]);
		if (seen.has(key)) throw new ContractError(`rows[${i}]: duplicate of an earlier row in this chunk`);
		seen.add(key);
	}
	return out;
}

/** The staging primary key of a row (minus load_id). */
export function rowIdentity(kind: ChunkKind, row: RowsByKind[ChunkKind]): string {
	const r = row as unknown as Record<string, unknown>;
	switch (kind) {
		case 'places':
			return String(r.place_key);
		case 'totals':
			return `${r.place_key}\u0000${r.month}`;
		case 'taxon_month':
			return `${r.place_key}\u0000${r.upstream_taxon_id}\u0000${r.month}`;
		case 'localities':
			return `${r.place_key}\u0000${r.rank}`;
		case 'recent':
			return String(r.upstream_record_id);
		case 'diagnostics':
			return `${r.code}\u0000${r.detail}`;
		case 'observers':
			return `${r.place_key}\u0000${r.rank}`;
		case 'taxa':
			return `${r.upstream_taxon_id}\u0000${r.canonical_name}`;
		case 'records':
			return String(r.upstream_record_id);
	}
}

// ── Manifest ───────────────────────────────────────────────────────────────

function monthsBetween(startIso: string, endIso: string): number {
	const s = new Date(`${startIso}T00:00:00Z`);
	const e = new Date(`${endIso}T00:00:00Z`);
	return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
}

/** The last day of the month `back` months before `at`'s month (UTC), as YYYY-MM-DD. */
export function monthEndBefore(at: Date, back: number): string {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - back + 1, 0)).toISOString().slice(0, 10);
}

/**
 * The window ends allowed for a load created at `createdAt` (rev 4 rule: the
 * latest complete months, frozen when the load is created). The window ends
 * with the last complete month the source's latest good copy covers, which
 * only the connector can see; GBIF re-copies weekly, so early in a month that
 * can still be the month before last. Either end is fixed by the load's
 * creation date and never drifts on a retry.
 */
export function allowedWindowEnds(createdAt: Date): string[] {
	return [monthEndBefore(createdAt, 1), monthEndBefore(createdAt, 2)];
}

/** The first day of the window that ends on `windowEnd` and spans `months` whole months. */
export function windowStartFor(windowEnd: string, months: number): string {
	const end = new Date(`${windowEnd}T00:00:00Z`);
	return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months + 1, 1)).toISOString().slice(0, 10);
}

/**
 * Checks the manifest's own shape and the window rule. Comparing it with the
 * chunks actually received is the lifecycle's job (it needs the database).
 */
export function parseManifest(
	v: unknown,
	opts: { windowMonths: number; region: string; now: Date; allowedEnds: string[] }
): Manifest {
	if (!isRecord(v)) throw new ContractError('manifest: expected an object');
	exactKeys(
		v,
		['window_start', 'window_end', 'retrieved_at', 'source_snapshot', 'filter_fingerprint', 'chunks', 'counts', 'places', 'months'],
		'manifest'
	);
	const windowStart = isoDate(v.window_start, 'manifest.window_start');
	const windowEnd = isoDate(v.window_end, 'manifest.window_end');
	if (!windowStart.endsWith('-01')) throw new ContractError('manifest.window_start: must be the first day of a month');
	const next = new Date(`${windowEnd}T00:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	if (next.getUTCDate() !== 1) throw new ContractError('manifest.window_end: must be the last day of a month');
	if (windowEnd >= opts.now.toISOString().slice(0, 10)) {
		throw new ContractError('manifest.window_end: the window must end before today');
	}
	if (!opts.allowedEnds.includes(windowEnd)) {
		throw new ContractError(
			`manifest.window_end: this load's window must end ${opts.allowedEnds.join(' or ')} (the latest complete months when it was queued)`
		);
	}
	const span = monthsBetween(windowStart, windowEnd);
	if (span !== opts.windowMonths) {
		throw new ContractError(`manifest: the window spans ${span} months; this source's window is ${opts.windowMonths}`);
	}

	if (typeof v.retrieved_at !== 'string') throw new ContractError('manifest.retrieved_at: expected an ISO timestamp');
	const retrieved = new Date(v.retrieved_at);
	if (!Number.isFinite(retrieved.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(v.retrieved_at)) {
		throw new ContractError('manifest.retrieved_at: expected an ISO timestamp');
	}
	if (retrieved.getTime() > opts.now.getTime() + 5 * 60_000) throw new ContractError('manifest.retrieved_at: is in the future');

	if (!isRecord(v.source_snapshot)) throw new ContractError('manifest.source_snapshot: expected an object');
	const snapKeys = Object.keys(v.source_snapshot);
	if (snapKeys.length > 10) throw new ContractError('manifest.source_snapshot: at most 10 fields');
	for (const k of snapKeys) {
		const sv = v.source_snapshot[k];
		if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(k)) throw new ContractError(`manifest.source_snapshot: bad field name "${k}"`);
		const ok =
			sv === null ||
			(typeof sv === 'number' && Number.isFinite(sv)) ||
			(typeof sv === 'string' && sv.length <= 200 && !CONTROL.test(sv));
		if (!ok) throw new ContractError(`manifest.source_snapshot.${k}: expected short text, a number or null`);
	}

	if (typeof v.filter_fingerprint !== 'string' || !HEX64.test(v.filter_fingerprint)) {
		throw new ContractError('manifest.filter_fingerprint: expected 64 hex digits');
	}

	if (!Array.isArray(v.chunks)) throw new ContractError('manifest.chunks: expected an array');
	const chunkIds = new Set<string>();
	const chunks: ManifestChunk[] = v.chunks.map((c, i) => {
		const where = `manifest.chunks[${i}]`;
		if (!isRecord(c)) throw new ContractError(`${where}: expected an object`);
		exactKeys(c, ['chunk_id', 'kind', 'rows', 'sha256'], where);
		if (typeof c.chunk_id !== 'string' || !CHUNK_ID.test(c.chunk_id)) throw new ContractError(`${where}.chunk_id: bad id`);
		if (chunkIds.has(c.chunk_id)) throw new ContractError(`${where}.chunk_id: listed twice`);
		chunkIds.add(c.chunk_id);
		if (!CHUNK_KINDS.includes(c.kind as ChunkKind)) throw new ContractError(`${where}.kind: unknown kind`);
		if (typeof c.sha256 !== 'string' || !HEX64.test(c.sha256)) throw new ContractError(`${where}.sha256: expected 64 hex digits`);
		return { chunk_id: c.chunk_id, kind: c.kind as ChunkKind, rows: count(c.rows, `${where}.rows`), sha256: c.sha256 };
	});

	if (!isRecord(v.counts)) throw new ContractError('manifest.counts: expected an object');
	const counts: Partial<Record<ChunkKind, number>> = {};
	for (const k of Object.keys(v.counts)) {
		if (!CHUNK_KINDS.includes(k as ChunkKind)) throw new ContractError(`manifest.counts: unknown kind "${k}"`);
		counts[k as ChunkKind] = count(v.counts[k], `manifest.counts.${k}`);
	}

	if (!Array.isArray(v.places) || v.places.length === 0) throw new ContractError('manifest.places: expected a list of place keys');
	const places = v.places.map((p, i) => placeKey(p, `manifest.places[${i}]`, opts.region));
	if (new Set(places).size !== places.length) throw new ContractError('manifest.places: a place is listed twice');
	if (!places.includes(opts.region)) throw new ContractError(`manifest.places: must include the region "${opts.region}"`);

	if (!Array.isArray(v.months)) throw new ContractError('manifest.months: expected the months 1–12');
	const months = v.months.map((m, i) => intIn(m, `manifest.months[${i}]`, 1, 12));
	if (months.length !== 12 || new Set(months).size !== 12) {
		throw new ContractError('manifest.months: every month 1–12 must be listed exactly once, empty months included');
	}

	return {
		window_start: windowStart,
		window_end: windowEnd,
		retrieved_at: retrieved.toISOString(),
		source_snapshot: v.source_snapshot as Record<string, string | number | null>,
		filter_fingerprint: v.filter_fingerprint,
		chunks,
		counts,
		places,
		months
	};
}

/** Strip anything that could carry a secret or break a log line. */
export function sanitizeReason(v: unknown): string {
	const s = typeof v === 'string' ? v : '';
	return s
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/\bext_[A-Za-z0-9_-]+/g, '[redacted]')
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.trim()
		.slice(0, 300);
}

export function isRegionCode(v: unknown): v is string {
	return typeof v === 'string' && REGION_CODE.test(v);
}

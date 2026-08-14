/**
 * eBird bar-chart (frequency) data pipeline — td-854207.
 *
 * Fetches ebird.org/barchartData TSV (multi-year weekly frequency for ALL
 * species at a region or hotspot) through the user's credentialed web session,
 * parses + validates it, and persists normalized sparse rows into
 * frequency_fetch / species_frequency (migration 0011).
 *
 * This is an UNOFFICIAL interface (same CAS-login family as life-list sync in
 * ebird-account.ts) — per cs.md it must fail soft: parse/validation failures
 * record an error attempt and NEVER replace previously stored good data;
 * callers surface stale data with a visible indicator.
 *
 * Politeness rules (plan 2026-08-06, CODEX1 review): fetching happens only in
 * owner-triggered form actions, sequentially (concurrency 1) with >=500 ms
 * start-to-start spacing, at most FETCH_BATCH_MAX per invocation, under a
 * per-owner single-flight lease, with a soft daily ceiling. An authentication
 * failure aborts the whole batch immediately.
 */
import { query, withTransaction } from '$lib/db';
import { buildMatcher } from '$server/species-match';
import {
	EbirdLoginError,
	EbirdUpstreamError,
	fetchAuthenticatedEbird
} from '$server/ebird-account';

export const WEEKS = 48; // 4 pseudo-weeks x 12 months
export const YEARS_BACK = 10; // begin_year = lastCompleteYear - YEARS_BACK + 1
export const FETCH_BATCH_MAX = 12;
export const FETCH_SPACING_MS = 500;
export const DAILY_FETCH_CAP = 200;
/** Sanity gate: a refetch keeping under this fraction of prior species count is rejected. */
const MIN_SPECIES_RETENTION = 0.25;
const UNMATCHED_SAMPLE_LIMIT = 20;

export class BarchartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BarchartError';
	}
}

/**
 * The response was a login page rather than data — an AUTHENTICATION symptom,
 * even at HTTP 200. Aborts the whole batch like EbirdLoginError (CODEX8 #2).
 */
export class BarchartAuthError extends BarchartError {
	constructor(message: string) {
		super(message);
		this.name = 'BarchartAuthError';
	}
}

export interface ParsedBarchart {
	/** 48 weekly checklist counts (the frequency denominators). */
	sampleSizes: number[];
	rows: { name: string; freqs: number[] }[];
}

export interface MatchedBarchart {
	/** species_code → 48 weekly frequencies. */
	bySpecies: Map<string, number[]>;
	unmatched: string[];
	/** Source rows that collapsed onto an already-matched code (lumps/splits). */
	collisions: number;
}

export interface FrequencyMeta {
	locCode: string;
	locKind: 'region' | 'hotspot';
	locName: string;
	beginYear: number;
	endYear: number;
	sampleSizes: number[];
	nSpecies: number;
	nUnmatched: number;
	unmatchedNames: string[];
	fetchedAt: Date;
}

export interface AttemptMeta {
	locCode: string;
	lastAttemptAt: Date;
	status: 'ok' | 'error';
	error: string | null;
}

export interface EnsureResult {
	/** Locs already stored and current (no fetch needed). */
	ready: string[];
	/** Locs fetched and stored during this invocation. */
	refreshed: string[];
	failed: { code: string; error: string }[];
	/** Locs needing a fetch that this invocation did not attempt (cap or abort). */
	notAttempted: string[];
	/** Human message when the CAS session/credentials blocked the batch. */
	credentialProblem: string | null;
	/** True when another batch for this owner was already running. */
	busy: boolean;
}

/** The last complete calendar year — the newest year we ever request. */
export function lastCompleteYear(now = new Date()): number {
	const y = Number(
		new Intl.DateTimeFormat('en-US', {
			timeZone: 'America/New_York',
			year: 'numeric'
		}).format(now)
	);
	return (Number.isInteger(y) ? y : now.getUTCFullYear()) - 1;
}

export function barchartUrl(locCode: string, beginYear: number, endYear: number): string {
	const r = encodeURIComponent(locCode);
	return `https://ebird.org/barchartData?r=${r}&bmo=1&emo=12&byr=${beginYear}&eyr=${endYear}&fmt=tsv`;
}

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

function stripTags(s: string): string {
	return s.replace(/<[^>]*>/g, '').trim();
}

/**
 * Split a TSV line and drop trailing empty fields (the export ends each row
 * with a trailing tab). Interior empty cells are preserved (they mean 0).
 */
function tsvFields(line: string): string[] {
	const fields = line.split('\t');
	while (fields.length > 0 && fields[fields.length - 1].trim() === '') fields.pop();
	return fields;
}

function parseNumberCell(raw: string, context: string): number {
	const s = raw.trim();
	if (s === '') return 0;
	const n = Number(s);
	if (!Number.isFinite(n)) {
		throw new BarchartError(`Barchart TSV has a non-numeric value ("${s}") in ${context}.`);
	}
	return n;
}

/**
 * Parse the raw barchartData TSV. Pure; throws BarchartError on anything that
 * does not look like the known export shape, so structure drift fails loudly
 * instead of storing garbage.
 */
export function parseBarchartTsv(tsv: string): ParsedBarchart {
	const head = tsv.slice(0, 500).toLowerCase();
	if (head.includes('<!doctype') || head.includes('<html')) {
		throw new BarchartAuthError(
			'eBird returned a web page instead of bar-chart data — the session was not authenticated.'
		);
	}

	const lines = tsv.split(/\r?\n/);
	let sampleSizes: number[] | null = null;
	const rows: ParsedBarchart['rows'] = [];

	for (const line of lines) {
		if (line.trim() === '') continue;
		const fields = tsvFields(line);
		if (fields.length === 0) continue;
		const label = stripTags(fields[0]);

		if (/^sample size/i.test(label)) {
			const values = fields.slice(1).map((v, i) => parseNumberCell(v, `sample size week ${i + 1}`));
			if (values.length !== WEEKS) {
				throw new BarchartError(
					`Barchart sample-size row has ${values.length} weeks (expected ${WEEKS}) — eBird may have changed the export.`
				);
			}
			if (values.some((v) => v < 0)) {
				throw new BarchartError('Barchart sample-size row contains a negative checklist count.');
			}
			// Counts arrive as "88523.0" — integer-valued floats. A genuinely
			// fractional count means the export changed meaning; reject rather
			// than silently rounding every downstream weight (CODEX8 #5).
			if (values.some((v) => !Number.isInteger(v))) {
				throw new BarchartError(
					'Barchart sample-size row contains a non-integer checklist count — eBird may have changed the export.'
				);
			}
			sampleSizes = values;
			continue;
		}

		// Preamble lines (titles, month header, "Number of taxa:\t955") have no
		// name or no 48-value body; a species row is: name + exactly 48 numeric
		// cells. Single-value labeled metadata is legitimate preamble, so only a
		// numeric row with 2+ values at the wrong width counts as format drift
		// (the post-parse sanity gate still catches wholesale truncation).
		if (label === '' || fields.length === 1) continue;
		const values = fields.slice(1);
		if (values.length !== WEEKS) {
			const numericish = values.every((v) => v.trim() === '' || Number.isFinite(Number(v)));
			if (numericish && values.length >= 2) {
				throw new BarchartError(
					`Barchart row for "${label}" has ${values.length} weeks (expected ${WEEKS}) — eBird may have changed the export.`
				);
			}
			continue;
		}
		const numeric = values.every((v) => v.trim() === '' || Number.isFinite(Number(v)));
		if (!numeric) continue; // header-ish line that happens to have 48 cells
		rows.push({
			name: label,
			freqs: values.map((v, i) => parseNumberCell(v, `"${label}" week ${i + 1}`))
		});
	}

	if (!sampleSizes) {
		throw new BarchartError(
			'Barchart TSV is missing the "Sample Size:" row — eBird may have changed the export.'
		);
	}
	return { sampleSizes, rows };
}

/**
 * Map parsed rows to species codes via the taxonomy matcher (override → common
 * → scientific; species category only, so spuhs/slashes/hybrids fall out as
 * unmatched). When two source rows land on one code (lumps), keep the per-week
 * max. Pure given a matcher.
 */
export function matchBarchartRows(
	parsed: ParsedBarchart,
	matcher: { match(comName: string): { code: string } | null }
): MatchedBarchart {
	const bySpecies = new Map<string, number[]>();
	const unmatched: string[] = [];
	let collisions = 0;

	for (const row of parsed.rows) {
		const m = matcher.match(row.name);
		if (!m) {
			unmatched.push(row.name);
			continue;
		}
		const existing = bySpecies.get(m.code);
		if (existing) {
			collisions++;
			for (let i = 0; i < WEEKS; i++) existing[i] = Math.max(existing[i], row.freqs[i]);
		} else {
			bySpecies.set(m.code, [...row.freqs]);
		}
	}
	return { bySpecies, unmatched, collisions };
}

/**
 * Sanity gate before any write. A syntactically valid but degenerate export
 * (zero matched species, out-of-range frequencies, drastic row collapse vs the
 * previously stored fetch) must never replace good cached data.
 */
export function validateMatchedBarchart(
	parsed: ParsedBarchart,
	matched: MatchedBarchart,
	priorNSpecies: number | null
): void {
	if (parsed.sampleSizes.length !== WEEKS) {
		throw new BarchartError(`Expected ${WEEKS} sample sizes, got ${parsed.sampleSizes.length}.`);
	}
	if (parsed.sampleSizes.every((n) => n === 0)) {
		throw new BarchartError('Barchart has zero checklists in every week — nothing to store.');
	}
	if (matched.bySpecies.size === 0) {
		throw new BarchartError(
			'No barchart rows matched the taxonomy — is the taxonomy synced? Refusing to store an empty dataset.'
		);
	}
	for (const [code, freqs] of matched.bySpecies) {
		for (const f of freqs) {
			if (!Number.isFinite(f) || f < 0 || f > 1) {
				throw new BarchartError(`Out-of-range frequency ${f} for ${code} — refusing to store.`);
			}
		}
	}
	if (
		priorNSpecies != null &&
		priorNSpecies > 0 &&
		matched.bySpecies.size < priorNSpecies * MIN_SPECIES_RETENTION
	) {
		throw new BarchartError(
			`Barchart returned ${matched.bySpecies.size} species where ${priorNSpecies} were previously stored — implausible collapse, keeping the existing data.`
		);
	}
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface StoreParams {
	locCode: string;
	locKind: 'region' | 'hotspot';
	locName: string;
	beginYear: number;
	endYear: number;
	/** State this location belongs to (e.g. 'US-ME'); groups /forecast/data. */
	regionCode?: string | null;
	parsed: ParsedBarchart;
	matched: MatchedBarchart;
}

/** Atomic replace of one location's frequency data (+ 'ok' attempt record). */
export async function storeFrequencies(p: StoreParams): Promise<void> {
	await withTransaction(async (client) => {
		await client.query(
			`INSERT INTO frequency_fetch
			   (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes,
			    n_species, n_unmatched, unmatched_names, region_code, fetched_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
			 ON CONFLICT (loc_code) DO UPDATE SET
			   loc_kind = EXCLUDED.loc_kind, loc_name = EXCLUDED.loc_name,
			   begin_year = EXCLUDED.begin_year, end_year = EXCLUDED.end_year,
			   sample_sizes = EXCLUDED.sample_sizes, n_species = EXCLUDED.n_species,
			   n_unmatched = EXCLUDED.n_unmatched, unmatched_names = EXCLUDED.unmatched_names,
			   region_code = COALESCE(EXCLUDED.region_code, frequency_fetch.region_code),
			   fetched_at = NOW()`,
			[
				p.locCode,
				p.locKind,
				p.locName,
				p.beginYear,
				p.endYear,
				p.parsed.sampleSizes,
				p.matched.bySpecies.size,
				p.matched.unmatched.length,
				p.matched.unmatched.slice(0, UNMATCHED_SAMPLE_LIMIT),
				p.regionCode ?? null
			]
		);
		await client.query('DELETE FROM species_frequency WHERE loc_code = $1', [p.locCode]);

		// Sparse: only weeks with freq > 0.
		const rows: { code: string; week: number; freq: number }[] = [];
		for (const [code, freqs] of p.matched.bySpecies) {
			for (let w = 0; w < WEEKS; w++) {
				if (freqs[w] > 0) rows.push({ code, week: w + 1, freq: freqs[w] });
			}
		}
		const BATCH = 500;
		for (let i = 0; i < rows.length; i += BATCH) {
			const slice = rows.slice(i, i + BATCH);
			const values: string[] = [];
			const params: unknown[] = [];
			slice.forEach((r, j) => {
				const o = j * 4;
				values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
				params.push(p.locCode, r.code, r.week, r.freq);
			});
			await client.query(
				`INSERT INTO species_frequency (loc_code, species_code, week, freq)
				 VALUES ${values.join(',')}`,
				params
			);
		}

		await client.query(
			`INSERT INTO frequency_fetch_attempts (loc_code, last_attempt_at, status, error)
			 VALUES ($1, NOW(), 'ok', NULL)
			 ON CONFLICT (loc_code) DO UPDATE SET last_attempt_at = NOW(), status = 'ok', error = NULL`,
			[p.locCode]
		);
	});
}

async function recordFailedAttempt(loc: LocToEnsure, message: string): Promise<void> {
	await query(
		`INSERT INTO frequency_fetch_attempts (loc_code, last_attempt_at, status, error, loc_kind, loc_name, region_code)
		 VALUES ($1, NOW(), 'error', $2, $3, $4, $5)
		 ON CONFLICT (loc_code) DO UPDATE SET last_attempt_at = NOW(), status = 'error', error = $2,
		   loc_kind = $3, loc_name = $4, region_code = $5`,
		[loc.code, message, loc.kind, loc.name, loc.regionCode ?? null]
	);
}

/** Stored fetch metadata for a set of locations (loaders read this, never fetch). */
export async function frequencyMeta(locCodes: string[]): Promise<Map<string, FrequencyMeta>> {
	if (locCodes.length === 0) return new Map();
	const r = await query<{
		loc_code: string;
		loc_kind: 'region' | 'hotspot';
		loc_name: string;
		begin_year: number;
		end_year: number;
		sample_sizes: number[];
		n_species: number;
		n_unmatched: number;
		unmatched_names: string[];
		fetched_at: string;
	}>(
		`SELECT loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes,
		        n_species, n_unmatched, unmatched_names, fetched_at
		   FROM frequency_fetch WHERE loc_code = ANY($1)`,
		[locCodes]
	);
	const map = new Map<string, FrequencyMeta>();
	for (const row of r.rows) {
		map.set(row.loc_code, {
			locCode: row.loc_code,
			locKind: row.loc_kind,
			locName: row.loc_name,
			beginYear: Number(row.begin_year),
			endYear: Number(row.end_year),
			sampleSizes: row.sample_sizes.map(Number),
			nSpecies: Number(row.n_species),
			nUnmatched: Number(row.n_unmatched),
			unmatchedNames: row.unmatched_names,
			fetchedAt: new Date(row.fetched_at)
		});
	}
	return map;
}

/** Attempt bookkeeping for a set of locations (failure visibility across reloads). */
export async function attemptMeta(locCodes: string[]): Promise<Map<string, AttemptMeta>> {
	if (locCodes.length === 0) return new Map();
	const r = await query<{
		loc_code: string;
		last_attempt_at: string;
		status: 'ok' | 'error';
		error: string | null;
	}>(
		`SELECT loc_code, last_attempt_at, status, error
		   FROM frequency_fetch_attempts WHERE loc_code = ANY($1)`,
		[locCodes]
	);
	const map = new Map<string, AttemptMeta>();
	for (const row of r.rows) {
		map.set(row.loc_code, {
			locCode: row.loc_code,
			lastAttemptAt: new Date(row.last_attempt_at),
			status: row.status,
			error: row.error
		});
	}
	return map;
}

// ---------------------------------------------------------------------------
// Batch orchestration
// ---------------------------------------------------------------------------

export interface LocToEnsure {
	code: string;
	kind: 'region' | 'hotspot';
	name: string;
	/** State/province of a hotspot (e.g. 'US-ME'); the code itself for regions. */
	regionCode?: string | null;
}

interface EnsureOptions {
	maxFetches?: number;
	/** Refetch even when stored data is current (owner-triggered "Refresh"). */
	force?: boolean;
	/** Injectable for tests: returns raw TSV text. */
	fetcher?: (userId: number, locCode: string, beginYear: number, endYear: number) => Promise<string>;
	/** Injectable for tests: start-to-start pacing delay. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
}

// Per-owner single-flight lease: one active barchart batch per data owner,
// process-wide. Overlapping invocations (second tab, double-submit, the client
// auto-loop racing itself) return busy instead of fanning out in parallel.
const activeBatch = new Set<number>();
// Soft daily ceiling per owner (resets on UTC day change or process restart).
const dailySpend = new Map<number, { day: string; count: number }>();

function underDailyCap(userId: number, now: Date): boolean {
	const day = now.toISOString().slice(0, 10);
	const spend = dailySpend.get(userId);
	if (!spend || spend.day !== day) {
		dailySpend.set(userId, { day, count: 0 });
		return true;
	}
	return spend.count < DAILY_FETCH_CAP;
}

function recordSpend(userId: number, now: Date): void {
	const day = now.toISOString().slice(0, 10);
	const spend = dailySpend.get(userId);
	if (spend && spend.day === day) spend.count++;
	else dailySpend.set(userId, { day, count: 1 });
}

async function defaultFetcher(
	userId: number,
	locCode: string,
	beginYear: number,
	endYear: number
): Promise<string> {
	return fetchAuthenticatedEbird(userId, barchartUrl(locCode, beginYear, endYear));
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make sure frequency data is stored and current for the given locations,
 * fetching (sequentially, politely) only what is missing or outdated.
 * Never throws: every outcome is reported in EnsureResult so form actions can
 * render it. Call ONLY from owner-triggered actions — never from GET loaders.
 */
export async function ensureFrequencies(
	userId: number,
	locs: LocToEnsure[],
	opts: EnsureOptions = {}
): Promise<EnsureResult> {
	const result: EnsureResult = {
		ready: [],
		refreshed: [],
		failed: [],
		notAttempted: [],
		credentialProblem: null,
		busy: false
	};
	if (locs.length === 0) return result;

	const maxFetches = Math.min(opts.maxFetches ?? FETCH_BATCH_MAX, FETCH_BATCH_MAX);
	const fetcher = opts.fetcher ?? defaultFetcher;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? (() => new Date());

	const endYear = lastCompleteYear(now());
	const beginYear = endYear - (YEARS_BACK - 1);

	const meta = await frequencyMeta(locs.map((l) => l.code));
	const current = (code: string) => {
		if (opts.force) return false;
		const m = meta.get(code);
		return m != null && m.endYear >= endYear;
	};
	const toFetch = locs.filter((l) => !current(l.code));
	result.ready = locs.filter((l) => current(l.code)).map((l) => l.code);
	if (toFetch.length === 0) return result;

	if (activeBatch.has(userId)) {
		result.busy = true;
		result.notAttempted = toFetch.map((l) => l.code);
		return result;
	}
	activeBatch.add(userId);
	try {
		// One taxonomy load per invocation, not per location; lazy so a batch
		// that aborts before its first fetch never pays for it.
		let matcherPromise: ReturnType<typeof buildMatcher> | null = null;
		const getMatcher = () => (matcherPromise ??= buildMatcher());
		let attempted = 0;
		let lastStart = 0;
		let rateLimited = false;
		for (const loc of toFetch) {
			if (attempted >= maxFetches || !underDailyCap(userId, now())) {
				result.notAttempted.push(loc.code);
				continue;
			}
			if (result.credentialProblem || rateLimited) {
				// Auth failed or eBird told us to back off — do not burn more calls.
				result.notAttempted.push(loc.code);
				continue;
			}

			const sinceLast = Date.now() - lastStart;
			if (lastStart > 0 && sinceLast < FETCH_SPACING_MS) {
				await sleep(FETCH_SPACING_MS - sinceLast);
			}
			lastStart = Date.now();
			attempted++;
			recordSpend(userId, now());

			try {
				const tsv = await fetcher(userId, loc.code, beginYear, endYear);
				const parsed = parseBarchartTsv(tsv);
				const matcher = await getMatcher();
				const matched = matchBarchartRows(parsed, {
					match: (name) => matcher.match(name)
				});
				validateMatchedBarchart(parsed, matched, meta.get(loc.code)?.nSpecies ?? null);
				await storeFrequencies({
					locCode: loc.code,
					locKind: loc.kind,
					locName: loc.name,
					beginYear,
					endYear,
					regionCode: loc.regionCode ?? null,
					parsed,
					matched
				});
				result.refreshed.push(loc.code);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				result.failed.push({ code: loc.code, error: message });
				if (err instanceof EbirdLoginError || err instanceof BarchartAuthError) {
					// Session/credentials are dead — abort the batch, keep stale data.
					// A login page at HTTP 200 counts (BarchartAuthError, CODEX8 #2).
					result.credentialProblem = message;
				} else if (err instanceof EbirdUpstreamError && err.status === 429) {
					// Rate limited: a global condition, not a credential problem —
					// stop the batch without telling the user to check Settings.
					rateLimited = true;
				}
				// Anything else (bad TSV, degenerate data, 5xx) is loc-specific.
				await recordFailedAttempt(loc, message);
			}
		}
	} finally {
		activeBatch.delete(userId);
	}
	return result;
}

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
 * per-owner single-flight lease. An authentication failure aborts the whole
 * batch immediately.
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
/** Pause before the single automatic retry of an eBird 5xx response. */
export const FETCH_5XX_RETRY_DELAY_MS = 4000;
/** A failed hotspot sits out of non-forced batches this long. */
export const HOTSPOT_FAILURE_COOLDOWN_MS = 15 * 60_000;
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

export interface FrequencyCorrection {
	speciesCode: string;
	week: number;
	originalFreq: number;
	storedFreq: number;
	sampleSize: number;
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

/**
 * Structured per-unit failure classification (CODEX1 #2) — attached where the
 * typed error is still in hand, so job policy never parses messages.
 */
export type UnitFailureKind = 'credential' | 'rate_limited' | 'transient' | 'unit' | 'cooldown';

export interface UnitOutcome {
	status: 'ok' | 'failed' | 'skipped';
	kind?: UnitFailureKind;
	error?: string;
}

export interface EnsureResult {
	/** Locs already stored and current (no fetch needed). */
	ready: string[];
	/** Locs fetched and stored during this invocation. */
	refreshed: string[];
	failed: { code: string; error: string; kind: UnitFailureKind }[];
	/** Locs needing a fetch that this invocation did not attempt (cap or abort). */
	notAttempted: string[];
	/** Human message when the CAS session/credentials blocked the batch. */
	credentialProblem: string | null;
	/** True when eBird 429'd and the batch stopped early (job policy backs off). */
	rateLimited: boolean;
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
 * Bound the one upstream anomaly we can interpret without inventing data:
 * eBird documents frequency as a proportion of complete checklists, so a
 * finite value above 1 means 100%, not a valid larger probability. Preserve
 * every correction for atomic audit persistence. Negative and non-finite
 * values pass through unchanged so the validation gate still rejects them.
 */
export function normalizeMatchedBarchart(
	parsed: ParsedBarchart,
	matched: MatchedBarchart
): { matched: MatchedBarchart; corrections: FrequencyCorrection[] } {
	const corrections: FrequencyCorrection[] = [];
	const bySpecies = new Map<string, number[]>();

	for (const [speciesCode, freqs] of matched.bySpecies) {
		bySpecies.set(
			speciesCode,
			freqs.map((freq, index) => {
				if (!Number.isFinite(freq) || freq <= 1) return freq;
				corrections.push({
					speciesCode,
					week: index + 1,
					originalFreq: freq,
					storedFreq: 1,
					sampleSize: parsed.sampleSizes[index]
				});
				return 1;
			})
		);
	}

	return {
		matched: {
			bySpecies,
			unmatched: [...matched.unmatched],
			collisions: matched.collisions
		},
		corrections
	};
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
	corrections?: FrequencyCorrection[];
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
		await client.query('DELETE FROM frequency_anomalies WHERE loc_code = $1', [p.locCode]);

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

		const corrections = p.corrections ?? [];
		for (let i = 0; i < corrections.length; i += BATCH) {
			const slice = corrections.slice(i, i + BATCH);
			const values: string[] = [];
			const params: unknown[] = [];
			slice.forEach((correction, j) => {
				const o = j * 6;
				values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
				params.push(
					p.locCode,
					correction.speciesCode,
					correction.week,
					correction.originalFreq,
					correction.storedFreq,
					correction.sampleSize
				);
			});
			await client.query(
				`INSERT INTO frequency_anomalies
				   (loc_code, species_code, week, original_freq, stored_freq, sample_size)
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

/** How the batch should wind down early, if at all. 'budget' = the caller's
 * chunk boundary hit — remaining locs route to notAttempted exactly like
 * cancel/drain; the CALLER (worker) yields the remainder for queue fairness. */
export type StopSignal = 'no' | 'cancel' | 'drain' | 'budget';

interface EnsureOptions {
	/**
	 * Max locations fetched this invocation. Default FETCH_BATCH_MAX (12) for
	 * request-path callers; the WORKER passes Infinity — no clamp (GROK #8).
	 */
	maxFetches?: number;
	/** Wall-clock budget; default BATCH_TIME_BUDGET_MS. Worker passes Infinity. */
	timeBudgetMs?: number;
	/** Refetch even when stored data is current (owner-triggered "Refresh"). */
	force?: boolean;
	/**
	 * Per-unit callback for job progress/events. Invoked OUTSIDE the fetch
	 * try/catch (CODEX1 #6): its failure must never convert a stored row into
	 * a barchart failure.
	 */
	onUnit?: (loc: LocToEnsure, outcome: UnitOutcome) => Promise<void>;
	/**
	 * Cooperative stop — checked between units AND around the 5xx retry sleep
	 * (GROK #6). 'cancel' and 'drain' both route remaining locs to
	 * notAttempted and return normally; the CALLER decides the job's fate.
	 */
	shouldStop?: () => Promise<StopSignal>;
	/** Injectable for tests: returns raw TSV text. */
	fetcher?: (userId: number, locCode: string, beginYear: number, endYear: number) => Promise<string>;
	/** Injectable for tests: start-to-start pacing delay. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
}

/** Stop starting new fetches once a batch has run this long (resumable). */
export const BATCH_TIME_BUDGET_MS = 4 * 60_000;
// NOTE: there is deliberately NO in-memory lease anymore — serialization is
// the worker queue (concurrency 1 + the Postgres advisory lock). And NO daily
// fetch ceiling (removed 2026-08-15, GBV: "WTF is the logic behind that false
// ceiling"). Politeness = worker-only fetching, sequential spacing, the 5xx
// retry-once, the failure cooldown, and the 429 stop.

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
		rateLimited: false
	};
	if (locs.length === 0) return result;

	// No clamp: the worker passes Infinity to cover a whole job in one call
	// (GROK #8 — a half-removed clamp here would silently truncate to 12).
	const maxFetches = opts.maxFetches ?? FETCH_BATCH_MAX;
	const timeBudgetMs = opts.timeBudgetMs ?? BATCH_TIME_BUDGET_MS;
	const fetcher = opts.fetcher ?? defaultFetcher;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? (() => new Date());
	const onUnit = opts.onUnit ?? (async () => {});
	const shouldStop = opts.shouldStop ?? (async () => 'no' as StopSignal);

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

	// One taxonomy load per invocation, not per location; lazy so a batch
	// that aborts before its first fetch never pays for it.
	let matcherPromise: ReturnType<typeof buildMatcher> | null = null;
	const getMatcher = () => (matcherPromise ??= buildMatcher());
	// Recently failed locations sit out a short cooldown — reported as
	// SKIPPED with kind 'cooldown' (CODEX1 #6): no fetch, no fresh failure;
	// job policy retries at the cooldown expiry. Explicit force bypasses.
	const priorAttempts = opts.force
		? new Map<string, AttemptMeta>()
		: await attemptMeta(toFetch.map((l) => l.code));
	const batchStart = now().getTime();
	let attempted = 0;
	let lastStart = 0;
	let stopped = false;

	for (const loc of toFetch) {
		if (!stopped && (await shouldStop()) !== 'no') stopped = true;
		if (stopped || result.credentialProblem || result.rateLimited) {
			result.notAttempted.push(loc.code);
			continue;
		}

		const prior = priorAttempts.get(loc.code);
		if (
			prior?.status === 'error' &&
			now().getTime() - prior.lastAttemptAt.getTime() < HOTSPOT_FAILURE_COOLDOWN_MS
		) {
			const error = `${prior.error ?? 'failed recently'} (waiting before retrying)`;
			result.failed.push({ code: loc.code, error, kind: 'cooldown' });
			await onUnit(loc, { status: 'skipped', kind: 'cooldown', error });
			continue;
		}
		if (attempted >= maxFetches || now().getTime() - batchStart > timeBudgetMs) {
			result.notAttempted.push(loc.code);
			continue;
		}

		const sinceLast = Date.now() - lastStart;
		if (lastStart > 0 && sinceLast < FETCH_SPACING_MS) {
			await sleep(FETCH_SPACING_MS - sinceLast);
		}
		lastStart = Date.now();
		attempted++;

		let outcome: UnitOutcome;
		try {
			let tsv: string;
			try {
				tsv = await fetcher(userId, loc.code, beginYear, endYear);
			} catch (err) {
				// eBird's export throws one-off 5xxs (seen live on prod,
				// 2026-08-14). One automatic retry after a short pause absorbs
				// the hiccup; a second failure is real. 429 excluded — backing
				// off, not retrying, is the polite response. The stop signal is
				// honored around this sleep too (GROK #6).
				if (err instanceof EbirdUpstreamError && err.status >= 500) {
					await sleep(FETCH_5XX_RETRY_DELAY_MS);
					if ((await shouldStop()) !== 'no') {
						stopped = true;
						result.notAttempted.push(loc.code);
						continue;
					}
					tsv = await fetcher(userId, loc.code, beginYear, endYear);
				} else {
					throw err;
				}
			}
			const parsed = parseBarchartTsv(tsv);
			const matcher = await getMatcher();
			const sourceMatched = matchBarchartRows(parsed, {
				match: (name) => matcher.match(name)
			});
			const { matched, corrections } = normalizeMatchedBarchart(parsed, sourceMatched);
			validateMatchedBarchart(parsed, matched, meta.get(loc.code)?.nSpecies ?? null);
			await storeFrequencies({
				locCode: loc.code,
				locKind: loc.kind,
				locName: loc.name,
				beginYear,
				endYear,
				regionCode: loc.regionCode ?? null,
				parsed,
				matched,
				corrections
			});
			result.refreshed.push(loc.code);
			outcome = { status: 'ok' };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Structured classification at the point where the typed error is
			// in hand (CODEX1 #2) — job policy never parses messages.
			let kind: UnitFailureKind = 'unit';
			if (err instanceof EbirdLoginError || err instanceof BarchartAuthError) {
				// Session/credentials are dead — abort the batch, keep stale data.
				result.credentialProblem = message;
				kind = 'credential';
			} else if (err instanceof EbirdUpstreamError && err.status === 429) {
				result.rateLimited = true;
				kind = 'rate_limited';
			} else if (err instanceof EbirdUpstreamError) {
				// 5xx/timeout that survived the in-batch retry.
				kind = 'transient';
			}
			result.failed.push({ code: loc.code, error: message, kind });
			await recordFailedAttempt(loc, message);
			outcome = { status: 'failed', kind, error: message };
		}
		// onUnit runs OUTSIDE the fetch/parse try/catch (CODEX1 #6): a failing
		// progress write must never convert a stored row into a barchart
		// failure — its errors are the caller's to handle.
		await onUnit(loc, outcome);
	}
	return result;
}

/**
 * eBird account (web login) integration — life-list sync without CSV friction.
 *
 * This uses eBird's *website* login (Cornell CAS at secure.birdcount.org),
 * which is an UNOFFICIAL interface: Cornell can change it at any time. Per
 * cs.md, every failure here must fail soft — callers keep the last synced
 * list and surface a "sync stale/error" state, never a hard app failure.
 *
 * Credentials are stored AES-GCM-encrypted (crypto.ts) and never logged.
 */
import { query, withTransaction } from '$lib/db';
import { decryptSecret } from '$server/crypto';
import { buildMatcher } from '$server/species-match';

// eBird auth is a Spring-Security CAS form at secure.birds.cornell.edu (the
// old secure.birdcount.org host no longer resolves). The sign-in form carries
// an `execution` token + `_eventId=submit`; success redirects through the
// service URL with a ticket, which sets the ebird.org session cookie.
const CAS_BASE = 'https://secure.birds.cornell.edu/cassso/login';
const CAS_SERVICE = 'https://ebird.org/login/cas?portal=ebird';
const CAS_LOGIN_URL = `${CAS_BASE}?service=${encodeURIComponent(CAS_SERVICE)}&locale=en_US`;
const LIFELIST_CSV_URL = 'https://ebird.org/lifelist?r=world&time=life&fmt=csv';
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) birds.gaylon.photos personal life-list sync';

export class EbirdLoginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EbirdLoginError';
	}
}

/** Minimal cookie jar: collects Set-Cookie across redirects, sends name=value pairs. */
class CookieJar {
	private cookies = new Map<string, string>();

	absorb(res: Response): void {
		for (const sc of res.headers.getSetCookie()) {
			const [pair] = sc.split(';');
			const eq = pair.indexOf('=');
			if (eq > 0) {
				const name = pair.slice(0, eq).trim();
				const value = pair.slice(eq + 1).trim();
				if (value === '' || value.toLowerCase() === 'deleted') this.cookies.delete(name);
				else this.cookies.set(name, value);
			}
		}
	}

	header(): string {
		return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}
}

/**
 * Every eBird web request is time-bounded. Without this, one crawling
 * response held a forecast batch (and its single-flight lease) for 5+
 * minutes on prod (2026-08-14) — a slow response must become a fast,
 * retryable failure instead.
 */
const EBIRD_FETCH_TIMEOUT_MS = 30_000;

async function fetchWithJar(url: string, jar: CookieJar, init?: RequestInit): Promise<Response> {
	const res = await fetch(url, {
		...init,
		redirect: 'manual',
		signal: AbortSignal.timeout(EBIRD_FETCH_TIMEOUT_MS),
		headers: { ...(init?.headers ?? {}), Cookie: jar.header(), 'User-Agent': UA }
	});
	jar.absorb(res);
	return res;
}

/** Follow redirects manually (fetch's auto-follow drops Set-Cookie state we need). */
async function followRedirects(start: Response, jar: CookieJar, maxHops = 8): Promise<Response> {
	let res = start;
	let hops = 0;
	while (res.status >= 300 && res.status < 400 && hops < maxHops) {
		const loc = res.headers.get('location');
		if (!loc) break;
		const next = new URL(loc, res.url).toString();
		res = await fetchWithJar(next, jar);
		hops++;
	}
	return res;
}

function extractInput(html: string, name: string): string | null {
	// CAS hidden fields (execution, service, locale). Attribute order varies.
	const re = new RegExp(
		`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']|<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`,
		'i'
	);
	const m = html.match(re);
	return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Authenticate against Cornell CAS; returns a jar holding ebird.org session cookies. */
async function casLogin(username: string, password: string): Promise<CookieJar> {
	const jar = new CookieJar();

	let formRes: Response;
	try {
		formRes = await followRedirects(await fetchWithJar(CAS_LOGIN_URL, jar), jar);
	} catch (err) {
		// Reachability (DNS/timeout/reset) is an UPSTREAM problem, never a
		// credential one — classifying it as EbirdLoginError made a Cornell
		// outage fail sync/frequency jobs terminally on attempt 1 instead of
		// retrying (CODEX1 Phase-3 #1).
		throw new EbirdUpstreamError(
			`Could not reach the eBird sign-in page: ${err instanceof Error ? err.message : err}`,
			0
		);
	}
	if (formRes.status >= 500 || formRes.status === 429) {
		// A 5xx/429 maintenance or throttle page has no login form — upstream.
		throw new EbirdUpstreamError(
			`eBird sign-in page returned HTTP ${formRes.status}.`,
			formRes.status
		);
	}
	const formHtml = await formRes.text();
	const execution = extractInput(formHtml, 'execution');
	if (!execution) {
		throw new EbirdLoginError(
			'eBird sign-in page did not contain the expected form (no execution token) — Cornell may have changed the login flow.'
		);
	}
	const service = extractInput(formHtml, 'service') ?? CAS_SERVICE;
	const locale = extractInput(formHtml, 'locale') ?? 'en_US';

	const body = new URLSearchParams({
		username,
		password,
		execution,
		_eventId: 'submit',
		service,
		locale
	});

	// The browser posts action="login" relative to the page → CAS_BASE (no query).
	// EVERY CAS network leg wraps reachability failures as upstream (CODEX1
	// Phase-3 re-review): a raw fetch TypeError here would classify as a
	// permanent per-unit failure in the frequency path instead of retrying.
	let loginRes: Response;
	try {
		loginRes = await fetchWithJar(CAS_BASE, jar, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		});
	} catch (err) {
		throw new EbirdUpstreamError(
			`Could not reach the eBird login endpoint: ${err instanceof Error ? err.message : err}`,
			0
		);
	}

	// Success is a 3xx redirect to the service URL with a ticket. A 200/401 here
	// means the form came back — almost always bad credentials.
	if (loginRes.status >= 300 && loginRes.status < 400) {
		try {
			await followRedirects(loginRes, jar);
		} catch (err) {
			throw new EbirdUpstreamError(
				`Could not complete the eBird sign-in redirect: ${err instanceof Error ? err.message : err}`,
				0
			);
		}
		return jar;
	}
	if (loginRes.status === 200 || loginRes.status === 401) {
		const html = await loginRes.text();
		if (/invalid|incorrect|name=["']password["']/i.test(html)) {
			throw new EbirdLoginError('eBird rejected the username or password.');
		}
	}
	if (loginRes.status >= 500 || loginRes.status === 429) {
		throw new EbirdUpstreamError(
			`eBird login endpoint returned HTTP ${loginRes.status}.`,
			loginRes.status
		);
	}
	throw new EbirdLoginError(`Unexpected eBird login response (HTTP ${loginRes.status}).`);
}

/** Verify saved credentials authenticate, without importing anything. */
export async function testEbirdLogin(userId: number): Promise<void> {
	const creds = await query<{ login_username_enc: string | null; login_password_enc: string | null }>(
		'SELECT login_username_enc, login_password_enc FROM user_ebird WHERE user_id = $1',
		[userId]
	);
	const row = creds.rows[0];
	if (!row?.login_username_enc || !row.login_password_enc) {
		throw new EbirdLoginError('No eBird account credentials saved — add them first.');
	}
	await casLogin(decryptSecret(row.login_username_enc), decryptSecret(row.login_password_enc));
}

// ---------------------------------------------------------------------------
// Authenticated ebird.org fetch service (used by barchart.ts). The cookie jar
// and CAS internals stay module-private on purpose — callers get exactly one
// narrow capability: "GET this ebird.org URL as the user's logged-in session."
// ---------------------------------------------------------------------------

const SESSION_MEMO_MS = 15 * 60_000;
const sessionMemo = new Map<number, { jar: CookieJar; at: number }>();
// Single-flight: concurrent callers share one CAS login instead of stacking them.
const sessionInFlight = new Map<number, Promise<CookieJar>>();

const AUTH_FETCH_ALLOWED_HOSTS = new Set(['ebird.org', 'www.ebird.org']);

async function loginFromStoredCreds(userId: number): Promise<CookieJar> {
	const creds = await query<{ login_username_enc: string | null; login_password_enc: string | null }>(
		'SELECT login_username_enc, login_password_enc FROM user_ebird WHERE user_id = $1',
		[userId]
	);
	const row = creds.rows[0];
	if (!row?.login_username_enc || !row.login_password_enc) {
		throw new EbirdLoginError('No eBird account credentials saved — add them in Settings.');
	}
	return casLogin(decryptSecret(row.login_username_enc), decryptSecret(row.login_password_enc));
}

function getSession(userId: number, forceFresh = false): Promise<CookieJar> {
	if (!forceFresh) {
		const memo = sessionMemo.get(userId);
		if (memo && Date.now() - memo.at < SESSION_MEMO_MS) return Promise.resolve(memo.jar);
		const inFlight = sessionInFlight.get(userId);
		if (inFlight) return inFlight;
	}
	const p = loginFromStoredCreds(userId)
		.then((jar) => {
			sessionMemo.set(userId, { jar, at: Date.now() });
			return jar;
		})
		.finally(() => {
			sessionInFlight.delete(userId);
		});
	sessionInFlight.set(userId, p);
	return p;
}

/** Drop the memoized session. Call on auth failure and when credentials change. */
export function invalidateEbirdSession(userId: number): void {
	sessionMemo.delete(userId);
}

/**
 * eBird answered on the right host but with an HTTP failure (429, 5xx, …).
 * NOT an authentication problem — callers must not blame credentials or
 * trigger a re-login for these (CODEX8 #3).
 */
export class EbirdUpstreamError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
		this.name = 'EbirdUpstreamError';
	}
}

/**
 * Fetch an ebird.org URL as the user's logged-in web session and return the
 * body text. Detects the session landing on the CAS login page (redirect off
 * the ebird.org host), evicts the memoized session, and retries with a fresh
 * login exactly once before failing with EbirdLoginError. An HTTP failure on
 * the requested host throws EbirdUpstreamError immediately — no re-login, no
 * credential blame.
 */
export async function fetchAuthenticatedEbird(userId: number, url: string): Promise<string> {
	const target = new URL(url);
	if (!AUTH_FETCH_ALLOWED_HOSTS.has(target.host)) {
		throw new Error(`fetchAuthenticatedEbird refuses non-eBird host: ${target.host}`);
	}

	const attempt = async (jar: CookieJar): Promise<string | null> => {
		let res: Response;
		try {
			res = await followRedirects(await fetchWithJar(url, jar), jar);
		} catch (err) {
			// A timed-out request is an upstream problem with retry-once
			// semantics (like a 5xx), never a credential problem.
			if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
				throw new EbirdUpstreamError('eBird did not respond within 30 seconds.', 504);
			}
			throw err;
		}
		// An expired/invalid session 302s to secure.birds.cornell.edu — a final
		// landing off the requested host means "not authenticated".
		if (new URL(res.url).host !== target.host) return null;
		// Right host, HTTP failure: an upstream problem, not an auth problem.
		if (!res.ok) {
			throw new EbirdUpstreamError(
				`eBird returned HTTP ${res.status} for this request${res.status === 429 ? ' (rate limited) — try again later' : ''}.`,
				res.status
			);
		}
		return res.text();
	};

	let body = await attempt(await getSession(userId));
	if (body == null) {
		invalidateEbirdSession(userId);
		body = await attempt(await getSession(userId, true));
	}
	if (body == null) {
		throw new EbirdLoginError(
			'eBird session could not authenticate this request — check the saved eBird login in Settings.'
		);
	}
	return body;
}

interface ParsedLifeList {
	rows: { comName: string; sciName: string | null; firstSeen: string | null }[];
}

/** Tolerant CSV line splitter (handles quoted fields with commas). */
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQ = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inQ) {
			if (c === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (c === '"') inQ = false;
			else cur += c;
		} else if (c === '"') inQ = true;
		else if (c === ',') {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out;
}

/**
 * Parse an eBird life-list CSV (download or web export). Tolerates both the
 * "Species" column style ("Common Name - Scientific Name" or just common
 * name) and separate Common/Scientific columns, plus a Date-ish column.
 */
export function parseLifeListCsv(csv: string): ParsedLifeList {
	const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
	if (lines.length < 2) return { rows: [] };

	const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
	const col = (...names: string[]) => {
		for (const n of names) {
			const i = header.indexOf(n);
			if (i >= 0) return i;
		}
		return -1;
	};

	const iSpecies = col('species', 'common name', 'comname');
	const iSci = col('scientific name', 'sciname');
	const iDate = col('date', 'first seen', 'firstseen');
	if (iSpecies < 0) {
		throw new Error(`Life-list CSV missing a Species column (saw: ${header.join(', ')})`);
	}

	const rows: ParsedLifeList['rows'] = [];
	for (let i = 1; i < lines.length; i++) {
		const f = splitCsvLine(lines[i]);
		const raw = (f[iSpecies] ?? '').trim();
		if (!raw) continue;
		let comName = raw;
		let sciName = iSci >= 0 ? (f[iSci] ?? '').trim() || null : null;
		// "Common Name - Scientific Name" combined style
		const dash = raw.indexOf(' - ');
		if (!sciName && dash > 0) {
			comName = raw.slice(0, dash).trim();
			sciName = raw.slice(dash + 3).trim() || null;
		}
		const dateRaw = iDate >= 0 ? (f[iDate] ?? '').trim() : '';
		const parsed = dateRaw ? new Date(dateRaw) : null;
		const firstSeen =
			parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
		rows.push({ comName, sciName, firstSeen });
	}
	return { rows };
}

export interface SyncResult {
	total: number;
	matched: number;
	unmatched: string[];
}

/**
 * Replace the user's synced seen_species rows from parsed life-list rows.
 * Manual rows (source='manual') are preserved.
 */
export async function importLifeList(
	userId: number,
	parsed: ParsedLifeList,
	source: 'ebird_sync' | 'csv_import'
): Promise<SyncResult> {
	const matcher = await buildMatcher();
	if (matcher.taxonomySize === 0) {
		throw new Error('Taxonomy cache is empty — run the taxonomy sync first (Settings).');
	}

	const seen = new Map<string, string | null>(); // code → first_seen
	const unmatched: string[] = [];
	for (const row of parsed.rows) {
		const m = matcher.match(row.comName, row.sciName);
		if (m) {
			if (!seen.has(m.code) || (row.firstSeen && !seen.get(m.code))) {
				seen.set(m.code, row.firstSeen);
			}
		} else {
			unmatched.push(row.comName);
		}
	}

	await withTransaction(async (client) => {
		await client.query(
			`DELETE FROM seen_species WHERE user_id = $1 AND source IN ('ebird_sync', 'csv_import')`,
			[userId]
		);
		const entries = [...seen.entries()];
		const BATCH = 500;
		for (let i = 0; i < entries.length; i += BATCH) {
			const slice = entries.slice(i, i + BATCH);
			const values: string[] = [];
			const params: unknown[] = [];
			slice.forEach(([code, firstSeen], j) => {
				const o = j * 4;
				values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
				params.push(userId, code, source, firstSeen);
			});
			await client.query(
				`INSERT INTO seen_species (user_id, species_code, source, first_seen)
				 VALUES ${values.join(',')}
				 ON CONFLICT (user_id, species_code) DO UPDATE SET source = EXCLUDED.source`,
				params
			);
		}
	});

	return { total: parsed.rows.length, matched: seen.size, unmatched };
}

/** Full credentialed sync: CAS login → lifelist CSV → import. Records status on user_ebird. */
export async function syncLifeListFromEbird(userId: number): Promise<SyncResult> {
	const creds = await query<{ login_username_enc: string | null; login_password_enc: string | null }>(
		'SELECT login_username_enc, login_password_enc FROM user_ebird WHERE user_id = $1',
		[userId]
	);
	const row = creds.rows[0];
	if (!row?.login_username_enc || !row.login_password_enc) {
		throw new EbirdLoginError('No eBird account credentials saved — add them in Settings.');
	}

	try {
		const jar = await casLogin(
			decryptSecret(row.login_username_enc),
			decryptSecret(row.login_password_enc)
		);
		let csvRes: Response;
		try {
			csvRes = await followRedirects(await fetchWithJar(LIFELIST_CSV_URL, jar), jar);
		} catch (err) {
			throw new EbirdUpstreamError(
				`Could not reach the eBird life-list export: ${err instanceof Error ? err.message : err}`,
				0
			);
		}
		const contentType = csvRes.headers.get('content-type') ?? '';
		const text = await csvRes.text();
		// Classification split (GROK Phase-3 P2, same class as the CAS legs):
		// a 5xx/429 export page after a SUCCESSFUL login is upstream trouble
		// and must retry — only a login-page/flow-change response blames auth.
		if (csvRes.status >= 500 || csvRes.status === 429) {
			throw new EbirdUpstreamError(
				`eBird life-list export returned HTTP ${csvRes.status}.`,
				csvRes.status
			);
		}
		if (!csvRes.ok) {
			throw new EbirdUpstreamError(
				`eBird life-list export returned HTTP ${csvRes.status} — the export URL may have moved.`,
				csvRes.status
			);
		}
		if (contentType.includes('text/html')) {
			throw new EbirdLoginError(
				'eBird login succeeded but the life-list export returned a page instead of CSV — the flow may have changed.'
			);
		}
		const result = await importLifeList(userId, parseLifeListCsv(text), 'ebird_sync');
		await query(
			`UPDATE user_ebird SET life_list_synced_at = NOW(), life_list_status = 'ok', life_list_error = NULL
			 WHERE user_id = $1`,
			[userId]
		);
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await query(
			`UPDATE user_ebird SET life_list_status = 'error', life_list_error = $2 WHERE user_id = $1`,
			[userId, message]
		);
		throw err;
	}
}

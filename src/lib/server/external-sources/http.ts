/**
 * Shared request handling for /api/ingest/ (td-eec7db Phase 1, [C-P2-6]).
 *
 * Order for every call: authenticate the bearer token (before the body is
 * read) → require application/json → cap the body at MAX_BODY_BYTES (before
 * parsing) → parse → run → map errors. Logs are one structured line per call
 * with a request id; tokens, bodies and connector-supplied text never appear
 * in them.
 */
import { randomUUID } from 'node:crypto';
import { authenticateConnector, type AuthFailure, type Connector } from './auth';
import { ContractError, MAX_BODY_BYTES, isUuid } from './contract';
import { IngestError } from './lifecycle';

export interface IngestContext {
	connector: Connector;
	body: unknown;
	bodyBytes: number;
	requestId: string;
	/** Set by the handler so the log line names the load. */
	log: { loadId?: string };
}

type LogFields = Record<string, string | number | boolean | null | undefined>;

function logIngest(level: 'info' | 'warn' | 'error', fields: LogFields): void {
	console[level](`[ingest] ${JSON.stringify(fields)}`);
}

const BASE_HEADERS = { 'cache-control': 'no-store' };

function respond(status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): Response {
	const headers: Record<string, string> = { ...BASE_HEADERS, 'x-request-id': requestId, ...extra };
	if (body === null) return new Response(null, { status, headers });
	headers['content-type'] = 'application/json';
	return new Response(JSON.stringify(body), { status, headers });
}

const AUTH_MESSAGES: Record<AuthFailure, string> = {
	missing: 'A bearer token is required.',
	unknown: 'The token is not recognised.',
	revoked: 'This token has been revoked.',
	inactive: 'This source is switched off.'
};

// Per-connector request budget (per process): a runaway connector gets 429s
// instead of saturating the app. The real connector runs 2 requests at a time.
const RATE_PER_SECOND = 20;
const buckets = new Map<number, { tokens: number; at: number }>();

function takeToken(connectorId: number, now = Date.now()): boolean {
	const b = buckets.get(connectorId) ?? { tokens: RATE_PER_SECOND, at: now };
	b.tokens = Math.min(RATE_PER_SECOND, b.tokens + ((now - b.at) / 1000) * RATE_PER_SECOND);
	b.at = now;
	const ok = b.tokens >= 1;
	if (ok) b.tokens -= 1;
	buckets.set(connectorId, b);
	return ok;
}

/** Test seam: forget the request budget between tests. */
export function resetIngestRateForTest(): void {
	buckets.clear();
}

async function readCapped(request: Request): Promise<{ text: string; bytes: number } | 'too_large'> {
	const declared = Number(request.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return 'too_large';
	if (!request.body) return { text: '', bytes: 0 };
	const reader = request.body.getReader();
	const parts: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => {});
			return 'too_large';
		}
		parts.push(value);
	}
	return { text: Buffer.concat(parts).toString('utf8'), bytes };
}

export function requestIdOf(request: Request): string {
	const id = request.headers.get('x-request-id')?.trim();
	return id && isUuid(id.toLowerCase()) ? id.toLowerCase() : randomUUID();
}

/**
 * Run one ingest call. `handler` returns the JSON body (status 200) or
 * `null` for 204 No Content.
 */
export async function handleIngest(
	route: string,
	request: Request,
	handler: (ctx: IngestContext) => Promise<unknown | null>
): Promise<Response> {
	const started = Date.now();
	const requestId = requestIdOf(request);
	const fields: LogFields = { route, request_id: requestId };
	const done = (status: number, body: unknown, extra: LogFields = {}, headers: Record<string, string> = {}) => {
		logIngest(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', {
			...fields,
			...extra,
			status,
			duration_ms: Date.now() - started
		});
		return respond(status, body, requestId, headers);
	};

	const auth = await authenticateConnector(request);
	if (!auth.ok) return done(401, { error: auth.reason, message: AUTH_MESSAGES[auth.reason] }, { auth: auth.reason });
	const connector = auth.connector;
	fields.connector_id = connector.connectorId;
	fields.source = connector.sourceId;

	if (!takeToken(connector.connectorId)) {
		return done(429, { error: 'rate_limited', message: 'Too many requests; back off.' }, {}, { 'retry-after': '1' });
	}
	const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (type !== 'application/json') {
		return done(415, { error: 'content_type', message: 'Send Content-Type: application/json.' });
	}
	const raw = await readCapped(request);
	if (raw === 'too_large') {
		return done(413, { error: 'too_large', message: `Bodies are limited to ${MAX_BODY_BYTES} bytes.` });
	}
	let body: unknown;
	try {
		body = JSON.parse(raw.text);
	} catch { // stale-safe: a connector's web request, never under a worker job claim; parse failure only
		return done(400, { error: 'malformed_json', message: 'The body is not valid JSON.' });
	}

	const ctx: IngestContext = { connector, body, bodyBytes: raw.bytes, requestId, log: {} };
	try {
		const result = await handler(ctx);
		return done(result === null ? 204 : 200, result, { load_id: ctx.log.loadId });
	} catch (err) { // stale-safe: a connector's web request, never under a worker job claim; maps errors to HTTP
		const extra = { load_id: ctx.log.loadId };
		if (err instanceof IngestError) {
			const headers: Record<string, string> = err.status === 429 ? { 'retry-after': '5' } : {};
			return done(err.status, { error: err.code, message: err.message }, { ...extra, error: err.code }, headers);
		}
		if (err instanceof ContractError) {
			const status = err.code === 'region' ? 403 : 422;
			return done(status, { error: err.code === 'invalid' ? 'invalid' : err.code, message: err.message }, {
				...extra,
				error: err.code
			});
		}
		logIngest('error', {
			...fields,
			...extra,
			event: 'unhandled',
			error: err instanceof Error ? err.message.slice(0, 300) : 'unknown'
		});
		return done(500, { error: 'server_error', message: 'The server could not complete this call.' }, extra);
	}
}

/** A `[id]` route parameter that is not a uuid is a 404, never a database error. */
export function loadIdParam(id: string | undefined): string {
	if (!isUuid(id)) throw new IngestError(404, 'unknown_load', 'No such load.');
	return id;
}

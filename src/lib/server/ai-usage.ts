/**
 * The AI usage ledger (td-09be7a): recording and aggregation over ai_usage.
 *
 * GRAIN: one row per billed-or-event ATTEMPT (see migration 0034). A plain
 * call writes one row; an Opus 5 server-side fallback chain writes one row per
 * usage.iterations entry, grouped by call_id.
 *
 * Dollars are NEVER stored — tokens are stored and priced at read time via
 * ai-models.ts's dollarsForRow, the ONE formula (GROK P1-6: every parallel
 * dollar computation is a chance to reintroduce the reported-vs-charged bug
 * as a SELECT). Nothing in this module multiplies a token count by a rate.
 */
import { query } from '$lib/db';
import { sanitizeErrorText } from './job-policy';
import { dollarsForRow, type CallEnvelope } from './ai-models';

export type AiPurpose = 'enrichment' | 'guidance' | 'compare';

export interface UsageCall {
	provider?: string; // default 'anthropic'
	requestedModel: string;
	purpose: AiPurpose;
	speciesCode?: string | null;
	jobId?: number | null;
	requestId?: string | null;
	httpStatus?: number | null;
	providerErrorType?: string | null;
	durationMs?: number | null;
	ok: boolean;
	/** Sanitized here — callers may pass raw provider text. */
	error?: string | null;
	/**
	 * From extractEnvelope. Empty for pre-response failures (network error,
	 * abort): recordUsage synthesizes one event row with NULL tokens and
	 * billed=TRUE — NULL tokens price to null and render "—" (unknown spend),
	 * never $0.00, which would read as a receipt for a free call.
	 */
	attempts: CallEnvelope[];
}

/**
 * Record one API call as its attempt rows. NEVER throws — a metering failure
 * must not fail the metered call (the $30 annotation matters more than its
 * receipt; the error is logged for the meter's own health).
 *
 * The whole chain goes in ONE INSERT statement with call_id minted inside the
 * statement (GROK P1-5): a row-at-a-time insert that fails after the
 * declined-primary row cannot be repaired — DELETE is revoked — and a "retry"
 * would unique-violate, get swallowed by never-throws, and leave the fallback
 * spend permanently unrecorded. Atomicity beats repair on an append-only
 * table. Side effect: every row of a chain shares `at` (one statement, one
 * NOW()), which the aggregate queries rely on (a chain never spans buckets).
 * There is deliberately NO retry here on any error, unique violations
 * included.
 */
export async function recordUsage(call: UsageCall): Promise<void> {
	try {
		const attempts: CallEnvelope[] =
			call.attempts.length > 0
				? call.attempts
				: [
						{
							attemptIndex: 0,
							attemptType: null,
							isFinal: true,
							servedModel: null,
							stopReason: null,
							billed: true, // unknown spend, not "free" — prices to null, renders "—"
							inputTokens: null,
							outputTokens: null,
							thinkingTokens: null,
							cacheReadTokens: null,
							cacheWrite5mTokens: null,
							cacheWrite1hTokens: null
						}
					];
		await query(
			`INSERT INTO ai_usage (
				call_id, attempt_index, attempt_type, is_final, provider,
				requested_model, served_model, purpose, species_code, job_id,
				request_id, http_status, provider_error_type,
				input_tokens, output_tokens, thinking_tokens,
				cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
				stop_reason, duration_ms, ok, billed, error
			)
			SELECT
				c.cid, a.attempt_index, a.attempt_type, a.is_final, $1,
				$2, a.served_model, $3, $4, $5,
				$6, $7, $8,
				a.input_tokens, a.output_tokens, a.thinking_tokens,
				a.cache_read_tokens, a.cache_write_5m_tokens, a.cache_write_1h_tokens,
				a.stop_reason, $9, $10, a.billed, $11
			FROM (SELECT gen_random_uuid() AS cid) c
			CROSS JOIN unnest(
				$12::smallint[], $13::text[], $14::boolean[], $15::text[],
				$16::int[], $17::int[], $18::int[],
				$19::int[], $20::int[], $21::int[],
				$22::text[], $23::boolean[]
			) AS a(
				attempt_index, attempt_type, is_final, served_model,
				input_tokens, output_tokens, thinking_tokens,
				cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
				stop_reason, billed
			)`,
			[
				call.provider ?? 'anthropic',
				call.requestedModel,
				call.purpose,
				call.speciesCode ?? null,
				call.jobId ?? null,
				call.requestId ?? null,
				call.httpStatus ?? null,
				call.providerErrorType ?? null,
				call.durationMs ?? null,
				call.ok,
				call.error != null ? sanitizeErrorText(call.error) : null,
				attempts.map((a) => a.attemptIndex),
				attempts.map((a) => a.attemptType),
				attempts.map((a) => a.isFinal),
				attempts.map((a) => a.servedModel),
				attempts.map((a) => a.inputTokens),
				attempts.map((a) => a.outputTokens),
				attempts.map((a) => a.thinkingTokens),
				attempts.map((a) => a.cacheReadTokens),
				attempts.map((a) => a.cacheWrite5mTokens),
				attempts.map((a) => a.cacheWrite1hTokens),
				attempts.map((a) => a.stopReason),
				attempts.map((a) => a.billed)
			]
		);
	} catch (err) {
		console.error(
			'ai-usage: recordUsage failed (metered call unaffected)',
			err instanceof Error ? err.message : err
		);
	}
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export interface UsageWindowTotals {
	dollars: number;
	/** Billed attempts whose dollars are unknowable (NULL tokens from an
	 * abort, or an unregistered served model) — EXCLUDED from `dollars`,
	 * surfaced so the UI can say "+N unpriced" instead of lying with a
	 * too-small total. */
	unpricedAttempts: number;
	calls: number;
	inputTokens: number;
	outputTokens: number;
}

export interface ModelPurposeCell {
	servedModel: string | null;
	purpose: AiPurpose | string;
	attempts: number;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	dollars: number;
	unpricedAttempts: number;
}

export interface RecentCall {
	callId: string;
	at: Date;
	purpose: string;
	speciesCode: string | null;
	requestedModel: string;
	/** The final attempt's served model — differs from requested under fallbacks. */
	servedModel: string | null;
	attempts: number;
	ok: boolean;
	billed: boolean;
	stopReason: string | null;
	httpStatus: number | null;
	durationMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	thinkingTokens: number | null;
	/** null = unpriceable (abort / unknown model) — render "—", never $0.00. */
	dollars: number | null;
	error: string | null;
}

export interface CountRow {
	key: string | null;
	n: number;
}

export interface UsageAggregates {
	windows: { today: UsageWindowTotals; d7: UsageWindowTotals; d30: UsageWindowTotals; all: UsageWindowTotals };
	byModelPurpose: ModelPurposeCell[];
	recent: RecentCall[];
	/** Final-attempt stop_reason counts, last 30 days. */
	stopReasons: CountRow[];
	/** Final-attempt provider_error_type counts over ok=false rows, last 30 days. */
	errors: CountRow[];
}

interface GroupRow {
	bucket: Date;
	served_model: string | null;
	purpose: string;
	billed: boolean;
	priceable: boolean;
	attempts: number;
	calls: number;
	input_tokens: string | number;
	output_tokens: string | number;
	cache_read_tokens: string | number;
	cache_write_5m_tokens: string | number;
	cache_write_1h_tokens: string | number;
}

const floorToHour = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

/**
 * THE aggregate function (GROK P1-6) — the only reader that turns the ledger
 * into money, feeding the stat tiles AND the by-model breakdown from the same
 * grouped rows so they cannot disagree.
 *
 * How pricing stays exact: rows are grouped by (hour bucket, served_model,
 * purpose, billed, priceable) and each GROUP SUM is priced with dollarsForRow
 * at the bucket instant. The formula is linear in tokens, so pricing a sum
 * equals summing per-row prices — PROVIDED no group spans a rate-window
 * boundary. That holds because every PricingWindow.fromUtc in the registry is
 * hour-aligned (Sonnet 5's is 07:00:00Z); keep it that way.
 *
 * What it deliberately does NOT filter on (each is P0-2 reborn as a SELECT):
 *   - NOT `WHERE ok` — a 200-then-parse-fail carries real spend;
 *   - NOT `WHERE is_final` — a billed declined primary is real spend;
 *   - NOT `SUM DISTINCT call_id` — both attempts of a chain cost money.
 * It sums every BILLED attempt row; billed=false event rows price to $0 via
 * the same function; NULL-token and unknown-model rows are excluded from
 * dollar sums and counted as unpricedAttempts instead (never silently $0).
 */
export async function usageAggregates(now: Date = new Date()): Promise<UsageAggregates> {
	const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const d7Start = new Date(floorToHour(now).getTime() - 7 * 86_400_000);
	const d30Start = new Date(floorToHour(now).getTime() - 30 * 86_400_000);

	const [groupsR, callsR, recent, stopR, errR] = await Promise.all([
		query<GroupRow>(
			`SELECT date_trunc('hour', at) AS bucket, served_model, purpose, billed,
			        (input_tokens IS NOT NULL AND output_tokens IS NOT NULL) AS priceable,
			        COUNT(*)::int AS attempts,
			        COUNT(DISTINCT call_id)::int AS calls,
			        COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
			        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
			        COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
			        COALESCE(SUM(cache_write_5m_tokens), 0)::bigint AS cache_write_5m_tokens,
			        COALESCE(SUM(cache_write_1h_tokens), 0)::bigint AS cache_write_1h_tokens
			 FROM ai_usage
			 GROUP BY 1, 2, 3, 4, 5`
		),
		query<{ calls_today: number; calls_7d: number; calls_30d: number; calls_all: number }>(
			`SELECT COUNT(DISTINCT call_id) FILTER (WHERE at >= $1)::int AS calls_today,
			        COUNT(DISTINCT call_id) FILTER (WHERE at >= $2)::int AS calls_7d,
			        COUNT(DISTINCT call_id) FILTER (WHERE at >= $3)::int AS calls_30d,
			        COUNT(DISTINCT call_id)::int AS calls_all
			 FROM ai_usage`,
			[todayStart, d7Start, d30Start]
		),
		recentCalls(50),
		query<{ key: string | null; n: number }>(
			`SELECT stop_reason AS key, COUNT(*)::int AS n
			 FROM ai_usage WHERE is_final AND at >= $1
			 GROUP BY stop_reason ORDER BY n DESC`,
			[d30Start]
		),
		query<{ key: string | null; n: number }>(
			`SELECT provider_error_type AS key, COUNT(*)::int AS n
			 FROM ai_usage WHERE is_final AND NOT ok AND at >= $1
			 GROUP BY provider_error_type ORDER BY n DESC`,
			[d30Start]
		)
	]);

	const emptyWindow = (): UsageWindowTotals => ({
		dollars: 0,
		unpricedAttempts: 0,
		calls: 0,
		inputTokens: 0,
		outputTokens: 0
	});
	const windows = { today: emptyWindow(), d7: emptyWindow(), d30: emptyWindow(), all: emptyWindow() };
	const cells = new Map<string, ModelPurposeCell>();

	for (const g of groupsR.rows) {
		const input = Number(g.input_tokens);
		const output = Number(g.output_tokens);
		// One formula: price the group sum as a row at the bucket instant.
		const dollars = g.priceable
			? dollarsForRow({
					billed: g.billed,
					served_model: g.served_model,
					at: g.bucket,
					input_tokens: input,
					output_tokens: output,
					cache_read_tokens: Number(g.cache_read_tokens),
					cache_write_5m_tokens: Number(g.cache_write_5m_tokens),
					cache_write_1h_tokens: Number(g.cache_write_1h_tokens)
				})
			: g.billed
				? null // NULL tokens on a billed row: spend unknown, not zero
				: 0;
		const unpriced = dollars == null ? g.attempts : 0;

		const targets: UsageWindowTotals[] = [windows.all];
		if (g.bucket.getTime() >= d30Start.getTime()) targets.push(windows.d30);
		if (g.bucket.getTime() >= d7Start.getTime()) targets.push(windows.d7);
		if (g.bucket.getTime() >= todayStart.getTime()) targets.push(windows.today);
		for (const w of targets) {
			w.dollars += dollars ?? 0;
			w.unpricedAttempts += unpriced;
			w.inputTokens += input;
			w.outputTokens += output;
		}

		const cellKey = `${g.served_model ?? ''} ${g.purpose}`;
		let cell = cells.get(cellKey);
		if (!cell) {
			cell = {
				servedModel: g.served_model,
				purpose: g.purpose,
				attempts: 0,
				calls: 0,
				inputTokens: 0,
				outputTokens: 0,
				dollars: 0,
				unpricedAttempts: 0
			};
			cells.set(cellKey, cell);
		}
		cell.attempts += g.attempts;
		// Chain rows share `at` (single-statement insert), so a call never spans
		// buckets: summing per-bucket distinct counts cannot double-count within
		// a cell. A fallback chain DOES appear once per served_model cell it
		// touched — that is the honest reading at this grain.
		cell.calls += g.calls;
		cell.inputTokens += input;
		cell.outputTokens += output;
		cell.dollars += dollars ?? 0;
		cell.unpricedAttempts += unpriced;
	}

	const c = callsR.rows[0];
	windows.today.calls = c?.calls_today ?? 0;
	windows.d7.calls = c?.calls_7d ?? 0;
	windows.d30.calls = c?.calls_30d ?? 0;
	windows.all.calls = c?.calls_all ?? 0;

	return {
		windows,
		byModelPurpose: [...cells.values()].sort((a, b) => b.dollars - a.dollars),
		recent,
		stopReasons: stopR.rows.map((r) => ({ key: r.key, n: r.n })),
		errors: errR.rows.map((r) => ({ key: r.key, n: r.n }))
	};
}

interface AttemptRow {
	call_id: string;
	at: Date;
	attempt_index: number;
	is_final: boolean;
	purpose: string;
	species_code: string | null;
	requested_model: string;
	served_model: string | null;
	stop_reason: string | null;
	http_status: number | null;
	duration_ms: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	thinking_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_5m_tokens: number | null;
	cache_write_1h_tokens: number | null;
	ok: boolean;
	billed: boolean;
	error: string | null;
}

/** The most recent `limit` CALLS (not rows), each folded from its attempt
 * chain and priced attempt-by-attempt with the one formula. A call with any
 * unpriceable billed attempt gets dollars=null — a partial sum shown as the
 * total would be a quiet lie. */
async function recentCalls(limit: number): Promise<RecentCall[]> {
	const ids = await query<{ call_id: string }>(
		`SELECT call_id FROM ai_usage GROUP BY call_id ORDER BY MAX(at) DESC LIMIT $1`,
		[limit]
	);
	if (ids.rows.length === 0) return [];
	const rows = await query<AttemptRow>(
		`SELECT call_id, at, attempt_index, is_final, purpose, species_code,
		        requested_model, served_model, stop_reason, http_status,
		        duration_ms, input_tokens, output_tokens, thinking_tokens,
		        cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
		        ok, billed, error
		 FROM ai_usage WHERE call_id = ANY($1::uuid[])
		 ORDER BY at DESC, call_id, attempt_index`,
		[ids.rows.map((r) => r.call_id)]
	);
	const byCall = new Map<string, AttemptRow[]>();
	for (const r of rows.rows) {
		const list = byCall.get(r.call_id);
		if (list) list.push(r);
		else byCall.set(r.call_id, [r]);
	}
	const calls: RecentCall[] = [];
	for (const attempts of byCall.values()) {
		const final = attempts.find((a) => a.is_final) ?? attempts[attempts.length - 1];
		let dollars: number | null = 0;
		let tokensSeen = false;
		for (const a of attempts) {
			const d = dollarsForRow({
				billed: a.billed,
				served_model: a.served_model,
				at: a.at,
				input_tokens: a.input_tokens,
				output_tokens: a.output_tokens,
				cache_read_tokens: a.cache_read_tokens,
				cache_write_5m_tokens: a.cache_write_5m_tokens,
				cache_write_1h_tokens: a.cache_write_1h_tokens
			});
			if (d == null) {
				dollars = null;
				break;
			}
			dollars += d;
			if (a.input_tokens != null) tokensSeen = true;
		}
		const sum = (pick: (a: AttemptRow) => number | null): number | null =>
			tokensSeen ? attempts.reduce((acc, a) => acc + (pick(a) ?? 0), 0) : null;
		calls.push({
			callId: final.call_id,
			at: final.at,
			purpose: final.purpose,
			speciesCode: final.species_code,
			requestedModel: final.requested_model,
			servedModel: final.served_model,
			attempts: attempts.length,
			ok: final.ok,
			billed: attempts.some((a) => a.billed),
			stopReason: final.stop_reason,
			httpStatus: final.http_status,
			durationMs: final.duration_ms,
			inputTokens: sum((a) => a.input_tokens),
			outputTokens: sum((a) => a.output_tokens),
			thinkingTokens: sum((a) => a.thinking_tokens),
			dollars,
			error: final.error
		});
	}
	calls.sort((a, b) => b.at.getTime() - a.at.getTime());
	return calls;
}

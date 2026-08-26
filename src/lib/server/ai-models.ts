/**
 * The AI model registry (td-015838/td-09be7a): the ONE place that knows how to
 * build a request for each model and what each model's tokens cost.
 *
 * Plan: docs/2026-08-26-ai-foundation-model-control-usage-meter-plan.md
 *
 * Why a registry and not if-statements at the call site: request shape is
 * per-model, and every difference below was learned the expensive way during
 * the Sonnet→Opus switch — thinking defaults differ, max_tokens covers
 * thinking AND output on thinking-by-default models, `effort` 400s on Haiku,
 * the fallbacks param needs a model-appropriate beta header, and sampling
 * params 400 on newer models. Callers state WHAT they want (`AiCallParts`);
 * entries own HOW each model is asked.
 *
 * PURE MODULE: no $env, no DB, no fetch. buildRequest NEVER sees the API key —
 * headers here are beta headers only, and the chokepoint (ai-call.ts) merges
 * auth at fetch time. That makes registry output snapshot-testable and makes a
 * key leak into logs or ai_usage.error structurally impossible from this
 * module (tested as key-ABSENCE in ai-models.test.ts).
 */

/** What a caller wants said — content and budget, nothing model-specific. */
export interface AiCallParts {
	system: string;
	user: string;
	/** output_config.format json_schema; omit for free text. */
	schema?: Record<string, unknown>;
	/** The ANSWER budget, thinking-exclusive; entries add model headroom. */
	maxOutputTokens: number;
	/** Preference; entries clamp or DROP it (Haiku 4.5 rejects effort). */
	effort?: 'low' | 'medium' | 'high';
}

export interface BuiltRequest {
	/** Beta headers ONLY — never auth. */
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * One billed-or-event attempt extracted from a response. A plain call yields
 * one; a server-side fallback chain yields one per usage.iterations entry.
 */
export interface CallEnvelope {
	attemptIndex: number;
	attemptType: string | null; // 'message' | 'fallback_message' | null
	isFinal: boolean;
	servedModel: string | null;
	stopReason: string | null;
	/**
	 * REPORTED != CHARGED: Anthropic reports usage for attempts it does not
	 * bill (pre-output refusals; declined fallback primaries with output 0).
	 * Billed iff the attempt produced output.
	 */
	billed: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	thinkingTokens: number | null; // breakdown of outputTokens, NEVER priced
	cacheReadTokens: number | null;
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
}

/**
 * The shared per-CALL envelope (CODEX1 P1-3): one error/success contract for
 * every consumer. Populated the moment headers/body are available — so a
 * non-2xx response and a post-200 parse failure both carry the request-id
 * that Anthropic support asks for, plus whatever attempts were extractable.
 * Attached to EnrichmentAiError AND GuidanceError on every throw; returned
 * beside the parsed result on success.
 */
export interface AiCallEnvelope {
	requestId: string | null;
	httpStatus: number | null;
	/** Anthropic error.type on failures ('overloaded_error', …). */
	providerErrorType: string | null;
	/** Empty when no response body was readable (network error, abort). */
	attempts: CallEnvelope[];
}

export interface PricingWindow {
	/** Inclusive start, as an exact UTC instant (timezone ambiguity killed
	 * here, not at render: Anthropic pricing boundaries are US/Pacific). */
	fromUtc: string;
	inPerMTok: number;
	outPerMTok: number;
}

export interface ModelEntry {
	id: string;
	provider: 'anthropic';
	label: string;
	/** One line for the admin radio-card (AGY design). */
	description: string;
	pricing: PricingWindow[];
	/** Absent on pricing-only entries (fallback targets we must price but
	 * never select). */
	buildRequest?: (parts: AiCallParts) => BuiltRequest;
}

const ANTHROPIC_VERSION = '2023-06-01';
/**
 * Thinking-by-default models spend max_tokens on thinking AND answer together;
 * this is the headroom added on top of the caller's answer budget. 2000 answer
 * + 6000 headroom reproduces the 8000 that runs in production today.
 */
export const THINKING_HEADROOM_TOKENS = 6000;

function baseBody(id: string, parts: AiCallParts, maxTokens: number): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: id,
		max_tokens: maxTokens,
		system: parts.system,
		messages: [{ role: 'user', content: parts.user }]
	};
	const output: Record<string, unknown> = {};
	if (parts.schema) output.format = { type: 'json_schema', schema: parts.schema };
	if (Object.keys(output).length > 0) body.output_config = output;
	return body;
}

function withEffort(body: Record<string, unknown>, effort?: string): Record<string, unknown> {
	if (!effort) return body;
	const output = (body.output_config as Record<string, unknown> | undefined) ?? {};
	output.effort = effort;
	body.output_config = output;
	return body;
}

/** Selectable in the admin dropdowns. Order = display order. */
export const SELECTABLE_MODELS: ModelEntry[] = [
	{
		id: 'claude-opus-5',
		provider: 'anthropic',
		label: 'Claude Opus 5',
		description: 'Deepest reasoning; batch enrichment quality ceiling',
		pricing: [{ fromUtc: '2020-01-01T00:00:00Z', inPerMTok: 5, outPerMTok: 25 }],
		buildRequest(parts) {
			// Opus 5 thinks by default; adaptive is stated explicitly for
			// legibility. max_tokens covers thinking + answer, hence headroom.
			// fallbacks:'default' re-runs a safety-classifier decline on the
			// server's recommended model instead of burning a 7-day error lane;
			// the scalar form is gated by the -2026-07-01 header specifically.
			const body = withEffort(
				baseBody(this.id, parts, parts.maxOutputTokens + THINKING_HEADROOM_TOKENS),
				parts.effort ?? 'medium'
			);
			body.thinking = { type: 'adaptive' };
			body.fallbacks = 'default';
			return {
				headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' },
				body
			};
		}
	},
	{
		id: 'claude-sonnet-5',
		provider: 'anthropic',
		label: 'Claude Sonnet 5',
		description: 'Near-Opus quality at Sonnet cost; intro pricing to Aug 31',
		pricing: [
			// Intro $2/$10 through 2026-08-31 US/Pacific; boundary expressed as
			// the exact UTC instant of midnight Pacific (PDT, UTC-7).
			{ fromUtc: '2020-01-01T00:00:00Z', inPerMTok: 2, outPerMTok: 10 },
			{ fromUtc: '2026-09-01T07:00:00Z', inPerMTok: 3, outPerMTok: 15 }
		],
		buildRequest(parts) {
			// Adaptive is Sonnet 5's default AND its only on-mode; stated
			// explicitly. Thinks by default → headroom applies. No fallbacks.
			const body = withEffort(
				baseBody(this.id, parts, parts.maxOutputTokens + THINKING_HEADROOM_TOKENS),
				parts.effort ?? 'medium'
			);
			body.thinking = { type: 'adaptive' };
			return { headers: {}, body };
		}
	},
	{
		id: 'claude-sonnet-4-6',
		provider: 'anthropic',
		label: 'Claude Sonnet 4.6',
		description: 'Previous Sonnet; no thinking spend, proven on this pipeline',
		pricing: [{ fromUtc: '2020-01-01T00:00:00Z', inPerMTok: 3, outPerMTok: 15 }],
		buildRequest(parts) {
			// 4.6 does NOT think when `thinking` is omitted — omit it, and the
			// answer budget IS the max_tokens. Effort is supported.
			return {
				headers: {},
				body: withEffort(baseBody(this.id, parts, parts.maxOutputTokens), parts.effort)
			};
		}
	},
	{
		id: 'claude-haiku-4-5',
		provider: 'anthropic',
		label: 'Claude Haiku 4.5',
		description: 'Fastest and cheapest; fine for simple surfaces',
		pricing: [{ fromUtc: '2020-01-01T00:00:00Z', inPerMTok: 1, outPerMTok: 5 }],
		buildRequest(parts) {
			// Haiku 4.5: no adaptive thinking, and `effort` is REJECTED — the
			// caller's preference is dropped here, deliberately.
			return { headers: {}, body: baseBody(this.id, parts, parts.maxOutputTokens) };
		}
	}
];

/**
 * Priceable but never selectable. claude-opus-4-8 is where Opus 5's
 * fallbacks:'default' currently routes — but routing is server-defined, so the
 * meter also needs a graceful path for models neither list knows (rate
 * unavailable, never NaN, never $0).
 */
export const PRICING_ONLY_MODELS: ModelEntry[] = [
	{
		id: 'claude-opus-4-8',
		provider: 'anthropic',
		label: 'Claude Opus 4.8',
		description: 'Fallback target only',
		pricing: [{ fromUtc: '2020-01-01T00:00:00Z', inPerMTok: 5, outPerMTok: 25 }]
	}
];

const ALL_MODELS = [...SELECTABLE_MODELS, ...PRICING_ONLY_MODELS];

/** Compiled defaults — the values the constants used to be. */
export const DEFAULT_MODEL_IDS = {
	enrichment: 'claude-opus-5',
	guidance: 'claude-sonnet-4-6'
} as const;

export function modelById(id: string): ModelEntry | undefined {
	return ALL_MODELS.find((m) => m.id === id);
}

/**
 * Resolve a stored config value to a SELECTABLE entry, falling back to the
 * compiled default on anything unknown. This guards two real cases beyond bad
 * input: a registry entry removed in a later deploy while app_config still
 * names it, and a manual UPDATE. Never build a request for an id the registry
 * doesn't know.
 */
export function resolveModel(
	configValue: unknown,
	defaultId: string
): ModelEntry {
	const fallback = SELECTABLE_MODELS.find((m) => m.id === defaultId) ?? SELECTABLE_MODELS[0];
	if (configValue == null || typeof configValue !== 'object') return fallback;
	const id = (configValue as { model?: unknown }).model;
	if (typeof id !== 'string') return fallback;
	const entry = SELECTABLE_MODELS.find((m) => m.id === id);
	if (!entry || !entry.buildRequest) {
		console.warn(`ai-models: stored model "${id}" not selectable; using ${fallback.id}`);
		return fallback;
	}
	return entry;
}

/** Auth + protocol headers, merged at FETCH time only — never in the registry. */
export function anthropicHeaders(apiKey: string, beta: Record<string, string>): Record<string, string> {
	return {
		'x-api-key': apiKey,
		'anthropic-version': ANTHROPIC_VERSION,
		'content-type': 'application/json',
		...beta
	};
}

/* ------------------------------------------------------------------ */
/* Envelope extraction                                                 */
/* ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */

function tokensOf(u: any): Pick<
	CallEnvelope,
	| 'inputTokens'
	| 'outputTokens'
	| 'thinkingTokens'
	| 'cacheReadTokens'
	| 'cacheWrite5mTokens'
	| 'cacheWrite1hTokens'
> {
	const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
	// cache_creation may arrive as the split object or only as the flat total;
	// when only the total exists, attribute it to the 5m column (the common
	// TTL) rather than losing it — collapsing the split the other way is what
	// makes history unpriceable.
	const split = u?.cache_creation;
	const flat = num(u?.cache_creation_input_tokens);
	const w5 = num(split?.ephemeral_5m_input_tokens);
	const w1 = num(split?.ephemeral_1h_input_tokens);
	return {
		inputTokens: num(u?.input_tokens),
		outputTokens: num(u?.output_tokens),
		thinkingTokens: num(u?.output_tokens_details?.thinking_tokens),
		cacheReadTokens: num(u?.cache_read_input_tokens),
		cacheWrite5mTokens: w5 ?? (w1 == null ? flat : null),
		cacheWrite1hTokens: w1
	};
}

/**
 * One envelope per billed-or-event attempt.
 *
 * The discriminator is NOT "usage.iterations present" — the API can attach
 * iterations to ordinary responses (observed: a single all-zero 'message'
 * entry beside nonzero top-level usage; pricing the iteration would record $0
 * for a real call). Iterations are authoritative only when they describe a
 * fallback: an entry of type 'fallback_message', or >1 entries with nonzero
 * tokens. Otherwise the top-level usage is the single attempt.
 */
export function extractEnvelope(data: any): CallEnvelope[] {
	const iterations: any[] = Array.isArray(data?.usage?.iterations) ? data.usage.iterations : [];
	const hasTokens = (e: any) =>
		(e?.usage?.input_tokens ?? e?.input_tokens ?? 0) > 0 ||
		(e?.usage?.output_tokens ?? e?.output_tokens ?? 0) > 0;
	const meaningful =
		iterations.some((e) => e?.type === 'fallback_message') ||
		(iterations.length > 1 && iterations.some(hasTokens));

	if (meaningful) {
		return iterations.map((e, i) => {
			const usage = e?.usage ?? e;
			const isFinal = i === iterations.length - 1;
			const t = tokensOf(usage);
			return {
				attemptIndex: i,
				attemptType: typeof e?.type === 'string' ? e.type : null,
				isFinal,
				servedModel:
					typeof e?.model === 'string' ? e.model : isFinal ? (data?.model ?? null) : null,
				stopReason: isFinal ? (data?.stop_reason ?? null) : (e?.stop_reason ?? null),
				// Reported != charged: only attempts that produced output are billed.
				billed: (t.outputTokens ?? 0) > 0,
				...t
			};
		});
	}

	const t = tokensOf(data?.usage);
	return [
		{
			attemptIndex: 0,
			attemptType: null,
			isFinal: true,
			servedModel: data?.model ?? null,
			stopReason: data?.stop_reason ?? null,
			// A pre-output refusal is a 200 with usage and output 0 — an event
			// row, not spend.
			billed: (t.outputTokens ?? 0) > 0,
			...t
		}
	];
}

/* ------------------------------------------------------------------ */
/* Pricing — the formula written once, used everywhere                 */
/* ------------------------------------------------------------------ */

function windowFor(entry: ModelEntry, at: Date): PricingWindow {
	let chosen = entry.pricing[0];
	for (const w of entry.pricing) {
		if (new Date(w.fromUtc).getTime() <= at.getTime()) chosen = w;
	}
	return chosen;
}

/**
 * Rate lookup by served model with FAMILY-PREFIX matching, not exact string:
 * if the API ever returns a dated variant (claude-opus-4-8-YYYYMMDD), exact
 * matching would turn every fallback row into "rate unavailable" and the
 * meter would read $0 on real spend. Longest matching registry-id prefix wins.
 */
export function rateFor(servedModel: string | null, at: Date): PricingWindow | null {
	if (!servedModel) return null;
	let best: ModelEntry | null = null;
	for (const m of ALL_MODELS) {
		if (servedModel === m.id || servedModel.startsWith(`${m.id}-`)) {
			if (!best || m.id.length > best.id.length) best = m;
		}
	}
	return best ? windowFor(best, at) : null;
}

export interface PriceableRow {
	billed: boolean;
	served_model: string | null;
	at: Date;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_5m_tokens: number | null;
	cache_write_1h_tokens: number | null;
}

/**
 * dollars(row) — the ONE formula (plan §cost formula):
 *   input*in + cacheRead*in*0.1 + cacheWrite5m*in*1.25 + cacheWrite1h*in*2 + output*out
 * Never adds thinking (a breakdown of output). Returns:
 *   0     for billed=false event rows (genuinely $0 — refusals may say so)
 *   null  for unpriceable rows: NULL core tokens (aborts — rendered "—",
 *         never $0.00, which would read as a receipt for a free call) or an
 *         unknown served model ("rate unavailable").
 */
export function dollarsForRow(row: PriceableRow): number | null {
	if (!row.billed) return 0;
	if (row.input_tokens == null || row.output_tokens == null) return null;
	const rate = rateFor(row.served_model, row.at);
	if (!rate) return null;
	const inR = rate.inPerMTok / 1_000_000;
	const outR = rate.outPerMTok / 1_000_000;
	return (
		row.input_tokens * inR +
		(row.cache_read_tokens ?? 0) * inR * 0.1 +
		(row.cache_write_5m_tokens ?? 0) * inR * 1.25 +
		(row.cache_write_1h_tokens ?? 0) * inR * 2 +
		row.output_tokens * outR
	);
}

/**
 * The metering chokepoint (td-015838/td-09be7a): every AI call in the app —
 * worker enrichment, web guidance, admin compare — goes through meteredAiCall,
 * which resolves the model PER CALL from config, owns the timeout signal, and
 * records exactly one ledger call (one row per attempt) on success AND on
 * every failure shape. Forgetting to record at a future call site becomes
 * unrepresentable: if it talks to a provider, it goes through here.
 *
 * Why the resolution is per call: the worker has no push channel (jobs
 * polling only), so a dropdown change takes effect at the NEXT call — a PK
 * read on a two-row table, consistent with the poll-and-reconcile house style.
 */
import {
	resolveModel,
	type AiCallEnvelope,
	type ModelEntry
} from './ai-models';
import { getConfig } from './app-config';
import { recordUsage, type AiPurpose } from './ai-usage';

export interface MeteredAiCallOpts<T> {
	purpose: AiPurpose;
	/** app_config key holding the model choice (CONFIG_KEYS.*). Required
	 * unless modelOverride is set. */
	configKey?: string;
	/** Compiled default id (DEFAULT_MODEL_IDS.*). Required unless
	 * modelOverride is set. */
	defaultModelId?: string;
	/** Explicit model — the compare runner's isolation from the dropdowns:
	 * comparing must never read or disturb the configured choice. */
	modelOverride?: ModelEntry;
	speciesCode?: string | null;
	jobId?: number | null;
	/** The chokepoint OWNS the timeout (GROK P1-8): consumers must use the
	 * provided signal instead of hardcoding their own AbortSignal.timeout. */
	timeoutMs: number;
	/**
	 * Perform the API call with the resolved model. MUST return the parsed
	 * result plus the call envelope; on throw, the error SHOULD carry
	 * `.envelope: AiCallEnvelope` (EnrichmentAiError / GuidanceError do) —
	 * a throw without one is recorded as an unknown-spend event row.
	 */
	run: (model: ModelEntry, signal: AbortSignal) => Promise<{ result: T; envelope: AiCallEnvelope }>;
}

/**
 * The attempt object (CODEX1 P1-4): provenance travels WITH the result.
 * job-handlers' keep-best retry loop swaps whole attempt objects, and
 * upsertAiData stamps the kept attempt's servedModel — never "the model most
 * recently resolved", which can differ when config changes between retries or
 * a fallback serves the response.
 */
export interface AiAttempt<T> {
	result: T;
	requestedModel: string;
	/** The final attempt's served model — under Opus 5 server-side fallbacks
	 * this can differ from requestedModel; it is what provenance stamps. */
	servedModel: string | null;
	envelope: AiCallEnvelope;
}

export async function meteredAiCall<T>(opts: MeteredAiCallOpts<T>): Promise<AiAttempt<T>> {
	let model: ModelEntry;
	if (opts.modelOverride) {
		model = opts.modelOverride;
	} else if (!opts.configKey || !opts.defaultModelId) {
		// Programmer error, not a runtime condition — thrown before any spend.
		throw new Error('meteredAiCall: configKey + defaultModelId required without modelOverride');
	} else {
		// getConfig never throws by contract; the catch is belt-and-braces so a
		// contract regression still cannot take the AI stage down with it.
		const stored = await getConfig(opts.configKey, {
			provider: 'anthropic',
			model: opts.defaultModelId
		}).catch(() => null);
		model = resolveModel(stored, opts.defaultModelId);
	}

	const signal = AbortSignal.timeout(opts.timeoutMs);
	const started = Date.now();
	try {
		const { result, envelope } = await opts.run(model, signal);
		await record(opts, model, envelope, Date.now() - started, true, null);
		return {
			result,
			requestedModel: model.id,
			servedModel: finalServedModel(envelope),
			envelope
		};
	} catch (err) {
		const envelope = envelopeOf(err);
		await record(
			opts,
			model,
			envelope,
			Date.now() - started,
			false,
			err instanceof Error ? err.message : String(err)
		);
		throw err;
	}
}

function finalServedModel(envelope: AiCallEnvelope): string | null {
	return envelope.attempts.find((a) => a.isFinal)?.servedModel ?? null;
}

function envelopeOf(err: unknown): AiCallEnvelope {
	const e = (err as { envelope?: AiCallEnvelope } | null)?.envelope;
	if (e && Array.isArray(e.attempts)) return e;
	// No envelope (network error, abort before headers): unknown spend —
	// recordUsage synthesizes the NULL-token event row.
	return { requestId: null, httpStatus: null, providerErrorType: null, attempts: [] };
}

async function record<T>(
	opts: MeteredAiCallOpts<T>,
	model: ModelEntry,
	envelope: AiCallEnvelope,
	durationMs: number,
	ok: boolean,
	error: string | null
): Promise<void> {
	// recordUsage never throws by contract; the catch is belt-and-braces —
	// the metered call matters more than its receipt, in BOTH directions.
	await recordUsage({
		requestedModel: model.id,
		purpose: opts.purpose,
		speciesCode: opts.speciesCode ?? null,
		jobId: opts.jobId ?? null,
		requestId: envelope.requestId,
		httpStatus: envelope.httpStatus,
		providerErrorType: envelope.providerErrorType,
		durationMs,
		ok,
		error,
		attempts: envelope.attempts
	}).catch((err) => {
		console.error('ai-call: recordUsage rejected', err instanceof Error ? err.message : err);
	});
}

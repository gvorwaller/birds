/**
 * LLM field-guidance (Phase 3): short, hedged per-stop birding tips that
 * correlate a stop's target species with the weather + time of year. The model
 * supplies species natural history from its own knowledge; the eBird/weather
 * inputs stay authoritative. Strictly framed as "suggestions to verify" — the
 * model is told never to invent specific sightings or uncertain facts.
 *
 * Model comes from app_config (`ai.model.guidance`, compiled default
 * DEFAULT_MODEL_IDS.guidance) via the registry; every call is metered through
 * meteredAiCall (td-015838/td-09be7a). Deliberately NO structured outputs in
 * v1 — the array-root JSON contract below works, and converting it is a
 * behavior change with its own test burden (plan decision).
 *
 * The key is read from $env and never logged.
 */
import { env } from '$env/dynamic/private';
import type { WeatherResult } from '$server/weather';
import {
	anthropicHeaders,
	extractEnvelope,
	type AiCallEnvelope,
	type ModelEntry
} from './ai-models';
import { DEFAULT_MODEL_IDS } from './ai-models';
import { meteredAiCall } from './ai-call';
import { CONFIG_KEYS } from './app-config';

export const GUIDANCE_TIMEOUT_MS = 30_000;
/** Answer budget; thinking-by-default models get their headroom on top. */
export const GUIDANCE_ANSWER_BUDGET_TOKENS = 1500;

export class GuidanceError extends Error {
	/**
	 * The shared call envelope (CODEX1 P1-3), set on every throw once a
	 * response exists — the refusal and malformed-200 throws used to discard
	 * model/usage/stop_reason, the same bug fixed on the enrichment side.
	 * Absent only when no response arrived.
	 */
	envelope?: AiCallEnvelope;
}

interface StopInput {
	id: number;
	name: string;
	notes: string | null; // planner stops embed the trigger species here
}

interface FieldTipsInput {
	tripName: string;
	stops: StopInput[];
	weather: WeatherResult | null;
	now: Date;
}

const SYSTEM =
	'You are a birding field-guidance assistant. Give short, practical, HEDGED ' +
	"suggestions a birder can verify in the field. Base bird behavior only on " +
	'well-established natural history (time-of-day activity, habitat, foraging, ' +
	'weather/wind/tide sensitivity). Never invent specific recent sightings or ' +
	"facts you're unsure of. Keep each tip to 1–2 sentences.";

function weatherBlock(w: WeatherResult | null): string {
	if (!w || w.periods.length === 0) return 'No weather data available.';
	return w.periods
		.map(
			(p) =>
				`${p.name}: ${p.tempF}°F, ${p.shortForecast}, wind ${p.windDirection} ${p.windSpeed}` +
				(p.precipPct != null ? `, ${p.precipPct}% precip` : '')
		)
		.join('\n');
}

function buildUserText(input: FieldTipsInput): string {
	const stopsText = input.stops
		.map((s, i) => `${i + 1}. ${s.name}${s.notes ? ` — ${s.notes}` : ''}`)
		.join('\n');
	return (
		`Trip: ${input.tripName}\n` +
		`Date: ${input.now.toISOString().slice(0, 10)}\n\n` +
		`Weather near the trip:\n${weatherBlock(input.weather)}\n\n` +
		`Stops (in order):\n${stopsText}\n\n` +
		`For each stop, give ONE short field tip (1–2 sentences) to improve the odds ` +
		`on the target birds, grounded in the species' well-known natural history and ` +
		`the weather/time of year. Hedge everything ("likely", "try", "often") — these ` +
		`are suggestions to verify, not guarantees. Note which factor each tip leans on ` +
		`(a species trait or the weather). If a stop has no clear target, give a brief ` +
		`general tip.\n\n` +
		`Respond with ONLY a JSON array, one object per stop in the same order: ` +
		`[{"n": <stop number>, "tip": "<tip>"}]. No text outside the JSON.`
	);
}

type Fetcher = typeof fetch;

/**
 * One batched call with the given registry model → a hedged tip per stop.
 * Returns tips + envelope; throws GuidanceError (user-safe message) carrying
 * the envelope whenever a response existed. `opts.signal` is expected from
 * the metering chokepoint (GROK P1-8).
 */
export async function generateFieldTips(
	input: FieldTipsInput,
	model: ModelEntry,
	opts: { fetcher?: Fetcher; signal?: AbortSignal } = {}
): Promise<{ tips: Record<number, string>; envelope: AiCallEnvelope }> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new GuidanceError('AI tips are not configured (no API key set).');
	if (!model.buildRequest) {
		throw new GuidanceError('The configured AI model is unavailable.');
	}

	// No schema: free text under the array-root JSON contract in the prompt.
	const built = model.buildRequest({
		system: SYSTEM,
		user: buildUserText(input),
		maxOutputTokens: GUIDANCE_ANSWER_BUDGET_TOKENS
	});
	const fetcher = opts.fetcher ?? fetch;
	let res: Response;
	try {
		res = await fetcher('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: anthropicHeaders(apiKey, built.headers),
			body: JSON.stringify(built.body),
			signal: opts.signal ?? AbortSignal.timeout(GUIDANCE_TIMEOUT_MS)
		});
	} catch {
		throw new GuidanceError('Could not reach the AI service — try again shortly.');
	}

	// A response exists: every throw from here carries the envelope.
	const envelope: AiCallEnvelope = {
		requestId: res.headers.get('request-id'),
		httpStatus: res.status,
		providerErrorType: null,
		attempts: []
	};
	const fail = (e: GuidanceError): never => {
		e.envelope = envelope;
		throw e;
	};

	/* eslint-disable @typescript-eslint/no-explicit-any */
	if (!res.ok) {
		envelope.providerErrorType = await res
			.json()
			.then((b: any) => (typeof b?.error?.type === 'string' ? b.error.type : null))
			.catch(() => null);
		if (res.status === 401) fail(new GuidanceError('The AI API key is missing or invalid.'));
		if (res.status === 429)
			fail(new GuidanceError('AI service is rate-limited — try again shortly.'));
		fail(new GuidanceError(`AI service error (${res.status}).`));
	}

	let data: any;
	try {
		data = await res.json();
	} catch {
		fail(new GuidanceError('The AI response could not be read — try again.'));
	}
	envelope.attempts = extractEnvelope(data);
	if (data.stop_reason === 'refusal') {
		fail(new GuidanceError('The AI declined to answer for this request.'));
	}
	const text: string = (data.content ?? [])
		.filter((b: any) => b.type === 'text')
		.map((b: any) => b.text)
		.join('')
		.trim();
	/* eslint-enable @typescript-eslint/no-explicit-any */

	let arr: { n: number; tip: string }[];
	try {
		const start = text.indexOf('[');
		const end = text.lastIndexOf(']');
		if (start < 0 || end < 0) throw new Error('no array');
		arr = JSON.parse(text.slice(start, end + 1));
	} catch {
		fail(new GuidanceError('The AI response could not be read — try again.'));
		throw new Error('unreachable'); // fail() always throws; satisfies TS flow
	}

	const tips: Record<number, string> = {};
	for (const item of arr) {
		const idx = Number(item?.n) - 1;
		const stop = input.stops[idx];
		if (stop && typeof item?.tip === 'string' && item.tip.trim()) {
			tips[stop.id] = item.tip.trim();
		}
	}
	return { tips, envelope };
}

/**
 * The trips action's entry point: config-resolved model, metered call.
 * Empty stop lists return without touching the API OR the ledger — metering
 * is per API call, and no call happens here.
 */
export async function fieldTipsForTrip(input: FieldTipsInput): Promise<Record<number, string>> {
	if (input.stops.length === 0) return {};
	const attempt = await meteredAiCall({
		purpose: 'guidance',
		configKey: CONFIG_KEYS.guidanceModel,
		defaultModelId: DEFAULT_MODEL_IDS.guidance,
		timeoutMs: GUIDANCE_TIMEOUT_MS,
		run: async (model, signal) => {
			const { tips, envelope } = await generateFieldTips(input, model, { signal });
			return { result: tips, envelope };
		}
	});
	return attempt.result;
}

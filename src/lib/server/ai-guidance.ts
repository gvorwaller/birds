/**
 * LLM field-guidance (Phase 3): short, hedged per-stop birding tips that
 * correlate a stop's target species with the weather + time of year. The model
 * supplies species natural history from its own knowledge; the eBird/weather
 * inputs stay authoritative. Strictly framed as "suggestions to verify" — the
 * model is told never to invent specific sightings or uncertain facts.
 *
 * Direct call to the Anthropic Messages API (no SDK dependency). The key is read
 * from $env and never logged.
 */
import { env } from '$env/dynamic/private';
import type { WeatherResult } from '$server/weather';

const MODEL = 'claude-sonnet-4-6';

export class GuidanceError extends Error {}

interface StopInput {
	id: number;
	name: string;
	notes: string | null; // planner stops embed the trigger species here
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

/**
 * One batched call → a hedged tip per stop. Returns a map of stopId → tip text.
 * Throws GuidanceError (with a user-safe message) on any failure.
 */
export async function generateFieldTips(input: {
	tripName: string;
	stops: StopInput[];
	weather: WeatherResult | null;
	now: Date;
}): Promise<Record<number, string>> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new GuidanceError('AI tips are not configured (no API key set).');
	if (input.stops.length === 0) return {};

	const stopsText = input.stops
		.map((s, i) => `${i + 1}. ${s.name}${s.notes ? ` — ${s.notes}` : ''}`)
		.join('\n');

	const userText =
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
		`[{"n": <stop number>, "tip": "<tip>"}]. No text outside the JSON.`;

	let res: Response;
	try {
		res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 1500,
				system: SYSTEM,
				messages: [{ role: 'user', content: userText }]
			}),
			signal: AbortSignal.timeout(30000)
		});
	} catch {
		throw new GuidanceError('Could not reach the AI service — try again shortly.');
	}

	if (res.status === 401) throw new GuidanceError('The AI API key is missing or invalid.');
	if (res.status === 429) throw new GuidanceError('AI service is rate-limited — try again shortly.');
	if (!res.ok) throw new GuidanceError(`AI service error (${res.status}).`);

	/* eslint-disable @typescript-eslint/no-explicit-any */
	const data = (await res.json()) as any;
	if (data.stop_reason === 'refusal') {
		throw new GuidanceError('The AI declined to answer for this request.');
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
		throw new GuidanceError('The AI response could not be read — try again.');
	}

	const out: Record<number, string> = {};
	for (const item of arr) {
		const idx = Number(item?.n) - 1;
		const stop = input.stops[idx];
		if (stop && typeof item?.tip === 'string' && item.tip.trim()) {
			out[stop.id] = item.tip.trim();
		}
	}
	return out;
}

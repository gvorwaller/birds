/**
 * HTTP helpers shared by every connector (td-99eebf; moved from
 * artsobs/artskart.ts unchanged): injectable fetch and sleep, an abortable
 * sleep, and Retry-After parsing.
 */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export const abortableSleep: SleepFn = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const t = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});

/** Retry-After as seconds or an HTTP date, capped at two minutes; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
	if (!header) return null;
	const secs = Number(header);
	const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
	return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 120_000) : null;
}

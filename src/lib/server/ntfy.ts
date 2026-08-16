/**
 * ntfy.sh publisher (plan A3). The topic is a CAPABILITY — whoever knows it
 * can send to (and on the public server, read) the user's alerts. Sacred
 * handling mirrors eBird credentials: never in payloads/events/results/
 * progress, and NEVER inside error messages or URLs that could be recorded
 * (CODEX1 #4) — NtfyError carries only a status.
 */

export const NTFY_TIMEOUT_MS = 10_000;
const NTFY_BASE = 'https://ntfy.sh';

/** Long-random topic names only — reject URLs, whitespace, short guessables. */
export function validNtfyTopic(topic: string): boolean {
	return /^[A-Za-z0-9_-]{8,64}$/.test(topic);
}

export class NtfyError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
		this.name = 'NtfyError';
	}
}

export interface NtfyMessage {
	title: string;
	body: string;
	/** ABSOLUTE URL (notification clients have no origin to resolve against). */
	clickUrl?: string;
	tags?: string[];
}

export async function sendNtfy(
	topic: string,
	msg: NtfyMessage,
	fetcher: typeof fetch = fetch
): Promise<void> {
	if (!validNtfyTopic(topic)) {
		throw new NtfyError('invalid ntfy topic (not sent)', 0);
	}
	// JSON publish, not the header API (CODEX1): HTTP header values are
	// ByteStrings, so a Title carrying a non-Latin-1 bird name (ʻAkikiki)
	// throws in undici and the alert is silently lost. The JSON body is
	// UTF-8. Bonus: the topic rides in the body, never in a URL.
	let res: Response;
	try {
		res = await fetcher(NTFY_BASE, {
			method: 'POST',
			body: JSON.stringify({
				topic,
				title: msg.title,
				message: msg.body,
				...(msg.clickUrl ? { click: msg.clickUrl } : {}),
				...(msg.tags?.length ? { tags: msg.tags } : {})
			}),
			headers: { 'Content-Type': 'application/json' },
			signal: AbortSignal.timeout(NTFY_TIMEOUT_MS)
		});
	} catch {
		// Deliberately no cause/URL in the message — it could carry the topic.
		throw new NtfyError('could not reach ntfy', 0);
	}
	if (!res.ok) {
		throw new NtfyError(`ntfy returned HTTP ${res.status}`, res.status);
	}
}

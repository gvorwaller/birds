/**
 * Web Push publisher for the installed birds PWA (channel change from ntfy,
 * Gaylon 2026-08-16). A push subscription's endpoint URL is a CAPABILITY —
 * holder of it (plus the VAPID key) can push to that device — so endpoints
 * never appear in error messages, events, results, or logs; typed errors
 * carry only a status code, same discipline as the eBird credentials.
 */
import { env } from '$env/dynamic/private';
import webpush from 'web-push';

export const PUSH_TIMEOUT_MS = 10_000;

export interface PushSubscriptionRow {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export interface PushMessage {
	title: string;
	body: string;
	/** ABSOLUTE URL the notification opens. */
	url?: string;
	/** Collapse key — same tag replaces, not stacks. */
	tag?: string;
}

/**
 * Endpoint validation for save-time (CODEX1: an attacker-chosen https URL +
 * offline-generated key material is authenticated blind SSRF from this
 * host). Only the push-service origins real browsers hand out are accepted —
 * Apple (Safari/iOS PWA), FCM (Chrome/Edge/Brave), Mozilla (Firefox),
 * WNS (Edge legacy) — with structural checks: no credentials, no fragment,
 * default port only, sane length.
 */
const PUSH_HOST_ALLOW: RegExp[] = [
	/(^|\.)push\.apple\.com$/,
	/^fcm\.googleapis\.com$/,
	/(^|\.)push\.services\.mozilla\.com$/,
	/(^|\.)notify\.windows\.com$/
];

export function validPushEndpoint(raw: string): boolean {
	if (raw.length < 20 || raw.length > 1024) return false;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	if (u.username || u.password || u.hash) return false;
	if (u.port !== '') return false; // default 443 only
	return PUSH_HOST_ALLOW.some((re) => re.test(u.hostname));
}

/** P-256 uncompressed point (65 bytes) / 16-byte auth secret, base64url. */
const B64URL = /^[A-Za-z0-9_-]+$/;
export function validPushKeys(p256dh: string, auth: string): boolean {
	return (
		B64URL.test(p256dh) &&
		p256dh.length >= 80 &&
		p256dh.length <= 100 &&
		B64URL.test(auth) &&
		auth.length >= 16 &&
		auth.length <= 30
	);
}

export class PushError extends Error {
	constructor(
		message: string,
		public status: number,
		/** 404/410: the subscription is dead — prune it. */
		public gone: boolean
	) {
		super(message);
		this.name = 'PushError';
	}
}

let configured = false;
function ensureConfigured(): void {
	if (configured) return;
	const pub = env.VAPID_PUBLIC_KEY;
	const priv = env.VAPID_PRIVATE_KEY;
	if (!pub || !priv) {
		throw new PushError('VAPID keys are not configured', 0, false);
	}
	webpush.setVapidDetails(env.VAPID_SUBJECT ?? 'mailto:gaylon@vorwaller.net', pub, priv);
	configured = true;
}

export function vapidPublicKey(): string | null {
	return env.VAPID_PUBLIC_KEY ?? null;
}

type Sender = (
	sub: { endpoint: string; keys: { p256dh: string; auth: string } },
	payload: string,
	options: { TTL: number; timeout: number }
) => Promise<unknown>;

/**
 * Send one push to one device. Throws typed PushError; 404/410 mark the
 * subscription GONE (caller prunes). The injected sender exists for tests;
 * the default is the real web-push library, timeout-bounded.
 */
export async function sendWebPush(
	sub: PushSubscriptionRow,
	msg: PushMessage,
	sender: Sender = (s, p, o) => webpush.sendNotification(s, p, o)
): Promise<void> {
	ensureConfigured();
	const payload = JSON.stringify({
		title: msg.title,
		body: msg.body,
		...(msg.url ? { url: msg.url } : {}),
		...(msg.tag ? { tag: msg.tag } : {})
	});
	try {
		await sender(
			{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
			payload,
			{ TTL: 3600, timeout: PUSH_TIMEOUT_MS }
		);
	} catch (err) {
		const status =
			typeof (err as { statusCode?: unknown })?.statusCode === 'number'
				? ((err as { statusCode: number }).statusCode as number)
				: 0;
		// Deliberately no endpoint/URL in the message.
		throw new PushError(
			status > 0 ? `push endpoint returned HTTP ${status}` : 'could not reach the push service',
			status,
			status === 404 || status === 410
		);
	}
}

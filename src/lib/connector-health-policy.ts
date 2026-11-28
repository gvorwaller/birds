/**
 * Sightings connectors' health (td-afba28, plan
 * docs/2026-11-27-connector-health-plan-CC.md): the pure parts — what a
 * connector's last check-in means, and the owner's offline / back-online push
 * wording. The worker side is $server/external-sources/refresh.ts; the
 * check-in itself is recorded by $server/external-sources/auth.ts.
 */

/** Checked in this recently: online. A polling connector calls every 10 s, a loading one at least every 60 s. */
export const CONNECTOR_ONLINE_MS = 2 * 60_000;

/** Not heard from for longer than this: offline (and given no automatic loads). */
export const CONNECTOR_OFFLINE_MS = 5 * 60_000;

/** Offline this long, and still offline at a check, before the owner is told. */
export const CONNECTOR_ALERT_AFTER_MS = 15 * 60_000;

/** Back-online events are reconciled for outages closed this recently. */
export const CONNECTOR_ONLINE_RECONCILE_MS = 24 * 60 * 60_000;

export type ConnectorState = 'online' | 'quiet' | 'offline' | 'never';

export function connectorState(lastSeenAt: string | Date | null, now: string | Date): ConnectorState {
	if (lastSeenAt == null) return 'never';
	const age = new Date(now).getTime() - new Date(lastSeenAt).getTime();
	if (age <= CONNECTOR_ONLINE_MS) return 'online';
	if (age <= CONNECTOR_OFFLINE_MS) return 'quiet';
	return 'offline';
}

/** The badge words, the same on Server health and Sources (AGY4 [A-4]). */
export const CONNECTOR_STATE_LABEL: Record<ConnectorState, string> = {
	online: 'Online',
	quiet: 'Quiet',
	offline: 'Offline',
	never: 'Never checked in'
};

export const CONNECTOR_STATE_TONE: Record<ConnectorState, 'ok' | 'warn' | 'error'> = {
	online: 'ok',
	quiet: 'warn',
	offline: 'error',
	never: 'warn'
};

/** "40 s", "18 min", "3 h 10 min", "2 d 4 h" (AGY4 [A-3]). */
export function spanWords(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function connectorPush(
	a:
		| { kind: 'connector_offline'; countryName: string; lastSeenAt: Date; now: Date }
		| { kind: 'connector_online'; countryName: string; lastSeenAt: Date; closedAt: Date }
): { title: string; body: string } {
	if (a.kind === 'connector_offline') {
		return {
			title: `${a.countryName} connector offline`,
			body: `Last heard from ${spanWords(a.now.getTime() - a.lastSeenAt.getTime())} ago. Loads wait until it's back.`
		};
	}
	return {
		title: `${a.countryName} connector back online`,
		// From the last check-in before the outage to the recorded recovery, not the send time.
		body: `It was offline for ${spanWords(a.closedAt.getTime() - a.lastSeenAt.getTime())}.`
	};
}

/** Where a tap on either connector push lands: the Server health card. */
export const CONNECTOR_ALERT_PATH = '/admin?tab=health#sys-connectors';

/** One tag per source for both kinds, so "back online" replaces a stale "offline" banner (AGY4 [A-3]). */
export function connectorAlertTag(sourceId: string): string {
	return `ext-${sourceId}-connector`;
}

/** A reported build version: a git SHA (short or full) or "dev". */
export function isConnectorVersion(v: unknown): v is string {
	return typeof v === 'string' && /^([0-9a-f]{7,40}|dev)$/.test(v);
}

/**
 * A reported process start time, or null when it isn't believable: more than
 * 5 minutes in the future or more than a year old.
 */
export function parseConnectorStarted(v: unknown, now = new Date()): Date | null {
	if (typeof v !== 'string' || v.length > 40) return null;
	const t = Date.parse(v);
	if (!Number.isFinite(t)) return null;
	if (t > now.getTime() + 5 * 60_000) return null;
	if (t < now.getTime() - 366 * 24 * 60 * 60_000) return null;
	return new Date(t);
}

/**
 * The connector last reported a different build than the app's own (short
 * and full SHAs compare alike). Unknown on either side is not a difference.
 */
export function versionDiffers(connector: string | null, app: string | null): boolean {
	if (!connector || !app || connector === 'dev' || app === 'dev') return false;
	return !(connector.startsWith(app) || app.startsWith(connector));
}

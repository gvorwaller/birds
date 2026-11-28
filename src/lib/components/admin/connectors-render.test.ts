/**
 * Server health's "Sightings connectors" card (td-afba28), on the
 * server-rendered markup: each state's badge, the version check, loading and
 * queued work, the refresh line, the outage's notification state, and the
 * link to the source on the Sources tab (a full reload, so the tab switches).
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ConnectorsCard from './ConnectorsCard.svelte';
import type { ConnectorHealth } from '$server/external-sources/connector-health';

const NOW = '2026-11-27T21:00:00.000Z';
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();

function row(over: Partial<ConnectorHealth> = {}): ConnectorHealth {
	return {
		sourceId: 'artportalen',
		name: 'Artportalen',
		countryName: 'Sweden',
		active: true,
		state: 'online',
		lastSeenAt: ago(0.1),
		version: '19e8845',
		startedAt: ago(120),
		loading: [],
		queued: 0,
		lastLoad: { regionName: 'Stockholm', status: 'done', origin: 'auto', finishedAt: ago(120), error: null },
		refreshDays: 7,
		oldestLoaded: { regionName: 'Jönköping', retrievedAt: ago(6 * 24 * 60) },
		outage: null,
		...over
	};
}

const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const show = (rows: ConnectorHealth[], adminHasDevice = true, appVersion = '19e8845') =>
	render(ConnectorsCard, { props: { card: { ok: true, data: { rows, adminHasDevice } }, now: NOW, appVersion } }).body;

describe('Server health → Sightings connectors (td-afba28)', () => {
	it('shows a healthy connector: badge, check-in, work, last load, refresh and process', () => {
		const t = text(show([row()]));
		expect(t).toContain('Artportalen Online');
		expect(t).toContain('Last check-in 6 s ago');
		expect(t).toContain('Doing Waiting for work');
		expect(t).toContain('Last load Stockholm, done 2 h ago (automatic)');
		expect(t).toContain('Refresh Weekly · oldest Jönköping (loaded 6 d ago)');
		expect(t).toMatch(/Process version 19e8845 · up since /);
		expect(t).not.toContain('differs');
		expect(t).not.toContain('Offline since');
	});

	it('flags a version that differs from the app, and says unknown when nothing was reported', () => {
		expect(text(show([row({ version: '03f5c7f' })]))).toContain("Last reported version differs from the app's (19e8845)");
		const t = text(show([row({ version: null, startedAt: null })]));
		expect(t).toContain('version unknown · up since unknown');
		expect(t).not.toContain('differs');
	});

	it('shows every load in progress, an expired lease as such, and what is queued behind them', () => {
		const t = text(
			show([
				row({
					loading: [
						{ regionName: 'Stockholm', status: 'staging', progress: { phase: 'chunks', done: 3, total: 9 }, startedAt: ago(3), expired: false },
						{ regionName: 'Uppsala', status: 'leased', progress: null, startedAt: ago(20), expired: true }
					],
					queued: 2
				})
			])
		);
		expect(t).toContain(
			'Doing Loading Stockholm: chunks 3/9, started 3 min ago · Uppsala: lease expired, awaiting the next check · 2 more queued'
		);
		expect(text(show([row({ state: 'offline', lastSeenAt: ago(30), queued: 1 })]))).toContain('Doing Not checking in · 1 load queued');
	});

	it('shows an open outage with its notification state, the badge kept to one word', () => {
		const out = (notice: NonNullable<ConnectorHealth['outage']>['notice'], device = true) =>
			text(show([row({ state: 'offline', lastSeenAt: ago(40), outage: { since: ago(40), detectedAt: ago(20), notice } })], device));
		expect(out('sent')).toMatch(/Artportalen Offline Last check-in 40 min ago/);
		expect(out('sent')).toMatch(/Offline since .+; notification accepted by the push service for at least one admin device\./);
		expect(out('pending')).toMatch(/; notification pending\./);
		expect(out('pending', false)).toMatch(/; no device to notify\./);
		expect(out('gave_up')).toMatch(/; the notification could not be delivered\./);
	});

	it('words each state, and shows nothing more for a source that is off', () => {
		expect(text(show([row({ state: 'quiet' })]))).toContain('Artportalen Quiet');
		expect(text(show([row({ state: 'never', lastSeenAt: null })]))).toContain('Artportalen Never checked in Last check-in never');
		expect(text(show([row({ state: 'no_token' })]))).toContain('Artportalen No token');
		const off = text(show([row({ state: 'off', active: false, version: '03f5c7f' })]));
		expect(off).toContain('Artportalen Source off');
		expect(off).not.toContain('Last check-in');
		expect(off).not.toContain('differs');
		expect(text(show([row({ refreshDays: null })]))).toContain('Refresh Off');
		expect(text(show([row({ oldestLoaded: null })]))).toContain('Refresh Weekly · no loaded region open for refresh');
	});

	it('links to the source on the Sources tab with a full reload', () => {
		expect(show([row()])).toMatch(/<a href="\/admin\?tab=sources#source-artportalen" data-sveltekit-reload[^>]*>Tokens and loads<\/a>/);
	});

	it('says why the card is missing', () => {
		const body = render(ConnectorsCard, { props: { card: { ok: false, reason: 'Timed out after 3 s.' }, now: NOW, appVersion: 'x' } }).body;
		expect(text(body)).toBe('Unavailable: Timed out after 3 s.');
	});
});

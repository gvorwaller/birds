/**
 * Admin → Sources (td-2219df), checked on the server-rendered markup: every
 * section of a source is a fold with its heading in the summary, Load a
 * region and Loads start open and the rest closed, the match sections stay
 * folds when empty (so an action's result has somewhere to show), and
 * without JavaScript an action's result shows at the top of the tab (the
 * per-section message needs the browser).
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

const nav = vi.hoisted(() => ({ url: new URL('http://localhost/admin?tab=sources') }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return nav.url;
		}
	}
}));
import SourcesPanel from './SourcesPanel.svelte';
import type { AdminSource } from '$server/external-sources/admin';

function source(over: Partial<AdminSource> = {}): AdminSource {
	return {
		id: 'artsobs',
		name: 'Artsobservasjoner',
		publisher: 'Test publisher',
		license: 'CC BY 4.0',
		active: true,
		windowMonths: 24,
		storeObservers: true,
		refreshDays: 7,
		failedRefreshes: [],
		reloadable: 1,
		connectors: [
			{ id: 1, label: 'droplet', createdAt: '2026-10-20T10:00:00Z', lastSeenAt: '2026-10-29T18:00:00Z', revokedAt: null, state: 'online' }
		],
		connectorAsOf: '2026-10-29T18:00:30Z',
		connectorState: 'online',
		outageSince: null,
		regions: [{ code: 'NO-18', name: 'Nordland', open: true, loadedAt: '2026-10-29T12:00:00Z', window: null }],
		loads: [],
		oldestQueuedAt: null,
		overdueLeases: 0,
		unmatched: [
			{
				upstreamTaxonId: '3927',
				canonicalName: 'Columba livia domestica',
				localName: 'bydue',
				reason: 'no_match',
				reports: 97,
				regions: ['NO-18'],
				suggestion: { code: 'rocpig', comName: 'Rock Pigeon', sciName: 'Columba livia' },
				isNew: false
			}
		],
		matched: [
			{
				upstreamTaxonId: '4100',
				canonicalName: 'Corvus corone',
				localName: 'kråke',
				speciesCode: 'carcro1',
				comName: 'Carrion Crow',
				sciName: 'Corvus corone',
				method: 'scientific',
				reports: 4210
			},
			{
				upstreamTaxonId: '3700',
				canonicalName: 'Emberiza schoeniclus',
				localName: 'sivspurv',
				speciesCode: 'reebun',
				comName: 'Reed Bunting',
				sciName: 'Schoeniclus schoeniclus',
				method: 'former_name',
				reports: 204
			}
		],
		overrides: [
			{
				upstreamTaxonId: '227111',
				canonicalName: 'Corvus corone cornix',
				localName: 'gråkråke',
				speciesCode: 'hoocro1',
				comName: 'Hooded Crow',
				setAt: '2026-10-29T18:00:00Z'
			}
		],
		...over
	};
}

/** Each top-level fold: its summary text and whether it starts open. */
function folds(body: string): { title: string; open: boolean }[] {
	const out: { title: string; open: boolean }[] = [];
	for (const m of body.matchAll(/<details class="sec[^"]*"( open)?[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>/g)) {
		const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		out.push({ title, open: Boolean(m[1]) });
	}
	return out;
}
const named = (title: string) => title.replace(/\s*\(.*$/, '').replace(/ (online|quiet|offline|never checked in|no active).*$/, '');

describe('Admin → Sources folds (td-2219df)', () => {
	it('puts every section in a fold, headings kept, only the load sections open', () => {
		const { body } = render(SourcesPanel, { props: { sources: [source()], form: null } });
		const f = folds(body);
		expect(f.map((x) => named(x.title))).toEqual([
			'Reference',
			'Connector',
			'Load a region',
			'Refresh Weekly',
			'Regions open for loading',
			'Loads',
			'Unmatched taxa',
			'Saved matches',
			'Change a match',
			'Re-match species'
		]);
		expect(f.filter((x) => x.open).map((x) => named(x.title))).toEqual(['Load a region', 'Loads']);
		// Every region is open, so the "open for loading" fold stays closed (td-99eebf).
		expect(f.find((x) => x.title.startsWith('Regions open for loading'))?.title).toBe('Regions open for loading (1 of 1)');
		// The headings stay headings inside the summaries.
		expect(body).toMatch(/<summary[^>]*><h3[^>]*>Reference<\/h3><\/summary>/);
		expect(body).toMatch(/<summary[^>]*><h4[^>]*>Re-match species<\/h4><\/summary>/);
		// Counts and the connector state are readable while closed.
		expect(f.find((x) => x.title.startsWith('Unmatched'))?.title).toBe('Unmatched taxa (1)');
		// Measured against the reading's clock (30 s after the check-in), not the test machine's (td-afba28).
		expect(f.find((x) => x.title.startsWith('Connector'))?.title).toBe('Connector online, last seen just now');
		// Nothing is busy on the server: the buttons are live and say what they do.
		expect(body).toContain('Match to Rock Pigeon');
		expect(body).not.toContain('Matching…');
		expect(body).not.toMatch(/<button[^>]*disabled[^>]*>\s*Match to Rock Pigeon/);
	});

	it('keeps the match sections as folds when they are empty', () => {
		const { body } = render(SourcesPanel, {
			props: { sources: [source({ unmatched: [], overrides: [], matched: [] })], form: null }
		});
		const f = folds(body);
		expect(f.find((x) => x.title.startsWith('Unmatched'))).toEqual({ title: 'Unmatched taxa (0)', open: false });
		expect(f.find((x) => x.title.startsWith('Saved'))).toEqual({ title: 'Saved matches (0)', open: false });
		expect(f.find((x) => x.title.startsWith('Change'))).toEqual({ title: 'Change a match (0 matched taxa)', open: false });
		expect(body).toContain('Every loaded taxon matched an eBird species.');
		expect(body).toContain('None yet.');
		expect(body).toContain('No loaded taxon is matched to an eBird species yet.');
	});

	it('starts every region list on "Choose a region…", so one tap never opens or loads the first region (td-99eebf)', () => {
		const regions = [
			{ code: 'SE-K', name: 'Blekinge län', open: false, loadedAt: null, window: null },
			{ code: 'SE-F', name: 'Jönköpings län', open: false, loadedAt: null, window: null },
			{ code: 'SE-AB', name: 'Stockholms län', open: true, loadedAt: null, window: null }
		];
		const { body } = render(SourcesPanel, { props: { sources: [source({ regions })], form: null } });
		const selects = [...body.matchAll(/<select name="region_code"[^>]*>([\s\S]*?)<\/select>/g)].map((m) => m[1]);
		expect(selects).toHaveLength(3); // Load a region, Closed region, Open region
		for (const opts of selects) {
			expect(opts).toMatch(/^\s*(<!--[^>]*-->)?\s*<option value="" disabled(="")? selected(="")?>Choose a region…<\/option>/);
			expect(opts.match(/ selected/g)).toHaveLength(1);
		}
	});

	it('says when no connector token is active', () => {
		const { body } = render(SourcesPanel, { props: { sources: [source({ connectors: [], connectorState: 'no_token' })], form: null } });
		expect(folds(body).find((x) => x.title.startsWith('Connector'))?.title).toBe('Connector no active token');
	});

	it('shows an action result at the top of the tab without JavaScript', () => {
		const message = 'Matched bydue (Columba livia domestica) → Rock Pigeon. Loaded data updated.';
		const { body } = render(SourcesPanel, {
			props: { sources: [source()], form: { kind: 'sources', ok: true, message } }
		});
		const top = body.indexOf(message);
		expect(top).toBeGreaterThan(-1);
		expect(top).toBeLessThan(body.indexOf('Artsobservasjoner'));
		expect(body.indexOf(message, top + 1)).toBe(-1);
	});
});

describe('Admin → Sources after a taxonomy re-match (td-493c58)', () => {
	it("says when a match came through eBird's former name, and what eBird calls it now", () => {
		const { body } = render(SourcesPanel, { props: { sources: [source()], form: null } });
		const text = body.replace(/<!--[^>]*-->/g, '');
		expect(text).toMatch(/matched by a scientific name eBird used before; eBird\s+now calls it <i>Schoeniclus schoeniclus<\/i>/);
		expect(text.match(/now calls it/g)).toHaveLength(1);
	});

	it('opens Unmatched taxa when Admin → Taxonomy links to it', () => {
		nav.url = new URL('http://localhost/admin?tab=sources&unmatched=artsobs');
		try {
			const { body } = render(SourcesPanel, { props: { sources: [source()], form: null } });
			expect(body).toMatch(/<details class="sec[^"]*" id="source-artsobs-unmatched" open/);
		} finally {
			nav.url = new URL('http://localhost/admin?tab=sources');
		}
		const { body } = render(SourcesPanel, { props: { sources: [source()], form: null } });
		expect(body).toMatch(/<details class="sec[^"]*" id="source-artsobs-unmatched">/);
	});
});

describe('Admin → Sources refresh and alerts (td-9fe839)', () => {
	const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

	it('puts what needs the owner under the subtitle: taxa to match (new ones counted) and failed refreshes', () => {
		const unmatched = [
			{ ...source().unmatched[0], isNew: true },
			{ ...source().unmatched[0], upstreamTaxonId: '9', canonicalName: 'Nonexistus fakeus', localName: null, isNew: false }
		];
		const failedRefreshes = [{ regionCode: 'NO-18', regionName: 'Nordland', error: 'Artskart answered 503', at: '2026-11-26T04:00:00Z' }];
		const { body } = render(SourcesPanel, { props: { sources: [source({ unmatched, failedRefreshes })], form: null } });
		const t = text(body);
		expect(t).toContain('Attention 2 taxa need a match (1 new)');
		expect(body).toContain('href="/admin?tab=sources&amp;unmatched=artsobs#source-artsobs-unmatched"');
		expect(t).toMatch(/Refresh failed Nordland, .*The previous reports are still shown\. Artskart answered 503/);
		expect(t.indexOf('2 taxa need a match')).toBeLessThan(t.indexOf('Load a region'));
		// The new taxon carries a New badge and sorts first (the server orders; the badge shows).
		expect(body.match(/data-tone="warn">New</g)).toHaveLength(1);
	});

	it('says nothing when nothing needs the owner, and says one taxon in the singular', () => {
		expect(text(render(SourcesPanel, { props: { sources: [source({ unmatched: [] })], form: null } }).body)).not.toContain('Attention');
		expect(text(render(SourcesPanel, { props: { sources: [source()], form: null } }).body)).toContain('1 taxon needs a match');
	});

	it('offers the refresh setting with a Save button, and Reload loaded regions only when there is one', () => {
		const { body } = render(SourcesPanel, { props: { sources: [source()], form: null } });
		const sel = body.match(/<select name="refresh_days"[^>]*>([\s\S]*?)<\/select>/)![1];
		expect([...sel.matchAll(/>([^<]+)<\/option>/g)].map((m) => m[1])).toEqual(['Off', 'Weekly', 'Every 2 weeks', 'Monthly']);
		expect(sel).toMatch(/<option value="7" selected/);
		expect(text(body)).toContain('Reload loaded regions (1)');
		const none = render(SourcesPanel, { props: { sources: [source({ reloadable: 0, refreshDays: null })], form: null } }).body;
		expect(text(none)).not.toContain('Reload loaded regions');
		expect(none).toMatch(/<option value="off" selected/);
	});

	it('marks an automatic load as such instead of naming the admin it runs under', () => {
		const load = {
			id: 'l1',
			regionCode: 'NO-18',
			regionName: 'Nordland',
			status: 'queued',
			attempt: 0,
			maxAttempts: 3,
			requestedByName: 'Gaylon',
			origin: 'auto' as const,
			createdAt: '2026-11-27T04:00:00Z',
			finishedAt: null,
			heartbeatAt: null,
			leaseExpiresAt: null,
			overdue: false,
			progress: null,
			error: null,
			result: null,
			notes: []
		};
		const t = text(render(SourcesPanel, { props: { sources: [source({ loads: [load] })], form: null } }).body);
		expect(t).toContain('Auto');
		expect(t).not.toContain('by Gaylon');
	});

	it('labels a nominate match', () => {
		const matched = [{ ...source().matched[0], canonicalName: 'Pica pica pica', method: 'nominate' }];
		expect(text(render(SourcesPanel, { props: { sources: [source({ matched })], form: null } }).body)).toContain(
			'matched as its species (nominate subspecies)'
		);
	});
});

describe('Admin → Sources: connector freshness (td-afba28)', () => {
	const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

	it('shows the state read when the page loaded, dated, with a link to the live view', () => {
		const { body } = render(SourcesPanel, {
			props: {
				sources: [
					source({
						connectors: [
							{ id: 1, label: 'droplet', createdAt: '2026-10-20T10:00:00Z', lastSeenAt: '2026-10-29T17:00:00Z', revokedAt: null, state: 'offline' }
						],
						connectorAsOf: '2026-10-29T18:00:00Z',
						connectorState: 'offline'
					})
				],
				form: null
			}
		});
		// "last seen" against the reading's clock, not the test machine's.
		expect(folds(body).find((x) => x.title.startsWith('Connector'))?.title).toBe('Connector offline, last seen 1 h ago');
		expect(text(body)).toMatch(/As of Oct 29, \d+:00 [AP]M\. Live status in Server health/);
		expect(body).toMatch(/<a href="\/admin\?tab=health#sys-connectors" data-sveltekit-reload[^>]*>Live status in Server health<\/a>/);
		expect(text(body)).toContain('droplet Offline');
	});

	it('says only "never checked in" for a connector that never has (AGY4)', () => {
		const { body } = render(SourcesPanel, {
			props: {
				sources: [
					source({
						connectors: [{ id: 1, label: 'droplet', createdAt: '2026-10-20T10:00:00Z', lastSeenAt: null, revokedAt: null, state: 'never' }],
						connectorState: 'never'
					})
				],
				form: null
			}
		});
		expect(folds(body).find((x) => x.title.startsWith('Connector'))?.title).toBe('Connector never checked in');
	});

	it('puts an open outage with the attention lines, linked to Server health', () => {
		const { body } = render(SourcesPanel, {
			props: { sources: [source({ connectorState: 'offline', outageSince: '2026-10-29T17:00:00Z' })], form: null }
		});
		expect(text(body)).toMatch(/Offline Connector offline since Oct 29, \d+:00 [AP]M/);
		expect(body).toMatch(/<a href="\/admin\?tab=health#sys-connectors" data-sveltekit-reload[^>]*>Connector offline since/);
		expect(text(render(SourcesPanel, { props: { sources: [source()], form: null } }).body)).not.toContain('Connector offline since');
	});
});

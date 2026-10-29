/**
 * Admin → Sources (td-2219df), checked on the server-rendered markup: every
 * section of a source is a fold with its heading in the summary, Load a
 * region and Loads start open and the rest closed, the match sections stay
 * folds when empty (so an action's result has somewhere to show), and
 * without JavaScript an action's result shows at the top of the tab (the
 * per-section message needs the browser).
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
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
		connectors: [{ id: 1, label: 'droplet', createdAt: '2026-10-20T10:00:00Z', lastSeenAt: '2026-10-29T18:00:00Z', revokedAt: null }],
		regions: [{ code: 'NO-18', name: 'Nordland', loadedAt: '2026-10-29T12:00:00Z', window: null }],
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
				suggestion: { code: 'rocpig', comName: 'Rock Pigeon', sciName: 'Columba livia' }
			}
		],
		matched: [
			{
				upstreamTaxonId: '4100',
				canonicalName: 'Corvus corone',
				localName: 'kråke',
				speciesCode: 'carcro1',
				comName: 'Carrion Crow',
				method: 'scientific',
				reports: 4210
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
const named = (title: string) => title.replace(/\s*\(.*$/, '').replace(/ (last seen|no active).*$/, '');

describe('Admin → Sources folds (td-2219df)', () => {
	it('puts every section in a fold, headings kept, only the load sections open', () => {
		const { body } = render(SourcesPanel, { props: { sources: [source()], form: null } });
		const f = folds(body);
		expect(f.map((x) => named(x.title))).toEqual([
			'Reference',
			'Connector',
			'Load a region',
			'Loads',
			'Unmatched taxa',
			'Saved matches',
			'Change a match',
			'Re-match species'
		]);
		expect(f.filter((x) => x.open).map((x) => named(x.title))).toEqual(['Load a region', 'Loads']);
		// The headings stay headings inside the summaries.
		expect(body).toMatch(/<summary[^>]*><h3[^>]*>Reference<\/h3><\/summary>/);
		expect(body).toMatch(/<summary[^>]*><h4[^>]*>Re-match species<\/h4><\/summary>/);
		// Counts and the connector state are readable while closed.
		expect(f.find((x) => x.title.startsWith('Unmatched'))?.title).toBe('Unmatched taxa (1)');
		expect(f.find((x) => x.title.startsWith('Connector'))?.title).toMatch(/^Connector last seen /);
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

	it('says when no connector token is active', () => {
		const { body } = render(SourcesPanel, { props: { sources: [source({ connectors: [] })], form: null } });
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

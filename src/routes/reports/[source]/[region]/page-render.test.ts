/**
 * "Where and when to look" (td-b6ddfc), checked on the server-rendered page:
 * what works without JavaScript (CODEX1 P2), a failed reload stays visible
 * beside the last good counts (CODEX1 P2), and the wording rules.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

const nav = vi.hoisted(() => ({ url: new URL('http://x/reports/artsobs/NO-18') }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return nav.url;
		}
	}
}));
// The breadcrumb needs the app's navigation store; it isn't under test here.
vi.mock('$components/PathNavigation.svelte', () => ({ default: () => {} }));
const { default: Page } = await import('./+page.svelte');

const source = {
	id: 'artsobs',
	name: 'Artsobservasjoner',
	publisher: 'Artsdatabanken',
	license: 'CC BY 4.0',
	licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
	citation: 'Test citation',
	doi: null,
	attribution: 'Reports from Artsobservasjoner, CC BY 4.0',
	homepage: 'https://www.artsobservasjoner.no/',
	countryName: 'Norway',
	regionLink: null,
	storeObservers: true
};
const published = {
	loadId: 'l1',
	windowStart: '2024-10-01',
	windowEnd: '2026-09-30',
	retrievedAt: null,
	finishedAt: '2026-10-28T00:00:00.000Z'
};
const june = (n: number) => [0, 0, 0, 0, 0, n, 0, 0, 0, 0, 0, 0];
const species = Array.from({ length: 45 }, (_, i) => ({
	code: `sp${i}`,
	name: `Species ${String(i).padStart(2, '0')}`,
	sciName: null,
	seen: false,
	months: june(100 - i),
	reports: 100 - i,
	whereMonth: [{ name: 'Bodø', reports: 3 }],
	whereWindow: [{ name: 'Røst', reports: 9 }]
}));

function view(search: string, over: Record<string, unknown> = {}) {
	nav.url = new URL(`http://x/reports/artsobs/NO-18${search}`);
	const data = {
		state: { source, published, active: null, failed: null },
		regionName: 'Nordland',
		month: 6,
		place: null,
		places: [],
		monthTotals: june(5000),
		species,
		placeRows: [],
		localities: [],
		observers: [],
		regionCode: 'NO-18',
		mode: nav.url.searchParams.get('view') === 'species' ? 'species' : 'month',
		seen: 'needs',
		accountId: 1,
		canLoad: true,
		...over
	};
	// Template line breaks render as whitespace; compare text with it collapsed.
	return render(Page, { props: { data, form: null, params: {} } as never }).body.replace(/\s+/g, ' ');
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe('/reports/[source]/[region] without JavaScript', () => {
	it("renders every listed species row's months, places and card link on the server", () => {
		const html = view('?view=species');
		expect(count(html, /<details class="sp/g)).toBe(40);
		expect(count(html, /role="list" aria-label="Species \d+ reports in Nordland, by month"/g)).toBe(40);
		expect(count(html, /Where to find it in Nordland ›/g)).toBe(40);
		expect(html).toContain('Most reports in');
	});

	it('reaches the rows past 40 through a link, and back', () => {
		const first = view('?view=species');
		expect(first).not.toContain('Species 44');
		expect(first).toMatch(/<a class="button secondary showall[^"]*" href="\/reports\/artsobs\/NO-18\?view=species&amp;all=1"/);
		expect(first).toContain('Show all 45');
		const all = view('?view=species&all=1');
		expect(count(all, /<details class="sp/g)).toBe(45);
		expect(all).toContain('Species 44');
		expect(all).toMatch(/href="\/reports\/artsobs\/NO-18\?view=species"[^>]*>\s?Show the first 40/);
	});

	it('does the same by month', () => {
		expect(count(view('?month=6'), /class="rwhere/g)).toBe(40);
		expect(view('?month=6&all=1')).toContain('Species 44');
	});
});

describe('/reports/[source]/[region] load state', () => {
	const failed = { at: '2026-10-28T01:00:00.000Z', error: 'Artskart answered 503' };

	it('says a reload failed beside the last good counts, and offers Reload', () => {
		const html = view('?month=6', { state: { source, published, active: null, failed } });
		expect(html).toContain('The last reload failed: Artskart answered 503');
		expect(html).toContain('These counts are from the load before it.');
		expect(html).toContain('Reload Nordland');
		expect(html).toContain('Species 00');
	});

	it('offers no Reload without a failure, nor to a viewer', () => {
		expect(view('?month=6')).not.toContain('Reload Nordland');
		const viewer = view('?month=6', { state: { source, published, active: null, failed }, canLoad: false });
		expect(viewer).toContain('The last reload failed');
		expect(viewer).not.toContain('Reload Nordland');
	});

	it('says a first load failed when nothing is loaded', () => {
		const html = view('', { state: { source, published: null, active: null, failed } });
		expect(html).toContain('The last load failed: Artskart answered 503');
		expect(html).toContain('Load Artsobservasjoner reports for Nordland');
	});
});

describe('/reports/[source]/[region] wording', () => {
	it('never words counts as likelihoods, and always credits the source', () => {
		for (const html of [view('?month=6'), view('?view=species'), view('', { state: { source, published: null, active: null, failed: null } })]) {
			expect(html).not.toMatch(/likely|frequency(?! or)/i);
			expect(html).toContain('not checklist frequency or the chance of seeing a bird');
			expect(html).toContain('Artsobservasjoner');
		}
	});
});

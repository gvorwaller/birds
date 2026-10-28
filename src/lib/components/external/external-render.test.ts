/**
 * The Norway cards' wording rules (td-eec7db Phase 3), checked on the
 * server-rendered markup: report counts in the month cells, the share only
 * in the selected month's caption, never "likely"/"frequency", attribution
 * everywhere, and "no reports" never worded as absence.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ExternalSpeciesCard from './ExternalSpeciesCard.svelte';
import ExternalSourcesCard from './ExternalSourcesCard.svelte';
import type { ExternalOverviewSource, ExternalSpeciesCard as Card } from '$server/external-sources/reports';

const source = {
	id: 'artsobs',
	name: 'Artsobservasjoner',
	publisher: 'Norwegian Biodiversity Information Centre (Artsdatabanken)',
	license: 'CC BY 4.0',
	licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
	citation: 'Test citation',
	doi: null,
	attribution: 'Reports from Artsobservasjoner (Norwegian Biodiversity Information Centre), CC BY 4.0',
	homepage: 'https://www.artsobservasjoner.no/',
	countryName: 'Norway',
	regionLink: null,
	storeObservers: true
};
const published = {
	loadId: '00000000-0000-0000-0000-000000000001',
	windowStart: '2024-10-01',
	windowEnd: '2026-09-30',
	retrievedAt: '2026-10-28T00:04:31.000Z',
	finishedAt: '2026-10-28T00:13:19.000Z'
};

function card(over: Partial<Card> = {}): Card {
	return {
		source,
		published,
		active: null,
		failed: null,
		months: [10, 12, 30, 90, 142, 120, 60, 40, 20, 15, 8, 5],
		monthTotals: [8250, 6567, 10928, 19714, 32195, 18897, 11793, 9841, 11847, 10024, 5255, 3215],
		month: 5,
		places: [{ name: 'Bodø', reports: 40 }],
		placesScope: 'month',
		latest: [
			{
				id: '1',
				observedOn: '2026-10-20',
				count: 3,
				locality: 'Skogsøy',
				place: 'Nesna',
				lat: 66.2,
				lon: 13.0,
				url: 'https://www.artsobservasjoner.no/Sighting/1',
				observer: 'Observer A, Observer B'
			},
			{
				id: '2',
				observedOn: '2026-10-19',
				count: null,
				locality: 'Fjellet',
				place: null,
				lat: null,
				lon: null,
				url: 'https://www.artsobservasjoner.no/Sighting/2',
				observer: null
			}
		],
		...over
	};
}

function speciesCard(c: Card, canLoad = true) {
	return render(ExternalSpeciesCard, {
		props: {
			cards: [c],
			speciesName: 'Willow Ptarmigan',
			regionCode: 'NO-18',
			regionName: 'Nordland',
			canLoad,
			monthHref: (m: number) => `?species=wilpta&region=NO-18&month=${m}`
		}
	}).body;
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('ExternalSpeciesCard', () => {
	it('shows counts in the cells and the share only in the caption', () => {
		const body = speciesCard(card());
		const strip = body.slice(body.indexOf('class="strip'), body.indexOf('class="caption'));
		expect(strip).not.toContain('%');
		expect(strip).toContain('>142<');
		expect(strip).toContain('aria-current="true"');
		expect(strip).toContain('href="?species=wilpta&amp;region=NO-18&amp;month=6"');
		expect(text(body)).toContain('142 reports in May — 0.4% of all 32,195 bird reports in Nordland that month.');
		expect(text(body).match(/%/g)?.length).toBe(1);
	});

	it('never uses likelihood words and always carries the attribution', () => {
		const t = text(speciesCard(card())).toLowerCase();
		expect(t).not.toMatch(/\blikel|\bprobab/);
		// "frequency" appears only in the disclaimer that this is NOT one.
		expect(t.match(/frequenc/g)?.length).toBe(2);
		expect(t).toContain('not checklist frequency or the chance of seeing this bird');
		expect(t).toContain('reports from artsobservasjoner (norwegian biodiversity information centre), cc by 4.0');
		expect(t).toContain('oct 2024 – sep 2026');
	});

	it('gives a coordinate map and Add to trip only to a precise report', () => {
		const body = speciesCard(card());
		expect(body).toContain('/trips/plan?place=Sk');
		expect(body.match(/Add to trip/g)?.length).toBe(1);
		expect(body).toContain('Observer A, Observer B');
		// The municipality is added once, only when the locality doesn't name it.
		expect(text(body)).toContain('Skogsøy, Nesna');
		expect(text(render(ExternalSpeciesCard, {
			props: {
				cards: [card({ latest: [{ ...card().latest[0], locality: 'Finneset, Kabelvåg, Vågan, No', place: 'Vågan' }] })],
				speciesName: 'X', regionCode: 'NO-18', regionName: 'Nordland', canLoad: false, monthHref: () => '?'
			}
		}).body)).toContain('Finneset, Kabelvåg, Vågan, No Observer A');
		expect(body).toContain('href="https://www.artsobservasjoner.no/Sighting/2"');
		// The imprecise one is searched by name: locality, region, country.
		expect(body).toContain(encodeURIComponent('Fjellet, Nordland, Norway'));
	});

	it('never words no reports as absence', () => {
		const t = text(speciesCard(card({ months: new Array(12).fill(0), places: [], latest: [] })));
		expect(t).toContain('No reports of Willow Ptarmigan in Nordland in Oct 2024 – Sep 2026.');
		expect(t).toContain("this doesn't mean it isn't there");
		expect(t).not.toMatch(/not present|absent|doesn't occur/i);
	});

	it('shows the latest reports even with none in the window (CODEX1 F1)', () => {
		const t = text(speciesCard(card({ months: new Array(12).fill(0), places: [] })));
		expect(t).toContain('No reports of Willow Ptarmigan in Nordland in Oct 2024 – Sep 2026.');
		expect(t).toContain('Latest reports');
		expect(t).toContain('Sighting ↗');
		expect(t).not.toContain('Where in');
	});

	it('says a month with only county-level reports has no municipality detail (CODEX1 F4)', () => {
		const months = [0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0];
		const t = text(speciesCard(card({ months, month: 5, places: [], placesScope: 'month' })));
		expect(t).toContain('7 reports in May');
		expect(t).toContain('The May reports are placed only at county level');
		expect(t).not.toContain('No reports in May');
	});

	it('offers a load when the region is not loaded, but not to a viewer', () => {
		const unloaded = card({ published: null, months: null, monthTotals: null, places: [], latest: [] });
		expect(text(speciesCard(unloaded))).toContain('Load Artsobservasjoner reports for Nordland');
		expect(speciesCard(unloaded, false)).not.toContain('<form');
	});

	it('says a load is in progress instead of offering another', () => {
		const t = text(speciesCard(card({ active: { status: 'running', done: 3, total: 30, phase: 'fetching' } })));
		expect(t).toContain('Loading now.');
		expect(t).not.toContain('Reload Nordland');
	});
});

describe('ExternalSourcesCard', () => {
	const overview: ExternalOverviewSource[] = [
		{
			source,
			country: { code: 'NO', name: 'Norway' },
			regions: [
				{
					code: 'NO-18',
					name: 'Nordland',
					link: null,
					published: { ...published, reports: 148526, species: 298, places: 41, monthTotals: new Array(12).fill(100) },
					active: null,
					failed: null,
					observers: [{ rank: 1, observer: 'Observer A', days: 300, species: 250, localities: 80, reports: 9000 }]
				},
				{ code: 'NO-19', name: 'Troms', link: null, published: null, active: null, failed: null, observers: [] },
				{
					code: 'NO-20',
					name: 'Finnmark',
					link: null,
					published: null,
					active: null,
					failed: { at: '2026-10-28T00:00:00.000Z', error: 'Artskart answered 503' },
					observers: []
				}
			]
		}
	];

	it('lists loaded and failed regions, birders by days, and offers the rest in one picker', () => {
		const body = render(ExternalSourcesCard, { props: { overview, canLoad: true } }).body;
		const t = text(body);
		expect(body).toContain('id="ext-NO-18"');
		expect(t).toContain('148,526 reports · 298 species');
		expect(t).toContain('Most active birders (1)');
		expect(t).toContain('Ranked by days with reports');
		expect(t).toContain('Last load failed: Artskart answered 503');
		expect(t).toContain('Try again');
		// Troms is not loaded: only in the picker.
		expect(body).not.toContain('id="ext-NO-19"');
		expect(body).toContain('<option value="NO-19"');
		expect(t).toContain('1 of 3 regions loaded');
		expect(t).not.toMatch(/\blikel|\bprobab/i);
	});

	it('shows a refusal that names no region under the picker (CODEX1 F5)', () => {
		const t = text(
			render(ExternalSourcesCard, {
				props: { overview, canLoad: true, result: { externalError: 'Pick a source and a region.', regionCode: null } }
			}).body
		);
		expect(t).toContain('Pick a source and a region.');
	});

	it('shows no forms to a viewer and says when it could not read', () => {
		expect(render(ExternalSourcesCard, { props: { overview, canLoad: false } }).body).not.toContain('<form');
		expect(text(render(ExternalSourcesCard, { props: { overview: null, canLoad: true } }).body)).toContain(
			"Couldn't read the reports from other sources."
		);
	});
});

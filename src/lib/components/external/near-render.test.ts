/**
 * "What can I see?" → "Reported on <source> near <place>" (td-46fff6 rev B),
 * checked on the server-rendered markup: the card works without JavaScript
 * (rows rendered, folds are <details>), report counts and never
 * "likely"/"frequency", the nearest-only and unloaded states, and viewers
 * get no Load button.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ExternalNearCard from './ExternalNearCard.svelte';
import type { ExternalNearCard as Card, NearSpecies } from '$server/external-sources/near';
import type { ExternalRegionState } from '$server/external-sources/reports';
import { NEAR_SPECIES_SHOWN } from '$lib/external-reports';

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
const nordland = { code: 'NO-18', name: 'Nordland', windowStart: '2024-10-01', windowEnd: '2026-09-30' };

function sp(i: number, over: Partial<NearSpecies> = {}): NearSpecies {
	return {
		code: `sp${i}`,
		name: `Species ${String(i).padStart(2, '0')}`,
		sciName: null,
		seen: false,
		reports: 100 - i,
		years: 2,
		regionCode: 'NO-18',
		regionName: 'Nordland',
		where: [
			{ key: 'NO-18:Nesna\u0000Skogsøy, Nesna, No', locality: 'Skogsøy, Nesna, No', municipality: 'Nesna', reports: 40, km: 34 },
			{ key: 'NO-18:Alstahaug\u0000Steirostranda', locality: 'Steirostranda', municipality: 'Alstahaug', reports: 4, km: 11.5 }
		],
		...over
	};
}

function card(over: Partial<Card> = {}): Card {
	return {
		source,
		month: 10,
		radiusKm: 50,
		counties: [nordland],
		reports: 1429,
		monthYears: 2,
		species: [
			...Array.from({ length: NEAR_SPECIES_SHOWN + 5 }, (_, i) => sp(i + 1)),
			sp(90, { name: 'Seen Bird', seen: true, reports: 3 })
		],
		places: [
			{ key: 'NO-18:Nesna\u0000Skogsøy, Nesna, No', locality: 'Skogsøy, Nesna, No', municipality: 'Nesna', regionCode: 'NO-18', reports: 309, km: 34, lat: 66.2, lon: 13.0 },
			{ key: 'NO-18\u0000Fjellet', locality: 'Fjellet', municipality: null, regionCode: 'NO-18', reports: 5, km: 9, lat: null, lon: null }
		],
		municipalities: [
			{ regionCode: 'NO-18', name: 'Nesna', reports: 600 },
			{ regionCode: 'NO-18', name: 'Alstahaug', reports: 300 }
		],
		nearest: null,
		...over
	};
}

const unloaded = (over: Partial<ExternalRegionState> = {}) => ({
	source,
	published: null,
	active: null,
	failed: null,
	regionCode: 'NO-19',
	regionName: 'Troms',
	...over
});

function html(props: Partial<Parameters<typeof render<typeof ExternalNearCard>>[1]['props']> = {}) {
	return render(ExternalNearCard, {
		props: {
			cards: [card()],
			placeLabel: 'Sandnessjøen',
			radiusKm: 50,
			month: 10,
			canLoad: true,
			speciesHref: (code: string) => `/species/${code}`,
			...props
		}
	}).body;
}

const text = (h: string) => h.replace(/<!--[^]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('ExternalNearCard', () => {
	it('renders the needs, the folds and the places on the server', () => {
		const h = html();
		const t = text(h);
		expect(t).toContain('Reported on Artsobservasjoner near Sandnessjøen');
		expect(t).toContain(
			`${NEAR_SPECIES_SHOWN + 5} species you still need were reported within 31 mi in October, Oct 2024 – Sep 2026 (1,429 bird reports in all).`
		);
		// Every need is in the markup; the rest sit in a <details>.
		for (let i = 1; i <= NEAR_SPECIES_SHOWN + 5; i++) expect(t).toContain(`Species ${String(i).padStart(2, '0')}`);
		expect(h).toMatch(/<details class="fold[^"]*"><summary[^>]*>Show all 30<\/summary>/);
		expect(h).toContain(`start="${NEAR_SPECIES_SHOWN + 1}"`);
		expect(t).toContain('99 reports · in 2 of 2 Octobers');
		expect(t).toContain('Skogsøy, Nesna, No (40 reports, 21 mi) · Steirostranda, Alstahaug (4 reports, 7.1 mi)');
		expect(h).toContain('href="/forecast/species?species=sp1&amp;region=NO-18&amp;month=10"');
		expect(h).toContain('href="/species/sp1"');
		expect(t).toContain('1 species you\'ve already seen');
		expect(t).toContain('Busiest places near here in October');
		expect(t).toContain('309 reports · 21 mi');
		// A pin and Add to trip only for a placed place; a text search otherwise.
		expect(h).toContain('/trips/plan?place=Sk');
		expect((h.match(/Add to trip/g) ?? []).length).toBe(1);
		expect(h).toContain('href="/reports/artsobs/NO-18?place=Nesna&amp;month=10"');
		expect(t).toContain('Oct 2024 – Sep 2026');
		expect(h).not.toContain('<form');
	});

	it('never says likely or frequency outside the callout and the licence notes', () => {
		const h = html().replace(/<details class="license[^]*?<\/details>/, '');
		const t = text(h).replace('not checklist frequency or the chance of seeing a bird', '');
		expect(t).not.toMatch(/likely|frequency|chance/i);
	});

	it('says so when none of the species are needs', () => {
		const t = text(html({ cards: [card({ species: [sp(1, { seen: true })] })] }));
		expect(t).toContain('None of the 1 species reported within 31 mi in October, Oct 2024 – Sep 2026, are ones you still need');
		expect(t).not.toContain('Show all');
	});

	it('names the nearest report when nothing is within the radius', () => {
		const nearest = { key: 'NO-18:Alstahaug\u0000Steirohatten, Alstahaug, No', locality: 'Steirohatten, Alstahaug, No', municipality: 'Alstahaug', reports: 0, km: 11, regionCode: 'NO-18' };
		const t = text(
			html({ radiusKm: 8, cards: [card({ radiusKm: 8, reports: 0, species: [], places: [], municipalities: [], nearest })] })
		);
		expect(t).toContain(
			'No Artsobservasjoner reports within 5.0 mi in October, Oct 2024 – Sep 2026. The nearest is Steirohatten, Alstahaug, No, 6.8 mi away.'
		);
	});

	it('offers to load an unloaded county, never to a viewer', () => {
		const h = html({ cards: [], unloaded: [unloaded()] });
		expect(text(h)).toContain('No Artsobservasjoner reports are loaded for Troms yet.');
		expect(h).toContain('action="?/queueExternalLoad"');
		expect(h).toContain('name="region_code" value="NO-19"');
		expect(text(h)).toContain('Load Artsobservasjoner reports for Troms');
		const v = html({ cards: [], unloaded: [unloaded()], canLoad: false });
		expect(text(v)).toContain('No Artsobservasjoner reports are loaded for Troms yet.');
		expect(v).not.toContain('<form');
	});

	it('adds the unloaded county to the same source card and shows a load in progress', () => {
		const h = html({ unloaded: [unloaded({ active: { status: 'running', done: 0, total: 0, phase: null } })] });
		expect((h.match(/<section/g) ?? []).length).toBe(1);
		expect(text(h)).toContain('Loading now.');
		expect(h).not.toContain('<form');
	});

	it('keys its place lists by the reader\'s place key, unique even for repeated names (CODEX1 F1)', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./ExternalNearCard.svelte', import.meta.url), 'utf8');
		expect(src).toContain('{#each s.where as p, i (p.key)}');
		expect(src).toContain('{#each c.places as p (p.key)}');
		// Two places with one name in two counties render both.
		const twin = sp(1, {
			where: [
				{ key: 'NO-18\u0000Skjæret', locality: 'Skjæret', municipality: null, reports: 1, km: 6 },
				{ key: 'NO-03\u0000Skjæret', locality: 'Skjæret', municipality: null, reports: 1, km: 7 }
			]
		});
		const t = text(html({ cards: [card({ species: [twin] })] }));
		expect(t).toContain('Skjæret (1 report, 3.7 mi) · Skjæret (1 report, 4.3 mi)');
	});
});

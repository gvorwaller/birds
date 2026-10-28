import { describe, expect, it } from 'vitest';
import {
	busiestMonths,
	externalRegionHref,
	pickedRegion,
	monthCaption,
	rankPlaces,
	reportDate,
	reportsText,
	shareText,
	speciesInMonth,
	speciesShown,
	tripPlanHref,
	whereWhenHref,
	windowLabel
} from './external-reports';

describe('external report wording (td-eec7db Phase 3)', () => {
	it('labels an inclusive window by its months', () => {
		expect(windowLabel('2024-10-01', '2026-09-30')).toBe('Oct 2024 – Sep 2026');
	});

	it('counts reports in words', () => {
		expect(reportsText(1)).toBe('1 report');
		expect(reportsText(0)).toBe('0 reports');
		expect(reportsText(1204)).toBe('1,204 reports');
	});

	it('gives a share only with a denominator, and never rounds a real share to 0%', () => {
		expect(shareText(142, 7890)).toBe('1.8%');
		expect(shareText(1, 32195)).toBe('under 0.1%');
		expect(shareText(0, 100)).toBe('0.0%');
		expect(shareText(5, 0)).toBeNull();
	});

	it('puts the share in full prose beside its denominator', () => {
		expect(monthCaption(142, 7890, 6, 'Nordland')).toBe(
			'142 reports in June — 1.8% of all 7,890 bird reports in Nordland that month.'
		);
		expect(monthCaption(0, 0, 1, 'Finnmark')).toBe(
			'0 reports in January — share unavailable (no bird reports counted in Finnmark that month).'
		);
	});

	it('never words a count as a likelihood or frequency', () => {
		const text = [monthCaption(3, 40, 2, 'Troms'), monthCaption(0, 0, 3, 'Troms')].join(' ').toLowerCase();
		expect(text).not.toMatch(/likel|frequen|chance|probab/);
	});

	it('orders the busiest months by reports, ties in calendar order', () => {
		expect(busiestMonths([0, 5, 9, 9, 1, 0, 0, 0, 0, 0, 0, 0])).toEqual([3, 4, 2]);
		expect(busiestMonths(new Array(12).fill(0))).toEqual([]);
	});

	it('keeps a pick only while its region is still offered', () => {
		const offered = [{ code: 'NO-01' }, { code: 'NO-03' }];
		expect(pickedRegion('NO-03', offered)).toBe('NO-03');
		// NO-02 was just queued and left the list: fall back, never submit nothing.
		expect(pickedRegion('NO-02', offered)).toBe('NO-01');
		expect(pickedRegion(undefined, offered)).toBe('NO-01');
		expect(pickedRegion('NO-02', [])).toBe('');
	});

	it('links a region to its row on Hotspots & data', () => {
		expect(externalRegionHref('NO-18')).toBe('/forecast/data#ext-NO-18');
	});

	it('formats a report date without time-zone drift', () => {
		expect(reportDate('2026-10-27')).toBe('Tue, Oct 27');
	});
});

describe('where and when to look (td-eec7db Phase 4)', () => {
	const m = (june: number, may = 0) => [0, 0, 0, 0, may, june, 0, 0, 0, 0, 0, 0];
	const species = [
		{ code: 'a', name: 'Alpha', seen: true, months: m(5) },
		{ code: 'b', name: 'Beta', seen: false, months: m(0, 9) },
		{ code: 'c', name: 'Gamma', seen: false, months: m(12) },
		{ code: 'd', name: 'Delta', seen: false, months: m(5) }
	];

	it('lists needs only, or every species', () => {
		expect(speciesShown(species, true).map((s) => s.code)).toEqual(['b', 'c', 'd']);
		expect(speciesShown(species, false).map((s) => s.code)).toEqual(['a', 'b', 'c', 'd']);
	});

	it("lists a month's species by reports, ties by name, leaving out the month's absentees", () => {
		expect(speciesInMonth(species, 6).map((s) => s.code)).toEqual(['c', 'a', 'd']);
		expect(speciesInMonth(species, 5).map((s) => s.code)).toEqual(['b']);
		expect(speciesInMonth(species, 1)).toEqual([]);
	});

	it('ranks municipalities by needs or species, for the month or the window', () => {
		const rows = [
			{ name: 'Øksnes', monthSpecies: 9, monthNeeds: 2, species: 20, needs: 15 },
			{ name: 'Bodø', monthSpecies: 5, monthNeeds: 4, species: 30, needs: 10 },
			{ name: 'Andøy', monthSpecies: 5, monthNeeds: 2, species: 20, needs: 15 }
		];
		expect(rankPlaces(rows, true, true).map((r) => r.name)).toEqual(['Bodø', 'Andøy', 'Øksnes']);
		expect(rankPlaces(rows, true, false).map((r) => r.name)).toEqual(['Øksnes', 'Andøy', 'Bodø']);
		expect(rankPlaces(rows, false, true).map((r) => r.name)).toEqual(['Andøy', 'Øksnes', 'Bodø']);
		expect(rankPlaces(rows, false, false).map((r) => r.name)).toEqual(['Bodø', 'Andøy', 'Øksnes']);
	});

	it('links to the view and the trip planner', () => {
		expect(whereWhenHref('artsobs', 'NO-18')).toBe('/reports/artsobs/NO-18');
		expect(whereWhenHref('artsobs', 'NO-18', { month: 6, place: 'Bodø', view: 'species' })).toBe(
			'/reports/artsobs/NO-18?view=species&place=Bod%C3%B8&month=6'
		);
		// "Every species" from the species card must not hide species already seen (CODEX1 P3).
		expect(whereWhenHref('artsobs', 'NO-18', { month: 6, seen: 'all' })).toBe('/reports/artsobs/NO-18?month=6&seen=all');
		expect(tripPlanHref('Kjerringøy', 67.5, 14.7)).toBe('/trips/plan?place=Kjerring%C3%B8y&lat=67.50000&lng=14.70000');
	});
});

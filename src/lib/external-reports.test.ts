import { describe, expect, it } from 'vitest';
import { busiestMonths, externalRegionHref, pickedRegion, monthCaption, reportDate, reportsText, shareText, windowLabel } from './external-reports';

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

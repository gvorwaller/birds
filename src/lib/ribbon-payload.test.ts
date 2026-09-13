import { describe, expect, it } from 'vitest';
import { stringify, parse } from 'devalue';
import { encodeRibbonGrid, decodeRibbonGrid } from './ribbon-payload';
import type { RibbonGridClient } from './components/migration-ribbon';

describe('ribbon page payload', () => {
	it('preserves every cell, fractional number, state and label through page transport', () => {
		const cells = [
			null,
			{f:0,num:0,n:1200000,state:'zero',low:false,excluded:0},
			{f:0,num:5.75,n:30,state:'thin',low:true,excluded:2},
			{f:0.161167,num:105945.2576,n:439972,state:'reported',low:true,excluded:1},
			{f:0.0000000123456789,num:0.0123456789,n:1000000,state:'reported',low:false,excluded:0}
		];
		const grid = {
			speciesCode:'osprey',modes:{equal:{cols:[[cells]],world:[cells]},checklists:{cols:[[cells]],world:[cells]}},
			regionCounts:[[19]],gapMonths:[1,12],meta:{regions:19,countries:4,columnsLoaded:['EU'],columnsMissing:['AN'],unmappedCountries:['Åland']}
		} as RibbonGridClient;
		const original = structuredClone(grid);
		const encoded = encodeRibbonGrid(grid);
		const transported = parse(stringify({ok:true,gridJson:encoded}));
		expect(decodeRibbonGrid(transported.gridJson)).toEqual(original);
		expect(grid).toEqual(original);
	});
	it('preserves absence and refuses malformed payloads rather than masking them as no data', () => {
		expect(decodeRibbonGrid(encodeRibbonGrid(null))).toBeNull();
		expect(() => decodeRibbonGrid('{')).toThrow();
	});
});

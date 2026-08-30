import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('$lib/db', () => ({ query: dbMock.query }));

import {
	__resetRegionsCacheForTests,
	countriesList,
	getRegion,
	regionCoordsFor,
	regionLabel,
	regionLabels,
	subnational1Of,
	validateRegionCode
} from './regions';

const ROWS = [
	{ code: 'US', name: 'United States', level: 'country', parent_code: null, lat: 37.1, lon: -95.7 },
	{ code: 'US-FL', name: 'Florida', level: 'subnational1', parent_code: 'US', lat: 28.6, lon: -82.4 },
	{ code: 'DK', name: 'Denmark', level: 'country', parent_code: null, lat: 56.0, lon: 10.0 },
	{ code: 'DK-05', name: 'Bornholm', level: 'subnational1', parent_code: 'DK', lat: 55.1, lon: 14.9 },
	{ code: 'SE', name: 'Sweden', level: 'country', parent_code: null, lat: 62.2, lon: 17.6 },
	// Non-ASCII first letters — the localeCompare ordering cases.
	{ code: 'SE-AB', name: 'Stockholms län', level: 'subnational1', parent_code: 'SE', lat: 59.5, lon: 18.2 },
	{ code: 'SE-E', name: 'Östergötlands län', level: 'subnational1', parent_code: 'SE', lat: 58.4, lon: 15.6 },
	{ code: 'SE-I', name: 'Gotlands län', level: 'subnational1', parent_code: 'SE', lat: 57.5, lon: 18.5 }
];

beforeEach(() => {
	__resetRegionsCacheForTests();
	dbMock.query.mockReset();
	dbMock.query.mockResolvedValue({ rows: ROWS });
});

describe('regionLabel — THE label rule', () => {
	it('country → bare name; subnational1 → "Name, Country"', async () => {
		expect(await regionLabel('DK')).toBe('Denmark');
		expect(await regionLabel('DK-05')).toBe('Bornholm, Denmark');
	});

	it('within its own country → bare name; within a DIFFERENT country → still qualified', async () => {
		expect(await regionLabel('US-FL', { within: 'US' })).toBe('Florida');
		expect(await regionLabel('DK-05', { within: 'US' })).toBe('Bornholm, Denmark');
	});

	it('unknown code → null, never a guess (subnational2 included, by design)', async () => {
		expect(await regionLabel('ZZ')).toBeNull();
		expect(await regionLabel('US-FL-031')).toBeNull();
	});

	it('regionLabels maps many codes and silently omits unknowns', async () => {
		const m = await regionLabels(['DK-05', 'ZZ', 'US']);
		expect(m.get('DK-05')).toBe('Bornholm, Denmark');
		expect(m.get('US')).toBe('United States');
		expect(m.has('ZZ')).toBe(false);
	});
});

describe('index behavior', () => {
	it('one query per process — repeated and CONCURRENT first calls share it', async () => {
		await Promise.all([countriesList(), getRegion('US'), regionLabel('DK-05')]);
		await subnational1Of('SE');
		expect(dbMock.query).toHaveBeenCalledTimes(1);
	});

	it('a rejected first load is NOT cached — the next call retries (CODEX1 P2-2)', async () => {
		dbMock.query.mockRejectedValueOnce(new Error('bootstrap blip'));
		await expect(countriesList()).rejects.toThrow('bootstrap blip');
		// Without the catch-reset this would reject forever until PM2 restart.
		expect((await countriesList()).length).toBeGreaterThan(0);
		expect(dbMock.query).toHaveBeenCalledTimes(2);
	});

	it('sorts with localeCompare so Å/Ö names order among the letters, not after Z', async () => {
		const names = (await subnational1Of('SE')).map((r) => r.name);
		expect(names).toEqual(['Gotlands län', 'Östergötlands län', 'Stockholms län']);
	});
});

describe('validateRegionCode', () => {
	it('accepts a real country and subnational1 (normalizing case)', async () => {
		expect((await validateRegionCode('us'))?.name).toBe('United States');
		expect((await validateRegionCode(' dk-05 '))?.name).toBe('Bornholm');
	});

	it('rejects subnational2, unknown codes, and garbage', async () => {
		expect(await validateRegionCode('US-FL-031')).toBeNull();
		expect(await validateRegionCode('XX')).toBeNull();
		expect(await validateRegionCode('not a code')).toBeNull();
	});
});

describe('regionCoordsFor', () => {
	it('returns coordinates for known codes only, deduplicating input', async () => {
		const m = await regionCoordsFor(['US-FL', 'US-FL', 'DK-05', 'ZZ']);
		expect(m.size).toBe(2);
		expect(m.get('US-FL')).toEqual({ lat: 28.6, lon: -82.4 });
	});
});

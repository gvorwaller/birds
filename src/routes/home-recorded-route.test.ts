import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), geo: vi.fn(), base: vi.fn() }));
vi.mock('$lib/db', () => ({ query: m.query }));
vi.mock('$server/ebird', () => ({ decodeEbirdApiKey: () => null, EbirdError: class extends Error {} }));
vi.mock('$server/needs', () => ({ seenSet: async () => new Set(['shthaw']), geoTargetsBase: m.base }));
vi.mock('$server/geocode', () => ({ geocodePlace: m.geo }));
vi.mock('$server/access', () => ({ galleryContextFrom: async () => ({ hasGallery: false, photoCounts: new Map() }) }));
import { load } from './+page.server';
const records = [
  { speciesCode: 'shthaw', comName: 'Short-tailed Hawk', firstSeen: '2026-09-02', locationName: 'Fixture home', locId: 'L1', subId: 'S1', obsCount: 1, lat: 30, lng: -81 },
  { speciesCode: 'unknow', comName: 'Unlocated fixture', firstSeen: '2026-09-18', locationName: 'Unknown', locId: 'L2', subId: 'S2', obsCount: null, lat: null, lng: null },
];
beforeEach(() => {
  vi.clearAllMocks();vi.useFakeTimers({ toFake: ['Date'] });vi.setSystemTime(new Date('2026-09-19T18:00:00Z'));
  m.geo.mockResolvedValue({ lat: 40, lng: -74, name: 'Searched area' });
  m.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM users')
    ? [{ home_lat: 30, home_lon: -81, home_label: 'Saved home', near_me_radius_km: 40, gallery_url: null }]
    : sql.includes('FROM user_ebird') ? [{ api_key_enc: null, life_list_synced_at: null }]
      : records }));
});
afterEach(() => vi.useRealTimers());
async function run(search: string) {
  const url = new URL('http://localhost/' + search);
  return await load({ url, request: new Request(url), locals: { user: { id: 2, role: 'viewer' }, scopeId: 1 } } as never) as any;
}
describe('Home recorded-sighting loader', () => {
  it('returns scoped first-seen evidence without an API key', async () => {
    const data = await run('?back=30&user=999');
    expect(data.hasApiKey).toBe(false);expect(m.base).not.toHaveBeenCalled();
    expect(data.recordedSightings.find((r: any) => r.speciesCode === 'shthaw')).toMatchObject({ inWindow: true, inRadius: true, distanceKm: 0 });
    expect(m.query.mock.calls.find(([sql]) => String(sql).includes('FROM seen_species'))?.[1]).toEqual([1]);
    expect(data.recordedDateStart).toBe('2026-08-21');expect(data.recordedDateEnd).toBe('2026-09-19');
  });
  it('uses the active searched area instead of the saved-home radius', async () => {
    const data = await run('?place=Searched&dist=1&back=30');
    expect(data.location).toMatchObject({ lat: 40, lng: -74 });
    expect(data.recordedSightings.find((r: any) => r.speciesCode === 'shthaw')).toMatchObject({ inWindow: true, inRadius: false });
  });
  it('does not pretend a failed place search selected home', async () => {
    m.geo.mockResolvedValue(null);const data = await run('?place=Missing&back=30');
    expect(data.location).toBeNull();expect(data.recordedSightings.every((r: any) => !r.inRadius)).toBe(true);
  });
  it('keeps unlocated window records explicitly separate and honors one-day dates', async () => {
    const data = await run('?back=30');expect(data.recordedSightings.find((r: any) => r.speciesCode === 'unknow')).toMatchObject({ locationUnavailable: true, inRadius: false, inWindow: true });
    const one = await run('?back=1');expect(one.recordedSightings.every((r: any) => !r.inWindow)).toBe(true);
    expect(one.recordedDateStart).toBe('2026-09-19');expect(one.recordedDateEnd).toBe('2026-09-19');
  });
});

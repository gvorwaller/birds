import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  query: vi.fn(), key: vi.fn(), seen: vi.fn(), notable: vi.fn(), engine: vi.fn(), forecast: vi.fn(), hydrate: vi.fn(),
  gate: { take: () => true, remaining: () => 24, run: async (fn: () => unknown) => fn() },
}));
vi.mock('$lib/db', () => ({ query: m.query }));
vi.mock('$server/ebird', () => ({
  getEbirdApiKey: m.key,
  validEbirdSpeciesCode: (s: string) => /^[a-z0-9]{3,12}$/.test(s),
  notableNearbyObs: m.notable,
  EbirdError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock('$server/needs', () => ({ seenSet: m.seen }));
vi.mock('$server/forecast', () => ({ forecastNeedsNear: m.forecast, FREQ_LIKELY: 0.2 }));
vi.mock('$server/nearest-ladder', () => ({ createProbeGate: () => m.gate, nearestSpeciesReports: m.engine }));
vi.mock('$server/location-placeids', () => ({ hydrateEbirdLocationPlaceIds: m.hydrate }));
import { load } from './+page.server';
import { EbirdError } from '$server/ebird';

const report = (subId: string, lat = 30) => ({ speciesCode: 'naswar', comName: 'Nashville Warbler', sciName: 'Leiothlypis ruficapilla', locId: subId === 'S1' ? 'L1' : 'L2', locName: 'Test fixture', obsDt: '2026-09-18 13:16', subId, lat, lng: -81, obsValid: false, obsReviewed: false, locationPrivate: false, howMany: 1 });
const engineResult = (rows = [report('S1', 31)]) => ({ rows, stale: false, via: 'ladder', searched: { regions: 2, boundKm: 0 }, capped: true, partial: false, proven: false });
async function run(search: string, signal?: AbortSignal) {
  const url = new URL('http://localhost/nearest' + search);
  return await load({ url, request: new Request(url, { signal }), locals: { user: { id: 2, role: 'viewer' }, scopeId: 1 } } as never) as any;
}
beforeEach(() => {
  vi.clearAllMocks();vi.useFakeTimers({ toFake: ['Date'] });vi.setSystemTime(new Date('2026-09-19T18:00:00Z'));
  m.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM users') ? [{ home_lat: 30, home_lon: -81, home_label: 'Home', near_me_radius_km: 40 }] : [{ species_code: 'naswar', com_name: 'Nashville Warbler' }] }));
  m.key.mockResolvedValue('fixture-key');m.seen.mockResolvedValue(new Set());m.hydrate.mockResolvedValue(new Map());
  m.forecast.mockResolvedValue({ species: [] });m.engine.mockResolvedValue(engineResult());
  m.notable.mockResolvedValue({ data: [report('S2')], stale: false, fetchedAt: new Date() });
});
afterEach(() => vi.useRealTimers());

describe('nearest loader contract', () => {
  it.each(['?back=2', '?nearestKm=12', '?back=', '?nearestKm='])('rejects %s before data/provider work', async (q) => {
    await expect(run(q)).rejects.toMatchObject({ status: 400 });expect(m.query).not.toHaveBeenCalled();expect(m.notable).not.toHaveBeenCalled();expect(m.engine).not.toHaveBeenCalled();
  });
  it('keeps seen species and name search free of report fetches', async () => {
    m.seen.mockResolvedValue(new Set(['naswar']));expect((await run('?code=naswar&back=30&nearestKm=25')).searchedSeen.speciesCode).toBe('naswar');
    await run('?q=Warbler&back=30&nearestKm=25');expect(m.notable).not.toHaveBeenCalled();expect(m.engine).not.toHaveBeenCalled();
    expect(m.key).toHaveBeenCalledWith(1);expect(m.seen).toHaveBeenCalledWith(1);
  });
  it('rejects unknown species before starting report fetches', async () => {
    await expect(run('?code=bad!')).rejects.toMatchObject({ status: 400 });expect(m.notable).not.toHaveBeenCalled();expect(m.engine).not.toHaveBeenCalled();
  });
  it('does not start provider work for a pre-aborted selected request', async () => {
    const controller = new AbortController();controller.abort();
    await run('?code=naswar&back=30', controller.signal);
    expect(m.notable).not.toHaveBeenCalled();expect(m.engine).not.toHaveBeenCalled();
  });
  it('does not start notable work without a key or auto targets', async () => {
    m.key.mockResolvedValue(null);await run('?code=naswar');expect(m.notable).not.toHaveBeenCalled();
    m.key.mockResolvedValue('fixture-key');await run('?back=30');expect(m.notable).not.toHaveBeenCalled();expect(m.engine).not.toHaveBeenCalled();
  });
  it('retains engine reports and merges the closer notable result through the actual wrapper', async () => {
    const data = await run('?code=naswar&back=30&nearestKm=any');
    expect(data.searched.rows.map((r: any) => r.subId)).toEqual(['S2', 'S1']);expect(data.searched.capped).toBe(true);expect(data.searched.proven).toBe(false);
    expect(m.engine).toHaveBeenCalledWith('fixture-key', 'naswar', { lat: 30, lon: -81 }, 30, expect.objectContaining({ probeBudget: 8, ladderDeadlineMs: 15000, gate: m.gate }));
  });
  it('retains valid yesterday-local reports returned for a last-24-hours request', async () => {
    m.engine.mockResolvedValue(engineResult([{ ...report('S1'), obsDt: '2026-09-18 23:59' }]));
    m.notable.mockResolvedValue({ data: [], stale: false, fetchedAt: new Date() });
    const data = await run('?code=naswar&back=1');
    expect(data.searched.rows.map((r: any) => r.subId)).toEqual(['S1']);
    expect(m.engine.mock.calls[0][3]).toBe(1);
  });
  it('shares a single window/radius-specific notable fetch across six auto targets', async () => {
    m.forecast.mockResolvedValue({ species: Array.from({ length: 6 }, (_, n) => ({ code: 'war' + n, comName: 'Fixture ' + n, areaFreq: 0.3, lowSample: false })) });
    m.engine.mockResolvedValue(engineResult([]));
    const data = await run('?back=7&nearestKm=25');expect(data.targets).toHaveLength(6);expect(m.engine).toHaveBeenCalledTimes(6);expect(m.notable).toHaveBeenCalledTimes(1);
    expect(m.notable).toHaveBeenCalledWith('fixture-key', 30, -81, 25, 7, expect.objectContaining({ deadlineMs: 8000 }));
  });
  it('keeps good engine evidence and discloses a rejected notable request', async () => {
    m.notable.mockRejectedValue(new Error('fixture outage'));const data = await run('?code=naswar&back=30');
    expect(data.searched.rows.map((r: any) => r.subId)).toEqual(['S1']);expect(data.searched.partial).toBe(true);expect(data.searched.notableFailed).toBe(true);
    expect(m.engine.mock.calls[0][4].signal.aborted).toBe(false);
  });
  it.each([401, 403, 429])('stops additional regional scheduling on fatal notable %s', async (status) => {
    m.notable.mockRejectedValue(new EbirdError('fixture fatal', status));
    await run('?code=naswar&back=30');expect(m.engine.mock.calls[0][4].signal.aborted).toBe(true);
  });
  it('stops regional scheduling when stale notable fallback records a rate limit', async () => {
    m.notable.mockResolvedValue({ data: [report('S2')], stale: true, fetchedAt: new Date(), refreshErrorStatus: 429 });
    const data = await run('?code=naswar&back=30');expect(data.searched.partial).toBe(true);expect(m.engine.mock.calls[0][4].signal.aborted).toBe(true);
  });

});

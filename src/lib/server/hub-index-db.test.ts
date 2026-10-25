/**
 * td-877997: the hotspot search index rebuilds only when the data it reads
 * changes, keeps answering from the current index while a hotspot-list change
 * rebuilds, and waits when loaded data changed. Owned fixture rows only (a
 * ZZ-9… list cache key and a disposable US-FL-Q… county), deleted exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { __hubIndexForTests, __resetDiscoveryCacheForTests, hubDiscover, hubIndexState } from "$server/hub-discovery";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const RUN = String(process.pid % 100000).padStart(5, "0");
const LIST = `hotspotsRegion:ZZ-9${RUN}X`;
const OTHER = `regions:subnational2:ZZ-9${RUN}X`;
const HOTSPOT = `L99${RUN}01`;
const NAME = `Qzindexfixture${RUN} Marsh`;
const RENAMED = `Qzrenamedfixture${RUN} Marsh`;
const COUNTY = `US-FL-Q${RUN}`;
const COUNTY_NAME = `Qzindexcounty${RUN} County`;

const entry = (over: Record<string, unknown> = {}) => ({
  locId: HOTSPOT,
  locName: NAME,
  lat: 29.5,
  lng: -84.2,
  countryCode: "US",
  subnational1Code: "US-FL",
  subnational2Code: "US-FL-073",
  latestObsDt: "2026-10-01 07:00",
  numSpeciesAllTime: 120,
  numChecklistsAllTime: 40,
  ...over,
});

async function cleanup() {
  await query("DELETE FROM ebird_cache WHERE cache_key = ANY($1::text[])", [[LIST, OTHER]]);
  await query("DELETE FROM frequency_fetch WHERE loc_code = $1", [COUNTY]);
}

const search = (find: string) =>
  hubDiscover({ mode: "typed", find, submitted: find, page: 1 } as Parameters<typeof hubDiscover>[0]);
const ids = async (find: string) => (await search(find)).results.map((r) => r.id);
const changedAt = async (key: string) =>
  (await query<{ t: Date | null; f: string | null }>("SELECT content_changed_at AS t, index_fingerprint AS f FROM ebird_cache WHERE cache_key = $1", [key])).rows[0];

describe.runIf(dbUp)("hotspot search index rebuilds (td-877997)", () => {
  beforeAll(async () => {
    await cleanup();
    __resetDiscoveryCacheForTests();
  });
  afterAll(async () => {
    await cleanup();
    __resetDiscoveryCacheForTests();
  });

  it("dates a hotspot list's content by the fields the index reads, not by when it was fetched", async () => {
    await query(`INSERT INTO ebird_cache (cache_key, payload, fetched_at) VALUES ($1, $2, NOW() - interval '2 days')`, [
      LIST,
      JSON.stringify([entry()]),
    ]);
    const first = await changedAt(LIST);
    expect(first.f).toMatch(/^[0-9a-f]{32}$/);
    // A refetch of the same hotspots, and one where only the daily counts moved: unchanged.
    await query(`UPDATE ebird_cache SET payload = payload, fetched_at = NOW() WHERE cache_key = $1`, [LIST]);
    await query(`UPDATE ebird_cache SET payload = $2, fetched_at = NOW() WHERE cache_key = $1`, [
      LIST,
      JSON.stringify([entry({ latestObsDt: "2026-10-25 08:00", numSpeciesAllTime: 121, numChecklistsAllTime: 41 })]),
    ]);
    expect(await changedAt(LIST)).toEqual(first);
    // Other cache rows are left alone.
    await query(`INSERT INTO ebird_cache (cache_key, payload, fetched_at) VALUES ($1, '[]', NOW())`, [OTHER]);
    expect(await changedAt(OTHER)).toEqual({ t: null, f: null });
  });

  it("builds once, reuses it for a same-content refetch, and keeps answering while a list change rebuilds", async () => {
    expect(hubIndexState()).toBe("cold");
    expect(await ids(NAME)).toContain(HOTSPOT);
    expect(hubIndexState()).toBe("ready");
    const builds = __hubIndexForTests().builds;
    await query(`UPDATE ebird_cache SET payload = payload, fetched_at = NOW() WHERE cache_key = $1`, [LIST]);
    expect(await ids(NAME)).toContain(HOTSPOT);
    expect(__hubIndexForTests().builds).toBe(builds);

    // eBird renamed the hotspot: the search answers at once from the current index...
    await query(`UPDATE ebird_cache SET payload = $2, fetched_at = NOW() WHERE cache_key = $1`, [LIST, JSON.stringify([entry({ locName: RENAMED })])]);
    expect(await ids(RENAMED)).not.toContain(HOTSPOT);
    expect(__hubIndexForTests().builds).toBe(builds + 1);
    // ...and once the new one is built, it is used.
    await __hubIndexForTests().building;
    expect(await ids(RENAMED)).toContain(HOTSPOT);
  });

  it("waits for the new index when loaded data changed (the owner's own load)", async () => {
    expect(await ids(COUNTY_NAME)).not.toContain(COUNTY);
    await query(
      `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
       VALUES ($1, 'region', $2, 2015, 2024, array_fill(0, ARRAY[48]), 7, 'US-FL')`,
      [COUNTY, COUNTY_NAME],
    );
    expect(await ids(COUNTY_NAME)).toContain(COUNTY);
    // A refresh that only moves fetched_at is not a change.
    const builds = __hubIndexForTests().builds;
    await query(`UPDATE frequency_fetch SET fetched_at = NOW() WHERE loc_code = $1`, [COUNTY]);
    expect(await ids(COUNTY_NAME)).toContain(COUNTY);
    expect(__hubIndexForTests().builds).toBe(builds);
  });
});

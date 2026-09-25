/**
 * td-9eae4f: Hotspots & data performance contracts. Owned fixture rows only
 * (ZZ9… cache keys and a disposable US-FL-Q… county), deleted exactly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { query } from "$lib/db";
import { cachedSubregionLists } from "$server/ebird";
import { __resetDiscoveryCacheForTests, hubDiscover } from "$server/hub-discovery";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const RUN = String(process.pid % 100000).padStart(5, "0");
const PARENTS = [`ZZ-9${RUN}A`, `ZZ-9${RUN}B`, `ZZ-9${RUN}C`, `ZZ-9${RUN}D`];
const COUNTY = `US-FL-Q${RUN}`;
const COUNTY_NAME = `Qzfixture${RUN} County`;

async function cleanup() {
  await query("DELETE FROM ebird_cache WHERE cache_key = ANY($1::text[])", [
    PARENTS.map((p) => `regions:subnational2:${p}`),
  ]);
  await query("DELETE FROM frequency_fetch WHERE loc_code = $1", [COUNTY]);
}

describe.runIf(dbUp)("cachedSubregionLists", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(async () => {
    await cleanup();
    // One fresh list, one expired a year ago, one malformed; D has none.
    await query(
      `INSERT INTO ebird_cache (cache_key, payload, fetched_at) VALUES
         ($1, $2::jsonb, NOW()),
         ($3, $4::jsonb, NOW() - interval '365 days'),
         ($5, $6::jsonb, NOW())`,
      [
        `regions:subnational2:${PARENTS[0]}`,
        JSON.stringify([{ code: `${PARENTS[0]}-001`, name: "Alpha" }]),
        `regions:subnational2:${PARENTS[1]}`,
        JSON.stringify([{ code: `${PARENTS[1]}-001`, name: "Beta" }]),
        `regions:subnational2:${PARENTS[2]}`,
        JSON.stringify([{ code: `${PARENTS[2]}-001` }]),
      ],
    );
  });
  afterAll(async () => {
    await cleanup();
    fetchSpy.mockRestore();
  });

  it("returns every cached list in one read, stale ones included, and never calls eBird", async () => {
    const lists = await cachedSubregionLists([...PARENTS, PARENTS[0]]);
    expect(lists.get(PARENTS[0])).toEqual([{ code: `${PARENTS[0]}-001`, name: "Alpha" }]);
    // A year-old list is still served: the page request never refreshes it.
    expect(lists.get(PARENTS[1])).toEqual([{ code: `${PARENTS[1]}-001`, name: "Beta" }]);
    // A malformed cached list is rejected rather than presented as real data.
    expect(lists.has(PARENTS[2])).toBe(false);
    // No cached list: absent (the page shows an unknown total), not an eBird call.
    expect(lists.has(PARENTS[3])).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a single query regardless of how many states are asked for", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./ebird.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function cachedSubregionLists"));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn.match(/await query/g)).toHaveLength(1);
    expect(fn).toContain("WHERE cache_key = ANY($1::text[])");
    expect(fn).not.toMatch(/ebirdFetch|cachedFetch|subregions\(/);
  });
});

describe.runIf(dbUp)("discovery reuse (hubDiscover)", () => {
  beforeAll(async () => {
    await cleanup();
    __resetDiscoveryCacheForTests();
  });
  afterAll(async () => {
    await cleanup();
    __resetDiscoveryCacheForTests();
  });

  const search = (find: string) =>
    hubDiscover({ mode: "typed", find, submitted: find, page: 1 } as Parameters<typeof hubDiscover>[0]);

  it("reuses the index between searches and rebuilds it when loaded data changes", async () => {
    const before = await search(COUNTY_NAME);
    expect(before.results.some((r) => r.id === COUNTY)).toBe(false);
    // Loading a county changes frequency_fetch, which changes the revision.
    await query(
      `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
       VALUES ($1, 'region', $2, 2015, 2024, array_fill(0, ARRAY[48]), 7, 'US-FL')`,
      [COUNTY, COUNTY_NAME],
    );
    const after = await search(COUNTY_NAME);
    expect(after.results.map((r) => r.id)).toContain(COUNTY);
    // Unchanged inputs: the same answer again from the reused index.
    const again = await search(COUNTY_NAME);
    expect(again.results.map((r) => r.id)).toEqual(after.results.map((r) => r.id));
  });
});

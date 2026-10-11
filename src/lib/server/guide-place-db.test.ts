/**
 * td-3cbf64 (plan D4): the Field Guide place filter reads the species-presence
 * layer (0083) instead of every month row under the place. It must return the
 * SAME species as the month-table filter it replaced, for every grain.
 *
 * Shared birds_test: own fixtures only (a per-run region under country ZZ,
 * per-run species codes and L… locations), exact cleanup, no seed/reset. Real
 * places are only read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query, withTransaction } from "$lib/db";
import type { GuideLocationSelection } from "$lib/guide-location";
import { guideLocationCoverage, resolveGuideLocation, type GuidePlace } from "./guide-location";
import { searchGuide } from "./species-enrichment";

const tag = randomUUID().replaceAll("-", "").slice(0, 8);
const REGION = `ZZ-G${tag.slice(0, 5).toUpperCase()}`;
const COUNTY = `${REGION}-001`;
const OTHER_COUNTY = `${REGION}-002`;
const SP = ["a", "b", "c", "d", "e"].map((x) => `zzg${x}${tag}`);
const SPUH = `zzgspuh${tag}`;
const locs: string[] = [];
const newLoc = () => {
  const l = `LZZG${tag}${locs.length}`;
  locs.push(l);
  return l;
};

type Week = [species: string, week: number, freq: number];
/** One hotspot as storeFrequencies writes it: metadata, weekly rows, and the month rollup. */
async function store(loc: string, region: string, weeks: Week[], samples = Array(48).fill(10)) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
       VALUES ($1, 'hotspot', 'Guide place fixture', 2016, 2025, $2, 0, $3)`,
      [loc, samples, region],
    );
    await c.query(
      `INSERT INTO species_frequency (loc_code, species_code, week, freq)
       SELECT $1, s, w, f FROM unnest($2::text[], $3::int[], $4::float8[]) AS t(s, w, f)`,
      [loc, weeks.map((x) => x[0]), weeks.map((x) => x[1]), weeks.map((x) => x[2])],
    );
    // num = weeks with checklists in which the species was reported (barchart.ts rollup).
    await c.query(
      `INSERT INTO species_month_freq (loc_code, species_code, month, num)
       SELECT $1, s, (w - 1) / 4 + 1, count(*) FILTER (WHERE ($5::int[])[w] > 0)
         FROM unnest($2::text[], $3::int[], $4::float8[]) AS t(s, w, f)
        GROUP BY s, (w - 1) / 4 + 1`,
      [loc, weeks.map((x) => x[0]), weeks.map((x) => x[1]), weeks.map((x) => x[2]), samples],
    );
  });
}

/** The filter this release replaced: month rows with num > 0 over the old LIKE-matched coverage. */
async function monthTableSpecies(locCodes: readonly string[]): Promise<string[]> {
  const { rows } = await query<{ species_code: string }>(
    `SELECT DISTINCT m.species_code FROM species_month_freq m
       JOIN taxonomy_cache t ON t.species_code = m.species_code AND t.category = 'species'
      WHERE m.loc_code = ANY($1) AND m.num > 0`,
    [locCodes],
  );
  return rows.map((r) => r.species_code).sort();
}
async function likeCoverage(code: string): Promise<string[]> {
  const { rows } = await query<{ loc_code: string }>(
    `SELECT loc_code FROM frequency_fetch
      WHERE (loc_kind = 'region' AND (loc_code = $1 OR loc_code LIKE $2))
         OR (loc_kind = 'hotspot' AND (region_code = $1 OR region_code LIKE $2))`,
    [code, `${code}-%`],
  );
  return rows.map((r) => r.loc_code).sort();
}
const guideSpecies = async (place: GuidePlace | null) =>
  (await searchGuide("", [], 0, place)).rows.map((r) => r.species_code).sort();

beforeAll(async () => {
  if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "15436" || env.PGDATABASE !== "birds_test")
    throw Error("Requires dedicated birds_test");
  for (const code of SP)
    await query(
      "INSERT INTO taxonomy_cache (species_code, com_name, sci_name, family, category) VALUES ($1, 'Guide place taxon', 'Guide place taxon', 'Guide place family', 'species')",
      [code],
    );
  await query(
    "INSERT INTO taxonomy_cache (species_code, com_name, sci_name, family, category) VALUES ($1, 'Guide place spuh', 'Guide place spuh', 'Guide place family', 'spuh')",
    [SPUH],
  );
  const zeroWeek10 = Array(48).fill(10);
  zeroWeek10[9] = 0;
  // Two hotspots in a county, one filed directly under the state, one in
  // another county. (Region-kind rows must name seeded regions, so they are
  // covered by the real places below, not by fixtures.)
  await store(newLoc(), COUNTY, [[SP[0], 1, 0.2], [SP[0], 5, 0.1], [SPUH, 2, 0.3]]);
  await store(newLoc(), REGION, [[SP[1], 3, 0.05]]);
  // SP[2] only in a week with no checklists: not present anywhere.
  await store(newLoc(), OTHER_COUNTY, [[SP[3], 20, 0.4], [SP[2], 10, 0.5]], zeroWeek10);
  await store(newLoc(), COUNTY, [[SP[4], 40, 0.01], [SP[0], 2, 0.2]]);
});

afterAll(async () => {
  await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [locs]);
  await query("DELETE FROM taxonomy_cache WHERE species_code = ANY($1)", [[...SP, SPUH]]);
  const left = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM species_region_membership WHERE region_code = $1)
          + (SELECT count(*) FROM species_country_membership WHERE species_code = ANY($2))
          + (SELECT count(*) FROM species_location_membership WHERE loc_code = ANY($3))
          + (SELECT count(*) FROM species_month_freq WHERE loc_code = ANY($3)) AS n`,
    [REGION, [...SP, SPUH], locs],
  );
  expect(Number(left.rows[0].n)).toBe(0);
});

describe("Field Guide place filter reads the presence layer (td-3cbf64)", () => {
  it("fixture region: the region table gives the month-table set; zero-checklist and non-species taxa excluded", async () => {
    const coverage = await guideLocationCoverage(REGION);
    expect(coverage.locCodes.sort()).toEqual(await likeCoverage(REGION));
    const expected = await monthTableSpecies(coverage.locCodes);
    expect(expected).toEqual([SP[0], SP[1], SP[3], SP[4]].sort());
    expect(await guideSpecies({ kind: "region", code: REGION })).toEqual(expected);
  });

  it("fixture county and single hotspot: the location arrays give the month-table set", async () => {
    const county = await guideLocationCoverage(COUNTY);
    expect(county.locCodes.sort()).toEqual([locs[0], locs[3]].sort());
    expect(await guideSpecies({ kind: "locations", locCodes: county.locCodes })).toEqual(
      await monthTableSpecies(county.locCodes),
    );
    expect(await guideSpecies({ kind: "locations", locCodes: [locs[2]] })).toEqual([SP[3]]);
  });

  it("a place with no loaded data matches nothing; Anywhere is unfiltered", async () => {
    expect(await guideSpecies({ kind: "region", code: "ZZ-NODATA" })).toEqual([]);
    expect(await guideSpecies({ kind: "country", code: "ZY" })).toEqual([]);
    expect(await guideSpecies({ kind: "locations", locCodes: [] })).toEqual([]);
    const anywhere = await searchGuide(SP[2], [], 0, null);
    expect(anywhere.rows.map((r) => r.species_code)).toEqual([SP[2]]);
  });

  it("the unknown-tags count applies the same place filter", async () => {
    // Fixture taxa have no enrichment, so every present one is "not yet evaluated".
    const inRegion = await searchGuide("Guide place taxon", ["habitat:mudflat"], 0, { kind: "region", code: REGION });
    expect(inRegion.rows).toEqual([]);
    expect(inRegion.unknownCount).toBe(4);
    const inHotspot = await searchGuide("Guide place taxon", ["habitat:mudflat"], 0, { kind: "locations", locCodes: [locs[2]] });
    expect(inHotspot.unknownCount).toBe(1);
    const anywhere = await searchGuide("Guide place taxon", ["habitat:mudflat"], 0, null);
    expect(anywhere.unknownCount).toBe(5);
  });

  // Real birds_test places (read only): every grain the route resolves.
  const realPlaces: [string, () => Promise<GuideLocationSelection | null>][] = [
    ["country US", async () => ({ kind: "country", country: "US" })],
    ["country NO", async () => ({ kind: "country", country: "NO" })],
    ["region US-FL", async () => ({ kind: "region", country: "US", region: "US-FL" })],
    ["region NO-18", async () => ({ kind: "region", country: "NO", region: "NO-18" })],
    ["busiest Florida county", async () => {
      const county = (await query<{ region_code: string }>(
        `SELECT f.region_code FROM frequency_fetch f
           JOIN frequency_fetch c ON c.loc_kind = 'region' AND c.loc_code = f.region_code
          WHERE f.loc_kind = 'hotspot' AND f.region_code LIKE 'US-FL-%'
          GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
      )).rows[0]?.region_code;
      return county ? { kind: "county", country: "US", region: "US-FL", county } : null;
    }],
    ["one hotspot in it", async () => {
      const row = (await query<{ loc_code: string; region_code: string }>(
        `SELECT f.loc_code, f.region_code FROM frequency_fetch f
           JOIN frequency_fetch c ON c.loc_kind = 'region' AND c.loc_code = f.region_code
          WHERE f.loc_kind = 'hotspot' AND f.region_code LIKE 'US-FL-%' AND f.loc_code ~ '^L[0-9]+$'
          ORDER BY f.n_species DESC, f.loc_code LIMIT 1`,
      )).rows[0];
      return row
        ? { kind: "hotspot", country: "US", region: "US-FL", county: row.region_code, hotspot: row.loc_code }
        : null;
    }],
    ["map radius around Miami", async () => ({ kind: "map", place: "Miami", lat: 25.76, lng: -80.19, dist: 60 })],
  ];
  for (const [name, selection] of realPlaces) {
    it(`real place, ${name}: same species as the month-table filter`, async () => {
      const sel = await selection();
      if (!sel) return; // not loaded on this snapshot
      const resolved = (await resolveGuideLocation(sel))!;
      if (sel.kind === "country" || sel.kind === "region") {
        // The study-coded coverage selects exactly the old LIKE-matched locations.
        expect([...resolved.locCodes].sort()).toEqual(await likeCoverage(sel.kind === "country" ? sel.country : sel.region));
      }
      expect(await guideSpecies(resolved.place)).toEqual(await monthTableSpecies(resolved.locCodes));
    }, 30_000);
  }
});

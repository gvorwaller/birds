import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query, withTransaction } from "$lib/db";
import { storeFrequencies } from "./barchart";

const prefix = "membership" + randomUUID().replaceAll("-", "");
const locations: string[] = [];
const codes = Array.from({ length: 12 }, (_, i) => `${prefix}${i}`);
async function location(region: string | null = "US-FL") {
  const loc = `L${prefix}${locations.length}`;
  locations.push(loc);
  await query(
    `INSERT INTO frequency_fetch
    (loc_code,loc_kind,loc_name,region_code,begin_year,end_year,sample_sizes,n_species)
    VALUES($1,'hotspot','Country membership test',$2,2016,2025,array_fill(100,ARRAY[48]),1)`,
    [loc, region],
  );
  return loc;
}
async function reports(loc: string, code: string) {
  await query(
    `INSERT INTO species_frequency(loc_code,species_code,week,freq)
    VALUES($1,$2,1,0.1),($1,$2,2,0.2)`,
    [loc, code],
  );
}
async function membership(code: string) {
  return (
    await query(
      `SELECT country_code,source_count FROM species_country_membership
    WHERE species_code=$1 ORDER BY country_code`,
      [code],
    )
  ).rows;
}
beforeAll(() => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires isolated birds_test");
});
afterAll(async () => {
  await query("DELETE FROM frequency_fetch WHERE loc_code=ANY($1::text[])", [
    locations,
  ]);
  await query(
    "DELETE FROM frequency_fetch_attempts WHERE loc_code=ANY($1::text[])",
    [locations],
  );
  expect(
    (
      await query(
        "SELECT 1 FROM species_country_membership WHERE species_code=ANY($1::text[])",
        [codes],
      )
    ).rows,
  ).toEqual([]);
});

describe("incremental study-country membership on PostgreSQL", () => {
  it("keeps a species until its last week and last reporting source disappear", async () => {
    const a = await location(),
      b = await location();
    await reports(a, codes[0]);
    await reports(b, codes[0]);
    expect(await membership(codes[0])).toEqual([
      { country_code: "US", source_count: 2 },
    ]);
    await query("DELETE FROM species_frequency WHERE loc_code=$1 AND week=1", [
      a,
    ]);
    expect(await membership(codes[0])).toEqual([
      { country_code: "US", source_count: 2 },
    ]);
    await query("DELETE FROM frequency_fetch WHERE loc_code=$1", [b]);
    expect(await membership(codes[0])).toEqual([
      { country_code: "US", source_count: 1 },
    ]);
    await query("DELETE FROM species_frequency WHERE loc_code=$1", [a]);
    expect(await membership(codes[0])).toEqual([]);
  });
  it("handles unknown geography, later mapping, moves between countries, and unmapping", async () => {
    const loc = await location(null);
    await reports(loc, codes[1]);
    expect(await membership(codes[1])).toEqual([]);
    for (const [region, expected] of [
      [" us-fl ", "US"],
      ["CA-ON", "CA"],
      ["bogus", null],
      ["US-FL", "US"],
      [null, null],
    ] as const) {
      await query(
        "UPDATE frequency_fetch SET region_code=$2 WHERE loc_code=$1",
        [loc, region],
      );
      expect(await membership(codes[1])).toEqual(
        expected ? [{ country_code: expected, source_count: 1 }] : [],
      );
    }
  });
  it("updates both sides when weekly rows change species or location", async () => {
    const a = await location(),
      b = await location("CA-ON");
    await reports(a, codes[2]);
    await query(
      "UPDATE species_frequency SET species_code=$2,loc_code=$3 WHERE loc_code=$1",
      [a, codes[3], b],
    );
    expect(await membership(codes[2])).toEqual([]);
    expect(await membership(codes[3])).toEqual([
      { country_code: "CA", source_count: 1 },
    ]);
    await query("UPDATE species_frequency SET freq=0.5 WHERE loc_code=$1", [b]);
    expect(await membership(codes[3])).toEqual([
      { country_code: "CA", source_count: 1 },
    ]);
  });
  it("rolls back membership together with failed report replacement and remapping", async () => {
    const loc = await location();
    await reports(loc, codes[4]);
    await expect(
      withTransaction(async (client) => {
        await client.query(
          "UPDATE frequency_fetch SET region_code=$2 WHERE loc_code=$1",
          [loc, "CA-ON"],
        );
        await client.query("DELETE FROM species_frequency WHERE loc_code=$1", [
          loc,
        ]);
        await client.query(
          "INSERT INTO species_frequency VALUES($1,$2,1,0.4)",
          [loc, codes[5]],
        );
        throw Error("abort test replacement");
      }),
    ).rejects.toThrow("abort test replacement");
    expect(await membership(codes[4])).toEqual([
      { country_code: "US", source_count: 1 },
    ]);
    expect(await membership(codes[5])).toEqual([]);
  });
  it("does not lose contributions when two locations in one country commit concurrently", async () => {
    const a = await location(),
      b = await location();
    await Promise.all([reports(a, codes[6]), reports(b, codes[6])]);
    expect(await membership(codes[6])).toEqual([
      { country_code: "US", source_count: 2 },
    ]);
    await Promise.all([
      query("DELETE FROM frequency_fetch WHERE loc_code=$1", [a]),
      query("DELETE FROM frequency_fetch WHERE loc_code=$1", [b]),
    ]);
    expect(await membership(codes[6])).toEqual([]);
  });
  it("serializes direct concurrent weekly inserts without conflicting with their foreign-key locks", async () => {
    const loc = await location();
    await Promise.all(
      [1, 2, 3].map((week) =>
        query("INSERT INTO species_frequency VALUES($1,$2,$3,0.1)", [
          loc,
          codes[11],
          week,
        ]),
      ),
    );
    expect(await membership(codes[11])).toEqual([
      { country_code: "US", source_count: 1 },
    ]);
    expect(
      (
        await query(
          "SELECT count(*)::int AS n FROM species_frequency WHERE loc_code=$1",
          [loc],
        )
      ).rows[0].n,
    ).toBe(3);
  });
  it("handles a multi-location statement and an empty statement", async () => {
    const a = await location(),
      b = await location("CA-ON");
    await query(
      `INSERT INTO species_frequency VALUES($1,$3,1,0.1),($2,$3,1,0.2)`,
      [a, b, codes[7]],
    );
    expect(await membership(codes[7])).toEqual([
      { country_code: "CA", source_count: 1 },
      { country_code: "US", source_count: 1 },
    ]);
    await query(
      "DELETE FROM species_frequency WHERE loc_code=ANY($1::text[])",
      [[a, b]],
    );
    await query(
      "DELETE FROM species_frequency WHERE loc_code=ANY($1::text[])",
      [[a, b]],
    );
    expect(await membership(codes[7])).toEqual([]);
  });
  it("tracks real storeFrequencies replacement, including concurrent writes to the same location", async () => {
    const loc = await location();
    const store = (code: string) =>
      storeFrequencies({
        locCode: loc,
        locKind: "hotspot",
        locName: "Country membership test",
        regionCode: "US-FL",
        beginYear: 2016,
        endYear: 2025,
        parsed: { sampleSizes: Array(48).fill(100), rows: [] },
        matched: {
          bySpecies: new Map([[code, Array(48).fill(0.1)]]),
          unmatched: [],
          collisions: 0,
        },
      });
    await store(codes[8]);
    expect(await membership(codes[8])).toEqual([
      { country_code: "US", source_count: 1 },
    ]);
    await Promise.all([store(codes[9]), store(codes[10])]);
    const actual = (
      await query(
        "SELECT DISTINCT species_code FROM species_frequency WHERE loc_code=$1",
        [loc],
      )
    ).rows.map((r) => r.species_code);
    const summarized = (
      await query(
        "SELECT species_code FROM species_country_membership WHERE species_code=ANY($1::text[])",
        [codes.slice(8, 11)],
      )
    ).rows.map((r) => r.species_code);
    expect(actual).toHaveLength(1);
    expect(summarized).toEqual(actual);
  });
});

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { recordSpeciesView } from "./species-views";
import {
  studyCountries,
  studyCountrySpecies,
  studySpecies,
} from "./species-study";

const code = "study" + randomUUID().replaceAll("-", "").slice(0, 8);
const secondCode = "count" + randomUUID().replaceAll("-", "").slice(0, 8);
const locs = [
  "LstudyUS" + randomUUID(),
  "LstudyCA" + randomUUID(),
  "LstudyCA" + randomUUID(),
];
let owner: number, viewer: number;
beforeAll(async () => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires dedicated birds_test");
  owner = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Study test','!unset','user') RETURNING id",
      ["study-" + randomUUID()],
    )
  ).rows[0].id;
  viewer = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role,views_user_id) VALUES($1,'Study viewer','!unset','viewer',$2) RETURNING id",
      ["study-" + randomUUID(), owner],
    )
  ).rows[0].id;
  await query(
    "INSERT INTO taxonomy_cache(species_code,com_name,sci_name,family,category) VALUES($1,'Study test taxon','Study taxon','Study family','species')",
    [code],
  );
  for (const [index, loc] of locs.entries()) {
    await query(
      "INSERT INTO frequency_fetch(loc_code,loc_kind,loc_name,region_code,begin_year,end_year,sample_sizes,n_species) VALUES($1,'hotspot','Study fixture',$2,2016,2025,array_fill(100,ARRAY[48]),1)",
      [loc, index ? "CA-ON" : "US-FL"],
    );
    await query(
      "INSERT INTO species_frequency(loc_code,species_code,week,freq) VALUES($1,$2,1,0.1),($1,$2,2,0.2)",
      [loc, code],
    );
  }
  await recordSpeciesView(owner, code, randomUUID());
  await query(
    "INSERT INTO taxonomy_cache(species_code,com_name,sci_name,family,category) VALUES($1,'Second study taxon','Second study taxon','Study family','species')",
    [secondCode],
  );
  await query(
    "INSERT INTO species_frequency(loc_code,species_code,week,freq) VALUES($1,$2,1,0.1)",
    [locs[0], secondCode],
  );
  await query("UPDATE frequency_fetch SET n_species=2 WHERE loc_code=$1", [
    locs[0],
  ]);
  // A field observation must never exclude the viewer from Not yet viewed.
  await query("INSERT INTO seen_species(user_id,species_code) VALUES($1,$2)", [
    viewer,
    code,
  ]);
});
afterAll(async () => {
  await query("DELETE FROM frequency_fetch WHERE loc_code=ANY($1::text[])", [
    locs,
  ]);
  await query("DELETE FROM users WHERE id=ANY($1::int[])", [
    [owner, viewer].filter(Boolean),
  ]);
  await query("DELETE FROM taxonomy_cache WHERE species_code=ANY($1::text[])", [
    [code, secondCode],
  ]);
});
describe("study lists on real PostgreSQL", () => {
  it("uses actual account history for the complement, independently of shared owner and life list", async () => {
    expect(
      (await studySpecies(owner, code, "viewed", true)).rows[0],
    ).toMatchObject({ code, family: "Study family" });
    expect(
      (await studySpecies(owner, code, "unviewed", true)).rows,
    ).toHaveLength(0);
    expect(
      (await studySpecies(viewer, code, "viewed", true)).rows,
    ).toHaveLength(0);
    expect((await studySpecies(viewer, code, "unviewed", true)).rows).toEqual([
      expect.objectContaining({ code, view: null, family: "Study family" }),
    ]);
  });
  it("returns the full unviewed taxonomy and treats wildcard searches literally", async () => {
    const total = Number(
      (
        await query(
          "SELECT count(*) FROM taxonomy_cache WHERE category='species'",
        )
      ).rows[0].count,
    );
    expect(
      (await studySpecies(viewer, "", "unviewed", true)).rows,
    ).toHaveLength(total);
    expect(total).toBeGreaterThan(100);
    expect(
      (await studySpecies(viewer, "%", "unviewed", true)).rows,
    ).toHaveLength(0);
  });
  it("duplicates across countries but deduplicates weekly reports within a country", async () => {
    for (const country of ["US", "CA"]) {
      const result = await studyCountrySpecies(
        owner,
        code,
        "viewed",
        true,
        country,
      );
      expect(result.rows.map((r) => r.code)).toEqual([code]);
      expect(result.locCodes).toContain(locs[country === "US" ? 0 : 1]);
    }
    expect(
      (await studyCountrySpecies(viewer, code, "viewed", true, "US")).rows,
    ).toHaveLength(0);
  }, 20000);
  it("provides coverage separately from membership, and no matching reports are not invented", async () => {
    const countries = await studyCountries([code]);
    expect(countries.find((c) => c.code === "US")).toMatchObject({
      sourceCount: expect.any(Number),
      beginYear: expect.any(Number),
      speciesCount: 1,
    });
    const elsewhere = await studyCountrySpecies(
      owner,
      code,
      "viewed",
      true,
      "GB",
    );
    expect(elsewhere.rows).toHaveLength(0);
    expect(elsewhere.locCodes.length).toBeGreaterThan(0);
  }, 20000);
  it("shows only matching countries and counts each species once across weeks and locations", async () => {
    const countries = await studyCountries([code]);
    expect(countries.map((c) => [c.code, c.speciesCount])).toEqual([
      ["CA", 1],
      ["US", 1],
    ]);
    expect(await studyCountries([])).toEqual([]);
    expect(await studyCountries(["no-mapped-study-species"])).toEqual([]);
    const twoSpecies = await studyCountries([code, secondCode]);
    expect(twoSpecies.map((c) => [c.code, c.speciesCount])).toEqual([
      ["CA", 1],
      ["US", 2],
    ]);
  });
  it("country counts follow viewed/unviewed membership, account identity and search", async () => {
    for (const [account, status, expected] of [
      [owner, "viewed", 2],
      [owner, "unviewed", 0],
      [viewer, "viewed", 0],
      [viewer, "unviewed", 2],
    ] as const) {
      const rows = (await studySpecies(account, code, status, true)).rows;
      expect(await studyCountries(rows.map((r) => r.code))).toHaveLength(
        expected,
      );
    }
    const noMatches = await studySpecies(owner, "%", "viewed", true);
    expect(await studyCountries(noMatches.rows.map((r) => r.code))).toEqual([]);
  });
});

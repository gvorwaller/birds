/**
 * td-7162f6: the species-presence layer (0053-0055 + 0083) on real PostgreSQL.
 * Shared birds_test: own fixtures only (country ZZ, a per-run region, per-run
 * species codes and L… locations), exact cleanup, no seed/reset. The TRUNCATE
 * cases run inside a transaction that is always rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { env } from "$env/dynamic/private";
import { query, withTransaction } from "$lib/db";
import { presenceCounts } from "./species-presence";

const tag = randomUUID().replaceAll("-", "").slice(0, 8);
const REGION = `ZZ-P${tag.slice(0, 5).toUpperCase()}`;
const REGION2 = `ZZ-Q${tag.slice(0, 5).toUpperCase()}`;
const REGION3 = `ZZ-R${tag.slice(0, 5).toUpperCase()}`;
const SP = ["a", "b", "c", "d"].map((x) => `zzp${x}${tag}`);
const SPUH = `zzpspuh${tag}`;
const locs: string[] = [];
const newLoc = () => {
  const l = `LZZP${tag}${locs.length}`;
  locs.push(l);
  return l;
};

const version = async () =>
  BigInt((await query<{ v: string }>("SELECT version::text AS v FROM species_presence_state WHERE id = 1")).rows[0].v);
const ledger = async (loc: string) =>
  (await query<{ species_codes: string[]; country_code: string | null; region_code: string | null }>(
    "SELECT species_codes, country_code, region_code FROM species_location_membership WHERE loc_code = $1",
    [loc],
  )).rows[0];
const regionRows = async (region: string) =>
  Object.fromEntries(
    (await query<{ species_code: string; source_count: number }>(
      "SELECT species_code, source_count FROM species_region_membership WHERE region_code = $1 AND species_code = ANY($2)",
      [region, [...SP, SPUH]],
    )).rows.map((r) => [r.species_code, r.source_count]),
  );
const countryRows = async () =>
  Object.fromEntries(
    (await query<{ species_code: string; source_count: number }>(
      "SELECT species_code, source_count FROM species_country_membership WHERE country_code = 'ZZ' AND species_code = ANY($1)",
      [[...SP, SPUH]],
    )).rows.map((r) => [r.species_code, r.source_count]),
  );

type Week = [species: string, week: number, freq: number];
/** storeFrequencies' statement order: upsert metadata, delete weekly rows, insert in small batches. */
async function store(loc: string, region: string, weeks: Week[], samples?: number[]) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
       VALUES ($1, 'hotspot', 'Presence fixture', 2016, 2025, $2, 0, $3)
       ON CONFLICT (loc_code) DO UPDATE SET sample_sizes = EXCLUDED.sample_sizes, region_code = EXCLUDED.region_code`,
      [loc, samples ?? Array(48).fill(10), region],
    );
    await c.query("DELETE FROM species_frequency WHERE loc_code = $1", [loc]);
    for (let i = 0; i < weeks.length; i += 2) {
      const slice = weeks.slice(i, i + 2);
      await c.query(
        `INSERT INTO species_frequency (loc_code, species_code, week, freq)
         SELECT $1, s, w, f FROM unnest($2::text[], $3::int[], $4::float8[]) AS t(s, w, f)`,
        [loc, slice.map((x) => x[0]), slice.map((x) => x[1]), slice.map((x) => x[2])],
      );
    }
  });
}

beforeAll(async () => {
  if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "15436" || env.PGDATABASE !== "birds_test")
    throw Error("Requires dedicated birds_test");
  for (const code of SP)
    await query(
      "INSERT INTO taxonomy_cache (species_code, com_name, sci_name, family, category) VALUES ($1, 'Presence taxon', 'Presence taxon', 'Presence family', 'species')",
      [code],
    );
  await query(
    "INSERT INTO taxonomy_cache (species_code, com_name, sci_name, family, category) VALUES ($1, 'Presence spuh', 'Presence spuh', 'Presence family', 'spuh')",
    [SPUH],
  );
});

afterAll(async () => {
  await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [locs]);
  await query("DELETE FROM taxonomy_cache WHERE species_code = ANY($1)", [[...SP, SPUH]]);
  // Nothing of ours may remain in the derived tables.
  const left = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM species_region_membership WHERE region_code IN ($1, $2, $5))
          + (SELECT count(*) FROM species_country_membership WHERE species_code = ANY($3))
          + (SELECT count(*) FROM species_location_membership WHERE loc_code = ANY($4))
          + (SELECT count(*) FROM species_presence_pending WHERE loc_code = ANY($4)) AS n`,
    [REGION, REGION2, [...SP, SPUH], locs, REGION3],
  );
  expect(Number(left.rows[0].n)).toBe(0);
});

describe("species presence layer (td-7162f6)", () => {
  it("a store updates location, region and country presence at commit, with ONE version bump", async () => {
    const loc = newLoc();
    const before = await version();
    await store(loc, `${REGION}-001`, [
      [SP[0], 1, 0.2],
      [SP[0], 2, 0.1],
      [SP[1], 3, 0.05],
      [SPUH, 4, 0.3],
      [SP[2], 5, 0.4],
    ]);
    expect(await version()).toBe(before + 1n);
    const row = await ledger(loc);
    expect(row).toMatchObject({ country_code: "ZZ", region_code: REGION });
    expect(row.species_codes).toEqual([SP[0], SP[1], SP[2], SPUH].sort());
    expect(await regionRows(REGION)).toEqual({ [SP[0]]: 1, [SP[1]]: 1, [SP[2]]: 1, [SPUH]: 1 });
    expect(await countryRows()).toEqual({ [SP[0]]: 1, [SP[1]]: 1, [SP[2]]: 1, [SPUH]: 1 });
    expect((await query("SELECT 1 FROM species_presence_pending WHERE loc_code = $1", [loc])).rowCount).toBe(0);
  });

  it("only category 'species' counts in the totals", async () => {
    const counts = await presenceCounts(query as never);
    expect(counts.regions[REGION]).toBe(3);
  });

  it("a species reported only in weeks with no checklists is not present", async () => {
    const loc = newLoc();
    const samples = Array(48).fill(10);
    samples[9] = 0;
    await store(loc, REGION, [[SP[3], 10, 0.0015]], samples);
    expect((await ledger(loc)).species_codes).toEqual([]);
    expect(await regionRows(REGION)).not.toHaveProperty(SP[3]);
  });

  it("a second location adds to source_count; a reload with fewer species decrements and drops zeros", async () => {
    const loc = newLoc();
    await store(loc, REGION, [[SP[0], 1, 0.1], [SP[3], 2, 0.1]]);
    expect(await regionRows(REGION)).toMatchObject({ [SP[0]]: 2, [SP[3]]: 1 });
    const before = await version();
    await store(loc, REGION, [[SP[0], 1, 0.1]]);
    expect(await version()).toBe(before + 1n);
    const rows = await regionRows(REGION);
    expect(rows[SP[0]]).toBe(2);
    expect(rows).not.toHaveProperty(SP[3]);
    expect(await countryRows()).not.toHaveProperty(SP[3]);
  });

  it("a reload with identical species changes nothing and does not bump the version", async () => {
    const loc = locs[2];
    const before = await version();
    await store(loc, REGION, [[SP[0], 1, 0.3]]);
    expect(await version()).toBe(before);
  });

  it("a sample-size-only update re-derives presence", async () => {
    const loc = locs[2];
    const samples = Array(48).fill(10);
    samples[0] = 0;
    await query("UPDATE frequency_fetch SET sample_sizes = $2 WHERE loc_code = $1", [loc, samples]);
    expect((await ledger(loc)).species_codes).toEqual([]);
    expect((await regionRows(REGION))[SP[0]]).toBe(1);
  });

  it("a region change moves the location's species between regions", async () => {
    const loc = newLoc();
    await store(loc, REGION, [[SP[1], 1, 0.1]]);
    expect((await regionRows(REGION))[SP[1]]).toBe(2);
    await query("UPDATE frequency_fetch SET region_code = $2 WHERE loc_code = $1", [loc, REGION2]);
    expect((await regionRows(REGION))[SP[1]]).toBe(1);
    expect(await regionRows(REGION2)).toEqual({ [SP[1]]: 1 });
    expect((await ledger(loc)).region_code).toBe(REGION2);
  });

  it("deleting a location (cascade) removes its contribution", async () => {
    const loc = locs[locs.length - 1];
    await query("DELETE FROM frequency_fetch WHERE loc_code = $1", [loc]);
    expect(await ledger(loc)).toBeUndefined();
    expect(await regionRows(REGION2)).toEqual({});
  });

  it("a rolled-back store changes nothing, version included", async () => {
    const loc = newLoc();
    const before = await version();
    const regionBefore = await regionRows(REGION);
    await expect(
      withTransaction(async (c) => {
        await c.query(
          `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
           VALUES ($1, 'hotspot', 'Presence fixture', 2016, 2025, array_fill(10, ARRAY[48]), 0, $2)`,
          [loc, REGION],
        );
        await c.query("INSERT INTO species_frequency (loc_code, species_code, week, freq) VALUES ($1, $2, 1, 0.5)", [loc, SP[3]]);
        throw new Error("rollback on purpose");
      }),
    ).rejects.toThrow("rollback on purpose");
    expect(await version()).toBe(before);
    expect(await regionRows(REGION)).toEqual(regionBefore);
    expect(await ledger(loc)).toBeUndefined();
  });

  it("a new location with no species still gets a ledger row (zero is known, not missing)", async () => {
    const loc = newLoc();
    await store(loc, REGION, []);
    expect(await ledger(loc)).toMatchObject({ species_codes: [], region_code: REGION });
  });

  it("a loaded place whose locations have no species reads 0; an unloaded place has no entry", async () => {
    const loc = newLoc();
    await store(loc, REGION3, []);
    const counts = await presenceCounts(query as never);
    expect(counts.regions[REGION3]).toBe(0);
    expect(counts.regions).not.toHaveProperty(`ZZ-NONE${tag.toUpperCase()}`);
  });

  it("a taxonomy write bumps the version (category decides what counts)", async () => {
    const before = await version();
    await query("UPDATE taxonomy_cache SET category = 'species' WHERE species_code = $1", [SP[0]]);
    expect(await version()).toBe(before + 1n);
  });

  it("concurrent stores in different regions and in one region both commit (no deadlock)", async () => {
    const a = newLoc();
    const b = newLoc();
    const c = newLoc();
    await Promise.all([
      store(a, REGION, [[SP[2], 1, 0.1], [SP[1], 2, 0.1]]),
      store(b, REGION2, [[SP[1], 1, 0.1], [SP[2], 2, 0.1]]),
      store(c, REGION, [[SP[1], 3, 0.1], [SP[2], 4, 0.1]]),
    ]);
    expect((await regionRows(REGION2))[SP[1]]).toBe(1);
    expect((await ledger(c)).species_codes).toEqual([SP[1], SP[2]].sort());
  });

  it("TRUNCATE guards clear region and country presence and bump the version (owner role; always rolled back)", async () => {
    // TRUNCATE is an owner-only bulk reset; birds_app cannot run it.
    const owner = new pg.Client({
      host: env.PGHOST,
      port: Number(env.PGPORT),
      database: env.PGDATABASE,
      user: env.MIGRATION_PGUSER ?? "birds_owner",
      password: env.MIGRATION_PGPASSWORD,
    });
    await owner.connect();
    try {
      for (const statement of [
        "TRUNCATE species_frequency",
        "TRUNCATE species_location_membership",
        "TRUNCATE frequency_fetch CASCADE",
      ]) {
        const before = await version();
        await owner.query("BEGIN");
        try {
          await owner.query("SET LOCAL lock_timeout = '5s'");
          await owner.query(statement);
          const r = await owner.query<{ region: string; country: string; loc: string; v: string }>(
            `SELECT (SELECT count(*) FROM species_region_membership)::text AS region,
                    (SELECT count(*) FROM species_country_membership)::text AS country,
                    (SELECT count(*) FROM species_location_membership)::text AS loc,
                    (SELECT version::text FROM species_presence_state) AS v`,
          );
          expect(r.rows[0]).toMatchObject({ region: "0", country: "0", loc: "0" });
          expect(BigInt(r.rows[0].v)).toBeGreaterThan(before);
        } finally {
          await owner.query("ROLLBACK");
        }
      }
    } finally {
      await owner.end();
    }
    // Rolled back: our fixtures are intact.
    expect((await regionRows(REGION))[SP[0]]).toBeGreaterThan(0);
  }, 60_000);

  it("the forecast species picker admits only effectively present species", async () => {
    const { readFileSync } = await import("node:fs");
    const server = readFileSync("src/routes/forecast/species/+page.server.ts", "utf8");
    expect(server).toContain("FROM species_location_membership lm");
    expect(server).not.toMatch(/AND EXISTS \(SELECT 1 FROM species_frequency sf\s+WHERE sf\.loc_code = \$2/);
  });
});

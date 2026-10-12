/**
 * td-b569b5 (plan D5): the enrichment universe reads the species-presence
 * layer, not the weekly rows. Shared birds_test: own fixtures only (country ZZ,
 * per-run species codes and L… locations, a per-run user and its one seen
 * row, one photo row), exact cleanup, no seed/reset. The ledger-gap case runs
 * inside a transaction that is always rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { env } from "$env/dynamic/private";
import pg from "pg";
import { query, withTransaction } from "$lib/db";
import { guideLocationCoverage } from "./guide-location";
import { enrichmentScope, inScopeSql, placeParams, placeSpeciesSql } from "./species-enrichment";

const tag = randomUUID().replaceAll("-", "").slice(0, 8);
const PRESENT = `zzsp${tag}`; // weekly rows in a week with checklists (country ZZ)
const UNASSIGNED = `zzsu${tag}`; // weekly rows at a location with no country
const ZERO = `zzsz${tag}`; // weekly rows only in a week with no checklists
const SEEN = `zzss${tag}`; // on a life list, no weekly rows
const PHOTO = `zzsh${tag}`; // photo-linked, no weekly rows
const NONE = `zzsn${tag}`; // taxonomy only
const CODES = [PRESENT, UNASSIGNED, ZERO, SEEN, PHOTO, NONE];
const LOC_ZZ = `LZZS${tag}0`;
const LOC_NONE = `LZZS${tag}1`;
const REGION = `ZZ-S${tag.slice(0, 5).toUpperCase()}`;
const PHOTO_ID = `zzscope-${tag}`;
let uid = 0;

async function store(loc: string, region: string | null, rows: [string, number][], samples: number[]) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
       VALUES ($1, 'hotspot', 'Scope fixture', 2016, 2025, $2, 0, $3)`,
      [loc, samples, region],
    );
    await c.query(
      `INSERT INTO species_frequency (loc_code, species_code, week, freq)
       SELECT $1, s, w, 0.2 FROM unnest($2::text[], $3::int[]) AS t(s, w)`,
      [loc, rows.map((r) => r[0]), rows.map((r) => r[1])],
    );
    // num = weeks with checklists in which the species was reported (barchart.ts rollup).
    await c.query(
      `INSERT INTO species_month_freq (loc_code, species_code, month, num)
       SELECT $1, s, (w - 1) / 4 + 1, count(*) FILTER (WHERE ($4::int[])[w] > 0)
         FROM unnest($2::text[], $3::int[]) AS t(s, w)
        GROUP BY s, (w - 1) / 4 + 1`,
      [loc, rows.map((r) => r[0]), rows.map((r) => r[1]), samples],
    );
  });
}

beforeAll(async () => {
  if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "15436" || env.PGDATABASE !== "birds_test")
    throw Error("Requires dedicated birds_test");
  for (const code of CODES)
    await query(
      "INSERT INTO taxonomy_cache (species_code, com_name, sci_name, family, category) VALUES ($1, 'Scope taxon', 'Scope taxon', 'Scope family', 'species')",
      [code],
    );
  // Week 2 has no checklists at the ZZ location.
  const samples = Array(48).fill(10);
  samples[1] = 0;
  await store(LOC_ZZ, REGION, [[PRESENT, 1], [ZERO, 2]], samples);
  await store(LOC_NONE, null, [[UNASSIGNED, 1]], Array(48).fill(10));
  uid = (
    await query<{ id: number }>(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, 'Scope test', '!unset', 'user') RETURNING id",
      [`zzscope-${tag}`],
    )
  ).rows[0].id;
  await query("INSERT INTO seen_species (user_id, species_code, source) VALUES ($1, $2, 'manual')", [uid, SEEN]);
  await query(
    `INSERT INTO photo_links (photo_id, species_code, source_species, url, thumbnail, page_url, match_method)
     VALUES ($1, $2, 'Scope taxon', 'https://example.invalid/p', 'https://example.invalid/t', 'https://example.invalid/', 'override')`,
    [PHOTO_ID, PHOTO],
  );
});

afterAll(async () => {
  await query("DELETE FROM photo_links WHERE photo_id = $1", [PHOTO_ID]);
  await query("DELETE FROM seen_species WHERE user_id = $1 AND species_code = $2", [uid, SEEN]);
  await query("DELETE FROM users WHERE id = $1 AND username = $2", [uid, `zzscope-${tag}`]);
  await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [[LOC_ZZ, LOC_NONE]]);
  await query("DELETE FROM taxonomy_cache WHERE species_code = ANY($1)", [CODES]);
  const left = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM species_country_membership WHERE species_code = ANY($1))
          + (SELECT count(*) FROM species_location_membership WHERE loc_code = ANY($2))
          + (SELECT count(*) FROM species_region_membership WHERE region_code = $3) AS n`,
    [CODES, [LOC_ZZ, LOC_NONE], REGION],
  );
  expect(Number(left.rows[0].n)).toBe(0);
});

describe("enrichment scope reads the species-presence layer (td-b569b5)", () => {
  it("admits seen, photo-linked, effectively present and unassigned-location species only", async () => {
    expect((await query("SELECT 1 FROM species_location_membership WHERE loc_code = $1 AND country_code IS NULL", [LOC_NONE])).rowCount).toBe(1);
    const scope = new Set(await enrichmentScope());
    expect(CODES.filter((c) => scope.has(c)).sort()).toEqual([PRESENT, UNASSIGNED, SEEN, PHOTO].sort());
  });

  it("a loaded location missing from the ledger keeps its species in scope, as in the Field Guide (rolled back)", async () => {
    // A broken ledger, made only inside a transaction that is always rolled
    // back, on the owner connection (the app role cannot write the ledger).
    const c = new pg.Client({
      host: env.PGHOST,
      port: Number(env.PGPORT),
      database: env.PGDATABASE,
      user: env.MIGRATION_PGUSER,
      password: env.MIGRATION_PGPASSWORD,
    });
    await c.connect();
    const run = ((text: string, params?: unknown[]) => c.query(text, params as never[])) as never;
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM species_location_membership WHERE loc_code = $1", [LOC_ZZ]);
      // The gap is real: the country table lost the location's species.
      expect((await c.query("SELECT 1 FROM species_country_membership WHERE species_code = $1", [PRESENT])).rowCount).toBe(0);
      // The Field Guide still lists it for the region...
      const coverage = await guideLocationCoverage(REGION, run);
      expect(coverage.unledgered).toEqual([LOC_ZZ]);
      const [kind, code, locCodes, unledgered] = placeParams({ kind: "region", code: REGION, unledgered: coverage.unledgered });
      const guide = await c.query<{ species_code: string }>(
        `SELECT species_code FROM (${placeSpeciesSql("$1", "$2", "$3", "$4")}) p WHERE species_code = ANY($5)`,
        [kind, code, locCodes, unledgered, CODES],
      );
      expect(guide.rows.map((r) => r.species_code)).toEqual([PRESENT]);
      // ...and enrichment keeps it in scope; the zero-checklist species stays out.
      const scope = await c.query<{ species_code: string }>(
        `SELECT tc.species_code FROM taxonomy_cache tc
          WHERE tc.species_code = ANY($1) AND ${inScopeSql("tc.species_code")}`,
        [CODES],
      );
      expect(scope.rows.map((r) => r.species_code).sort()).toEqual([PRESENT, UNASSIGNED, SEEN, PHOTO].sort());
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
    expect((await query("SELECT 1 FROM species_location_membership WHERE loc_code = $1", [LOC_ZZ])).rowCount).toBe(1);
  });

  it("no enrichment reader touches the weekly rows", () => {
    const src = readFileSync("src/lib/server/species-enrichment.ts", "utf8");
    expect(src).not.toMatch(/FROM species_frequency/);
  });
});

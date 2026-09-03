#!/usr/bin/env node
/**
 * Removes everything scripts/seed-ribbon-fixture.mjs wrote. TEST-ONLY.
 *
 * Required because the fixture's real production country codes (US, CA,
 * AU, ...) share `band_locs` / `band_month_samples` / `species_band_month_freq`
 * grouping keys with forecast-db.test.ts's OWN synthetic fixtures for the
 * same countries (e.g. country='US', band=40, west=true) — those tables
 * have no per-caller namespace, so seeded real rows and a test's temporary
 * rows land in the same aggregate group and corrupt each other's counts.
 * Run this before any test suite run that touches ribbonRegions/speciesRibbon.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import pg from "pg";

const FORCE = process.argv.includes("--force");
if (process.env.BIRDS_ENV !== "test" && !FORCE) {
  console.error("[unseed-ribbon-fixture] refusing to run outside BIRDS_ENV=test (pass --force to override).");
  process.exit(1);
}

function loadFixtureMeta() {
  const src = readFileSync(new URL("../docs/mockups/ribbon-prod-curves.js", import.meta.url), "utf8");
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function("window", src)(win);
  return win.RIBBON_DATA;
}

async function main() {
  const client = new pg.Client({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 15436),
    database: process.env.PGDATABASE ?? "birds_test",
    user: process.env.MIGRATION_PGUSER ?? process.env.PGUSER,
    password: process.env.MIGRATION_PGPASSWORD ?? process.env.PGPASSWORD,
  });
  await client.connect();
  const regions = loadFixtureMeta();
  const locCodes = regions.map((r) => r.code);
  const countries = [...new Set(regions.map((r) => r.country))];
  const species = ["osprey", "bkpwar", "bkcchi"];

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM species_frequency WHERE loc_code = ANY($1) AND species_code = ANY($2)", [
      locCodes,
      species,
    ]);
    await client.query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [locCodes]);
    await client.query("DELETE FROM species_band_month_freq WHERE country = ANY($1) AND species_code = ANY($2)", [
      countries,
      species,
    ]);
    await client.query("DELETE FROM band_month_samples WHERE country = ANY($1)", [countries]);
    await client.query("DELETE FROM band_locs WHERE country = ANY($1)", [countries]);
    await client.query("DELETE FROM taxonomy_cache WHERE species_code = ANY($1)", [species]);
    await client.query("COMMIT");
    console.log(
      `[unseed-ribbon-fixture] removed fixture rows for ${locCodes.length} regions, ${countries.length} countries, species ${species.join(", ")}.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[unseed-ribbon-fixture] failed:", err);
  process.exitCode = 1;
});

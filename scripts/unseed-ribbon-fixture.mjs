#!/usr/bin/env node
/**
 * Removes exactly what scripts/seed-ribbon-fixture.mjs recorded it wrote,
 * via `.local/ribbon-fixture-marker.json`. TEST-ONLY.
 *
 * SAFETY (CC1 P2-1, 2026-09-03): `BIRDS_ENV=test` is also set on a
 * prod-restored `birds_test` — a supported workflow here — so this script
 * never re-derives "what to delete" from the fixture file (docs/mockups/
 * ribbon-prod-curves.js real country/loc codes would otherwise make it
 * indistinguishable from real production rows). It deletes ONLY the
 * loc_codes / species / countries the marker lists, and refuses outright
 * (exit 1) if no marker exists — including on a prod-restored cluster,
 * where there is nothing this script ever created to remove; reset the
 * test cluster instead (`npm run test:db:reset && npm run test:db:up`).
 *
 * `band_locs`/`species_frequency`/etc. for the marked loc_codes cascade
 * from the `frequency_fetch` delete (FK ON DELETE CASCADE); the aggregate
 * `band_month_samples`/`species_band_month_freq` tables are not FK'd to
 * `frequency_fetch` and are deleted explicitly, scoped to the marker's own
 * countries/species — safe only because seed's pre-flight check refused to
 * write there unless those groups were exclusively this fixture's.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import process from "node:process";
import pg from "pg";

const FORCE = process.argv.includes("--force");
if (process.env.BIRDS_ENV !== "test" && !FORCE) {
  console.error("[unseed-ribbon-fixture] refusing to run outside BIRDS_ENV=test (pass --force to override).");
  process.exit(1);
}

const MARKER_PATH = new URL("../.local/ribbon-fixture-marker.json", import.meta.url);

async function main() {
  if (!existsSync(MARKER_PATH)) {
    console.error(
      `[unseed-ribbon-fixture] refusing: no marker at ${MARKER_PATH.pathname} — nothing recorded ` +
        `as created by seed-ribbon-fixture.mjs (already unseeded, never seeded, or a different ` +
        `cluster). There is nothing safe to delete here.`,
    );
    process.exit(1);
  }
  const marker = JSON.parse(readFileSync(MARKER_PATH, "utf8"));
  const { locCodes, species, countries } = marker;
  if (!Array.isArray(locCodes) || !Array.isArray(species) || !Array.isArray(countries)) {
    console.error(`[unseed-ribbon-fixture] refusing: marker at ${MARKER_PATH.pathname} is malformed.`);
    process.exit(1);
  }

  const client = new pg.Client({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 15436),
    database: process.env.PGDATABASE ?? "birds_test",
    user: process.env.MIGRATION_PGUSER ?? process.env.PGUSER,
    password: process.env.MIGRATION_PGPASSWORD ?? process.env.PGPASSWORD,
  });
  await client.connect();

  try {
    await client.query("BEGIN");
    // Cascades band_locs, species_frequency, frequency_anomalies,
    // loc_month_samples, species_month_freq for these loc_codes.
    await client.query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [locCodes]);
    await client.query(
      "DELETE FROM species_band_month_freq WHERE country = ANY($1) AND species_code = ANY($2)",
      [countries, species],
    );
    await client.query("DELETE FROM band_month_samples WHERE country = ANY($1)", [countries]);
    await client.query("DELETE FROM taxonomy_cache WHERE species_code = ANY($1)", [species]);
    await client.query("COMMIT");
    unlinkSync(MARKER_PATH);
    console.log(
      `[unseed-ribbon-fixture] removed marked fixture rows for ${locCodes.length} regions, ` +
        `${countries.length} countries, species ${species.join(", ")}. Marker deleted.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[unseed-ribbon-fixture] failed:", err.message ?? err);
  process.exitCode = 1;
});

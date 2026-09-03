#!/usr/bin/env node
/**
 * TEST-ONLY fixture seeder for the migration ribbon (td-950907 manual
 * verification). NOT part of the app or the deploy path — delete freely
 * once TD-C has been reviewed in the running app.
 *
 * Loads docs/mockups/ribbon-prod-curves.js (real production eBird barchart
 * curves for 196 subnational1 regions, 3 species) and writes:
 *   - taxonomy_cache rows for osprey / bkpwar / bkcchi
 *   - frequency_fetch + species_frequency, per region (drives the drill
 *     endpoint and the existing Best-time-of-year teaser)
 *   - band_locs / band_month_samples / species_band_month_freq, aggregated
 *     with the SAME arithmetic as migration 0050's backfill (grouped by
 *     band/country/west), so the ribbon grid reads real numbers.
 *
 * SAFETY (CC1 P2-1, 2026-09-03): `BIRDS_ENV=test` is also set on a
 * prod-restored `birds_test` — a supported workflow here — so it cannot by
 * itself tell "empty test cluster" from "real data, just restored". This
 * script therefore refuses outright (exit 1) rather than upserting/deleting
 * if ANY fixture loc_code already exists in `frequency_fetch`, if any of
 * the three species already exists in `taxonomy_cache`, or if any OTHER
 * loc_code already contributes to a (band, country, west) group this
 * fixture would aggregate into (that write would silently fold real
 * coverage into a number that is actually only this fixture's). On a
 * prod-restored cluster, run `npm run test:db:reset && npm run test:db:up`
 * FIRST — seeding is only safe against an empty/isolated test cluster.
 *
 * On success this records exactly what it wrote — plus the database's own
 * identity (`pg_database.oid` + `pg_postmaster_start_time()`, CC1 P2-1) —
 * to `.local/ribbon-fixture-marker.json`; `unseed-ribbon-fixture.mjs`
 * refuses unless the CURRENT database matches that identity, and deletes
 * only what the marker lists (never a re-derivation from this file, and
 * never anything it did not itself create). A prod-restored cluster must
 * be reset (`npm run test:db:reset && npm run test:db:up`) before seeding
 * — that is also what invalidates a stale marker from a dropped database.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import pg from "pg";

const FORCE = process.argv.includes("--force");
if (process.env.BIRDS_ENV !== "test" && !FORCE) {
  console.error(
    "[seed-ribbon-fixture] refusing to run outside BIRDS_ENV=test (pass --force to override).",
  );
  process.exit(1);
}

const SPECIES = {
  osprey: { com_name: "Osprey", sci_name: "Pandion haliaetus", family: "Pandionidae" },
  bkpwar: { com_name: "Blackpoll Warbler", sci_name: "Setophaga striata", family: "Parulidae" },
  bkcchi: {
    com_name: "Black-capped Chickadee",
    sci_name: "Poecile atricapillus",
    family: "Paridae",
  },
};
const NA_SPLIT_LON = -100;
const PRESENT = 0.005;
const MARKER_PATH = new URL("../.local/ribbon-fixture-marker.json", import.meta.url);

function bandOf(lat) {
  return Math.max(-90, Math.min(80, Math.floor(lat / 10) * 10));
}

function loadFixture() {
  const src = readFileSync(
    new URL("../docs/mockups/ribbon-prod-curves.js", import.meta.url),
    "utf8",
  );
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function("window", src)(win);
  return win.RIBBON_DATA;
}

/**
 * Identity of the DATABASE this connection is talking to, not just its name
 * (CC1 P2-1): `test-db-reset.sh` DROPs and CREATEs `birds_test`, which gets
 * a brand-new `pg_database.oid` even though the name is unchanged — a
 * dropped-and-recreated database is a DIFFERENT database as far as this
 * marker is concerned. `pg_postmaster_start_time()` additionally catches a
 * full Postgres restart. Neither alone (nor together) proves an in-place
 * `pg_restore` never happened without a drop/recreate — that risk is why
 * unseed ALSO re-verifies frequency_fetch/band_locs content before
 * deleting anything, not just this identity match.
 */
async function getDbIdentity(client) {
  const res = await client.query(
    `SELECT (SELECT oid FROM pg_database WHERE datname = current_database()) AS oid,
            pg_postmaster_start_time() AS start_time`,
  );
  return { oid: res.rows[0].oid, startTime: res.rows[0].start_time };
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
  const dbIdentity = await getDbIdentity(client);

  const regions = loadFixture();
  const locCodes = regions.map((r) => r.code);
  const species = Object.keys(SPECIES);
  const countries = [...new Set(regions.map((r) => r.country))];
  console.log(`[seed-ribbon-fixture] ${regions.length} regions, species: ${species.join(", ")}`);

  try {
    await client.query("BEGIN");

    // ---- Pre-flight: refuse rather than overwrite/merge into anything
    // this script did not create (CC1 P2-1). ------------------------------
    const existingLocs = await client.query(
      "SELECT loc_code FROM frequency_fetch WHERE loc_code = ANY($1) ORDER BY loc_code",
      [locCodes],
    );
    if (existingLocs.rows.length > 0) {
      const sample = existingLocs.rows.slice(0, 5).map((r) => r.loc_code).join(", ");
      throw new Error(
        `refusing to seed: ${existingLocs.rows.length} fixture loc_code(s) already exist in ` +
          `frequency_fetch (e.g. ${sample}) — this looks like an already-seeded or ` +
          `prod-restored cluster. Run 'npm run unseed:ribbon-fixture' first if this is a ` +
          `stale fixture, or 'npm run test:db:reset && npm run test:db:up' if this is a ` +
          `prod-restored cluster, then re-seed.`,
      );
    }
    const existingSpecies = await client.query(
      "SELECT species_code FROM taxonomy_cache WHERE species_code = ANY($1) ORDER BY species_code",
      [species],
    );
    if (existingSpecies.rows.length > 0) {
      const sample = existingSpecies.rows.map((r) => r.species_code).join(", ");
      throw new Error(
        `refusing to seed: taxonomy_cache already has ${sample} — this looks like an ` +
          `already-seeded or prod-restored cluster (real taxonomy would already carry these ` +
          `codes). Reset the test cluster or unseed first.`,
      );
    }
    // A DIFFERENT loc_code already contributing to a (band, country, west)
    // group this fixture aggregates into: writing there would fold real
    // coverage into a total that is actually only this fixture's.
    const foreignBandLocs = await client.query(
      "SELECT DISTINCT country FROM band_locs WHERE country = ANY($1) AND NOT (loc_code = ANY($2))",
      [countries, locCodes],
    );
    if (foreignBandLocs.rows.length > 0) {
      const sample = foreignBandLocs.rows.map((r) => r.country).join(", ");
      throw new Error(
        `refusing to seed: band_locs already has OTHER regions loaded for ${sample} — ` +
          `aggregating this fixture into those (band, country, west) groups would silently ` +
          `merge real coverage into fixture-only numbers. Reset the test cluster first.`,
      );
    }

    for (const [code, meta] of Object.entries(SPECIES)) {
      await client.query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
         VALUES ($1, $2, $3, 'species', $4)`,
        [code, meta.com_name, meta.sci_name, meta.family],
      );
    }

    // ---- Per-region frequency_fetch + species_frequency (drill / teaser) ----
    for (const r of regions) {
      // 48 weekly sample sizes reconstructing the fixture's monthly n exactly
      // (monthlyStat sums 4 weeks/month — forecast.ts:65-70,77-91).
      const sampleSizes = [];
      for (let m = 0; m < 12; m++) {
        const n = r.curves.osprey[m][1]; // n is species-independent in this fixture
        const base = Math.round(n / 4);
        const last = n - base * 3;
        sampleSizes.push(base, base, base, last);
      }
      await client.query(
        `INSERT INTO frequency_fetch
           (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes,
            n_species, n_unmatched, unmatched_names, region_code, fetched_at)
         VALUES ($1, 'region', $2, 2016, 2026, $3, $4, 0, '{}', $1, NOW())`,
        [r.code, r.name, sampleSizes, species.length],
      );
      for (const sp of species) {
        const curve = r.curves[sp];
        for (let m = 0; m < 12; m++) {
          const [freq] = curve[m];
          if (freq <= 0) continue;
          for (let wk = 0; wk < 4; wk++) {
            await client.query(
              `INSERT INTO species_frequency (loc_code, species_code, week, freq)
               VALUES ($1, $2, $3, $4)`,
              [r.code, sp, m * 4 + wk + 1, freq],
            );
          }
        }
      }
    }

    // ---- Aggregate band tables, identical grouping to 0050's backfill ----
    const groupKey = (band, country, west) => `${band}|${country}|${west}`;
    /** @type {Map<string, { band:number; country:string; west:boolean; locCodes:Set<string> }>} */
    const locGroups = new Map();
    for (const r of regions) {
      const band = bandOf(r.lat);
      const west = (r.country === "US" || r.country === "CA" || r.country === "MX") && r.lon < NA_SPLIT_LON;
      const key = groupKey(band, r.country, west);
      let g = locGroups.get(key);
      if (!g) locGroups.set(key, (g = { band, country: r.country, west, locCodes: new Set() }));
      g.locCodes.add(r.code);
    }

    for (const g of locGroups.values()) {
      for (const locCode of g.locCodes) {
        await client.query(
          `INSERT INTO band_locs (band, country, west, loc_code) VALUES ($1,$2,$3,$4)`,
          [g.band, g.country, g.west, locCode],
        );
      }
    }

    const regionsByCode = new Map(regions.map((r) => [r.code, r]));
    for (const g of locGroups.values()) {
      for (let m = 0; m < 12; m++) {
        let n = 0;
        for (const locCode of g.locCodes) n += regionsByCode.get(locCode).curves.osprey[m][1];
        await client.query(
          `INSERT INTO band_month_samples (band, country, west, month, n) VALUES ($1,$2,$3,$4,$5)`,
          [g.band, g.country, g.west, m + 1, n],
        );
      }
      for (const sp of species) {
        for (let m = 0; m < 12; m++) {
          let num = 0;
          let reached = 0;
          for (const locCode of g.locCodes) {
            const [freq, n] = regionsByCode.get(locCode).curves[sp][m];
            num += freq * n;
            if (n > 0 && freq >= PRESENT) reached++;
          }
          await client.query(
            `INSERT INTO species_band_month_freq (species_code, band, country, west, month, num, reached)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [sp, g.band, g.country, g.west, m + 1, num, reached],
          );
        }
      }
    }

    await client.query("COMMIT");

    mkdirSync(new URL("../.local/", import.meta.url), { recursive: true });
    writeFileSync(
      MARKER_PATH,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          dbOid: dbIdentity.oid,
          dbPostmasterStartTime: dbIdentity.startTime,
          locCodes,
          species,
          countries,
        },
        null,
        2,
      ),
    );
    console.log(
      `[seed-ribbon-fixture] done: ${locGroups.size} band/country/west groups, ${regions.length} regions, ` +
        `3 species. Marker written to ${MARKER_PATH.pathname}.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[seed-ribbon-fixture] failed:", err.message ?? err);
  process.exitCode = 1;
});

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
 * Refuses to run unless BIRDS_ENV=test (cs.md safety convention) or --force
 * is passed.
 */
import { readFileSync } from "node:fs";
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

async function main() {
  const client = new pg.Client({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 15436),
    database: process.env.PGDATABASE ?? "birds_test",
    user: process.env.MIGRATION_PGUSER ?? process.env.PGUSER,
    password: process.env.MIGRATION_PGPASSWORD ?? process.env.PGPASSWORD,
  });
  await client.connect();

  const regions = loadFixture();
  console.log(`[seed-ribbon-fixture] ${regions.length} regions, species: ${Object.keys(SPECIES).join(", ")}`);

  try {
    await client.query("BEGIN");

    for (const [code, meta] of Object.entries(SPECIES)) {
      await client.query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
         VALUES ($1, $2, $3, 'species', $4)
         ON CONFLICT (species_code) DO UPDATE SET
           com_name = EXCLUDED.com_name, sci_name = EXCLUDED.sci_name, family = EXCLUDED.family`,
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
         VALUES ($1, 'region', $2, 2016, 2026, $3, $4, 0, '{}', $1, NOW())
         ON CONFLICT (loc_code) DO UPDATE SET
           loc_name = EXCLUDED.loc_name, sample_sizes = EXCLUDED.sample_sizes,
           n_species = EXCLUDED.n_species, region_code = EXCLUDED.region_code,
           fetched_at = NOW()`,
        [r.code, r.name, sampleSizes, Object.keys(SPECIES).length],
      );
      await client.query("DELETE FROM species_frequency WHERE loc_code = $1 AND species_code = ANY($2)", [
        r.code,
        Object.keys(SPECIES),
      ]);
      for (const species of Object.keys(SPECIES)) {
        const curve = r.curves[species];
        const rows = [];
        for (let m = 0; m < 12; m++) {
          const [freq] = curve[m];
          if (freq <= 0) continue;
          for (let wk = 0; wk < 4; wk++) rows.push([m * 4 + wk + 1, freq]);
        }
        for (const [week, freq] of rows) {
          await client.query(
            `INSERT INTO species_frequency (loc_code, species_code, week, freq)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (loc_code, species_code, week) DO UPDATE SET freq = EXCLUDED.freq`,
            [r.code, species, week, freq],
          );
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

    await client.query("DELETE FROM species_band_month_freq WHERE species_code = ANY($1)", [
      Object.keys(SPECIES),
    ]);
    // Only clear band_locs/band_month_samples rows this fixture is about to
    // rewrite (by country), so a re-run is idempotent without touching any
    // other seeded coverage.
    const countries = [...new Set(regions.map((r) => r.country))];
    await client.query("DELETE FROM band_locs WHERE country = ANY($1)", [countries]);
    await client.query("DELETE FROM band_month_samples WHERE country = ANY($1)", [countries]);

    for (const g of locGroups.values()) {
      for (const locCode of g.locCodes) {
        await client.query(
          `INSERT INTO band_locs (band, country, west, loc_code) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [g.band, g.country, g.west, locCode],
        );
      }
    }

    const regionsByCode = new Map(regions.map((r) => [r.code, r]));
    for (const [key, g] of locGroups) {
      for (let m = 0; m < 12; m++) {
        let n = 0;
        for (const locCode of g.locCodes) n += regionsByCode.get(locCode).curves.osprey[m][1];
        await client.query(
          `INSERT INTO band_month_samples (band, country, west, month, n) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (band, country, west, month) DO UPDATE SET n = EXCLUDED.n`,
          [g.band, g.country, g.west, m + 1, n],
        );
      }
      for (const species of Object.keys(SPECIES)) {
        for (let m = 0; m < 12; m++) {
          let num = 0;
          let reached = 0;
          for (const locCode of g.locCodes) {
            const [freq, n] = regionsByCode.get(locCode).curves[species][m];
            num += freq * n;
            if (n > 0 && freq >= PRESENT) reached++;
          }
          await client.query(
            `INSERT INTO species_band_month_freq (species_code, band, country, west, month, num, reached)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (species_code, band, country, west, month)
             DO UPDATE SET num = EXCLUDED.num, reached = EXCLUDED.reached`,
            [species, g.band, g.country, g.west, m + 1, num, reached],
          );
        }
      }
    }

    await client.query("COMMIT");
    console.log(
      `[seed-ribbon-fixture] done: ${locGroups.size} band/country/west groups, ${regions.length} regions, 3 species.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[seed-ribbon-fixture] failed:", err);
  process.exitCode = 1;
});

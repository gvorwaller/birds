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
 * Three independent guards before anything is deleted:
 *  1. DATABASE IDENTITY: the marker's `pg_database.oid` and
 *     `pg_postmaster_start_time()` must match the CURRENT database exactly.
 *     `test-db-reset.sh` DROPs and CREATEs `birds_test`, which gets a new
 *     oid even with the same name — a marker from before that reset now
 *     describes a database that no longer exists, and this script refuses
 *     rather than trust it. (`test-db-reset.sh` also deletes the marker
 *     file on success, so this is belt-and-suspenders against a marker
 *     that survives some OTHER reset path.)
 *  2. TABLE LOCK (CODEX1 P2-1, 2026-09-03): the content re-verification
 *     below and the DELETEs that follow it are otherwise a check-then-act
 *     race under READ COMMITTED — nothing stops a concurrent writer (the
 *     worker's `storeFrequencies` transaction rebuilding a country's
 *     rollup, another seed/unseed run) from committing a new contributor
 *     between the validation SELECTs and the DELETEs, which would then
 *     delete a row the validation never saw. Immediately after `BEGIN`,
 *     `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE` on every table this
 *     script reads-then-deletes: that mode conflicts with every other
 *     writer's lock (INSERT/UPDATE/DELETE all take ROW EXCLUSIVE or
 *     stronger) while still allowing plain readers (e.g. the app serving
 *     GETs), so once it's acquired no writer can commit a change until
 *     this transaction ends — making the validate-then-delete atomic with
 *     respect to every table it touches. A 5s `lock_timeout` means a busy
 *     cluster fails closed (refuse, roll back, exit 1) rather than hang.
 *  3. CONTENT RE-VERIFICATION (inside that lock, before any DELETE):
 *     `frequency_fetch` must hold EXACTLY the marker's loc_codes for the
 *     marker's countries (no more, no fewer — an in-place `pg_restore`
 *     that never dropped the database would still change this), and
 *     `band_locs` must have no OTHER contributor for those countries.
 *     Either mismatch refuses outright.
 *
 * `band_locs`/`species_frequency`/etc. for the marked loc_codes cascade
 * from the `frequency_fetch` delete (FK ON DELETE CASCADE); the aggregate
 * `band_month_samples`/`species_band_month_freq` tables are not FK'd to
 * `frequency_fetch` and are deleted explicitly, scoped to the marker's own
 * countries/species.
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

async function getDbIdentity(client) {
  const res = await client.query(
    `SELECT (SELECT oid FROM pg_database WHERE datname = current_database()) AS oid,
            pg_postmaster_start_time() AS start_time`,
  );
  return { oid: res.rows[0].oid, startTime: res.rows[0].start_time };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

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
  const { locCodes, species, countries, dbOid, dbPostmasterStartTime } = marker;
  if (
    !Array.isArray(locCodes) ||
    !Array.isArray(species) ||
    !Array.isArray(countries) ||
    dbOid == null ||
    !dbPostmasterStartTime
  ) {
    console.error(
      `[unseed-ribbon-fixture] refusing: marker at ${MARKER_PATH.pathname} is malformed or predates ` +
        `the database-identity guard (re-seed with the current scripts to get a valid marker).`,
    );
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
    const identity = await getDbIdentity(client);
    if (
      String(identity.oid) !== String(dbOid) ||
      new Date(identity.startTime).getTime() !== new Date(dbPostmasterStartTime).getTime()
    ) {
      throw new Error(
        `refusing: the marker's database identity (oid ${dbOid}, postmaster start ` +
          `${dbPostmasterStartTime}) does not match the CURRENT database (oid ${identity.oid}, ` +
          `postmaster start ${identity.startTime.toISOString()}) — this looks like a different ` +
          `database incarnation (e.g. a reset since the marker was written, or a restore). There ` +
          `is nothing this script created in THIS database to remove.`,
      );
    }

    await client.query("BEGIN");

    // Lock every table this script reads-then-deletes, BEFORE the first
    // validation query (CODEX1 P2-1): SHARE ROW EXCLUSIVE conflicts with
    // every other writer (a frequency rebuild's storeFrequencies
    // transaction, another seed/unseed run) while still allowing plain
    // readers, so nothing can commit a new contributor between the
    // validation SELECTs below and the DELETEs that follow — the
    // check-then-act race CODEX1 flagged is closed for the duration of
    // this transaction. Fails closed: a 5s lock_timeout means a busy
    // cluster refuses rather than blocks indefinitely.
    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        `LOCK TABLE frequency_fetch, species_frequency, species_month_freq, loc_month_samples,
                  band_locs, band_month_samples, species_band_month_freq, taxonomy_cache
           IN SHARE ROW EXCLUSIVE MODE`,
      );
    } catch (lockErr) {
      await client.query("ROLLBACK").catch(() => {});
      if (lockErr && lockErr.code === "55P03") {
        console.error(
          "[unseed-ribbon-fixture] refusing: could not acquire SHARE ROW EXCLUSIVE on the ribbon " +
            "tables within 5s — a concurrent writer (a frequency rebuild via storeFrequencies, the " +
            "worker, or another seed/unseed run) is holding a conflicting lock on at least one of " +
            "them. Nothing checked or deleted. Try again once it finishes.",
        );
        process.exit(1);
      }
      throw lockErr;
    }

    // Content re-verification, inside that lock, before any DELETE (CC1
    // P2-1): even a matching database identity doesn't rule out an
    // in-place restore that never dropped the database.
    const heldLocs = await client.query(
      `SELECT ff.loc_code
         FROM frequency_fetch ff
         JOIN regions r ON r.code = ff.loc_code
        WHERE r.parent_code = ANY($1) OR r.code = ANY($1)`,
      [countries],
    );
    const heldSet = heldLocs.rows.map((r) => r.loc_code).sort();
    if (!sameSet(heldSet, [...locCodes].sort())) {
      throw new Error(
        `refusing: frequency_fetch for the marker's countries (${countries.join(", ")}) no longer ` +
          `holds exactly the marker's ${locCodes.length} loc_code(s) (found ${heldSet.length}) — ` +
          `something else changed this data since seeding. Nothing deleted.`,
      );
    }
    const foreignBandLocs = await client.query(
      "SELECT DISTINCT loc_code FROM band_locs WHERE country = ANY($1) AND NOT (loc_code = ANY($2))",
      [countries, locCodes],
    );
    if (foreignBandLocs.rows.length > 0) {
      throw new Error(
        `refusing: band_locs has OTHER contributors for the marker's countries beyond what it ` +
          `recorded creating — deleting the aggregate band tables would destroy real coverage. ` +
          `Nothing deleted.`,
      );
    }

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
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[unseed-ribbon-fixture] failed:", err.message ?? err);
  process.exitCode = 1;
});

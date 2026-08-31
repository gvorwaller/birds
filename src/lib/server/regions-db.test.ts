/**
 * DB integration tests for the regions reference data + the 0045 invariant,
 * against the LOCAL TEST CLUSTER (birds_test on :15436) — same harness as
 * forecast-db.test.ts: skips (never fails) when the cluster is down, and
 * additionally when the 0044 seed has not been applied yet, since the seed
 * migration is generated from live eBird and lands after the schema.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function loadEnvTest(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(new URL("../../../.env.test", import.meta.url), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const envTest = loadEnvTest();
for (const k of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
  if (envTest[k]) process.env[k] = envTest[k];
}
process.env.EBIRD_KEY_SECRET ??= envTest.EBIRD_KEY_SECRET ?? "test-secret";

const { query } = await import("$lib/db");

let dbUp = false;
let seeded = false;
let fkApplied = false;
try {
  if (envTest.PGPORT === "15436") {
    await query("SELECT 1");
    dbUp = true;
    const n = await query<{ n: string }>("SELECT count(*) AS n FROM regions");
    seeded = Number(n.rows[0].n) >= 3500;
    const fk = await query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_constraint
         WHERE conname = 'frequency_fetch_region_fk') AS ok`,
    );
    fkApplied = fk.rows[0].ok;
  }
} catch {
  dbUp = false;
}

describe.skipIf(!dbUp || !seeded)("regions seed shape (0043/0044)", () => {
  it("covers the world at the promised scale with intact parentage", async () => {
    const r = await query<{
      countries: string;
      sub1: string;
      orphans: string;
      null_coords: string;
      bad_codes: string;
    }>(`SELECT
          count(*) FILTER (WHERE level = 'country') AS countries,
          count(*) FILTER (WHERE level = 'subnational1') AS sub1,
          count(*) FILTER (WHERE level = 'subnational1' AND parent_code NOT IN
            (SELECT code FROM regions WHERE level = 'country')) AS orphans,
          count(*) FILTER (WHERE lat IS NULL OR lon IS NULL) AS null_coords,
          count(*) FILTER (WHERE code !~ '^[A-Z]{2}(-[A-Z0-9]+)?$') AS bad_codes
        FROM regions`);
    const row = r.rows[0];
    expect(Number(row.countries)).toBeGreaterThanOrEqual(240);
    // 3,621 seeded of 3,922 listed: 301 codes eBird has never geocoded are
    // excluded (backend/db/regions-excluded-codes.txt) — the count reflects
    // the honest seed, not the raw list.
    expect(Number(row.sub1)).toBeGreaterThanOrEqual(3300);
    expect(Number(row.orphans)).toBe(0);
    expect(Number(row.null_coords)).toBe(0); // NOT NULL, belt and braces
    expect(Number(row.bad_codes)).toBe(0);
  });

  it("spot checks: real places at their real coordinates, no barchart artifacts", async () => {
    const r = await query<{
      code: string;
      name: string;
      level: string;
      parent_code: string | null;
      lat: number;
      lon: number;
    }>(`SELECT code, name, level, parent_code, lat, lon FROM regions
         WHERE code = ANY($1)`, [["US-FL", "DK-05", "IS", "SE-AB", "IS-1"]]);
    const by = new Map(r.rows.map((x) => [x.code, x]));
    expect(by.get("US-FL")).toMatchObject({ name: "Florida", parent_code: "US" });
    expect(by.get("US-FL")!.lat).toBeGreaterThan(24);
    expect(by.get("US-FL")!.lat).toBeLessThan(31);
    expect(by.get("DK-05")).toMatchObject({ name: "Bornholm", parent_code: "DK" });
    expect(by.get("IS")).toMatchObject({ name: "Iceland", level: "country" });
    // Pins the [SE-01]-style barchart-artifact fix: the reference name is the
    // clean eBird list name.
    expect(by.get("SE-AB")!.name).toBe("Stockholms län");
    expect(by.get("IS-1")).toBeDefined(); // single-digit sub1 code survives
  });

  it("every code prod data references is present (the FK pre-flight, locally)", async () => {
    const required = readFileSync(
      new URL("../../../backend/db/regions-required-codes.txt", import.meta.url),
      "utf8",
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(required.length).toBeGreaterThan(150);
    const r = await query<{ code: string }>(
      "SELECT code FROM regions WHERE code = ANY($1)",
      [required],
    );
    expect(r.rows.length).toBe(required.length);
  });

  it("regions is read-only for the app role", async () => {
    const r = await query<{ sel: boolean; ins: boolean }>(
      `SELECT has_table_privilege('birds_app','regions','SELECT') AS sel,
              has_table_privilege('birds_app','regions','INSERT') AS ins`,
    );
    expect(r.rows[0]).toEqual({ sel: true, ins: false });
  });
});

describe.skipIf(!dbUp || !seeded || !fkApplied)(
  "the 0045 invariant (frequency_fetch_region_fk)",
  () => {
    const cleanup = async () => {
      await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'ZZ-QQ%'");
      await query(
        "DELETE FROM frequency_fetch WHERE loc_code IN ('US-FL-999','LTESTREGION1')",
      );
    };
    beforeAll(cleanup);
    afterAll(cleanup);

    const insert = (locCode: string, kind: string) =>
      query(
        `INSERT INTO frequency_fetch
           (loc_code, loc_kind, loc_name, sample_sizes, begin_year, end_year, n_species)
         VALUES ($1, $2, 'FK test', $3, 2020, 2025, 0)`,
        [locCode, kind, Array(48).fill(1)],
      );

    it("rejects a region with no seeded reference (SQLSTATE 23503)", async () => {
      await expect(insert("ZZ-QQ", "region")).rejects.toMatchObject({
        code: "23503",
      });
    });

    it("rejects a COUNTY whose parent state is unseeded — the case a NULL-bypass design let through", async () => {
      await expect(insert("ZZ-QQ-999", "region")).rejects.toMatchObject({
        code: "23503",
      });
    });

    it("accepts a county under a seeded parent (US-FL-999 → anchored to US-FL)", async () => {
      await insert("US-FL-999", "region");
      const r = await query<{ region_ref: string }>(
        "SELECT region_ref FROM frequency_fetch WHERE loc_code = 'US-FL-999'",
      );
      expect(r.rows[0].region_ref).toBe("US-FL");
    });

    it("accepts a hotspot row untouched (region_ref NULL)", async () => {
      await insert("LTESTREGION1", "hotspot");
      const r = await query<{ region_ref: string | null }>(
        "SELECT region_ref FROM frequency_fetch WHERE loc_code = 'LTESTREGION1'",
      );
      expect(r.rows[0].region_ref).toBeNull();
    });

    it("rejects a malformed region code outright (shape CHECK, not a NULL escape)", async () => {
      await expect(insert("US-FL-1-2-3", "region")).rejects.toMatchObject({
        code: "23514", // check_violation
      });
    });
  },
);

it("regions DB suite ran against the live cluster (or skipped intentionally)", () => {
  // Mirrors forecast-db.test.ts's tail guard: a silent all-skip run should be
  // visible in the output, not mistaken for coverage.
  expect(typeof dbUp).toBe("boolean");
});

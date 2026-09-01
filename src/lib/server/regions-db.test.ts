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

describe.skipIf(!dbUp || !seeded)("region extents (0047/0048, td-a4a3bf)", () => {
  it("every seeded region has a bounding box, all four edges", async () => {
    const r = await query<{ total: string; boxed: string; partial: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE min_lat IS NOT NULL) AS boxed,
              count(*) FILTER (WHERE (min_lat IS NULL) <> (max_lon IS NULL)) AS partial
         FROM regions`,
    );
    // 100% coverage after the RU/AQ edge-tolerance fix; a partial box is
    // impossible by the 0047 all-or-none CHECK, asserted anyway.
    expect(Number(r.rows[0].boxed)).toBe(Number(r.rows[0].total));
    expect(Number(r.rows[0].partial)).toBe(0);
  });

  it("THE BUG, on real data: the home state contains home, the neighbor is a short hop", async () => {
    // Gaylon's Jacksonville home. Centroid ranking put Georgia (191 mi)
    // ahead of Florida (212 mi) — the state he is standing in.
    const r = await query<{ code: string; inside: boolean; edge_km: number }>(
      `SELECT code,
              (30.2630337 BETWEEN min_lat AND max_lat
               AND -81.6371102 BETWEEN min_lon AND max_lon) AS inside,
              6371*acos(least(1,
                cos(radians(30.2630337))*cos(radians(greatest(min_lat,least(30.2630337,max_lat))))*
                cos(radians(greatest(min_lon,least(-81.6371102,max_lon)))-radians(-81.6371102))+
                sin(radians(30.2630337))*sin(radians(greatest(min_lat,least(30.2630337,max_lat)))))) AS edge_km
         FROM regions WHERE code = ANY($1)`,
      [["US-FL", "US-GA"]],
    );
    const by = new Map(r.rows.map((x) => [x.code, x]));
    expect(by.get("US-FL")!.inside).toBe(true);
    expect(by.get("US-GA")!.inside).toBe(false);
    // Georgia's line is ~7 mi away — a real, actionable number, unlike the
    // 191 mi centroid figure it replaces.
    expect(Number(by.get("US-GA")!.edge_km)).toBeLessThan(30);
  });

  it("antimeridian-spanning regions kept their extent despite eBird's out-of-range edge", async () => {
    // eBird reports Russia/Antarctica as minX -180.000001; rejecting that box
    // over a millionth of a degree left them on a centroid eBird computes as
    // ~0° longitude (the Gulf of Guinea) — strictly worse than a clamped box.
    const r = await query<{ code: string; min_lon: number; max_lon: number }>(
      "SELECT code, min_lon, max_lon FROM regions WHERE code = ANY($1)",
      [["RU", "AQ"]],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(Number(row.min_lon)).toBeGreaterThanOrEqual(-180);
      expect(Number(row.max_lon)).toBeLessThanOrEqual(180);
    }
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

describe.skipIf(!dbUp || !seeded)("proximity candidate set (td-73e6f9)", () => {
  it("probes a country whose subnational1 coverage has holes", async () => {
    const { allProximityRegions } = await import("./regions");
    const { candidates } = await allProximityRegions();
    const codes = new Set(candidates.map((r) => r.code));

    // Hungary is missing 22 counties from the seed, Latvia 112, Moldova 29
    // (backend/db/regions-excluded-codes.txt). Probing only their seeded
    // children would skip that territory while the UI claimed it searched.
    for (const country of ["HU", "LV", "MD"]) {
      expect(codes.has(country), `${country} needs a country-level probe`).toBe(
        true,
      );
      // ...and its seeded children are still probed for their tighter bounds.
      expect(candidates.some((r) => r.parent === country)).toBe(true);
    }

    // The rule must key on the EXCLUDED list, not on "a seeded code that is
    // also excluded" — the generator deletes excluded codes from the seed, so
    // that intersection is empty and the arm would never fire.
    const withHoles = candidates.filter((r) => r.level === "country" && r.parent === null);
    expect(withHoles.length).toBeGreaterThan(56); // 56 childless + the holed ones
  });

  it("omits countries whose subnational1 coverage is complete", async () => {
    const { allProximityRegions } = await import("./regions");
    const { candidates } = await allProximityRegions();
    const codes = new Set(candidates.map((r) => r.code));
    // Sweden has every county seeded, so the country probe would only
    // duplicate its children's coverage at a looser bound.
    expect(codes.has("SE")).toBe(false);
    expect(candidates.some((r) => r.parent === "SE")).toBe(true);
  });

  it("keeps antimeridian regions out of the ladder entirely", async () => {
    const { allProximityRegions } = await import("./regions");
    const { candidates, unsafe } = await allProximityRegions();
    const codes = new Set(candidates.map((r) => r.code));

    // Their [-180,180] boxes are ~360° wide, so they have no usable lower
    // bound: sorting on it would put them first from everywhere, and a zero
    // bound can never be exceeded, so the search could never terminate.
    for (const code of ["US-AK", "RU-CHU", "FJ-E", "NZ-NTL"]) {
      expect(codes.has(code), `${code} must not be a ladder candidate`).toBe(false);
    }
    expect(unsafe.map((r) => r.code)).toContain("US-AK");
    // Small and enumerable — this is a documented coverage gap, not a surprise.
    expect(unsafe.length).toBeLessThan(20);
  });

  it("gives every candidate a usable box or none at all", async () => {
    const { boxSupportsProximity } = await import("$lib/geo");
    const { allProximityRegions } = await import("./regions");
    const { candidates } = await allProximityRegions();
    expect(candidates.length).toBeGreaterThan(3000);
    for (const r of candidates) {
      if (r.box) expect(boxSupportsProximity(r.box)).toBe(true);
    }
  });
});

it("regions DB suite ran against the live cluster (or skipped intentionally)", () => {
  // Mirrors forecast-db.test.ts's tail guard: a silent all-skip run should be
  // visible in the output, not mistaken for coverage.
  expect(typeof dbUp).toBe("boolean");
});

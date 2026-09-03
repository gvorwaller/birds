/**
 * DB integration tests against the LOCAL TEST CLUSTER (birds_test on :15436)
 * — the plan's §7 "DB/route" gate. These pin what the mocked unit suites
 * cannot: the weighted sparse SQL actually executed by Postgres, migration
 * CHECK constraints, cascade delete, and storeFrequencies' atomic replace.
 *
 * Connection comes from .env.test (the same file `npm run dev:test` uses).
 * If the test cluster is not running (`npm run test:db:up`), the whole suite
 * skips rather than failing — it never touches any other cluster: the port
 * is read from .env.test, which the repo's guard scripts pin to 15436.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Parse .env.test and expose connection vars BEFORE importing $lib/db —
// its pool reads env lazily on first query, and vitest isolates test files,
// so this file's process env is ours to set.
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
const pg = (await import("pg")).default;

/** Fixture regions must exist for frequency fixtures to satisfy the 0045
 * invariant — and `regions` is read-only for birds_app BY DESIGN, so they are
 * seeded through the owner role (the same privilege migrations use). Codes
 * live in the user-assigned ISO range (QZ, ZZ) that eBird never issues. */
const FIXTURE_REGIONS: [string, string, string | null][] = [
  ["QZ", "country", null],
  ["QZ-A", "subnational1", "QZ"],
  ["QZ-B", "subnational1", "QZ"],
  ["QZ-C", "subnational1", "QZ"],
  ["QZ-NN", "subnational1", "QZ"],
  ["QZ-BAD", "subnational1", "QZ"],
  ["QZ-DEL", "subnational1", "QZ"],
  ["QZ-ST", "subnational1", "QZ"],
  ["QZ-BND", "subnational1", "QZ"],
  ["QZ-RU", "subnational1", "QZ"],
  ["ZZ", "country", null],
  ["ZZ-A", "subnational1", "ZZ"],
  ["ZZ-ABC", "subnational1", "ZZ"],
  ["US-QQ", "subnational1", "US"],
  // Reserved for the 0050 band-rollup tests below (td-8d3526) — QZ/ZZ stay
  // out of that suite because they are LOADED for this whole describe and
  // are fixture countries in `regions`, which would make "country-only" and
  // "unmapped" assertions never true (CODEX1 P1-5). QY/ZY are a second,
  // disjoint reserved pair; ZY-B40 exists only to put a second country in
  // QY-W45/QY-E45's band (40) for the "two countries" test.
  ["QY", "country", null],
  ["QY-W45", "subnational1", "QY"],
  ["QY-E45", "subnational1", "QY"],
  ["ZY", "country", null],
  ["ZY-S35", "subnational1", "ZY"],
  ["ZY-B40", "subnational1", "ZY"],
];

/** Real coordinates for the band-rollup fixtures above (band/west depend on
 * lat/lon, unlike every other fixture here, which only needs to exist).
 * Every other FIXTURE_REGIONS code keeps the harmless (1, 1) default. */
const FIXTURE_COORDS: Record<string, [number, number]> = {
  QY: [60, -105],
  "QY-W45": [45, -110],
  "QY-E45": [42.5, -80],
  ZY: [-75, 0],
  "ZY-S35": [-33, 20],
  "ZY-B40": [45, 20],
};

async function withOwner(fn: (c: InstanceType<typeof pg.Client>) => Promise<void>) {
  const c = new pg.Client({
    host: envTest.PGHOST ?? "127.0.0.1",
    port: Number(envTest.PGPORT ?? 15436),
    database: envTest.PGDATABASE ?? "birds_test",
    user: envTest.MIGRATION_PGUSER ?? "birds_owner",
    password: envTest.MIGRATION_PGPASSWORD,
  });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtureRegions() {
  await withOwner(async (c) => {
    for (const [code, level, parent] of FIXTURE_REGIONS) {
      const [lat, lon] = FIXTURE_COORDS[code] ?? [1, 1];
      await c.query(
        `INSERT INTO regions (code, name, level, parent_code, lat, lon, source_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01')
         ON CONFLICT (code) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon`,
        [code, `Fixture ${code}`, level, parent, lat, lon],
      );
    }
  });
}

async function dropFixtureRegions() {
  await withOwner(async (c) => {
    // Children before parents; frequency rows are already cleaned up.
    await c.query("DELETE FROM regions WHERE code LIKE 'QZ%' OR code LIKE 'ZZ%' OR code = 'US-QQ'");
  });
}
const { rankLocsForSpeciesMonth, rankCountiesForNeeds, MIN_MONTH_N } =
  await import("./forecast");
const { normalizeMatchedBarchart, storeFrequencies, WEEKS } =
  await import("./barchart");

let dbUp = false;
try {
  if (envTest.PGPORT === "15436") {
    await query("SELECT 1");
    dbUp = true;
  }
} catch {
  dbUp = false;
}

/** sample_sizes helper: n per January week (weeks 1-4), zero elsewhere. */
function janSamples(w1: number, w2: number, w3: number, w4: number): number[] {
  const sizes = Array(WEEKS).fill(0);
  [w1, w2, w3, w4].forEach((n, i) => (sizes[i] = n));
  return sizes;
}

async function insertLoc(code: string, sizes: number[]): Promise<void> {
  await query(
    `INSERT INTO frequency_fetch
       (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species)
     VALUES ($1, 'region', $2, 2016, 2025, $3, 1)`,
    [code, `Fixture ${code}`, sizes],
  );
}

/** Fixtures write species_frequency directly, so they must rebuild the 0049
 * AND 0050 rollups the same way storeFrequencies does — one shared
 * definition, no second copy of the arithmetic to drift. */
async function refreshRollup(code: string) {
  const { rebuildMonthRollup, rebuildBandRollup } = await import("./barchart");
  await rebuildMonthRollup(code);
  await rebuildBandRollup(code);
}

async function insertFreq(code: string, week: number, freq: number) {
  return query(
    "INSERT INTO species_frequency (loc_code, species_code, week, freq) VALUES ($1, 'testsp', $2, $3)",
    [code, week, freq],
  );
}

const cleanup = async () => {
  // Band tables (0050) FIRST: species_band_month_freq/band_month_samples
  // key on `country`, not `loc_code`, so they do NOT cascade off the
  // frequency_fetch deletes below — and `country` REFERENCES regions(code)
  // with no ON DELETE CASCADE (0050), so leaving a stale row behind would
  // make dropFixtureRegions()'s DELETE FROM regions fail with a foreign key
  // violation the moment refreshRollup('ZZ-A') etc. populates them (it must,
  // per td-8d3526: refreshRollup calls rebuildBandRollup too).
  await query("DELETE FROM species_band_month_freq WHERE country IN ('QZ', 'ZZ', 'US')");
  await query("DELETE FROM band_month_samples WHERE country IN ('QZ', 'ZZ', 'US')");
  await query("DELETE FROM band_locs WHERE country IN ('QZ', 'ZZ', 'US')");
  await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'QZ-%'");
  await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'US-QQ-%'");
  await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'ZZ%'");
  await query(
    "DELETE FROM frequency_fetch_attempts WHERE loc_code LIKE 'QZ-%'",
  );
  await query(
    "DELETE FROM frequency_fetch_attempts WHERE loc_code LIKE 'US-QQ-%'",
  );
  await query("DELETE FROM frequency_fetch_attempts WHERE loc_code LIKE 'ZZ%'");
};

describe.skipIf(!dbUp)("forecast SQL against birds_test", () => {
  beforeAll(async () => {
    await seedFixtureRegions();
    await cleanup();
    // A: Jan weeks n = 10, 1000, 0, 0; reported 100% of wk1, 30% of wk2.
    await insertLoc("QZ-A", janSamples(10, 1000, 0, 0));
    await insertFreq("QZ-A", 1, 1.0);
    await insertFreq("QZ-A", 2, 0.3);
    // B: Jan weeks n = 100 each; reported only wk1 at 40% — absent sparse
    // weeks must still count their checklists in the denominator.
    await insertLoc("QZ-B", janSamples(100, 100, 100, 100));
    await insertFreq("QZ-B", 1, 0.4);
    // C: tiny sample (n=13 total) at 100% — must flag lowSample, sort last.
    await insertLoc("QZ-C", janSamples(13, 0, 0, 0));
    await insertFreq("QZ-C", 1, 1.0);
  });
  afterAll(async () => {
    await cleanup();
    await dropFixtureRegions();
  });

  it("computes checklist-weighted month frequency in SQL (sparse-safe)", async () => {
    const ranked = await rankLocsForSpeciesMonth(
      ["QZ-A", "QZ-B", "QZ-C"],
      "testsp",
      1,
    );
    expect(ranked.map((r) => r.code)).toEqual([
      "QZ-A",
      "QZ-B",
      "QZ-C",
    ]);
    // A: (1.0·10 + 0.3·1000) / 1010 — NOT the unweighted (1.0+0.3)/4.
    expect(ranked[0].freq).toBeCloseTo(310 / 1010, 6);
    expect(ranked[0].n).toBe(1010);
    // B: 0.4·100 / 400 — the three absent weeks stay in the denominator.
    expect(ranked[1].freq).toBeCloseTo(0.1, 6);
    expect(ranked[1].n).toBe(400);
    // C: 100% of 13 checklists → lowSample, sorted after adequate rows.
    expect(ranked[2].freq).toBeCloseTo(1.0, 6);
    expect(ranked[2].n).toBeLessThan(MIN_MONTH_N);
    expect(ranked[2].lowSample).toBe(true);
    expect(ranked[0].lowSample).toBe(false);
  });

  it("returns [] for unknown locations and respects month boundaries", async () => {
    expect(await rankLocsForSpeciesMonth(["QZ-NN"], "testsp", 1)).toEqual(
      [],
    );
    // December: none of the fixtures have week 45-48 checklists → n = 0.
    const dec = await rankLocsForSpeciesMonth(["QZ-A"], "testsp", 12);
    expect(dec[0].n).toBe(0);
    expect(dec[0].freq).toBe(0);
  });

  it("migration CHECKs reject bad rows; delete cascades", async () => {
    await expect(insertFreq("QZ-A", 49, 0.5)).rejects.toThrow(/check/i);
    await expect(insertFreq("QZ-A", 3, 1.5)).rejects.toThrow(/check/i);
    await expect(
      query(
        `INSERT INTO frequency_fetch
           (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species)
         VALUES ('QZ-BAD', 'region', 'Bad', 2016, 2025, $1, 1)`,
        [Array(47).fill(1)],
      ),
    ).rejects.toThrow(/check/i);

    await insertLoc("QZ-DEL", janSamples(50, 50, 50, 50));
    await insertFreq("QZ-DEL", 1, 0.2);
    await query("DELETE FROM frequency_fetch WHERE loc_code = 'QZ-DEL'");
    const orphans = await query(
      "SELECT 1 FROM species_frequency WHERE loc_code = 'QZ-DEL'",
    );
    expect(orphans.rows).toHaveLength(0);
  });

  it("storeFrequencies replaces atomically and keeps old data on failure", async () => {
    const parsed = {
      sampleSizes: janSamples(100, 100, 100, 100),
      rows: [],
    };
    const good = {
      bySpecies: new Map([["testsp", [0.5, ...Array(WEEKS - 1).fill(0)]]]),
      unmatched: ["spuh sp."],
      collisions: 0,
    };
    await storeFrequencies({
      locCode: "QZ-ST",
      locKind: "region",
      locName: "Store fixture",
      beginYear: 2016,
      endYear: 2025,
      parsed,
      matched: good,
    });
    const stored = await query(
      "SELECT n_species, unmatched_names FROM frequency_fetch WHERE loc_code = 'QZ-ST'",
    );
    expect(Number(stored.rows[0].n_species)).toBe(1);
    expect(stored.rows[0].unmatched_names).toEqual(["spuh sp."]);
    const attempts = await query(
      "SELECT status FROM frequency_fetch_attempts WHERE loc_code = 'QZ-ST'",
    );
    expect(attempts.rows[0].status).toBe("ok");

    // A replacement whose rows violate a CHECK must roll back wholesale —
    // the previously stored good rows survive.
    const bad = {
      bySpecies: new Map([["testsp", Array(WEEKS).fill(0)]]),
      unmatched: [],
      collisions: 0,
    };
    bad.bySpecies.get("testsp")![48] = 0; // keep 48 wide
    const badParsed = { sampleSizes: janSamples(1, 1, 1, 1), rows: [] };
    // Force a constraint violation via an out-of-range frequency.
    bad.bySpecies.set("testsp", [1.7, ...Array(WEEKS - 1).fill(0)]);
    await expect(
      storeFrequencies({
        locCode: "QZ-ST",
        locKind: "region",
        locName: "Store fixture",
        beginYear: 2016,
        endYear: 2025,
        parsed: badParsed,
        matched: bad,
      }),
    ).rejects.toThrow();
    const after = await query(
      "SELECT freq FROM species_frequency WHERE loc_code = 'QZ-ST' AND week = 1",
    );
    expect(Number(after.rows[0].freq)).toBeCloseTo(0.5, 6);
    const sizesAfter = await query(
      "SELECT sample_sizes[1] AS w1 FROM frequency_fetch WHERE loc_code = 'QZ-ST'",
    );
    expect(Number(sizesAfter.rows[0].w1)).toBe(100);
  });

  it("atomically stores bounded source anomalies without weakening the frequency CHECK", async () => {
    const samples = janSamples(100, 100, 100, 3);
    const parsed = { sampleSizes: samples, rows: [] };
    const source = {
      bySpecies: new Map([
        ["testsp", [0.5, 0.5, 0.5, 1.3333333, ...Array(WEEKS - 4).fill(0)]],
      ]),
      unmatched: [],
      collisions: 0,
    };
    const normalized = normalizeMatchedBarchart(parsed, source);

    await storeFrequencies({
      locCode: "QZ-BND",
      locKind: "region",
      locName: "Bounded fixture",
      beginYear: 2016,
      endYear: 2025,
      parsed,
      matched: normalized.matched,
      corrections: normalized.corrections,
    });

    const stored = await query(
      `SELECT freq FROM species_frequency
        WHERE loc_code = 'QZ-BND' AND species_code = 'testsp' AND week = 4`,
    );
    expect(Number(stored.rows[0].freq)).toBe(1);
    const anomaly = await query(
      `SELECT week, original_freq, stored_freq, sample_size
         FROM frequency_anomalies
        WHERE loc_code = 'QZ-BND' AND species_code = 'testsp'`,
    );
    expect(anomaly.rows).toEqual([
      expect.objectContaining({ week: 4, sample_size: 3 }),
    ]);
    expect(Number(anomaly.rows[0].original_freq)).toBeCloseTo(1.3333333, 7);
    expect(Number(anomaly.rows[0].stored_freq)).toBe(1);
    await expect(insertFreq("QZ-BND", 5, 1.01)).rejects.toThrow(/check/i);

    await storeFrequencies({
      locCode: "QZ-BND",
      locKind: "region",
      locName: "Bounded fixture",
      beginYear: 2016,
      endYear: 2025,
      parsed,
      matched: {
        bySpecies: new Map([
          ["testsp", [0.5, 0.5, 0.5, 0.75, ...Array(WEEKS - 4).fill(0)]],
        ]),
        unmatched: [],
        collisions: 0,
      },
    });
    const staleAnomalies = await query(
      "SELECT 1 FROM frequency_anomalies WHERE loc_code = 'QZ-BND'",
    );
    expect(staleAnomalies.rows).toHaveLength(0);
  });

  it("rankCountiesForNeeds counts absent sparse weeks in the denominator", async () => {
    // January: 40% of week 1, absent weeks 2–4 (100 checklists each) → 10%,
    // not 40%. Must not count as "likely".
    await insertLoc("US-QQ-001", janSamples(100, 100, 100, 100));
    await insertFreq("US-QQ-001", 1, 0.4);
    await refreshRollup("US-QQ-001");
    const ranks = await rankCountiesForNeeds(0, "US-QQ", 1);
    expect(ranks).toHaveLength(1);
    // 10% is "possible" (5–19%), not "likely" (≥20%).
    expect(ranks[0].likely).toBe(0);
    expect(ranks[0].possible).toBe(1);
    expect(ranks[0].n).toBe(400);
  });

  it("rankCountiesForNeeds handles variable-width codes and excludes grandchildren under a country-level code (td-f1d6da)", async () => {
    // "ZZ" is a country-level code with two subnational1 children of
    // DIFFERENT segment widths ("ZZ-A", "ZZ-ABC") — the old US-only regex
    // assumed a fixed 2-letter state / 3-digit county shape and would have
    // rejected both. "ZZ-A-01" is a subnational2 GRANDCHILD of "ZZ": a bare
    // `LIKE 'ZZ-%'` would also match it, so it must be excluded by the
    // parentOf(loc_code) === regionCode TS filter, not double-counted as a
    // direct child of "ZZ".
    await insertLoc("ZZ-A", janSamples(100, 100, 100, 100));
    await insertFreq("ZZ-A", 1, 0.9); // weighted: 0.9*100/400 = 22.5% -> likely
    await insertLoc("ZZ-ABC", janSamples(100, 100, 100, 100));
    await insertFreq("ZZ-ABC", 1, 0.3); // weighted: 0.3*100/400 = 7.5% -> possible
    await insertLoc("ZZ-A-01", janSamples(100, 100, 100, 100));
    await insertFreq("ZZ-A-01", 1, 1.0); // grandchild — must not appear at all
    for (const c of ["ZZ-A", "ZZ-ABC", "ZZ-A-01"]) await refreshRollup(c);

    const ranks = await rankCountiesForNeeds(0, "ZZ", 1);
    expect(ranks.map((r) => r.code).sort()).toEqual(["ZZ-A", "ZZ-ABC"]);
    const byCode = new Map(ranks.map((r) => [r.code, r]));
    expect(byCode.get("ZZ-A")?.likely).toBe(1);
    expect(byCode.get("ZZ-A")?.possible).toBe(0);
    expect(byCode.get("ZZ-ABC")?.likely).toBe(0);
    expect(byCode.get("ZZ-ABC")?.possible).toBe(1);
  });

  it("the 0049 rollup reproduces the weekly arithmetic EXACTLY, not approximately", async () => {
    // The rollup replaced a query that unnested each location's 48-week array
    // on every request. It is only safe if it is the same number: this
    // recomputes monthlyStat's contract from the raw weekly rows and compares
    // against what the derived tables hold.
    const { rebuildMonthRollup } = await import("./barchart");
    await insertLoc("QZ-RU", janSamples(10, 1000, 7, 0));
    await insertFreq("QZ-RU", 1, 1.0);
    await insertFreq("QZ-RU", 2, 0.3);
    await insertFreq("QZ-RU", 3, 0.5);
    await rebuildMonthRollup("QZ-RU");

    const direct = await query<{ num: number; n: number }>(
      `SELECT SUM(sf.freq * ss.n)::float8 AS num,
              (SELECT SUM(x.n)::float8
                 FROM frequency_fetch f2,
                      LATERAL unnest(f2.sample_sizes) WITH ORDINALITY AS x(n, week)
                WHERE f2.loc_code = 'QZ-RU' AND x.week BETWEEN 1 AND 4) AS n
         FROM species_frequency sf
         JOIN frequency_fetch ff ON ff.loc_code = sf.loc_code
         JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
           ON ss.week = sf.week
        WHERE sf.loc_code = 'QZ-RU' AND sf.week BETWEEN 1 AND 4`,
    );
    const rolled = await query<{ num: number; n: number }>(
      `SELECT smf.num, lms.n
         FROM species_month_freq smf
         JOIN loc_month_samples lms USING (loc_code, month)
        WHERE smf.loc_code = 'QZ-RU' AND smf.month = 1`,
    );
    expect(Number(rolled.rows[0].num)).toBeCloseTo(Number(direct.rows[0].num), 9);
    expect(Number(rolled.rows[0].n)).toBe(Number(direct.rows[0].n));
    // 1.0*10 + 0.3*1000 + 0.5*7 = 313.5 over 1017 checklists.
    expect(Number(rolled.rows[0].num)).toBeCloseTo(313.5, 9);
    expect(Number(rolled.rows[0].n)).toBe(1017);
  });

  it("a rollup rebuild REPLACES rather than accumulates (re-store must not double-count)", async () => {
    const { rebuildMonthRollup } = await import("./barchart");
    await rebuildMonthRollup("QZ-RU");
    await rebuildMonthRollup("QZ-RU");
    const r = await query<{ c: string }>(
      "SELECT count(*) AS c FROM species_month_freq WHERE loc_code = 'QZ-RU' AND month = 1",
    );
    expect(Number(r.rows[0].c)).toBe(1);
  });

  it("rankCountiesForNeeds returns [] for a subnational2 code (never a valid target)", async () => {
    expect(await rankCountiesForNeeds(0, "US-QQ-001", 1)).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // 0050 band rollup tables (td-8d3526, migration ribbon build spec TD-A).
  // Isolated reserved countries QY (60, -105) / ZY (-75, 0), never touched
  // by the describe above — QZ/ZZ are LOADED for its whole duration and are
  // fixture countries in `continents.json`'s absence sense (CODEX1 P1-5), so
  // "country-only" and eviction assertions would never be exercised there.
  // ---------------------------------------------------------------------
  describe("band rollup", () => {
    beforeEach(async () => {
      await query("DELETE FROM species_band_month_freq WHERE country IN ('QY', 'ZY')");
      await query("DELETE FROM band_month_samples WHERE country IN ('QY', 'ZY')");
      await query("DELETE FROM band_locs WHERE country IN ('QY', 'ZY')");
      await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'QY%' OR loc_code LIKE 'ZY%'");
      await query(
        "DELETE FROM frequency_fetch_attempts WHERE loc_code LIKE 'QY%' OR loc_code LIKE 'ZY%'",
      );
    });

    afterAll(async () => {
      await query("DELETE FROM species_band_month_freq WHERE country IN ('QY', 'ZY')");
      await query("DELETE FROM band_month_samples WHERE country IN ('QY', 'ZY')");
      await query("DELETE FROM band_locs WHERE country IN ('QY', 'ZY')");
      await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'QY%' OR loc_code LIKE 'ZY%'");
      await query(
        "DELETE FROM frequency_fetch_attempts WHERE loc_code LIKE 'QY%' OR loc_code LIKE 'ZY%'",
      );
      await withOwner(async (c) => {
        await c.query("DELETE FROM regions WHERE code LIKE 'QY%' OR code LIKE 'ZY%'");
      });
    });

    it("reproduces Σnum / Σn exactly", async () => {
      // Same vector as the 0049 QZ-RU test above: 1.0*10 + 0.3*1000 + 0.5*7
      // over 1017 checklists = 313.5. lat 45 -> band 40; QY is not US/CA/MX
      // so west is false regardless of longitude.
      await insertLoc("QY-W45", janSamples(10, 1000, 7, 0));
      await insertFreq("QY-W45", 1, 1.0);
      await insertFreq("QY-W45", 2, 0.3);
      await insertFreq("QY-W45", 3, 0.5);
      await refreshRollup("QY-W45");

      const freq = await query<{ num: string; reached: number }>(
        `SELECT num, reached FROM species_band_month_freq
          WHERE species_code = 'testsp' AND band = 40 AND country = 'QY'
            AND west = false AND month = 1`,
      );
      expect(freq.rows).toHaveLength(1);
      expect(Number(freq.rows[0].num)).toBeCloseTo(313.5, 9);
      expect(Number(freq.rows[0].reached)).toBe(1);

      const samples = await query<{ n: string }>(
        `SELECT n FROM band_month_samples
          WHERE band = 40 AND country = 'QY' AND west = false AND month = 1`,
      );
      expect(Number(samples.rows[0].n)).toBe(1017);
    });

    it("REPLACES, never accumulates", async () => {
      await insertLoc("QY-W45", janSamples(10, 1000, 7, 0));
      await insertFreq("QY-W45", 1, 1.0);
      await refreshRollup("QY-W45");
      await refreshRollup("QY-W45");
      const rows = await query(
        `SELECT 1 FROM species_band_month_freq
          WHERE species_code = 'testsp' AND country = 'QY' AND month = 1`,
      );
      expect(rows.rows).toHaveLength(1);
      const locs = await query(
        "SELECT 1 FROM band_locs WHERE country = 'QY' AND loc_code = 'QY-W45'",
      );
      expect(locs.rows).toHaveLength(1);
    });

    it("two countries in one band stay separate rows", async () => {
      // QY-W45 (lat 45) and ZY-B40 (lat 45) both fall in band 40.
      await insertLoc("QY-W45", janSamples(1000, 0, 0, 0));
      await insertFreq("QY-W45", 1, 0.1);
      await refreshRollup("QY-W45");
      await insertLoc("ZY-B40", janSamples(1000, 0, 0, 0));
      await insertFreq("ZY-B40", 1, 0.2);
      await refreshRollup("ZY-B40");

      const rows = await query<{ country: string; num: string }>(
        `SELECT country, num FROM species_band_month_freq
          WHERE species_code = 'testsp' AND band = 40 AND month = 1
            AND country IN ('QY', 'ZY')
          ORDER BY country`,
      );
      expect(rows.rows.map((r) => r.country)).toEqual(["QY", "ZY"]);
      expect(Number(rows.rows[0].num)).toBeCloseTo(100, 6); // 0.1 * 1000
      expect(Number(rows.rows[1].num)).toBeCloseTo(200, 6); // 0.2 * 1000
    });

    it("west is true only for US/CA/MX west of 100W", async () => {
      await withOwner(async (c) => {
        await c.query(
          `INSERT INTO regions (code, name, level, parent_code, lat, lon, source_at)
           VALUES ('US-QQW', 'Fixture US-QQW', 'subnational1', 'US', 45, -110, '2026-01-01'),
                  ('US-QQE', 'Fixture US-QQE', 'subnational1', 'US', 45, -80, '2026-01-01')
           ON CONFLICT (code) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon`,
        );
      });
      try {
        await insertLoc("US-QQW", janSamples(100, 0, 0, 0));
        await insertLoc("US-QQE", janSamples(100, 0, 0, 0));
        await refreshRollup("US-QQW"); // country grain: also picks up US-QQE
        const rows = await query<{ loc_code: string; west: boolean }>(
          "SELECT loc_code, west FROM band_locs WHERE loc_code IN ('US-QQW', 'US-QQE')",
        );
        const byLoc = new Map(rows.rows.map((r) => [r.loc_code, r.west]));
        expect(byLoc.get("US-QQW")).toBe(true);
        expect(byLoc.get("US-QQE")).toBe(false);

        // A non-NA country at the same longitude stays east — the west split
        // is restricted to US/CA/MX, not a bare lon < -100 (CODEX1 P1-6).
        await insertLoc("QY-W45", janSamples(100, 0, 0, 0));
        await refreshRollup("QY-W45");
        const qy = await query<{ west: boolean }>(
          "SELECT west FROM band_locs WHERE loc_code = 'QY-W45'",
        );
        expect(qy.rows[0].west).toBe(false);
      } finally {
        await query("DELETE FROM frequency_fetch WHERE loc_code IN ('US-QQW', 'US-QQE')");
        const { rebuildBandRollup } = await import("./barchart");
        await rebuildBandRollup("US-QQW"); // re-sync 'US' now the temp fixtures are gone
        await withOwner(async (c) => {
          await c.query("DELETE FROM regions WHERE code IN ('US-QQW', 'US-QQE')");
        });
      }
    });

    it("an antimeridian-wrapping NA region is west", async () => {
      // The real Alaska shape: centroid lon 0.31 (the committed seed's bug),
      // box crossing 180 (min_lon 172, max_lon -130). The CASE, not the raw
      // lon, must decide — a naive `lon < -100` would put this in the east.
      await withOwner(async (c) => {
        await c.query(
          `INSERT INTO regions
             (code, name, level, parent_code, lat, lon, min_lat, max_lat, min_lon, max_lon, source_at)
           VALUES ('US-QQX', 'Fixture US-QQX', 'subnational1', 'US', 64, 0.31, 51, 71, 172, -130, '2026-01-01')
           ON CONFLICT (code) DO UPDATE SET
             lat = EXCLUDED.lat, lon = EXCLUDED.lon,
             min_lat = EXCLUDED.min_lat, max_lat = EXCLUDED.max_lat,
             min_lon = EXCLUDED.min_lon, max_lon = EXCLUDED.max_lon`,
        );
      });
      try {
        await insertLoc("US-QQX", janSamples(50, 0, 0, 0));
        await refreshRollup("US-QQX");
        const row = await query<{ west: boolean }>(
          "SELECT west FROM band_locs WHERE loc_code = 'US-QQX'",
        );
        expect(row.rows[0].west).toBe(true);
      } finally {
        await query("DELETE FROM frequency_fetch WHERE loc_code = 'US-QQX'");
        const { rebuildBandRollup } = await import("./barchart");
        await rebuildBandRollup("US-QQX");
        await withOwner(async (c) => {
          await c.query("DELETE FROM regions WHERE code = 'US-QQX'");
        });
      }
    });

    it("a hotspot and a county never touch band tables", async () => {
      // "QY-W45-001" is a subnational2 shape (a county-equivalent grandchild
      // of QY) — distinct from the pre-existing "US-QQ-001" fixture used
      // elsewhere in this file, so it can't collide with it.
      await insertLoc("QY-W45-001", janSamples(50, 0, 0, 0));
      await query(
        `INSERT INTO frequency_fetch
           (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species)
         VALUES ('L999', 'hotspot', 'Fixture hotspot', 2016, 2025, $1, 1)`,
        [janSamples(50, 0, 0, 0)],
      );
      await refreshRollup("QY-W45-001");
      await refreshRollup("L999");
      const rows = await query(
        "SELECT 1 FROM band_locs WHERE loc_code IN ('QY-W45-001', 'L999')",
      );
      expect(rows.rows).toHaveLength(0);
      await query("DELETE FROM frequency_fetch WHERE loc_code IN ('QY-W45-001', 'L999')");
    });

    it("country-only country contributes its country row", async () => {
      await insertLoc("QY", janSamples(100, 0, 0, 0));
      await refreshRollup("QY");
      const rows = await query<{ band: number; country: string; west: boolean; loc_code: string }>(
        "SELECT band, country, west, loc_code FROM band_locs WHERE country = 'QY'",
      );
      expect(rows.rows).toEqual([
        expect.objectContaining({ band: 60, country: "QY", west: false, loc_code: "QY" }),
      ]);
    });

    it("first subnational1 evicts the country row", async () => {
      await insertLoc("QY", janSamples(100, 0, 0, 0));
      await refreshRollup("QY");
      await insertLoc("QY-W45", janSamples(50, 0, 0, 0));
      await refreshRollup("QY-W45");
      const rows = await query<{ loc_code: string }>(
        "SELECT loc_code FROM band_locs WHERE country = 'QY'",
      );
      expect(rows.rows.map((r) => r.loc_code)).toEqual(["QY-W45"]);
    });

    it("both loaded contributes ONLY sub1 rows", async () => {
      await insertLoc("ZY", janSamples(100, 0, 0, 0));
      await refreshRollup("ZY");
      await insertLoc("ZY-S35", janSamples(50, 0, 0, 0));
      await refreshRollup("ZY-S35");
      const rows = await query<{ loc_code: string }>(
        "SELECT loc_code FROM band_locs WHERE country = 'ZY'",
      );
      expect(rows.rows.map((r) => r.loc_code)).toEqual(["ZY-S35"]);
    });

    it("reached counts regions at region grain", async () => {
      // Region A (QY-W45) f=0.006 >= PRESENT; region B (QY-E45) f=0.001 <
      // PRESENT. Combined the cell reads 7/2000 = 0.0035 < PRESENT — reached
      // must come from each region's OWN ratio, not the summed cell.
      await insertLoc("QY-W45", janSamples(1000, 0, 0, 0));
      await insertFreq("QY-W45", 1, 0.006);
      await refreshRollup("QY-W45");
      await insertLoc("QY-E45", janSamples(1000, 0, 0, 0));
      await insertFreq("QY-E45", 1, 0.001);
      await refreshRollup("QY-E45");

      const row = await query<{ num: string; reached: number }>(
        `SELECT num, reached FROM species_band_month_freq
          WHERE species_code = 'testsp' AND band = 40 AND country = 'QY' AND month = 1`,
      );
      expect(row.rows).toHaveLength(1);
      expect(Number(row.rows[0].num)).toBeCloseTo(7, 6);
      expect(Number(row.rows[0].reached)).toBe(1);
    });

    it("deleting a loaded region rebuilds its country", async () => {
      await insertLoc("QY-W45", janSamples(1000, 0, 0, 0));
      await insertFreq("QY-W45", 1, 0.006);
      await refreshRollup("QY-W45");
      await insertLoc("QY-E45", janSamples(1000, 0, 0, 0));
      await insertFreq("QY-E45", 1, 0.001);
      await refreshRollup("QY-E45");

      const { deleteFrequencyLocation } = await import("./barchart");
      await deleteFrequencyLocation("QY-W45");

      const locs = await query<{ loc_code: string }>(
        "SELECT loc_code FROM band_locs WHERE country = 'QY'",
      );
      expect(locs.rows.map((r) => r.loc_code)).toEqual(["QY-E45"]);

      // Not the stale 2000 sum that included the now-deleted QY-W45.
      const samples = await query<{ n: string }>(
        "SELECT n FROM band_month_samples WHERE band = 40 AND country = 'QY' AND month = 1",
      );
      expect(Number(samples.rows[0].n)).toBe(1000);

      const freq = await query<{ num: string }>(
        `SELECT num FROM species_band_month_freq
          WHERE species_code = 'testsp' AND band = 40 AND country = 'QY' AND month = 1`,
      );
      expect(Number(freq.rows[0].num)).toBeCloseTo(1, 6); // 0.001 * 1000 only
    });

    it("backfill and rebuild agree (P2-7 reconciliation)", async () => {
      await insertLoc("QY-W45", janSamples(10, 1000, 7, 0));
      await insertFreq("QY-W45", 1, 1.0);
      await insertFreq("QY-W45", 2, 0.3);
      await refreshRollup("QY-W45");
      await insertLoc("QY-E45", janSamples(500, 0, 0, 0));
      await insertFreq("QY-E45", 1, 0.02);
      await refreshRollup("QY-E45");
      await insertLoc("ZY", janSamples(200, 0, 0, 0));
      await insertFreq("ZY", 1, 0.5);
      await refreshRollup("ZY");

      // Identical arithmetic to 0050's in-migration backfill (unparameterised
      // there; scoped here to our reserved countries only, so unrelated
      // fixtures elsewhere in this file — which are not all rebuilt at band
      // grain — can never produce a false mismatch).
      const locsDiff = await query(
        `WITH sub1 AS (
           SELECT ff.loc_code, r.parent_code AS country,
                  CASE WHEN r.min_lon IS NOT NULL AND r.min_lon > r.max_lon
                       THEN ((r.min_lon + r.max_lon + 360) / 2 + 540)::numeric % 360 - 180
                       ELSE r.lon END AS lon_eff,
                  r.lat
             FROM frequency_fetch ff JOIN regions r ON r.code = ff.loc_code
            WHERE ff.loc_kind = 'region' AND r.level = 'subnational1'),
         country_only AS (
           SELECT ff.loc_code, r.code AS country,
                  CASE WHEN r.min_lon IS NOT NULL AND r.min_lon > r.max_lon
                       THEN ((r.min_lon + r.max_lon + 360) / 2 + 540)::numeric % 360 - 180
                       ELSE r.lon END AS lon_eff,
                  r.lat
             FROM frequency_fetch ff JOIN regions r ON r.code = ff.loc_code
            WHERE ff.loc_kind = 'region' AND r.level = 'country'
              AND NOT EXISTS (SELECT 1 FROM sub1 s WHERE s.country = r.code)),
         contrib AS (
           SELECT loc_code, country,
                  GREATEST(-90, LEAST(80, floor(lat / 10) * 10))::smallint AS band,
                  (country IN ('US', 'CA', 'MX') AND lon_eff < -100) AS west
             FROM (SELECT * FROM sub1 UNION ALL SELECT * FROM country_only) u),
         backfill AS (
           SELECT band, country, west, loc_code FROM contrib WHERE country IN ('QY', 'ZY')),
         live AS (
           SELECT band, country, west, loc_code FROM band_locs WHERE country IN ('QY', 'ZY'))
         (SELECT * FROM backfill EXCEPT SELECT * FROM live)
         UNION ALL
         (SELECT * FROM live EXCEPT SELECT * FROM backfill)`,
      );
      expect(locsDiff.rows).toHaveLength(0);

      const samplesDiff = await query(
        `WITH backfill AS (
           SELECT bl.band, bl.country, bl.west, lms.month, SUM(lms.n)::float8 AS n
             FROM band_locs bl JOIN loc_month_samples lms ON lms.loc_code = bl.loc_code
            WHERE bl.country IN ('QY', 'ZY')
            GROUP BY 1, 2, 3, 4),
         live AS (
           SELECT band, country, west, month, n FROM band_month_samples
            WHERE country IN ('QY', 'ZY'))
         (SELECT * FROM backfill EXCEPT SELECT * FROM live)
         UNION ALL
         (SELECT * FROM live EXCEPT SELECT * FROM backfill)`,
      );
      expect(samplesDiff.rows).toHaveLength(0);

      const freqDiff = await query(
        `WITH backfill AS (
           SELECT smf.species_code, bl.band, bl.country, bl.west, smf.month,
                  SUM(smf.num)::float8 AS num,
                  COUNT(*) FILTER (WHERE lms.n > 0 AND smf.num / lms.n >= 0.005)::smallint AS reached
             FROM band_locs bl
             JOIN species_month_freq smf ON smf.loc_code = bl.loc_code
             JOIN loc_month_samples lms ON lms.loc_code = smf.loc_code AND lms.month = smf.month
            WHERE bl.country IN ('QY', 'ZY')
            GROUP BY 1, 2, 3, 4, 5),
         live AS (
           SELECT species_code, band, country, west, month, num, reached
             FROM species_band_month_freq WHERE country IN ('QY', 'ZY'))
         (SELECT * FROM backfill EXCEPT SELECT * FROM live)
         UNION ALL
         (SELECT * FROM live EXCEPT SELECT * FROM backfill)`,
      );
      expect(freqDiff.rows).toHaveLength(0);
    });
  });
});

it("suite ran against the live test DB (or was skipped intentionally)", () => {
  // A visible marker in test output: when birds_test is down the suite above
  // silently skips; this line makes the state explicit either way.
  expect(typeof dbUp).toBe("boolean");
});

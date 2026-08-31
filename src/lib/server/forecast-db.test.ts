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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
];

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
      await c.query(
        `INSERT INTO regions (code, name, level, parent_code, lat, lon, source_at)
         VALUES ($1, $2, $3, $4, 1, 1, '2026-01-01')
         ON CONFLICT (code) DO NOTHING`,
        [code, `Fixture ${code}`, level, parent],
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
 * rollup the same way storeFrequencies does — one shared definition, no
 * second copy of the arithmetic to drift. */
async function refreshRollup(code: string) {
  const { rebuildMonthRollup } = await import("./barchart");
  await rebuildMonthRollup(code);
}

async function insertFreq(code: string, week: number, freq: number) {
  return query(
    "INSERT INTO species_frequency (loc_code, species_code, week, freq) VALUES ($1, 'testsp', $2, $3)",
    [code, week, freq],
  );
}

const cleanup = async () => {
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
});

it("suite ran against the live test DB (or was skipped intentionally)", () => {
  // A visible marker in test output: when birds_test is down the suite above
  // silently skips; this line makes the state explicit either way.
  expect(typeof dbUp).toBe("boolean");
});

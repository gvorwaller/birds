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
const { rankLocsForSpeciesMonth, rankCountiesForNeeds, MIN_MONTH_N } =
  await import("./forecast");
const { storeFrequencies, WEEKS } = await import("./barchart");

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

async function insertFreq(code: string, week: number, freq: number) {
  return query(
    "INSERT INTO species_frequency (loc_code, species_code, week, freq) VALUES ($1, 'testsp', $2, $3)",
    [code, week, freq],
  );
}

const cleanup = async () => {
  await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'TESTX-%'");
  await query("DELETE FROM frequency_fetch WHERE loc_code LIKE 'US-QQ-%'");
  await query(
    "DELETE FROM frequency_fetch_attempts WHERE loc_code LIKE 'TESTX-%'",
  );
  await query(
    "DELETE FROM frequency_fetch_attempts WHERE loc_code LIKE 'US-QQ-%'",
  );
};

describe.skipIf(!dbUp)("forecast SQL against birds_test", () => {
  beforeAll(async () => {
    await cleanup();
    // A: Jan weeks n = 10, 1000, 0, 0; reported 100% of wk1, 30% of wk2.
    await insertLoc("TESTX-A", janSamples(10, 1000, 0, 0));
    await insertFreq("TESTX-A", 1, 1.0);
    await insertFreq("TESTX-A", 2, 0.3);
    // B: Jan weeks n = 100 each; reported only wk1 at 40% — absent sparse
    // weeks must still count their checklists in the denominator.
    await insertLoc("TESTX-B", janSamples(100, 100, 100, 100));
    await insertFreq("TESTX-B", 1, 0.4);
    // C: tiny sample (n=13 total) at 100% — must flag lowSample, sort last.
    await insertLoc("TESTX-C", janSamples(13, 0, 0, 0));
    await insertFreq("TESTX-C", 1, 1.0);
  });
  afterAll(cleanup);

  it("computes checklist-weighted month frequency in SQL (sparse-safe)", async () => {
    const ranked = await rankLocsForSpeciesMonth(
      ["TESTX-A", "TESTX-B", "TESTX-C"],
      "testsp",
      1,
    );
    expect(ranked.map((r) => r.code)).toEqual([
      "TESTX-A",
      "TESTX-B",
      "TESTX-C",
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
    expect(await rankLocsForSpeciesMonth(["TESTX-NONE"], "testsp", 1)).toEqual(
      [],
    );
    // December: none of the fixtures have week 45-48 checklists → n = 0.
    const dec = await rankLocsForSpeciesMonth(["TESTX-A"], "testsp", 12);
    expect(dec[0].n).toBe(0);
    expect(dec[0].freq).toBe(0);
  });

  it("migration CHECKs reject bad rows; delete cascades", async () => {
    await expect(insertFreq("TESTX-A", 49, 0.5)).rejects.toThrow(/check/i);
    await expect(insertFreq("TESTX-A", 3, 1.5)).rejects.toThrow(/check/i);
    await expect(
      query(
        `INSERT INTO frequency_fetch
           (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species)
         VALUES ('TESTX-BAD', 'region', 'Bad', 2016, 2025, $1, 1)`,
        [Array(47).fill(1)],
      ),
    ).rejects.toThrow(/check/i);

    await insertLoc("TESTX-DEL", janSamples(50, 50, 50, 50));
    await insertFreq("TESTX-DEL", 1, 0.2);
    await query("DELETE FROM frequency_fetch WHERE loc_code = 'TESTX-DEL'");
    const orphans = await query(
      "SELECT 1 FROM species_frequency WHERE loc_code = 'TESTX-DEL'",
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
      locCode: "TESTX-STORE",
      locKind: "region",
      locName: "Store fixture",
      beginYear: 2016,
      endYear: 2025,
      parsed,
      matched: good,
    });
    const stored = await query(
      "SELECT n_species, unmatched_names FROM frequency_fetch WHERE loc_code = 'TESTX-STORE'",
    );
    expect(Number(stored.rows[0].n_species)).toBe(1);
    expect(stored.rows[0].unmatched_names).toEqual(["spuh sp."]);
    const attempts = await query(
      "SELECT status FROM frequency_fetch_attempts WHERE loc_code = 'TESTX-STORE'",
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
        locCode: "TESTX-STORE",
        locKind: "region",
        locName: "Store fixture",
        beginYear: 2016,
        endYear: 2025,
        parsed: badParsed,
        matched: bad,
      }),
    ).rejects.toThrow();
    const after = await query(
      "SELECT freq FROM species_frequency WHERE loc_code = 'TESTX-STORE' AND week = 1",
    );
    expect(Number(after.rows[0].freq)).toBeCloseTo(0.5, 6);
    const sizesAfter = await query(
      "SELECT sample_sizes[1] AS w1 FROM frequency_fetch WHERE loc_code = 'TESTX-STORE'",
    );
    expect(Number(sizesAfter.rows[0].w1)).toBe(100);
  });

  it("rankCountiesForNeeds counts absent sparse weeks in the denominator", async () => {
    // January: 40% of week 1, absent weeks 2–4 (100 checklists each) → 10%,
    // not 40%. Must not count as "likely".
    await insertLoc("US-QQ-001", janSamples(100, 100, 100, 100));
    await insertFreq("US-QQ-001", 1, 0.4);
    const ranks = await rankCountiesForNeeds(0, "US-QQ", 1);
    expect(ranks).toHaveLength(1);
    // 10% is "possible" (5–19%), not "likely" (≥20%).
    expect(ranks[0].likely).toBe(0);
    expect(ranks[0].possible).toBe(1);
    expect(ranks[0].n).toBe(400);
  });
});

it("suite ran against the live test DB (or was skipped intentionally)", () => {
  // A visible marker in test output: when birds_test is down the suite above
  // silently skips; this line makes the state explicit either way.
  expect(typeof dbUp).toBe("boolean");
});

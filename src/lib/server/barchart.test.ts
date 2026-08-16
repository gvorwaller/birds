import { beforeEach, describe, expect, it, vi } from "vitest";
import usflTsv from "./fixtures/barchart-usfl.tsv?raw";
import usflRealTsv from "./fixtures/barchart-usfl-real.tsv?raw";
import malformedTsv from "./fixtures/barchart-malformed.tsv?raw";

// ---------------------------------------------------------------------------
// DB mock: ensureFrequencies/storeFrequencies are exercised without Postgres.
// Tests set `queryHandler` to route results by SQL text; every statement is
// recorded in `dbCalls` for assertions.
// ---------------------------------------------------------------------------
const dbCalls: { text: string; params: unknown[] }[] = [];
let queryHandler: (
  text: string,
  params?: unknown[],
) => { rows: unknown[] } | undefined = () => undefined;

async function mockQuery(text: string, params?: unknown[]) {
  dbCalls.push({ text, params: params ?? [] });
  return queryHandler(text, params) ?? { rows: [] };
}

vi.mock("$lib/db", () => ({
  query: (text: string, params?: unknown[]) => mockQuery(text, params),
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));

import {
  BarchartAuthError,
  BarchartError,
  WEEKS,
  barchartUrl,
  ensureFrequencies,
  lastCompleteYear,
  matchBarchartRows,
  parseBarchartTsv,
  validateMatchedBarchart,
  type MatchedBarchart,
  type ParsedBarchart,
} from "./barchart";
import { EbirdLoginError, EbirdUpstreamError } from "./ebird-account";

// Stub matcher: common names the tests recognize (species category only, so
// spuhs/slashes intentionally have no entry — same as the real matcher).
const CODES: Record<string, string> = {
  "crested caracara": "crecar",
  "great blue heron": "grbher3",
};
const stubMatcher = {
  match(name: string) {
    const code = CODES[name.toLowerCase()];
    return code ? { code } : null;
  },
};

function makeValidTsv(species: [string, number][]): string {
  const weekVals = (v: string) => Array(WEEKS).fill(v).join("\t");
  const lines = [
    "",
    "Sample Size:\t" + weekVals("100.0"),
    ...species.map(([name, f]) => `${name}\t` + weekVals(f.toFixed(4))),
  ];
  return lines.join("\n");
}

beforeEach(() => {
  dbCalls.length = 0;
  queryHandler = () => undefined;
});

describe("parseBarchartTsv", () => {
  it("parses the fixture: sample sizes, species rows, empty cells → 0", () => {
    const parsed = parseBarchartTsv(usflTsv);
    expect(parsed.sampleSizes).toHaveLength(WEEKS);
    expect(parsed.sampleSizes[0]).toBe(1000);
    expect(parsed.sampleSizes[47]).toBe(1470);
    const names = parsed.rows.map((r) => r.name);
    expect(names).toEqual([
      "Crested Caracara",
      "Great Blue Heron",
      "duck sp.",
      "Greater/Lesser Yellowlegs",
    ]);
    const caracara = parsed.rows[0];
    expect(caracara.freqs).toHaveLength(WEEKS);
    expect(caracara.freqs[0]).toBeCloseTo(0.3); // January
    expect(caracara.freqs[20]).toBe(0); // June (empty cell in the fixture)
  });

  it("tolerates the month-header preamble and trailing tabs", () => {
    // Fixture line 2 is a 48-cell non-numeric month header; it must be skipped,
    // not parsed as a species named "Jan" or rejected.
    const parsed = parseBarchartTsv(usflTsv);
    expect(parsed.rows.some((r) => r.name === "Jan")).toBe(false);
  });

  it("rejects an HTML login page loudly, typed as an AUTH error", () => {
    expect(() =>
      parseBarchartTsv('<!doctype html><html lang="en"><head>...'),
    ).toThrow(BarchartAuthError);
    expect(() => parseBarchartTsv("<HTML><body>login</body>")).toThrow(
      /not authenticated/,
    );
  });

  it("rejects fractional sample sizes instead of rounding them", () => {
    const vals = Array(WEEKS).fill("100.0");
    vals[5] = "100.5";
    expect(() => parseBarchartTsv("Sample Size:\t" + vals.join("\t"))).toThrow(
      /non-integer checklist count/,
    );
  });

  it("rejects a TSV without the Sample Size row", () => {
    expect(() =>
      parseBarchartTsv("Great Blue Heron\t" + Array(48).fill("0.1").join("\t")),
    ).toThrow(/Sample Size/);
  });

  it("rejects a numeric species row with the wrong week count", () => {
    expect(() => parseBarchartTsv(malformedTsv)).toThrow(/expected 48/);
  });

  it("rejects a sample-size row with the wrong week count", () => {
    expect(() =>
      parseBarchartTsv("Sample Size:\t" + Array(47).fill("10.0").join("\t")),
    ).toThrow(/expected 48/);
  });

  /**
   * Golden test against a REAL barchartData export (US-FL, 2016-2025, captured
   * 2026-08-10). Pins the actual format: ~10 blank preamble lines, a title
   * line, "Number of taxa:\t955" (single-value metadata — must be tolerated,
   * not treated as a malformed species row), month header, Sample Size row,
   * then 955 taxa rows with trailing tabs.
   */
  it("parses a real US-FL export end to end", () => {
    const parsed = parseBarchartTsv(usflRealTsv);
    expect(parsed.sampleSizes).toHaveLength(WEEKS);
    // Florida has enormous checklist volume — every week is well sampled.
    expect(Math.min(...parsed.sampleSizes)).toBeGreaterThan(10_000);
    expect(parsed.rows).toHaveLength(955);
    const caracara = parsed.rows.find((r) => r.name === "Crested Caracara");
    expect(caracara).toBeDefined();
    expect(caracara!.freqs.some((f) => f > 0.005)).toBe(true);
    expect(parsed.rows.some((r) => r.name === "Number of taxa:")).toBe(false);
  });
});

describe("matchBarchartRows", () => {
  it("maps names to codes and collects spuhs/slashes as unmatched", () => {
    const parsed = parseBarchartTsv(usflTsv);
    const matched = matchBarchartRows(parsed, stubMatcher);
    expect([...matched.bySpecies.keys()].sort()).toEqual(["crecar", "grbher3"]);
    expect(matched.unmatched).toEqual([
      "duck sp.",
      "Greater/Lesser Yellowlegs",
    ]);
    expect(matched.collisions).toBe(0);
  });

  it("keeps the per-week max when two rows collapse onto one code (lump)", () => {
    const parsed: ParsedBarchart = {
      sampleSizes: Array(WEEKS).fill(100),
      rows: [
        { name: "Great Blue Heron", freqs: Array(WEEKS).fill(0.1) },
        { name: "Great Blue Heron", freqs: Array(WEEKS).fill(0.3) },
      ],
    };
    const matched = matchBarchartRows(parsed, stubMatcher);
    expect(matched.collisions).toBe(1);
    expect(matched.bySpecies.get("grbher3")![0]).toBeCloseTo(0.3);
  });
});

describe("validateMatchedBarchart", () => {
  const okParsed = (): ParsedBarchart => ({
    sampleSizes: Array(WEEKS).fill(100),
    rows: [],
  });
  const okMatched = (n = 3): MatchedBarchart => {
    const bySpecies = new Map<string, number[]>();
    for (let i = 0; i < n; i++)
      bySpecies.set(`sp${i}`, Array(WEEKS).fill(0.2));
    return { bySpecies, unmatched: [], collisions: 0 };
  };

  it("passes a plausible dataset", () => {
    expect(() =>
      validateMatchedBarchart(okParsed(), okMatched(), null),
    ).not.toThrow();
  });

  it("rejects zero matched species (never store an empty dataset)", () => {
    expect(() =>
      validateMatchedBarchart(okParsed(), okMatched(0), null),
    ).toThrow(/No barchart rows matched/);
  });

  it("rejects all-zero sample sizes", () => {
    const parsed: ParsedBarchart = {
      sampleSizes: Array(WEEKS).fill(0),
      rows: [],
    };
    expect(() => validateMatchedBarchart(parsed, okMatched(), null)).toThrow(
      /zero checklists/,
    );
  });

  it("rejects out-of-range frequencies", () => {
    const matched = okMatched();
    matched.bySpecies.get("sp0")![5] = 1.5;
    expect(() => validateMatchedBarchart(okParsed(), matched, null)).toThrow(
      /Out-of-range/,
    );
  });

  it("rejects an implausible species-count collapse vs the prior fetch", () => {
    expect(() =>
      validateMatchedBarchart(okParsed(), okMatched(3), 100),
    ).toThrow(/implausible collapse/);
    // 30 of 100 is above the 25% retention floor — allowed.
    expect(() =>
      validateMatchedBarchart(okParsed(), okMatched(30), 100),
    ).not.toThrow();
  });
});

describe("lastCompleteYear / barchartUrl", () => {
  it("never includes the partial current year", () => {
    expect(lastCompleteYear(new Date(2026, 7, 6))).toBe(2025);
    expect(lastCompleteYear(new Date(2026, 0, 1))).toBe(2025);
    expect(lastCompleteYear(new Date(2026, 11, 31))).toBe(2025);
  });

  it("builds the documented barchartData URL", () => {
    expect(barchartUrl("US-FL", 2016, 2025)).toBe(
      "https://ebird.org/barchartData?r=US-FL&bmo=1&emo=12&byr=2016&eyr=2025&fmt=tsv",
    );
  });
});

// ---------------------------------------------------------------------------
// ensureFrequencies (injected fetcher — no live CAS, no live eBird, ever)
// ---------------------------------------------------------------------------

function taxonomyHandler(text: string): { rows: unknown[] } | undefined {
  if (text.includes("FROM taxonomy_cache")) {
    return {
      rows: [
        {
          species_code: "grbher3",
          com_name: "Great Blue Heron",
          sci_name: "Ardea herodias",
        },
        {
          species_code: "crecar",
          com_name: "Crested Caracara",
          sci_name: "Caracara plancus",
        },
      ],
    };
  }
  if (text.includes("FROM species_match_overrides")) return { rows: [] };
  return undefined;
}

const noSleep = async () => {};
const loc = (code: string) => ({
  code,
  kind: "region" as const,
  name: `Region ${code}`,
});

describe("ensureFrequencies", () => {
  it("skips locations whose stored data is already current", async () => {
    queryHandler = (text) => {
      if (text.includes("FROM frequency_fetch WHERE")) {
        return {
          rows: [
            {
              loc_code: "US-FL",
              loc_kind: "region",
              loc_name: "Florida",
              begin_year: 2016,
              end_year: lastCompleteYear(),
              sample_sizes: Array(WEEKS).fill(100),
              n_species: 300,
              n_unmatched: 2,
              unmatched_names: [],
              fetched_at: new Date().toISOString(),
            },
          ],
        };
      }
      return taxonomyHandler(text);
    };
    const fetcher = vi.fn();
    const result = await ensureFrequencies(1, [loc("US-FL")], {
      fetcher,
      sleep: noSleep,
    });
    expect(result.ready).toEqual(["US-FL"]);
    expect(result.refreshed).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches, stores, and records an ok attempt for missing locations", async () => {
    queryHandler = taxonomyHandler;
    const fetcher = vi.fn(
      async (_u: number, _code: string, _begin: number, _end: number) =>
        makeValidTsv([["Great Blue Heron", 0.25]]),
    );
    const result = await ensureFrequencies(1, [loc("US-FL")], {
      fetcher,
      sleep: noSleep,
    });
    expect(result.refreshed).toEqual(["US-FL"]);
    expect(result.failed).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // begin/end years: complete years only
    const [, , begin, end] = fetcher.mock.calls[0];
    expect(end).toBe(lastCompleteYear());
    expect(begin).toBe(lastCompleteYear() - 9);
    // stored: frequency_fetch upsert, sparse insert, ok attempt
    expect(
      dbCalls.some((c) => c.text.includes("INSERT INTO frequency_fetch\n")),
    ).toBe(true);
    expect(
      dbCalls.some((c) => c.text.includes("INSERT INTO species_frequency")),
    ).toBe(true);
    const attempt = dbCalls.find((c) =>
      c.text.includes("INSERT INTO frequency_fetch_attempts"),
    );
    expect(attempt?.text).toContain("'ok'");
  });

  it("enforces the per-invocation fetch cap", async () => {
    queryHandler = taxonomyHandler;
    const fetcher = vi.fn(async () =>
      makeValidTsv([["Great Blue Heron", 0.25]]),
    );
    const locs = Array.from({ length: 15 }, (_, i) => loc(`US-A${i}`));
    const result = await ensureFrequencies(1, locs, {
      fetcher,
      sleep: noSleep,
    });
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(result.refreshed).toHaveLength(12);
    expect(result.notAttempted).toHaveLength(3);
  });

  it("isolates a per-location data failure without poisoning the batch", async () => {
    queryHandler = taxonomyHandler;
    const badTsv =
      "Sample Size:\t" +
      Array(WEEKS).fill("100.0").join("\t") +
      "\nGreat Blue Heron\t" +
      Array(30).fill("0.1").join("\t"); // wrong week count → BarchartError
    const fetcher = vi.fn(async (_u: number, code: string) => {
      if (code === "US-B1") return badTsv;
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const result = await ensureFrequencies(
      1,
      [loc("US-B0"), loc("US-B1"), loc("US-B2")],
      { fetcher, sleep: noSleep },
    );
    expect(result.refreshed).toEqual(["US-B0", "US-B2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].code).toBe("US-B1");
    expect(result.credentialProblem).toBeNull();
    const errAttempt = dbCalls.find(
      (c) =>
        c.text.includes("frequency_fetch_attempts") &&
        c.text.includes("'error'"),
    );
    expect(errAttempt?.params[0]).toBe("US-B1");
  });

  it("treats a 200 login page as an auth failure and aborts the batch", async () => {
    queryHandler = taxonomyHandler;
    const fetcher = vi.fn(async (_u: number, code: string) => {
      if (code === "US-H1") return "<!doctype html><html>login</html>";
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const result = await ensureFrequencies(
      1,
      [loc("US-H0"), loc("US-H1"), loc("US-H2"), loc("US-H3")],
      { fetcher, sleep: noSleep },
    );
    expect(result.refreshed).toEqual(["US-H0"]);
    expect(result.credentialProblem).toMatch(/not authenticated/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.notAttempted).toEqual(["US-H2", "US-H3"]);
  });

  it("stops on rate limit (429) WITHOUT blaming credentials", async () => {
    queryHandler = taxonomyHandler;
    const fetcher = vi.fn(async (_u: number, code: string) => {
      if (code === "US-R1")
        throw new EbirdUpstreamError(
          "eBird returned HTTP 429 for this request (rate limited) — try again later.",
          429,
        );
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const result = await ensureFrequencies(
      1,
      [loc("US-R0"), loc("US-R1"), loc("US-R2")],
      { fetcher, sleep: noSleep },
    );
    expect(result.refreshed).toEqual(["US-R0"]);
    expect(result.credentialProblem).toBeNull(); // NOT a credential problem
    expect(result.failed[0].error).toMatch(/429/);
    expect(fetcher).toHaveBeenCalledTimes(2); // batch stopped
    expect(result.notAttempted).toEqual(["US-R2"]);
  });

  it("retries a transient 5xx once and recovers without recording a failure", async () => {
    queryHandler = taxonomyHandler;
    // First call 500s (the live prod hiccup of 2026-08-14), retry succeeds.
    let calls = 0;
    const fetcher = vi.fn(async (_u: number, code: string) => {
      if (code === "US-T1" && ++calls === 1)
        throw new EbirdUpstreamError("eBird returned HTTP 500.", 500);
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await ensureFrequencies(1, [loc("US-T1")], {
      fetcher,
      sleep,
    });
    expect(result.refreshed).toEqual(["US-T1"]);
    expect(result.failed).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // The retry waited the 5xx backoff, not the normal request spacing.
    expect(sleep.mock.calls.some(([ms]) => ms === 4000)).toBe(true);
  });

  it("keeps a PERSISTENT 5xx as a per-location failure and continues", async () => {
    queryHandler = taxonomyHandler;
    const fetcher = vi.fn(async (_u: number, code: string) => {
      if (code === "US-S1")
        throw new EbirdUpstreamError("eBird returned HTTP 503.", 503);
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const result = await ensureFrequencies(
      1,
      [loc("US-S0"), loc("US-S1"), loc("US-S2")],
      { fetcher, sleep: noSleep },
    );
    expect(result.refreshed).toEqual(["US-S0", "US-S2"]);
    expect(result.credentialProblem).toBeNull();
    expect(result.failed[0].code).toBe("US-S1");
    // Failing loc fetched twice (initial + one retry), never more.
    expect(
      fetcher.mock.calls.filter(([, code]) => code === "US-S1"),
    ).toHaveLength(2);
  });

  it("aborts the whole batch on an authentication failure", async () => {
    queryHandler = taxonomyHandler;
    const fetcher = vi.fn(async (_u: number, code: string) => {
      if (code === "US-C1")
        throw new EbirdLoginError("eBird rejected the username or password.");
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const result = await ensureFrequencies(
      1,
      [loc("US-C0"), loc("US-C1"), loc("US-C2"), loc("US-C3")],
      { fetcher, sleep: noSleep },
    );
    expect(result.refreshed).toEqual(["US-C0"]);
    expect(result.credentialProblem).toMatch(/rejected/);
    // The remaining locations were never fetched.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.notAttempted).toEqual(["US-C2", "US-C3"]);
  });

  it("stops starting fetches once the batch time budget is spent", async () => {
    queryHandler = taxonomyHandler;
    // Deterministic clock that advances 3 minutes per FETCH (a slow eBird
    // evening): budget check passes at 0 and 3 min, fails at 6 min.
    let elapsed = 0;
    const fakeNow = () => new Date(1_700_000_000_000 + elapsed);
    const fetcher = vi.fn(async () => {
      elapsed += 3 * 60_000;
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const result = await ensureFrequencies(
      1,
      [loc("US-B0"), loc("US-B1"), loc("US-B2")],
      { fetcher, sleep: noSleep, now: fakeNow },
    );
    expect(result.refreshed).toEqual(["US-B0", "US-B1"]);
    expect(result.notAttempted).toEqual(["US-B2"]);
  });


  it("recently failed locations sit out non-forced batches (no spend)", async () => {
    queryHandler = (text, params) => {
      if (text.includes("FROM frequency_fetch_attempts")) {
        return {
          rows: [
            {
              loc_code: "US-CD1",
              last_attempt_at: new Date(Date.now() - 5 * 60_000).toISOString(),
              status: "error",
              error: "eBird returned HTTP 500 for this request.",
            },
          ],
        };
      }
      return taxonomyHandler(text) ?? undefined;
    };
    const fetcher = vi.fn(async (_u: number, _code: string) =>
      makeValidTsv([["Great Blue Heron", 0.25]]),
    );
    const result = await ensureFrequencies(
      92,
      [loc("US-CD1"), loc("US-CD2")],
      { fetcher, sleep: noSleep },
    );
    // Cooldown loc reported failed WITHOUT a fetch; the other proceeds.
    expect(result.refreshed).toEqual(["US-CD2"]);
    expect(result.failed[0].code).toBe("US-CD1");
    expect(result.failed[0].error).toMatch(/waiting before retrying/);
    expect(fetcher.mock.calls.every(([, code]) => code !== "US-CD1")).toBe(
      true,
    );
    // force bypasses the cooldown (explicit Retry buttons).
    const forced = await ensureFrequencies(92, [loc("US-CD1")], {
      fetcher,
      sleep: noSleep,
      force: true,
    });
    expect(forced.refreshed).toEqual(["US-CD1"]);
  });

  it("no in-process lease: overlapping calls both run (serialization now lives in the job queue)", async () => {
    queryHandler = taxonomyHandler;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowFetcher = vi.fn(async () => {
      await gate;
      return makeValidTsv([["Great Blue Heron", 0.25]]);
    });
    const first = ensureFrequencies(7, [loc("US-D0")], {
      fetcher: slowFetcher,
      sleep: noSleep,
    });
    await new Promise((r) => setTimeout(r, 10));
    // A second call while the first is in flight proceeds — the single
    // worker + queue concurrency 1 is the serialization, not this module.
    const second = await ensureFrequencies(7, [loc("US-D1")], {
      fetcher: vi.fn(async () => makeValidTsv([["Great Blue Heron", 0.25]])),
      sleep: noSleep,
    });
    expect(second.refreshed).toEqual(["US-D1"]);
    expect(second.notAttempted).toEqual([]);
    release();
    const firstResult = await first;
    expect(firstResult.refreshed).toEqual(["US-D0"]);
  });

  it("maxFetches: Infinity actually fetches past the 12-unit default clamp (GROK #8)", async () => {
    queryHandler = taxonomyHandler;
    const fetcher = vi.fn(async () =>
      makeValidTsv([["Great Blue Heron", 0.25]]),
    );
    const locs = Array.from({ length: 15 }, (_, i) => loc(`US-INF-${i}`));
    const result = await ensureFrequencies(1, locs, {
      fetcher,
      sleep: noSleep,
      maxFetches: Infinity,
      timeBudgetMs: Infinity,
    });
    // Load-bearing for the worker: all 15 units in ONE ensure call — the old
    // in-path clamp would have stopped at 12 with 3 notAttempted.
    expect(fetcher).toHaveBeenCalledTimes(15);
    expect(result.refreshed).toHaveLength(15);
    expect(result.notAttempted).toEqual([]);
  });

  it("paces fetches with start-to-start spacing", async () => {
    queryHandler = taxonomyHandler;
    const sleep = vi.fn(async (_ms: number) => {});
    const fetcher = vi.fn(async () =>
      makeValidTsv([["Great Blue Heron", 0.25]]),
    );
    await ensureFrequencies(1, [loc("US-E0"), loc("US-E1"), loc("US-E2")], {
      fetcher,
      sleep,
    });
    // 3 fetches → 2 pacing sleeps, each <= the 500 ms spacing.
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const [ms] of sleep.mock.calls) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(500);
    }
  });

  it("force-refreshes current data when asked", async () => {
    queryHandler = (text) => {
      if (text.includes("FROM frequency_fetch WHERE")) {
        return {
          rows: [
            {
              loc_code: "US-FL",
              loc_kind: "region",
              loc_name: "Florida",
              begin_year: 2016,
              end_year: lastCompleteYear(),
              sample_sizes: Array(WEEKS).fill(100),
              n_species: 1, // matches the single-species TSV below (retention gate)
              n_unmatched: 0,
              unmatched_names: [],
              fetched_at: new Date().toISOString(),
            },
          ],
        };
      }
      return taxonomyHandler(text);
    };
    const fetcher = vi.fn(async () =>
      makeValidTsv([["Great Blue Heron", 0.25]]),
    );
    const result = await ensureFrequencies(1, [loc("US-FL")], {
      fetcher,
      sleep: noSleep,
      force: true,
    });
    expect(result.refreshed).toEqual(["US-FL"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

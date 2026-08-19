import { describe, expect, it } from "vitest";
import {
  MIGRATION_ABSENCE_WEEKS,
  MIN_WEEK_N,
  migrationSentence,
  migrationWindow,
  weekCurve,
  weekPhrase,
  type WeekStat,
} from "./forecast";

/** Build a 48-week curve: present weeks get freq, everything else absent. */
function curveWith(
  presentWeeks: number[],
  opts: { freq?: number; n?: number; nFor?: Record<number, number> } = {},
): WeekStat[] {
  const present = new Set(presentWeeks);
  const freq = opts.freq ?? 0.3;
  const n = opts.n ?? 40;
  return Array.from({ length: 48 }, (_, i) => {
    const week = i + 1;
    return {
      week,
      freq: present.has(week) ? freq : 0,
      n: opts.nFor?.[week] ?? n,
    };
  });
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("weekCurve", () => {
  it("emits all 48 weeks; sparse map weeks are 0-freq with their real n", () => {
    const c = weekCurve(new Map([[14, 0.4]]), Array(48).fill(25));
    expect(c).toHaveLength(48);
    expect(c[13]).toEqual({ week: 14, freq: 0.4, n: 25 });
    expect(c[0]).toEqual({ week: 1, freq: 0, n: 25 });
  });

  it("missing sample sizes are n=0 (no data, not zero frequency)", () => {
    const c = weekCurve(new Map(), []);
    expect(c[47]).toEqual({ week: 48, freq: 0, n: 0 });
  });
});

describe("migrationWindow — GROK emit/suppress matrix", () => {
  it("summer resident: winter absence gap → arrives spring, departs fall", () => {
    // Present weeks 14-42 (early Apr – mid Nov), absent the rest (>8 weeks,
    // wrapping Nov→Mar).
    const w = migrationWindow(curveWith(range(14, 42)));
    expect(w).toEqual({ arriveWeek: 14, departWeek: 42 });
    expect(migrationSentence(curveWith(range(14, 42)))).toBe(
      `arrives ~${weekPhrase(14)} · departs ~${weekPhrase(42)}`,
    );
  });

  it("winter resident: WRAP-AROUND presence (Oct–Mar), summer absence gap", () => {
    const w = migrationWindow(curveWith([...range(40, 48), ...range(1, 12)]));
    expect(w).toEqual({ arriveWeek: 40, departWeek: 12 });
  });

  it("year-round species → null (no ≥8-week absence run exists)", () => {
    expect(migrationWindow(curveWith(range(1, 48)))).toBeNull();
  });

  it("vagrant/absent species → null (no ≥2-week presence run)", () => {
    expect(migrationWindow(curveWith([20]))).toBeNull(); // one isolated week
    expect(migrationWindow(curveWith([]))).toBeNull();
  });

  it("double-gap passage migrant → null (one sentence can't tell two windows)", () => {
    // Spring (10-17) and fall (33-40) presence, absent ≥8 weeks BOTH between
    // and around — two absence runs.
    expect(migrationWindow(curveWith([...range(10, 17), ...range(33, 40)]))).toBeNull();
  });

  it("low-n weeks are UNKNOWN: they neither extend absence nor count as presence", () => {
    // Would-be summer resident, but the entire winter has inadequate effort —
    // no adequate ≥8-week absence run can be proven.
    const nFor: Record<number, number> = {};
    for (const wk of [...range(1, 13), ...range(43, 48)]) nFor[wk] = MIN_WEEK_N - 1;
    expect(migrationWindow(curveWith(range(14, 42), { nFor }))).toBeNull();
  });

  it("low-n presence weeks cannot anchor arrival", () => {
    // Presence 14-42 but weeks 14-15 are under-sampled → arrival shifts to
    // the first adequate ≥2-week presence run (16).
    const w = migrationWindow(
      curveWith(range(14, 42), { nFor: { 14: 3, 15: 3 } }),
    );
    expect(w?.arriveWeek).toBe(16);
  });

  it(`absence must reach ${MIGRATION_ABSENCE_WEEKS} weeks — a short gap is not a season`, () => {
    // Absent only weeks 1-7 (7 weeks) — under the bar.
    expect(migrationWindow(curveWith(range(8, 48)))).toBeNull();
  });
});

describe("weekPhrase", () => {
  it("maps week slots to early/mid/mid-to-late/late month names", () => {
    expect(weekPhrase(13)).toBe("early April");
    expect(weekPhrase(16)).toBe("late April");
    expect(weekPhrase(42)).toBe("mid November"); // weeks 41-44 are November
  });
});

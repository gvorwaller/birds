/**
 * td-894144 B4 (plan rev 24 §B4e–B4g): exact finite-population bounds with a
 * Bonferroni split, the owner's two claims (precision; retention of legacy's
 * REAL positives), worst-case unsure handling, strict sample validation,
 * undefined/zero denominators, sizing on the same bounds, and one-sided
 * coverage over a dense predeclared grid.
 */
import { describe, expect, it } from "vitest";
import {
  NO_LEGACY_POSITIVES,
  PROPOSED_GATES,
  STRATA,
  STRATUM_FLAGS,
  evaluateGate,
  hyperLower,
  hyperUpper,
  precisionClaim,
  retentionClaim,
  seededRandom,
  sizeDesign,
  SIZING,
  worstGaps,
  type Design,
  type EvalObservation,
  type Label,
  type Stratum,
} from "./eval-stats";

let seq = 0;
const obs = (stratum: Stratum, label: Label): EvalObservation => {
  const f = STRATUM_FLAGS[stratum];
  return {
    code: `s${seq++}`,
    stratum,
    rulesYes: f.rulesYes,
    legacyYes: f.legacyYes,
    status: f.status,
    marine: f.marine ?? false,
    label,
  };
};
const NONE = new Set<string>();
const gate = (
  p: ReturnType<typeof precisionClaim>,
  r: ReturnType<typeof retentionClaim>,
  assigned = NONE,
  g: unknown = PROPOSED_GATES,
) => evaluateGate(g, p, r, assigned);
const design = (d: Partial<Record<Stratum, [number, number]>>): Design =>
  Object.fromEntries(
    STRATA.map((h) => [h, { N: d[h]?.[0] ?? 0, n: d[h]?.[1] ?? 0 }]),
  ) as Design;
const many = (h: Stratum, yes: number, no: number, unsure = 0) => [
  ...Array.from({ length: yes }, () => obs(h, "yes")),
  ...Array.from({ length: no }, () => obs(h, "no")),
  ...Array.from({ length: unsure }, () => obs(h, "unsure")),
];

describe("exact hypergeometric bounds", () => {
  it("census strata are exact; all-yes keeps a lower bound below N; all-no an upper bound above 0", () => {
    expect(hyperLower(10, 10, 7, 0.025)).toBe(7);
    expect(hyperUpper(10, 10, 7, 0.025)).toBe(7);
    const lo = hyperLower(200, 30, 30, 0.025);
    expect(lo).toBeLessThan(200);
    expect(lo).toBeGreaterThan(150);
    expect(hyperUpper(200, 30, 0, 0.025)).toBeGreaterThan(0);
  });
  it("matches a brute-force hypergeometric inversion on a small case", () => {
    // N=20, n=8, x=6: the smallest K with P(X ≥ 6 | K) > 0.025
    const choose = (a: number, b: number): number =>
      b < 0 || b > a ? 0 : b === 0 ? 1 : (choose(a - 1, b - 1) * a) / b;
    const tail = (K: number) => {
      let p = 0;
      for (let k = 6; k <= Math.min(8, K); k++)
        p += (choose(K, k) * choose(20 - K, 8 - k)) / choose(20, 8);
      return p;
    };
    let K = 6;
    while (tail(K) <= 0.025) K++;
    expect(hyperLower(20, 8, 6, 0.025)).toBe(K);
  });
});

describe("the owner's two claims", () => {
  it("retention counts only legacy positives the rules KEEP — new rules positives cannot compensate (CODEX1 rev-23a P1-1)", () => {
    // A: 0 real positives kept; B: many new ones; C1: all real positives lost.
    const d = design({ A: [10, 10], B: [90, 90], C1: [100, 100] });
    const o = [...many("A", 0, 10), ...many("B", 90, 0), ...many("C1", 100, 0)];
    expect(retentionClaim(o, d)).toMatchObject({ point: 0, lower: 0 });
  });
  it("precision uses rules-yes strata only; U-stratum legacy positives count against retention", () => {
    const d = design({ A: [10, 10], B: [10, 10], U: [5, 5] });
    const o = [...many("A", 9, 1), ...many("B", 8, 2), ...many("U", 5, 0)];
    expect(precisionClaim(o, d)).toMatchObject({
      point: 17 / 20,
      lower: 17 / 20,
    }); // census: exact
    expect(retentionClaim(o, d)).toMatchObject({
      point: 9 / 14,
      lower: 9 / 14,
    });
  });
  it("unsure takes its worst value per claim — including the mixed assignment (A→no, C/U→yes)", () => {
    const d = design({ A: [4, 4], C1: [2, 2] });
    const o = [...many("A", 2, 0, 2), ...many("C1", 0, 0, 2)];
    // worst: A has 2 kept (unsure→no), C1 has 2 lost (unsure→yes) → 2/4; all-no would say 2/2, all-yes 4/6.
    expect(retentionClaim(o, d)).toMatchObject({ point: 0.5, lower: 0.5 });
    expect(precisionClaim(o, d)).toMatchObject({ point: 0.5 });
  });
  it("zero observed legacy positives in a NON-census sample is not a pass (CODEX1 rev-23a P1-2)", () => {
    const d = design({ A: [50, 10], C1: [40, 10] });
    const o = [...many("A", 0, 10), ...many("C1", 0, 10)];
    const r = retentionClaim(o, d);
    expect(r.lower).toBe(0);
    expect(gate({ point: 1, lower: 1, note: null }, r).retentionOk).toBe(false);
  });
  it("only a census with no legacy positives makes retention vacuous", () => {
    const d = design({ A: [3, 3], C1: [2, 2] });
    const r = retentionClaim([...many("A", 0, 3), ...many("C1", 0, 2)], d);
    expect(r.note).toBe(NO_LEGACY_POSITIVES);
    expect(gate({ point: 1, lower: 1, note: null }, r).retentionOk).toBe(true);
  });
  it("no lost-side strata (or all censused at zero): the rules keep every legacy positive — lower bound 1", () => {
    expect(
      retentionClaim(many("A", 3, 7), design({ A: [50, 10] })),
    ).toMatchObject({ point: 1, lower: 1 });
    expect(
      retentionClaim(
        [...many("A", 0, 10), ...many("C1", 0, 2)],
        design({ A: [50, 10], C1: [2, 2] }),
      ),
    ).toMatchObject({
      lower: 1,
    });
  });
  it("rules that assign nothing make precision undefined — the gate fails", () => {
    const p = precisionClaim(many("C1", 1, 1), design({ C1: [4, 2] }));
    expect(p).toMatchObject({
      point: null,
      lower: null,
      note: "the rules assign no species",
    });
    expect(gate(p, { point: 1, lower: 1, note: null }).passed).toBe(false);
  });
});

describe("strict sample validation (CODEX1 rev-23a P1-4)", () => {
  it("a missing stratum, a duplicate species, wrong flags or a bad design are rejected", () => {
    const d = design({ A: [20, 2], C1: [10, 2] });
    expect(() => retentionClaim(many("A", 2, 0), d)).toThrow(
      /C1: 0 observations for n = 2/,
    );
    const dup = many("A", 2, 0);
    dup[1] = { ...dup[1], code: dup[0].code };
    expect(() => precisionClaim([...dup, ...many("C1", 1, 1)], d)).toThrow(
      /duplicate/,
    );
    expect(() =>
      precisionClaim(
        [
          { ...obs("A", "yes"), legacyYes: false },
          obs("A", "no"),
          ...many("C1", 1, 1),
        ],
        d,
      ),
    ).toThrow(/flags/);
    // C1/C2/U share rules/legacy flags: the carried status and marine proxy catch a swap (CODEX1 rev-24 P1-3).
    const swapped = many("C1", 1, 1);
    swapped[0] = { ...swapped[0], marine: false };
    expect(() => retentionClaim([...many("A", 2, 0), ...swapped], d)).toThrow(
      /flags do not match stratum C1/,
    );
    const asU = many("C1", 1, 1);
    asU[1] = { ...asU[1], status: "unevaluated" };
    expect(() => retentionClaim([...many("A", 2, 0), ...asU], d)).toThrow(
      /flags do not match/,
    );
    expect(() => precisionClaim([], design({ A: [2, 3] }))).toThrow(
      /invalid design/,
    );
  });
});

describe("the stored gate JSON is the only authority (CODEX1 rev-24 P1-1)", () => {
  const c = (point: number, lower: number) => ({ point, lower, note: null });
  it("needs precision point AND lower bound, retention lower bound, and no must-not named case", () => {
    expect(gate(c(0.95, 0.85), c(0.95, 0.9)).passed).toBe(true);
    expect(gate(c(0.949, 0.9), c(0.95, 0.9)).passed).toBe(false);
    expect(gate(c(0.99, 0.849), c(0.95, 0.9)).passed).toBe(false);
    expect(gate(c(0.99, 0.9), c(0.99, 0.899)).passed).toBe(false);
    expect(
      gate(c(0.99, 0.9), { point: null, lower: null, note: "undefined" })
        .passed,
    ).toBe(false);
  });
  it("a statistically passing set with American Kestrel assigned FAILS", () => {
    const d = gate(c(0.99, 0.95), c(0.99, 0.95), new Set(["amekes", "norful"]));
    expect(d).toMatchObject({
      precisionOk: true,
      retentionOk: true,
      namedCaseViolations: ["amekes"],
      passed: false,
    });
  });
  it("the stored thresholds decide, not code defaults", () => {
    const strict = {
      ...PROPOSED_GATES,
      precision: { point_min: 0.99, lower_min: 0.95 },
    };
    expect(gate(c(0.97, 0.9), c(0.99, 0.95), NONE, strict).passed).toBe(false);
    const lax = {
      ...PROPOSED_GATES,
      retention: { lower_min: 0.5 },
      named_cases_must_not: [],
    };
    expect(
      gate(c(0.97, 0.9), c(0.7, 0.6), new Set(["amekes"]), lax).passed,
    ).toBe(true);
  });
  it("a malformed or unversioned gate JSON is refused", () => {
    expect(() =>
      gate(c(1, 1), c(1, 1), NONE, { ...PROPOSED_GATES, version: 2 }),
    ).toThrow(/version/);
    expect(() =>
      gate(c(1, 1), c(1, 1), NONE, { ...PROPOSED_GATES, extra: 1 }),
    ).toThrow(/keys/);
    expect(() =>
      gate(c(1, 1), c(1, 1), NONE, {
        ...PROPOSED_GATES,
        precision: { point_min: 2, lower_min: 0.8 },
      }),
    ).toThrow(/precision/);
  });
});

describe("sizing on the same exact bounds", () => {
  it("meets both gap criteria in every grid scenario with ≥ min(N, 5) per stratum", () => {
    const N = { A: 180, B: 120, C1: 40, C2: 60, U: 10 };
    const s = sizeDesign(N);
    expect(s.feasible).toBe(true);
    expect(s.worstPrecisionGap).toBeLessThanOrEqual(SIZING.precisionGap);
    expect(s.worstRetentionGap).toBeLessThanOrEqual(SIZING.retentionGap);
    for (const h of STRATA)
      expect(s.n[h]).toBeGreaterThanOrEqual(Math.min(N[h], 5));
  });
  it("greedy is within 3 units of the brute-force minimum on a small population", () => {
    const N = { A: 14, B: 8, C1: 5, C2: 6, U: 3 };
    const s = sizeDesign(N);
    const ok = (n: Record<Stratum, number>) => {
      const g = worstGaps(N, n);
      return (
        g.precisionGap <= SIZING.precisionGap &&
        g.retentionGap <= SIZING.retentionGap
      );
    };
    let best = Infinity;
    const lo = (h: Stratum) => Math.min(N[h], SIZING.minPerStratum);
    const rec = (i: number, n: Record<string, number>, total: number) => {
      if (total >= best) return;
      if (i === STRATA.length) {
        if (ok(n as Record<Stratum, number>)) best = total;
        return;
      }
      const h = STRATA[i];
      for (let k = lo(h); k <= N[h]; k++)
        rec(i + 1, { ...n, [h]: k }, total + k);
    };
    rec(0, {}, 0);
    expect(s.feasible).toBe(true);
    expect(Number.isFinite(best)).toBe(true);
    expect(s.total).toBeLessThanOrEqual(best + 3);
  }, 120_000);
  it("empty strata get no sample; tiny strata are censused when needed", () => {
    const s = sizeDesign({ A: 30, B: 0, C1: 3, C2: 0, U: 0 });
    expect(s.n.B).toBe(0);
    expect(s.n.C1).toBe(3);
  });
});

describe("one-sided coverage of the lower bounds (dense predeclared grid)", () => {
  // Predeclared: 12 finite populations spanning precision ~.80–1.0 and
  // retention ~.70–1.0, incl. all-positive strata, tiny U, R≈.90; 400 draws
  // each at the sizeDesign n; truth may fall below each lower bound in at most
  // 3.5% of draws (nominal ≤ 2.5%; MC slack for 400 draws). Exact bounds are
  // conservative by construction; this guards the implementation.
  const pops: [string, Record<Stratum, number>, Record<Stratum, number>][] = [];
  const shapes = [
    { A: 180, B: 120, C1: 40, C2: 60, U: 10 },
    { A: 260, B: 40, C1: 30, C2: 40, U: 8 },
    { A: 60, B: 30, C1: 25, C2: 20, U: 3 },
  ];
  const rates = [
    { A: 0.95, B: 0.8, C1: 0.5, C2: 0.1, U: 0.3 },
    { A: 1.0, B: 0.95, C1: 0.4, C2: 0.05, U: 0.3 },
    { A: 0.97, B: 0.9, C1: 0.2, C2: 0.02, U: 0.0 },
    { A: 0.9, B: 0.6, C1: 0.7, C2: 0.25, U: 0.5 },
  ];
  for (const [i, N] of shapes.entries())
    for (const [j, p] of rates.entries())
      pops.push([`shape${i}-rates${j}`, N, p]);
  for (const [name, N, p] of pops) {
    it(`lower bounds cover (${name})`, () => {
      const rand = seededRandom(`pop|${name}`);
      const pop = new Map<Stratum, boolean[]>();
      for (const h of STRATA)
        pop.set(
          h,
          Array.from({ length: N[h] }, () => rand() < p[h]),
        );
      const K = (h: Stratum) => pop.get(h)!.filter(Boolean).length;
      const trueP = (K("A") + K("B")) / (N.A + N.B);
      const lostTrue = K("C1") + K("C2") + K("U");
      const trueR = K("A") + lostTrue > 0 ? K("A") / (K("A") + lostTrue) : null;
      const size = sizeDesign(N);
      const d = Object.fromEntries(
        STRATA.map((h) => [h, { N: N[h], n: size.n[h] }]),
      ) as Design;
      let belowP = 0;
      let belowR = 0;
      const DRAWS = 400;
      for (let r = 0; r < DRAWS; r++) {
        const o: EvalObservation[] = [];
        for (const h of STRATA) {
          const units = [...pop.get(h)!];
          for (let k = 0; k < d[h].n; k++) {
            const j2 = k + Math.floor(rand() * (units.length - k));
            [units[k], units[j2]] = [units[j2], units[k]];
            o.push(obs(h, units[k] ? "yes" : "no"));
          }
        }
        const pc = precisionClaim(o, d);
        expect(pc.lower).not.toBeNull(); // null is a failure here, never skipped
        if (trueP < pc.lower! - 1e-12) belowP++;
        const rc = retentionClaim(o, d);
        if (trueR == null) {
          expect(rc.note === NO_LEGACY_POSITIVES || rc.lower != null).toBe(
            true,
          );
        } else {
          expect(rc.lower).not.toBeNull();
          if (trueR < rc.lower! - 1e-12) belowR++;
        }
      }
      expect(belowP / DRAWS).toBeLessThanOrEqual(0.035);
      expect(belowR / DRAWS).toBeLessThanOrEqual(0.035);
    }, 60_000);
  }
});

describe("single-stratum bound coverage (both tails)", () => {
  it("truth exceeds hyperUpper and falls below hyperLower ≤ α (+MC slack) at α = 0.025", () => {
    const rand = seededRandom("tails");
    for (const [N, K, n] of [
      [120, 6, 25],
      [80, 70, 20],
      [200, 40, 30],
      [40, 0, 10],
      [60, 60, 12],
    ] as const) {
      const pop = Array.from({ length: N }, (_, i) => i < K);
      let over = 0;
      let under = 0;
      const DRAWS = 2000;
      for (let r = 0; r < DRAWS; r++) {
        const u = [...pop];
        let x = 0;
        for (let k = 0; k < n; k++) {
          const j = k + Math.floor(rand() * (N - k));
          [u[k], u[j]] = [u[j], u[k]];
          if (u[k]) x++;
        }
        if (K > hyperUpper(N, n, x, 0.025)) over++;
        if (K < hyperLower(N, n, x, 0.025)) under++;
      }
      expect(over / DRAWS).toBeLessThanOrEqual(0.03);
      expect(under / DRAWS).toBeLessThanOrEqual(0.03);
    }
  });
});

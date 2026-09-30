/**
 * Blind-test statistics for a tag revision (td-894144 Release B4, plan rev 24
 * §B4e–B4g). Pure: no DB, no clock.
 *
 * Frame = universe members the rules OR the displayed legacy value tag.
 * Strata (fixed flags): A rules∧legacy · B rules∧¬legacy · C1/C2 legacy ∧
 * rules not_assigned (marine / non-marine) · U legacy ∧ rules unevaluated.
 *
 * Owner's two claims (2026-09-29):
 *   precision = real positives among rules-yes          = (K_A + K_B) / (N_A + N_B)
 *   retention = legacy's real positives the rules keep  = K_A / (K_A + K_C1 + K_C2 + K_U)
 * where K_h = number of real positives (label "yes") in stratum h.
 *
 * Bounds (CODEX1 rev-23a): each stratum's K_h gets an EXACT finite-population
 * (hypergeometric) one-sided bound; the claim's one-sided α = 0.025 is split
 * equally (Bonferroni) across the non-census strata the claim uses; the claim's
 * bound is the worst combination of stratum bounds. Coverage is ≥ 97.5%
 * one-sided by construction — no pseudo sample sizes, no log singularities,
 * all-yes / all-no / empty cells handled exactly. "unsure" takes its WORST
 * value for each claim (precision: no; retention: A → no, C/U → yes).
 */

export const STRATA = ["A", "B", "C1", "C2", "U"] as const;
export type Stratum = (typeof STRATA)[number];
export type Label = "yes" | "no" | "unsure";

export type RulesStatus = "assigned" | "not_assigned" | "unevaluated";

/**
 * What defines each stratum (CODEX1 rev-24 P1-3: C1, C2 and U share the same
 * rules/legacy flags, so the rules status and the marine proxy are carried and
 * checked too — a swapped item is rejected). marine: null = not a criterion.
 */
export const STRATUM_FLAGS: Record<
  Stratum,
  {
    rulesYes: boolean;
    legacyYes: boolean;
    status: RulesStatus;
    marine: boolean | null;
  }
> = {
  A: { rulesYes: true, legacyYes: true, status: "assigned", marine: null },
  B: { rulesYes: true, legacyYes: false, status: "assigned", marine: null },
  C1: {
    rulesYes: false,
    legacyYes: true,
    status: "not_assigned",
    marine: true,
  },
  C2: {
    rulesYes: false,
    legacyYes: true,
    status: "not_assigned",
    marine: false,
  },
  U: { rulesYes: false, legacyYes: true, status: "unevaluated", marine: null },
};

/** The stratum a frame member belongs to, from its own attributes. */
export function stratumOf(
  status: RulesStatus,
  legacyYes: boolean,
  marine: boolean,
): Stratum | null {
  if (status === "assigned") return legacyYes ? "A" : "B";
  if (!legacyYes) return null; // neither system tags it: outside the frame
  if (status === "unevaluated") return "U";
  return marine ? "C1" : "C2";
}

export interface EvalObservation {
  code: string;
  stratum: Stratum;
  rulesYes: boolean;
  legacyYes: boolean;
  status: RulesStatus;
  marine: boolean;
  label: Label;
}

/** Population size and sample size per stratum. */
export type Design = Record<Stratum, { N: number; n: number }>;

export const ALPHA_ONE_SIDED = 0.025;

/** Reject any sample that does not exactly realise the design (CODEX1 rev-23a P1-4). */
export function validateSample(
  obs: readonly EvalObservation[],
  design: Design,
): void {
  const seen = new Set<string>();
  const count: Record<Stratum, number> = { A: 0, B: 0, C1: 0, C2: 0, U: 0 };
  for (const o of obs) {
    if (!STRATA.includes(o.stratum))
      throw new Error(`unknown stratum ${o.stratum}`);
    if (seen.has(o.code)) throw new Error(`duplicate species ${o.code}`);
    seen.add(o.code);
    const f = STRATUM_FLAGS[o.stratum];
    if (
      o.rulesYes !== f.rulesYes ||
      o.legacyYes !== f.legacyYes ||
      o.status !== f.status ||
      stratumOf(o.status, o.legacyYes, o.marine) !== o.stratum
    )
      throw new Error(`${o.code}: flags do not match stratum ${o.stratum}`);
    if (o.label !== "yes" && o.label !== "no" && o.label !== "unsure")
      throw new Error(`${o.code}: bad label`);
    count[o.stratum]++;
  }
  for (const h of STRATA) {
    const { N, n } = design[h];
    if (!Number.isInteger(N) || !Number.isInteger(n) || N < 0 || n < 0 || n > N)
      throw new Error(`stratum ${h}: invalid design N=${N} n=${n}`);
    if (count[h] !== n)
      throw new Error(`stratum ${h}: ${count[h]} observations for n = ${n}`);
  }
}

// ── exact hypergeometric bounds ─────────────────────────────────────────────
const lnFact: number[] = [0];
function lnFactorial(k: number): number {
  for (let i = lnFact.length; i <= k; i++)
    lnFact[i] = lnFact[i - 1] + Math.log(i);
  return lnFact[k];
}
const lnChoose = (a: number, b: number) =>
  b < 0 || b > a
    ? -Infinity
    : lnFactorial(a) - lnFactorial(b) - lnFactorial(a - b);

/** P(X ≥ x) for X ~ Hypergeometric(N, K successes, n draws). */
function upperTail(N: number, K: number, n: number, x: number): number {
  const den = lnChoose(N, n);
  let p = 0;
  for (let k = Math.max(x, 0); k <= Math.min(n, K); k++)
    p += Math.exp(lnChoose(K, k) + lnChoose(N - K, n - k) - den);
  return Math.min(1, p);
}
/** P(X ≤ x). */
function lowerTail(N: number, K: number, n: number, x: number): number {
  const den = lnChoose(N, n);
  let p = 0;
  for (let k = Math.max(0, n - (N - K)); k <= Math.min(x, K); k++)
    p += Math.exp(lnChoose(K, k) + lnChoose(N - K, n - k) - den);
  return Math.min(1, p);
}

const memo = new Map<string, number>();
/** Smallest K consistent with seeing ≥ x successes at one-sided level α (exact; census → x). */
export function hyperLower(
  N: number,
  n: number,
  x: number,
  alpha: number,
): number {
  if (n >= N) return x;
  if (x <= 0) return 0;
  const key = `L|${N}|${n}|${x}|${alpha}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  // P(X ≥ x | K) increases with K: the smallest K where it exceeds α.
  let lo = x;
  let hi = N - (n - x);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (upperTail(N, mid, n, x) > alpha) hi = mid;
    else lo = mid + 1;
  }
  memo.set(key, lo);
  return lo;
}
/** Largest K consistent with seeing ≤ x successes at one-sided level α (exact; census → x). */
export function hyperUpper(
  N: number,
  n: number,
  x: number,
  alpha: number,
): number {
  if (n >= N) return x;
  if (x >= n) return N;
  const key = `U|${N}|${n}|${x}|${alpha}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  // P(X ≤ x | K) decreases with K: the largest K where it exceeds α.
  let lo = x;
  let hi = N - (n - x);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lowerTail(N, mid, n, x) > alpha) lo = mid;
    else hi = mid - 1;
  }
  memo.set(key, lo);
  return lo;
}

// ── the two claims ──────────────────────────────────────────────────────────
export interface ClaimResult {
  /** Point estimate under the claim's worst-case unsure assignment; null = undefined. */
  point: number | null;
  /** One-sided exact lower bound at 97.5%; null = undefined (the gate fails). */
  lower: number | null;
  /** Why the claim is undefined or vacuous, if it is. */
  note: string | null;
}

export type Counts = Record<Stratum, { N: number; n: number; x: number }>;

function yesCount(
  obs: readonly EvalObservation[],
  h: Stratum,
  unsureYes: boolean,
): number {
  return obs.filter(
    (o) =>
      o.stratum === h &&
      (o.label === "yes" || (o.label === "unsure" && unsureYes)),
  ).length;
}

/** Precision: unsure → no. */
export function precisionClaim(
  obs: readonly EvalObservation[],
  design: Design,
): ClaimResult {
  validateSample(obs, design);
  return precisionFromCounts({
    A: { ...design.A, x: yesCount(obs, "A", false) },
    B: { ...design.B, x: yesCount(obs, "B", false) },
    C1: { ...design.C1, x: 0 },
    C2: { ...design.C2, x: 0 },
    U: { ...design.U, x: 0 },
  });
}

export function precisionFromCounts(c: Counts): ClaimResult {
  const NR = c.A.N + c.B.N;
  if (NR === 0)
    return { point: null, lower: null, note: "the rules assign no species" };
  const used = (["A", "B"] as const).filter((h) => c[h].N > 0);
  if (used.some((h) => c[h].n === 0))
    return {
      point: null,
      lower: null,
      note: "a rules-yes stratum has no sample",
    };
  const nonCensus = used.filter((h) => c[h].n < c[h].N).length;
  const a = nonCensus > 0 ? ALPHA_ONE_SIDED / nonCensus : ALPHA_ONE_SIDED;
  let point = 0;
  let lower = 0;
  for (const h of used) {
    point += (c[h].N * c[h].x) / c[h].n;
    lower += hyperLower(c[h].N, c[h].n, c[h].x, a);
  }
  return { point: point / NR, lower: lower / NR, note: null };
}

/** Retention of legacy's real positives: A-unsure → no, C/U-unsure → yes. */
export function retentionClaim(
  obs: readonly EvalObservation[],
  design: Design,
): ClaimResult {
  validateSample(obs, design);
  return retentionFromCounts({
    A: { ...design.A, x: yesCount(obs, "A", false) },
    B: { ...design.B, x: 0 },
    C1: { ...design.C1, x: yesCount(obs, "C1", true) },
    C2: { ...design.C2, x: yesCount(obs, "C2", true) },
    U: { ...design.U, x: yesCount(obs, "U", true) },
  });
}

export const NO_LEGACY_POSITIVES =
  "legacy has no real positives (census): nothing to retain";

export function retentionFromCounts(c: Counts): ClaimResult {
  const used = (["A", "C1", "C2", "U"] as const).filter((h) => c[h].N > 0);
  if (used.some((h) => c[h].n === 0))
    return {
      point: null,
      lower: null,
      note: "a legacy-yes stratum has no sample",
    };
  const nonCensus = used.filter((h) => c[h].n < c[h].N).length;
  const a = nonCensus > 0 ? ALPHA_ONE_SIDED / nonCensus : ALPHA_ONE_SIDED;
  const est = (h: Stratum) => (c[h].N > 0 ? (c[h].N * c[h].x) / c[h].n : 0);
  const kept = est("A");
  const lost = est("C1") + est("C2") + est("U");
  const keptLo = c.A.N > 0 ? hyperLower(c.A.N, c.A.n, c.A.x, a) : 0;
  const lostHi = (["C1", "C2", "U"] as const).reduce(
    (s, h) => s + (c[h].N > 0 ? hyperUpper(c[h].N, c[h].n, c[h].x, a) : 0),
    0,
  );
  if (lostHi === 0) {
    // No legacy positive can have been lost (every lost-side stratum is empty
    // or censused with none): the rules keep all of legacy's real positives,
    // or legacy has none at all. Either way the claim holds (CODEX1 rev-24 P2-2).
    if (nonCensus === 0 && kept === 0)
      return { point: null, lower: null, note: NO_LEGACY_POSITIVES };
    return {
      point: kept > 0 ? 1 : null,
      lower: 1,
      note: kept > 0 ? null : "no legacy positive can be lost",
    };
  }
  return {
    point: kept + lost > 0 ? kept / (kept + lost) : null,
    lower: keptLo / (keptLo + lostHi),
    note: null,
  };
}

// ── gates: the stored JSON is the ONLY authority (CODEX1 rev-24 P1-1) ─────────
export interface GateSpec {
  version: 1;
  confidence: string;
  precision: { point_min: number; lower_min: number };
  retention: { lower_min: number };
  unsure: string;
  undefined: string;
  named_cases_must_not: string[];
}

/** The gates proposed to the owner; what gates a set is the JSON confirmed on it. */
export const PROPOSED_GATES: GateSpec = {
  version: 1,
  confidence: "one-sided 97.5% exact, Bonferroni across non-census strata",
  precision: { point_min: 0.95, lower_min: 0.85 },
  retention: { lower_min: 0.9 },
  unsure: "worst case per claim",
  undefined: "fails, except retention when no legacy positive can be lost",
  named_cases_must_not: ["amekes", "egygoo", "osprey"],
};

const unit = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Validate a stored gate JSON exactly; throws on any deviation. */
export function parseGates(raw: unknown): GateSpec {
  const g = raw as Record<string, unknown>;
  const keys = [
    "version",
    "confidence",
    "precision",
    "retention",
    "unsure",
    "undefined",
    "named_cases_must_not",
  ];
  if (!g || typeof g !== "object" || Array.isArray(g))
    throw new Error("gates: not an object");
  if (Object.keys(g).sort().join() !== [...keys].sort().join())
    throw new Error("gates: wrong keys");
  if (g.version !== 1) throw new Error("gates: unsupported version");
  const p = g.precision as Record<string, unknown>;
  const r = g.retention as Record<string, unknown>;
  if (
    !p ||
    Object.keys(p).sort().join() !== "lower_min,point_min" ||
    !unit(p.point_min) ||
    !unit(p.lower_min)
  )
    throw new Error("gates: bad precision thresholds");
  if (!r || Object.keys(r).join() !== "lower_min" || !unit(r.lower_min))
    throw new Error("gates: bad retention threshold");
  if (
    !Array.isArray(g.named_cases_must_not) ||
    !g.named_cases_must_not.every(
      (c) => typeof c === "string" && /^[a-z0-9]{3,12}$/.test(c),
    )
  )
    throw new Error("gates: bad named cases");
  for (const k of ["confidence", "unsure", "undefined"])
    if (typeof g[k] !== "string") throw new Error(`gates: bad ${k}`);
  return g as unknown as GateSpec;
}

export interface GateDecision {
  precisionOk: boolean;
  retentionOk: boolean;
  /** must-not named cases the staged rules assign (each one fails the gate). */
  namedCaseViolations: string[];
  passed: boolean;
}

/**
 * The single pass decision: the stored gate JSON, both claims, and the
 * must-not named cases (codes the revision assigns, from the staged states).
 */
export function evaluateGate(
  storedGates: unknown,
  precision: ClaimResult,
  retention: ClaimResult,
  assignedCodes: ReadonlySet<string>,
): GateDecision {
  const g = parseGates(storedGates);
  const precisionOk =
    precision.point != null &&
    precision.lower != null &&
    precision.point >= g.precision.point_min &&
    precision.lower >= g.precision.lower_min;
  const retentionOk =
    retention.note === NO_LEGACY_POSITIVES ||
    (retention.lower != null && retention.lower >= g.retention.lower_min);
  const namedCaseViolations = g.named_cases_must_not.filter((c) =>
    assignedCodes.has(c),
  );
  return {
    precisionOk,
    retentionOk,
    namedCaseViolations,
    passed: precisionOk && retentionOk && namedCaseViolations.length === 0,
  };
}

// ── sizing: the same exact bounds, on expected counts ───────────────────────
export const RATE_GRID: Record<Stratum, number[]> = {
  A: [0.85, 0.95],
  B: [0.4, 0.7, 0.9],
  C1: [0.3, 0.6],
  C2: [0.02, 0.1, 0.25],
  U: [0.1, 0.4],
};
/** Point-minus-lower gap the design must achieve in every scenario. */
// Expected-count precision-gap targets (not a power guarantee): precision 0.10, retention 0.07.
export const SIZING = {
  precisionGap: 0.1,
  retentionGap: 0.07,
  minPerStratum: 5,
  cap: 1000,
};

function scenarios(grid: Record<Stratum, number[]>): Record<Stratum, number>[] {
  let out: Record<string, number>[] = [{}];
  for (const h of STRATA)
    out = out.flatMap((s) => grid[h].map((p) => ({ ...s, [h]: p })));
  return out as Record<Stratum, number>[];
}

/** Worst point-minus-lower gaps over the grid, for sample sizes ns (expected counts x = round(p·n)). */
export function worstGaps(
  Ns: Record<Stratum, number>,
  ns: Record<Stratum, number>,
  grid = RATE_GRID,
) {
  let precisionGap = 0;
  let retentionGap = 0;
  for (const p of scenarios(grid)) {
    const c = Object.fromEntries(
      STRATA.map((h) => [
        h,
        { N: Ns[h], n: ns[h], x: Math.round(p[h] * ns[h]) },
      ]),
    ) as Counts;
    const pr = precisionFromCounts(c);
    const rt = retentionFromCounts(c);
    if (Ns.A + Ns.B > 0)
      precisionGap = Math.max(
        precisionGap,
        pr.point == null || pr.lower == null ? Infinity : pr.point - pr.lower,
      );
    if (rt.note !== NO_LEGACY_POSITIVES && Ns.A + Ns.C1 + Ns.C2 + Ns.U > 0)
      retentionGap = Math.max(
        retentionGap,
        rt.point == null || rt.lower == null ? Infinity : rt.point - rt.lower,
      );
  }
  return { precisionGap, retentionGap };
}

export interface SizingResult {
  n: Record<Stratum, number>;
  total: number;
  feasible: boolean;
  worstPrecisionGap: number;
  worstRetentionGap: number;
  scenarios: number;
}

export function sizeDesign(
  Ns: Record<Stratum, number>,
  grid = RATE_GRID,
): SizingResult {
  const n = Object.fromEntries(
    STRATA.map((h) => [h, Math.min(Ns[h], SIZING.minPerStratum)]),
  ) as Record<Stratum, number>;
  const excess = (g: { precisionGap: number; retentionGap: number }) =>
    Math.max(0, g.precisionGap - SIZING.precisionGap) +
    Math.max(0, g.retentionGap - SIZING.retentionGap);
  let cur = worstGaps(Ns, n, grid);
  const total = () => STRATA.reduce((a, h) => a + n[h], 0);
  while (excess(cur) > 0 && total() < SIZING.cap) {
    let best: Stratum | null = null;
    let bestG = cur;
    for (const h of STRATA) {
      if (n[h] >= Ns[h]) continue;
      n[h]++;
      const g = worstGaps(Ns, n, grid);
      n[h]--;
      if (excess(g) < excess(bestG) - 1e-12) {
        best = h;
        bestG = g;
      }
    }
    if (!best) {
      // No single unit helps (bounds move in integer steps): add to the stratum
      // with the most unsampled units; ties in stratum order.
      const open = STRATA.filter((h) => n[h] < Ns[h]).sort(
        (a, b) => Ns[b] - n[b] - (Ns[a] - n[a]),
      );
      if (!open.length) break;
      n[open[0]]++;
      cur = worstGaps(Ns, n, grid);
      continue;
    }
    n[best]++;
    cur = bestG;
  }
  return {
    n,
    total: total(),
    feasible: excess(cur) <= 0,
    worstPrecisionGap: cur.precisionGap,
    worstRetentionGap: cur.retentionGap,
    scenarios: scenarios(grid).length,
  };
}

// ── seeded PRNG (synthetic tests only; real sampling uses HMAC ranks) ─────────
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Blind-test sampling and the gate report (td-894144 Release B4, plan rev 25
 * §B4g2, §B4i).
 *
 * Sampling runs in ONE REPEATABLE READ transaction: read the frame, rank each
 * stratum by sha256(seed|v1|tag|revision|stratum|code) (ties by code), take
 * the first n_h, and hand the set to create_tag_eval_set — which recomputes
 * the frame AND the ranked selection itself and refuses any difference (no
 * operator substitution). Only the display fields (masked text snapshot,
 * display order, eval_text_hash) come from here.
 */
import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction } from "$lib/db";
import { buildFrame, type EvalFrame, type FrameRow } from "./eval-frame";
import { tagEvalDesign } from "./eval-design";
import {
  STRATA,
  evaluateGate,
  parseGates,
  precisionClaim,
  retentionClaim,
  type Design,
  type EvalObservation,
  type Label,
  type RulesStatus,
  type Stratum,
} from "./eval-stats";

export const SAMPLE_ALGORITHM = "sha256-rank-v1";

/** The owner-facing hard stop when frame families lack a Wikipedia reference (plan §4). */
export function missingReferencesMessage(
  missing: readonly { familyCode: string; family: string; species: number }[],
): string {
  const species = missing.reduce((a, m) => a + m.species, 0);
  const names = missing.slice(0, 12).map((m) => m.family).join(", ");
  return `${species} species in ${missing.length} famil${missing.length === 1 ? "y have" : "ies have"} no family article yet (${names}${missing.length > 12 ? ", …" : ""}) — press "Fetch family articles" first`;
}

const sha256 = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** The rank key, byte-identical to create_tag_eval_set's SQL. */
export function rankKey(
  seed: string,
  tag: string,
  revisionId: string,
  stratum: string,
  code: string,
): string {
  return sha256(`${seed}|v1|${tag}|${revisionId}|${stratum}|${code}`);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Per stratum, the first n_h frame members by rank (ties by code). */
export function selectSample(
  frame: EvalFrame,
  n: Record<Stratum, number>,
  seed: string,
): FrameRow[] {
  const out: FrameRow[] = [];
  for (const h of STRATA) {
    const members = frame.rows
      .filter((r) => r.stratum === h)
      .map((r) => ({
        r,
        k: rankKey(seed, frame.tag, frame.revisionId, h, r.code),
      }))
      .sort((a, b) => cmp(a.k, b.k) || cmp(a.r.code, b.r.code));
    if (n[h] > members.length)
      throw new Error(
        `stratum ${h}: n = ${n[h]} exceeds N = ${members.length}`,
      );
    out.push(...members.slice(0, n[h]).map((m) => m.r));
  }
  return out;
}

export interface CreateEvalSetInput {
  tag: string;
  revisionId: string;
  n: Record<Stratum, number>;
  /** The simulation report's frame hash: sampling refuses any drift. */
  expectedFrameHash: string;
  /** The exact gate JSON the owner confirmed. */
  gates: unknown;
  userId: number;
  /** Extra design fields to record (simulation report id, owner's >250 acceptance). */
  designExtra?: Record<string, unknown>;
  /** Tests only: a fixed seed. Production draws 32 crypto bytes. */
  seed?: string;
}

export async function createEvalSet(
  input: CreateEvalSetInput,
): Promise<{ setId: string; items: number; seed: string }> {
  const design = tagEvalDesign(input.tag);
  if (!design) throw new Error(`no evaluation design for ${input.tag}`);
  parseGates(input.gates);
  const seed = input.seed ?? randomBytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("seed must be 64 hex");
  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const exec = ((text: string, params?: unknown[]) =>
      client.query(text, params as never[])) as never;
    const frame = await buildFrame(input.tag, input.revisionId, exec);
    if (frame.missingStates > 0)
      throw new Error(
        `${frame.missingStates} species have no current result for this revision — run the stage report first`,
      );
    if (frame.missingReferences.length > 0)
      throw new Error(missingReferencesMessage(frame.missingReferences));
    if (frame.frameHash !== input.expectedFrameHash)
      throw new Error(
        "The species set changed since the design was computed — run the design again.",
      );
    const picked = selectSample(frame, input.n, seed);
    // Display order: a second, independent keyed shuffle, so strata interleave.
    const display = [...picked].sort((a, b) =>
      cmp(
        sha256(`${seed}|display|${a.code}`),
        sha256(`${seed}|display|${b.code}`),
      ),
    );
    const items = display.map((r, i) => ({
      species_code: r.code,
      stratum: r.stratum,
      rules_yes: r.rulesYes,
      legacy_yes: r.legacyYes,
      rules_status: r.status,
      marine: r.marine,
      display_position: i + 1,
      eval_text_hash: r.evalTextHash,
      article: r.evalText,
      family_reference: r.familyReference,
    }));
    const designJson = {
      ...(input.designExtra ?? {}),
      algorithm: SAMPLE_ALGORITHM,
      seed,
      designHash: frame.designHash,
      frameHash: frame.frameHash,
      marineOrders: [...design.marineOrders],
      cueWords: [...design.cueWords],
      // The question is frozen with the set: the page always asks what this test asked.
      question: design.question,
      N: frame.N,
      n: input.n,
      // π_h and the selection, recorded and re-verified by the definer (CODEX1 rev-26 #4).
      pi: Object.fromEntries(
        Object.entries(frame.N)
          .filter(([, N]) => N > 0)
          .map(([h, N]) => [h, input.n[h as keyof typeof input.n] / N]),
      ),
      selectedCodes: picked.map((r) => r.code).sort(),
      noLegacyBaseline: frame.noLegacyBaseline,
    };
    const r = await client.query<{ id: string }>(
      "SELECT public.create_tag_eval_set($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)::text AS id",
      [
        input.tag,
        input.revisionId,
        JSON.stringify(designJson),
        JSON.stringify(items),
        JSON.stringify(input.gates),
        input.userId,
      ],
    );
    return { setId: r.rows[0].id, items: items.length, seed };
  });
}

// ── the gate report ─────────────────────────────────────────────────────────

export interface GateReportBody {
  passed: boolean;
  setId: string;
  gatesSha256: string;
  frameHash: string;
  precision: ReturnType<typeof precisionClaim>;
  retention: ReturnType<typeof retentionClaim>;
  precisionOk: boolean;
  retentionOk: boolean;
  namedCaseViolations: string[];
  namedCases: {
    code: string;
    name: string;
    expect: string;
    assigned: boolean;
    gating: boolean;
  }[];
  labels: Record<Label, number>;
  /** Answers by how they were given: "page", or "taxon:<rank>:<value>" (0076). */
  labelBasis: Record<string, number>;
  n: Record<Stratum, number>;
  N: Record<Stratum, number>;
}

/** Compute (not record) the gate for a FROZEN set, from the stored gate JSON only. */
export async function computeGate(
  setId: string,
): Promise<{ tag: string; revisionId: string; body: GateReportBody }> {
  const set = (
    await query<{
      tag: string;
      revision_id: string;
      status: string;
      design: {
        N: Record<Stratum, number>;
        n: Record<Stratum, number>;
        frameHash: string;
      };
      gates: unknown;
      gates_sha256: string;
    }>(
      "SELECT tag, revision_id::text, status, design, gates, gates_sha256 FROM tag_eval_set WHERE id = $1",
      [setId],
    )
  ).rows[0];
  if (!set) throw new Error(`no eval set ${setId}`);
  if (set.status !== "frozen")
    throw new Error(`eval set ${setId} is ${set.status}, not frozen`);
  const rows = (
    await query<{
      species_code: string;
      stratum: Stratum;
      rules_yes: boolean;
      legacy_yes: boolean;
      rules_status: RulesStatus;
      marine: boolean;
      label: Label | null;
      basis: string | null;
    }>(
      // An item is answered by its set's taxon confirmation (0076, always yes)
      // or by its page label; the two never coexist from the same set.
      `SELECT i.species_code, i.stratum, i.rules_yes, i.legacy_yes, i.rules_status, i.marine,
              CASE WHEN ta.item_id IS NOT NULL THEN 'yes' ELSE l.label END AS label,
              CASE WHEN ta.item_id IS NOT NULL THEN 'taxon:' || ta.taxon
                   WHEN l.id IS NOT NULL THEN 'page' END AS basis
         FROM tag_eval_item i
         LEFT JOIN tag_eval_label l
           ON l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
         LEFT JOIN tag_eval_taxon_answer ta ON ta.item_id = i.id
        WHERE i.set_id = $1`,
      [setId, set.tag],
    )
  ).rows;
  if (rows.some((r) => r.label == null))
    throw new Error("a frozen set has an unlabelled item (integrity)");
  const obs: EvalObservation[] = rows.map((r) => ({
    code: r.species_code,
    stratum: r.stratum,
    rulesYes: r.rules_yes,
    legacyYes: r.legacy_yes,
    status: r.rules_status,
    marine: r.marine,
    label: r.label!,
  }));
  const d = Object.fromEntries(
    STRATA.map((h) => [
      h,
      { N: set.design.N[h] ?? 0, n: set.design.n[h] ?? 0 },
    ]),
  ) as Design;
  const precision = precisionClaim(obs, d);
  const retention = retentionClaim(obs, d);
  const gates = parseGates(set.gates);
  const design = tagEvalDesign(set.tag);
  const named = [
    ...new Set([
      ...gates.named_cases_must_not,
      ...(design?.namedCases.map((c) => c.code) ?? []),
    ]),
  ];
  const assigned = new Set(
    (
      await query<{ code: string }>(
        `SELECT s.species_code AS code
           FROM species_tag_state s
           JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
          WHERE s.tag = $1 AND s.revision_id = $2 AND s.status = 'assigned' AND s.species_code = ANY ($3::text[])`,
        [set.tag, set.revision_id, named],
      )
    ).rows.map((r) => r.code),
  );
  const decision = evaluateGate(set.gates, precision, retention, assigned);
  const labels = { yes: 0, no: 0, unsure: 0 } as Record<Label, number>;
  for (const o of obs) labels[o.label]++;
  // How each answer was given: on its page, or by a whole-taxon confirmation (0076).
  const labelBasis: Record<string, number> = {};
  for (const r of rows) labelBasis[r.basis ?? "page"] = (labelBasis[r.basis ?? "page"] ?? 0) + 1;
  return {
    tag: set.tag,
    revisionId: set.revision_id,
    body: {
      passed: decision.passed,
      setId,
      gatesSha256: set.gates_sha256,
      frameHash: set.design.frameHash,
      precision,
      retention,
      precisionOk: decision.precisionOk,
      retentionOk: decision.retentionOk,
      namedCaseViolations: decision.namedCaseViolations,
      namedCases: named.map((code) => {
        const c = design?.namedCases.find((x) => x.code === code);
        return {
          code,
          name: c?.name ?? code,
          expect: gates.named_cases_must_not.includes(code)
            ? "no"
            : (c?.expect ?? "—"),
          assigned: assigned.has(code),
          gating: gates.named_cases_must_not.includes(code),
        };
      }),
      labels,
      labelBasis,
      n: set.design.n,
      N: set.design.N,
    },
  };
}

/** Record the gate report (the DB trigger re-checks set, status and gates hash). */
export async function recordGateReport(
  setId: string,
): Promise<{ reportId: string; passed: boolean }> {
  const g = await computeGate(setId);
  const id = (
    await query<{ id: string }>(
      "SELECT public.record_tag_report('gate', $1, $2, $3::jsonb)::text AS id",
      [g.tag, g.revisionId, JSON.stringify(g.body)],
    )
  ).rows[0].id;
  return { reportId: id, passed: g.body.passed };
}

/**
 * The evaluation frame for one tag revision (td-894144 Release B4, plan rev
 * 25 §B4d). Read-only.
 *
 * Frame = universe members with a CURRENT state for the revision (joined
 * through species_tag_input) that the rules OR the displayed legacy value
 * tag. Strata: A rules∧legacy · B rules∧¬legacy · C1/C2 legacy ∧ rules
 * not_assigned (marine / non-marine) · U legacy ∧ rules unevaluated.
 * Species neither system tags are outside every gate claim.
 *
 * The frame hash fingerprints exactly what a sample is drawn from (see
 * canonicalFrameHash). Any change in membership, article/names (input_hash),
 * rules result or design changes it. Each row also carries eval_text_hash,
 * the label identity of the page the labeller reads.
 */
import { createHash } from "node:crypto";
import { query } from "$lib/db";
import { designHash, evaluatorHash, tagEvalDesign } from "./eval-design";
import {
  STRATA,
  stratumOf,
  type RulesStatus,
  type Stratum,
} from "./eval-stats";
import {
  buildEvalText,
  type EvalSection,
  type FamilyReferenceSnapshot,
} from "./eval-text";

export interface FrameRow {
  code: string;
  stratum: Stratum;
  inputHash: string;
  rulesYes: boolean;
  legacyYes: boolean;
  status: RulesStatus;
  marine: boolean;
  /** The names masked out of the page — bound into the frame hash (CODEX1 rev-25 P1-1). */
  comName: string;
  sciName: string;
  evalTextHash: string;
  evalText: EvalSection[];
  /** taxonomy_cache.family_code and its reference hash ("" when none) — in the frame bytes (v2). */
  familyCode: string;
  referenceSha: string;
  familyReference: FamilyReferenceSnapshot | null;
}

/**
 * The frame hash byte contract (plan rev 26 §B4i; v2 td-894144 B5 §4),
 * mirrored exactly by the SQL function tag_eval_frame_hash: "tagframe-v2|" +
 * design hash + "|", then per row in species_code order (codes are ASCII, so
 * JS order = COLLATE "C"):
 *   len:code|len:stratum|len:input_hash|len:com_name|len:sci_name|r|l|len:family_code|len:reference_sha|
 * lengths in UTF-8 octets, r/l as 0/1, missing names as "". SHA-256 of the
 * UTF-8 bytes. Together with input_hash (whose text_hash covers the
 * normalized article the page is built from) and the design hash (renderer
 * version, deny list, cue words), this binds everything eval_text_hash
 * depends on, so a page change can never keep an old frame hash.
 */
export function canonicalFrameHash(
  designSha: string,
  rows: readonly {
    code: string;
    stratum: string;
    inputHash: string;
    comName: string;
    sciName: string;
    rulesYes: boolean;
    legacyYes: boolean;
    familyCode: string;
    referenceSha: string;
  }[],
): string {
  const lp = (v: string) => `${Buffer.byteLength(v, "utf8")}:${v}`;
  const sorted = [...rows].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  for (const r of sorted)
    if (!/^[\x20-\x7e]+$/.test(r.code))
      throw new Error(`non-ASCII species code ${r.code}`);
  const body = sorted
    .map(
      (r) =>
        `${lp(r.code)}|${lp(r.stratum)}|${lp(r.inputHash)}|${lp(r.comName)}|${lp(r.sciName)}|${r.rulesYes ? 1 : 0}|${r.legacyYes ? 1 : 0}|${lp(r.familyCode)}|${lp(r.referenceSha)}|`,
    )
    .join("");
  return createHash("sha256")
    .update(`tagframe-v2|${designSha}|${body}`, "utf8")
    .digest("hex");
}

export interface EvalFrame {
  tag: string;
  revisionId: string;
  rows: FrameRow[];
  N: Record<Stratum, number>;
  frameHash: string;
  designHash: string;
  /** Frame species whose legacy baseline is NULL (they display no tag today). */
  noLegacyBaseline: number;
  /** Universe members without a current state for the revision — must be 0 (stage first). */
  missingStates: number;
  /** Frame families with no usable Wikipedia reference — must be empty (hard stop, plan §4). */
  missingReferences: { familyCode: string; family: string; species: number }[];
}

type Exec = <T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;
const poolExec: Exec = (text, params) => query(text, params) as never;

/**
 * Build the frame. Pass `exec` to read inside a caller's transaction (the
 * sampling job reads the frame and inserts the set in ONE REPEATABLE READ
 * snapshot, so the DB's own recomputation sees the same frame).
 */
export async function buildFrame(
  tag: string,
  revisionId: string,
  exec: Exec = poolExec,
): Promise<EvalFrame> {
  const design = tagEvalDesign(tag);
  if (!design) throw new Error(`no evaluation design for ${tag}`);
  const missing = Number(
    (
      await exec<{ n: string }>(
        `SELECT count(*)::text AS n
				   FROM public.tag_universe_codes() u(code)
				   LEFT JOIN species_tag_input i ON i.species_code = u.code
				   LEFT JOIN species_tag_state s
				     ON s.species_code = u.code AND s.tag = $1 AND s.revision_id = $2 AND s.input_hash = i.input_hash
				  WHERE s.state_id IS NULL`,
        [tag, revisionId],
      )
    ).rows[0].n,
  );
  const raw = (
    await exec<{
      code: string;
      status: string;
      input_hash: string;
      legacy_yes: boolean;
      no_baseline: boolean;
      order_name: string | null;
      com_name: string | null;
      sci_name: string | null;
      family_code: string | null;
      family_sci_name: string | null;
      ref_title: string | null;
      ref_rev_id: string | null;
      ref_lead: string | null;
      reference_sha: string | null;
      wikipedia_extract: string | null;
      wikipedia_sections: EvalSection[] | null;
    }>(
      `SELECT u.code, s.status, i.input_hash,
			        coalesce($1 = ANY (se.legacy_tags), false) AS legacy_yes,
			        se.legacy_tags IS NULL AS no_baseline,
			        tc.order_name, tc.com_name, tc.sci_name, tc.family_code, tc.family_sci_name,
			        fr.wiki_title AS ref_title, fr.rev_id::text AS ref_rev_id, fr.lead AS ref_lead, fr.reference_sha,
			        se.wikipedia_extract, se.wikipedia_sections
			   FROM public.tag_universe_codes() u(code)
			   JOIN species_tag_input i ON i.species_code = u.code
			   JOIN species_tag_state s
			     ON s.species_code = u.code AND s.tag = $1 AND s.revision_id = $2 AND s.input_hash = i.input_hash
			   JOIN species_enrichment se ON se.species_code = u.code
			   JOIN taxonomy_cache tc ON tc.species_code = u.code
			   LEFT JOIN tag_family_reference fr ON fr.family_code = tc.family_code AND fr.status = 'ok'
			  WHERE s.status = 'assigned' OR coalesce($1 = ANY (se.legacy_tags), false)
			  ORDER BY u.code`,
      [tag, revisionId],
    )
  ).rows;
  const marine = new Set(design.marineOrders);
  const evaluator = evaluatorHash(tag);
  const rows: FrameRow[] = raw.map((r) => {
    const status = r.status as RulesStatus;
    const isMarine = !!r.order_name && marine.has(r.order_name);
    const stratum = stratumOf(status, r.legacy_yes, isMarine);
    if (!stratum) throw new Error(`frame: ${r.code} belongs to no stratum`);
    const reference =
      r.reference_sha && r.ref_title && r.ref_rev_id && r.ref_lead && r.family_code
        ? {
            familyCode: r.family_code,
            title: r.ref_title,
            revId: Number(r.ref_rev_id),
            lead: r.ref_lead,
          }
        : null;
    const text = buildEvalText(
      { extract: r.wikipedia_extract, sections: r.wikipedia_sections },
      { common: r.com_name, scientific: r.sci_name },
      design.cueWords,
      { evaluatorHash: evaluator, reference },
    );
    return {
      code: r.code,
      stratum,
      inputHash: r.input_hash,
      rulesYes: status === "assigned",
      legacyYes: r.legacy_yes,
      status,
      marine: isMarine,
      comName: r.com_name ?? "",
      sciName: r.sci_name ?? "",
      evalTextHash: text.hash,
      evalText: text.sections,
      familyCode: r.family_code ?? "",
      referenceSha: r.reference_sha ?? "",
      familyReference: text.reference,
    };
  });
  const missingByFamily = new Map<string, { family: string; species: number }>();
  for (const [i, r] of rows.entries())
    if (!r.referenceSha) {
      const key = r.familyCode || "(none)";
      const m = missingByFamily.get(key) ?? {
        family: raw[i].family_sci_name ?? key,
        species: 0,
      };
      m.species++;
      missingByFamily.set(key, m);
    }
  const N = Object.fromEntries(
    STRATA.map((h) => [h, rows.filter((r) => r.stratum === h).length]),
  ) as Record<Stratum, number>;
  const dHash = designHash(tag);
  const frameHash = canonicalFrameHash(dHash, rows);
  return {
    tag,
    revisionId,
    rows,
    N,
    frameHash,
    designHash: dHash,
    noLegacyBaseline: raw.filter((r) => r.no_baseline).length,
    missingStates: missing,
    missingReferences: [...missingByFamily.entries()]
      .map(([familyCode, v]) => ({ familyCode, ...v }))
      .sort((a, b) => (a.familyCode < b.familyCode ? -1 : a.familyCode > b.familyCode ? 1 : 0)),
  };
}

/**
 * `tag_draft_rules` worker job (td-894144 Release B4, plan rev 23 §B4a/B4b).
 *
 *  1. Freeze the tag's authoring set on first use (four cells of 12, see
 *     AUTHORING_CELLS) through the freeze_tag_authoring_set definer.
 *  2. Give the model each example's order, family and ≤ 6 cue sentences —
 *     never a legacy value or a label.
 *  3. Validate the model's JSON with the rules loader HERE (the AI module
 *     never sees the engine); one retry with the loader's error.
 *  4. Store a `proposed` row. AI output can only ever become a proposal.
 */
import { query } from "$lib/db";
import { ALL_TAGS, TAG_DEFINITIONS } from "$lib/species-tags";
import { meteredAiCall } from "$server/ai-call";
import { CONFIG_KEYS } from "$server/app-config";
import { DEFAULT_MODEL_IDS } from "$server/ai-models";
import {
  draftTagRules,
  TAG_DRAFT_TIMEOUT_MS,
  TagDraftAiError,
  type AuthoringExample,
} from "$server/ai-tag-draft";
import { sanitizeErrorText, type JobRow } from "$server/job-policy";
import { completeJob, failJob, recordEvent } from "$server/jobs";
import {
  designHash,
  EVAL_TEXT_DENY,
  tagEvalDesign,
} from "$server/tag-engine/eval-design";
import { cueRanges } from "$server/tag-engine/eval-text";
import { parseRuleset, RulesetError } from "$server/tag-engine/rules";
import { segmentArticle } from "$server/tag-engine/segment";

export const AUTHORING_PER_CELL = 12;
const MAX_CUE_SENTENCES = 6;

/** The four authoring cells (rev 23 §B4a); the last is the false-positive trap cell. */
const AUTHORING_CELLS = [
  { key: "legacy_yes_marine", legacy: true, marine: true, cue: null },
  { key: "legacy_yes_nonmarine", legacy: true, marine: false, cue: null },
  { key: "legacy_no_marine", legacy: false, marine: true, cue: null },
  { key: "legacy_no_nonmarine_cue", legacy: false, marine: false, cue: true },
] as const;

export function draftableTag(tag: string): boolean {
  return ALL_TAGS.has(tag) && !!TAG_DEFINITIONS[tag] && !!tagEvalDesign(tag);
}

/** Candidate authoring codes per cell (deterministic: md5(code‖tag) order). */
async function selectAuthoring(
  tag: string,
): Promise<{ codes: string[]; cells: Record<string, number> }> {
  const d = tagEvalDesign(tag)!;
  const cueRe = `\\m(${d.cueWords.map((w) => w.replace(/[^a-z]/gi, "")).join("|")})\\M`;
  const cells: Record<string, number> = {};
  const codes: string[] = [];
  for (const c of AUTHORING_CELLS) {
    const rows = (
      await query<{ code: string }>(
        `SELECT se.species_code AS code
				   FROM public.tag_universe_codes() u(code)
				   JOIN species_enrichment se ON se.species_code = u.code
				   JOIN taxonomy_cache tc ON tc.species_code = u.code
				  WHERE tc.order_name IS NOT NULL
				    AND (coalesce($2 = ANY (se.legacy_tags), false)) = $3
				    AND (tc.order_name = ANY ($4::text[])) = $5
				    AND ($6::boolean IS NULL OR
				         ((coalesce(se.wikipedia_extract, '') || ' ' || coalesce(se.wikipedia_sections::text, '')) ~* $7) = $6)
				  ORDER BY md5(se.species_code || $2)
				  LIMIT $1`,
        [
          AUTHORING_PER_CELL,
          tag,
          c.legacy,
          [...d.marineOrders],
          c.marine,
          c.cue,
          cueRe,
        ],
      )
    ).rows.map((r) => r.code);
    cells[c.key] = rows.length;
    codes.push(...rows);
  }
  return { codes, cells };
}

async function authoringExamples(
  tag: string,
  codes: readonly string[],
): Promise<AuthoringExample[]> {
  const d = tagEvalDesign(tag)!;
  const rows = (
    await query<{
      code: string;
      name: string;
      order_name: string | null;
      family_sci_name: string | null;
      wikipedia_extract: string | null;
      wikipedia_sections: { title: string; text: string }[] | null;
    }>(
      `SELECT se.species_code AS code, tc.com_name AS name, tc.order_name, tc.family_sci_name,
			        se.wikipedia_extract, se.wikipedia_sections
			   FROM species_enrichment se JOIN taxonomy_cache tc ON tc.species_code = se.species_code
			  WHERE se.species_code = ANY ($1::text[])
			  ORDER BY md5(se.species_code || $2)`,
      [codes, tag],
    )
  ).rows;
  return rows.map((r) => {
    const seg = segmentArticle(
      { extract: r.wikipedia_extract, sections: r.wikipedia_sections ?? [] },
      EVAL_TEXT_DENY,
    );
    const sentences: string[] = [];
    for (const s of seg.sections) {
      for (const sen of s.sentences) {
        const text = s.display.slice(sen.start, sen.end).trim();
        if (text && cueRanges(text, d.cueWords).length) sentences.push(text);
        if (sentences.length >= MAX_CUE_SENTENCES) break;
      }
      if (sentences.length >= MAX_CUE_SENTENCES) break;
    }
    return {
      name: r.name,
      order: r.order_name,
      family: r.family_sci_name,
      sentences,
    };
  });
}

async function isAdmin(userId: number): Promise<boolean> {
  return (
    (
      await query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
        userId,
      ])
    ).rows[0]?.role === "admin"
  );
}

export async function runTagDraftJob(job: JobRow): Promise<void> {
  const attempts = job.attempts;
  const tag = (job.payload as { tag?: unknown } | null)?.tag;
  if (typeof tag !== "string" || !draftableTag(tag)) {
    await failJob(
      job.id,
      attempts,
      "tag_draft_rules: the tag has no definition or evaluation design yet",
    );
    return;
  }
  await recordEvent(job.id, "claimed", { attempt: attempts, tag });
  if (!(await isAdmin(job.requested_by))) {
    await failJob(
      job.id,
      attempts,
      "tag_draft_rules: requester is no longer an admin",
    );
    return;
  }
  try {
    const candidates = await selectAuthoring(tag);
    const frozen = (
      await query<{ c: string }>(
        "SELECT c FROM public.freeze_tag_authoring_set($1, $2::text[]) c",
        [tag, candidates.codes],
      )
    ).rows.map((r) => r.c);
    const examples = await authoringExamples(tag, frozen);
    const attemptsLog: {
      loaderOk: boolean;
      loaderError: string | null;
      requestedModel: string;
      servedModel: string | null;
    }[] = [];
    let previousError: string | null = null;
    let proposalArtifact: unknown = null;
    for (let i = 0; i < 2 && proposalArtifact == null; i++) {
      const call = await meteredAiCall({
        purpose: "tag_draft",
        configKey: CONFIG_KEYS.enrichmentModel,
        defaultModelId: DEFAULT_MODEL_IDS.enrichment,
        jobId: job.id,
        timeoutMs: TAG_DRAFT_TIMEOUT_MS,
        run: async (model, signal) => {
          const { raw, envelope } = await draftTagRules(
            { tag, definition: TAG_DEFINITIONS[tag]!, examples, previousError },
            model,
            { signal },
          );
          return { result: raw, envelope };
        },
      });
      try {
        const rs = parseRuleset(call.result, ALL_TAGS);
        if (rs.tag !== tag)
          throw new RulesetError(`ruleset.tag must be ${tag}`);
        proposalArtifact = call.result;
        attemptsLog.push({
          loaderOk: true,
          loaderError: null,
          requestedModel: call.requestedModel,
          servedModel: call.servedModel,
        });
      } catch (e) {
        if (!(e instanceof RulesetError)) throw e;
        previousError = e.message;
        attemptsLog.push({
          loaderOk: false,
          loaderError: e.message,
          requestedModel: call.requestedModel,
          servedModel: call.servedModel,
        });
      }
    }
    const calls = (
      await query<{
        call_id: string;
        first_id: string;
      }>(
        `SELECT call_id, first_id::text FROM (
             SELECT DISTINCT ON (call_id) call_id::text, min(id) OVER (PARTITION BY call_id) AS first_id
               FROM ai_usage WHERE job_id = $1 AND purpose = 'tag_draft'
              ORDER BY call_id, id DESC
           ) c ORDER BY first_id::bigint`,
        [job.id],
      )
    ).rows;
    // A metering write is deliberately best-effort. Only associate ledger IDs
    // when every sequential call has one, so a missing receipt can never make
    // the successful proposal point at an earlier rejected attempt.
    const callsAligned = calls.length === attemptsLog.length;
    const attemptDetails = attemptsLog.map((attempt, i) => ({
      ...attempt,
      aiUsageCallId: callsAligned ? calls[i].call_id : null,
    }));
    const result = {
      tag,
      designHash: designHash(tag),
      authoring: { frozen: frozen.length, candidates: candidates.cells },
      attempts: attemptDetails,
    };
    if (proposalArtifact == null) {
      await failJob(
        job.id,
        attempts,
        `The AI draft failed validation twice: ${previousError}`,
        result,
      );
      return;
    }
    const successfulAttempt = attemptDetails.at(-1);
    const lastCall = successfulAttempt?.aiUsageCallId ?? null;
    const proposalId = (
      await query<{ id: string }>(
        `INSERT INTO tag_rule_proposal (tag, artifact, source, ai_usage_call_id)
				 VALUES ($1, $2::jsonb, 'ai', $3::uuid) RETURNING id::text`,
        [tag, JSON.stringify(proposalArtifact), lastCall],
      )
    ).rows[0].id;
    await completeJob(job.id, attempts, { ...result, proposalId });
  } catch (err) {
    const message =
      err instanceof TagDraftAiError
        ? err.message
        : sanitizeErrorText(
            err instanceof Error ? err.message : String(err),
          ).slice(0, 300);
    await failJob(job.id, attempts, message);
  }
}

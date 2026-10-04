/**
 * Read models + owner actions for the admin Tags tab (td-894144 Release B3,
 * plan "Admin Tags tab"). Reads are plain SELECTs as birds_app. Writes are
 * never done here directly: long or lock-holding work is ENQUEUED as a tag
 * job (tag-jobs.ts); the two instantaneous owner decisions (approve / reject
 * a proposal) call their definer routines. The admin route is the auth
 * boundary (Option A); user ids passed down are audit data.
 */
import { query } from "$lib/db";
import {
  ALL_TAGS,
  TAG_DIMENSIONS,
  TAG_VOCABULARY,
  type TagDimension,
} from "$lib/species-tags";
import { dedupKeys } from "$server/job-policy";
import { enqueueJob, type JobType } from "$server/jobs";
import { ensureTagRepairJob, tagRepairState } from "$server/tag-engine/repair";
import { TagTxRefusal, withTagWriteTx } from "$server/tag-engine/runtime";
import { parseRuleset, RulesetError } from "$server/tag-engine/rules";
import {
  checkTaxonRules,
  loadTaxonomyForCheck,
} from "$server/tag-engine/taxon-check";
import type { PreviewBody } from "$server/tag-engine/preview";
import { evalSections } from "$server/tag-engine/eval-text";
import { normalizeDisplay } from "$server/tag-engine/normalize";
import { runTagConsistencyNow } from "$server/tag-jobs";

// ── overview ──────────────────────────────────────────────────────────────

export interface TagOverviewRow {
  tag: string;
  dimension: TagDimension;
  value: string;
  owned: {
    revisionId: string;
    activatedAt: string;
    activatedBy: string | null;
  } | null;
  /** Species whose effective tags carry it now. */
  carrying: number;
  /** Owned tags only: current-state counts over the universe. */
  assigned: number | null;
  notAssigned: number | null;
  unevaluated: number | null;
  /** Universe members with no current state (reads as unknown). */
  unknown: number | null;
  lastActivation: { action: string; at: string } | null;
}

export interface TagsOverview {
  rows: TagOverviewRow[];
  universe: number;
  noLegacyBaseline: number;
}

export async function tagsOverview(): Promise<TagsOverview> {
  const [carrying, owned, states, last, universe, noLegacy] = await Promise.all(
    [
      query<{ tag: string; n: number }>(
        `SELECT t AS tag, count(*)::int AS n FROM species_enrichment se, unnest(se.tags) t GROUP BY t`,
      ),
      query<{
        tag: string;
        revision_id: string;
        activated_at: string;
        by: string | null;
      }>(
        `SELECT o.tag, a.revision_id::text, a.activated_at::text, u.display_name AS by
			   FROM tag_ownership o JOIN tag_activation a ON a.id = o.activation_id
			   LEFT JOIN users u ON u.id = a.activated_by`,
      ),
      query<{ tag: string; status: string; n: number }>(
        `SELECT o.tag, s.status, count(*)::int AS n
			   FROM tag_ownership o
			   JOIN tag_activation a ON a.id = o.activation_id
			   JOIN species_tag_state s ON s.tag = o.tag AND s.revision_id = a.revision_id
			   JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
			  GROUP BY o.tag, s.status`,
      ),
      query<{ tag: string; action: string; at: string }>(
        `SELECT DISTINCT ON (tag) tag, action, activated_at::text AS at
			   FROM tag_activation ORDER BY tag, id DESC`,
      ),
      query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.tag_universe_codes()",
      ),
      query<{ n: number }>(
        "SELECT count(*)::int AS n FROM species_enrichment WHERE legacy_tags IS NULL",
      ),
    ],
  );
  const carry = new Map(carrying.rows.map((r) => [r.tag, r.n]));
  const own = new Map(owned.rows.map((r) => [r.tag, r]));
  const lastBy = new Map(last.rows.map((r) => [r.tag, r]));
  const stateBy = new Map<string, Record<string, number>>();
  for (const r of states.rows)
    stateBy.set(r.tag, { ...(stateBy.get(r.tag) ?? {}), [r.status]: r.n });
  const U = universe.rows[0].n;
  const rows: TagOverviewRow[] = [];
  for (const dimension of TAG_DIMENSIONS)
    for (const value of TAG_VOCABULARY[dimension]) {
      const tag = `${dimension}:${value}`;
      const o = own.get(tag);
      const st = stateBy.get(tag) ?? {};
      const evaluated =
        (st.assigned ?? 0) + (st.not_assigned ?? 0) + (st.unevaluated ?? 0);
      const l = lastBy.get(tag);
      rows.push({
        tag,
        dimension,
        value,
        owned: o
          ? {
              revisionId: o.revision_id,
              activatedAt: o.activated_at,
              activatedBy: o.by,
            }
          : null,
        carrying: carry.get(tag) ?? 0,
        assigned: o ? (st.assigned ?? 0) : null,
        notAssigned: o ? (st.not_assigned ?? 0) : null,
        unevaluated: o ? (st.unevaluated ?? 0) : null,
        unknown: o ? Math.max(0, U - evaluated) : null,
        lastActivation: l ? { action: l.action, at: l.at } : null,
      });
    }
  return { rows, universe: U, noLegacyBaseline: noLegacy.rows[0].n };
}

// ── consistency + repair ─────────────────────────────────────────────────

export interface ConsistencyRunRow {
  id: string;
  startedAt: string;
  status: "clean" | "fixed" | "failed" | "deferred";
  checked: number;
  fixed: Record<string, number>;
  failures: { kind: string; detail: string }[];
  durationMs: number | null;
  bootstrap: boolean;
}

export interface TagsHealth {
  runs: ConsistencyRunRow[];
  nextRunAt: string | null;
  running: boolean;
  uncleared: { key: string; entryPoint: string; error: string; at: string }[];
  unclearedCount: number;
  repair: {
    pending: boolean;
    generation: string;
    repairedGeneration: string;
    job: {
      id: number;
      status: string;
      progress: { unitsDone?: number; unitsTotal?: number } | null;
    } | null;
  } | null;
}

export async function tagsHealth(limit = 10): Promise<TagsHealth> {
  const [runs, next, uncleared, count, repair] = await Promise.all([
    query<{
      id: string;
      started_at: string;
      status: ConsistencyRunRow["status"];
      checked: number;
      fixed_by_reason: Record<string, number>;
      failures: { kind: string; detail: string }[];
      duration_ms: number | null;
      bootstrap: boolean;
    }>(
      `SELECT id::text, started_at::text, status, checked, fixed_by_reason, failures, duration_ms,
			        coalesce((details->>'bootstrap')::boolean, false) AS bootstrap
			   FROM tag_consistency_run ORDER BY id DESC LIMIT $1`,
      [limit],
    ),
    query<{ status: string; next_retry_at: string | null }>(
      `SELECT status, next_retry_at::text FROM jobs
			  WHERE dedup_key = $1 AND status IN ('pending', 'running') ORDER BY id DESC LIMIT 1`,
      [dedupKeys.tagConsistency()],
    ),
    query<{ key: string; entry_point: string; error: string; at: string }>(
      `SELECT key, entry_point, error, last_failed_at::text AS at FROM tag_materialization_failure
			  WHERE cleared_at IS NULL ORDER BY last_failed_at DESC NULLS LAST LIMIT 10`,
    ),
    query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tag_materialization_failure WHERE cleared_at IS NULL",
    ),
    tagRepairState(),
  ]);
  let job: NonNullable<TagsHealth["repair"]>["job"] = null;
  if (repair?.pending) {
    const j = (
      await query<{
        id: number;
        status: string;
        progress: { unitsDone?: number; unitsTotal?: number } | null;
      }>(
        `SELECT id, status, progress FROM jobs WHERE type = 'tag_repair' AND dedup_key = $1
				  ORDER BY id DESC LIMIT 1`,
        [`tag_repair:g${repair.repairGeneration}`],
      )
    ).rows[0];
    job = j ?? null;
  }
  return {
    runs: runs.rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      status: r.status,
      checked: r.checked,
      fixed: r.fixed_by_reason,
      failures: r.failures,
      durationMs: r.duration_ms,
      bootstrap: r.bootstrap,
    })),
    nextRunAt:
      next.rows[0]?.status === "pending" ? next.rows[0].next_retry_at : null,
    running: next.rows[0]?.status === "running",
    uncleared: uncleared.rows.map((r) => ({
      key: r.key,
      entryPoint: r.entry_point,
      error: r.error,
      at: r.at,
    })),
    unclearedCount: count.rows[0].n,
    repair: repair
      ? {
          pending: repair.pending,
          generation: repair.repairGeneration.toString(),
          repairedGeneration: repair.repairedGeneration.toString(),
          job,
        }
      : null,
  };
}

// ── one tag ───────────────────────────────────────────────────────────────

export interface TagDetail {
  tag: string;
  owned: { activationId: string; revisionId: string } | null;
  history: {
    id: string;
    action: string;
    revisionId: string | null;
    at: string;
    by: string | null;
    gateReportId: string | null;
    benchmarkReportId: string | null;
  }[];
  revisions: {
    id: string;
    approvedAt: string;
    by: string | null;
    artifact: unknown;
    source: string;
  }[];
  proposals: {
    id: string;
    status: string;
    source: string;
    createdAt: string;
    artifact: unknown;
    sha: string;
    schemaVersion: number;
    crosscheck: {
      reviewer: string;
      verdict: string;
      text: string;
      matches: boolean;
      at: string;
      /** The Preview this cross-check reviewed, and whether it is still the current one. */
      previewId: string | null;
      previewCurrent: boolean;
    } | null;
    /** The newest completed Preview of this exact artifact, and whether it is current (plan §3d). */
    preview: {
      id: string;
      at: string;
      current: boolean;
      body: PreviewBody;
    } | null;
  }[];
  reports: {
    id: string;
    kind: string;
    revisionId: string | null;
    at: string;
    body: Record<string, unknown>;
  }[];
  jobs: {
    id: number;
    type: string;
    status: string;
    enqueuedAt: string;
    error: string | null;
    result: unknown;
  }[];
  samples: {
    assigned: {
      code: string;
      name: string | null;
      evidence: { sentence?: string; section?: string } | null;
    }[];
    notAssigned: { code: string; name: string | null; reason: string | null }[];
  };
}

export async function tagDetail(tag: string): Promise<TagDetail | null> {
  if (!ALL_TAGS.has(tag)) return null;
  const [owned, history, revisions, proposals, reports, jobs] =
    await Promise.all([
      query<{ activation_id: string; revision_id: string }>(
        `SELECT o.activation_id::text, a.revision_id::text FROM tag_ownership o
			   JOIN tag_activation a ON a.id = o.activation_id WHERE o.tag = $1`,
        [tag],
      ),
      query<{
        id: string;
        action: string;
        revision_id: string | null;
        at: string;
        by: string | null;
        gate: string | null;
        bench: string | null;
      }>(
        `SELECT a.id::text, a.action, a.revision_id::text, a.activated_at::text AS at, u.display_name AS by,
			        a.gate_report_id::text AS gate, a.benchmark_report_id::text AS bench
			   FROM tag_activation a LEFT JOIN users u ON u.id = a.activated_by
			  WHERE a.tag = $1 ORDER BY a.id DESC LIMIT 50`,
        [tag],
      ),
      query<{
        id: string;
        approved_at: string;
        by: string | null;
        artifact: unknown;
        source: string;
      }>(
        `SELECT r.id::text, r.approved_at::text, u.display_name AS by, r.artifact, r.source
			   FROM tag_revision r LEFT JOIN users u ON u.id = r.approved_by
			  WHERE r.tag = $1 ORDER BY r.id DESC LIMIT 20`,
        [tag],
      ),
      query<{
        id: string;
        status: string;
        source: string;
        created_at: string;
        artifact: unknown;
        sha: string;
        schema_version: number;
        reviewer: string | null;
        verdict: string | null;
        text: string | null;
        reviewed_sha256: string | null;
        checked_at: string | null;
        check_preview_id: string | null;
        pv_id: string | null;
        pv_at: string | null;
        pv_current: boolean | null;
        pv_body: PreviewBody | null;
      }>(
        // The corpus fingerprint is computed ONCE (it covers ~11k inputs).
        `WITH now_fp AS MATERIALIZED (SELECT public.tag_corpus_fingerprint() AS fp),
		      d AS (SELECT design_hash FROM tag_preview_design WHERE tag = $1)
		 SELECT p.id::text, p.status, p.source, p.created_at::text, p.artifact, p.artifact_sha256 AS sha,
			        p.schema_version,
			        c.reviewer, c.verdict, c.text, c.reviewed_sha256, c.created_at::text AS checked_at,
			        c.preview_id::text AS check_preview_id,
			        pv.id::text AS pv_id, pv.created_at::text AS pv_at, pv.body AS pv_body,
			        (pv.corpus_fingerprint = (SELECT fp FROM now_fp)
			         AND pv.preview_design_hash = (SELECT design_hash FROM d)) AS pv_current
			   FROM tag_rule_proposal p
			   LEFT JOIN LATERAL (
			     SELECT * FROM tag_crosscheck c WHERE c.proposal_id = p.id ORDER BY c.id DESC LIMIT 1) c ON true
			   LEFT JOIN LATERAL (
			     SELECT * FROM tag_proposal_preview pv
			      WHERE pv.proposal_id = p.id AND pv.artifact_sha256 = p.artifact_sha256
			      ORDER BY pv.id DESC LIMIT 1) pv ON true
			  WHERE p.tag = $1 ORDER BY p.created_at DESC LIMIT 20`,
        [tag],
      ),
      query<{
        id: string;
        kind: string;
        revision_id: string | null;
        at: string;
        body: Record<string, unknown>;
      }>(
        `SELECT id::text, kind, revision_id::text, created_at::text AS at, body
			   FROM tag_report WHERE tag = $1 ORDER BY id DESC LIMIT 30`,
        [tag],
      ),
      query<{
        id: number;
        type: string;
        status: string;
        enqueued_at: string;
        error: string | null;
        result: unknown;
      }>(
        `SELECT id, type, status, enqueued_at::text, error, result FROM jobs
			  WHERE (type IN ('tag_stage', 'tag_benchmark', 'tag_activate', 'tag_retire', 'tag_rollback',
			                  'tag_draft_rules', 'tag_design_simulation', 'tag_eval_create', 'tag_gate_report',
			                  'tag_preview')
			         AND payload->>'tag' = $1)
			     OR type = 'tag_family_refs'
			  ORDER BY id DESC LIMIT 10`,
        [tag],
      ),
    ]);
  const o = owned.rows[0] ?? null;
  const sampleRevision = o?.revision_id ?? revisions.rows[0]?.id ?? null;
  let samples: TagDetail["samples"] = { assigned: [], notAssigned: [] };
  if (sampleRevision) {
    const [a, n] = await Promise.all([
      query<{
        code: string;
        name: string | null;
        evidence: { sentence?: string; section?: string } | null;
      }>(
        `SELECT s.species_code AS code, tc.com_name AS name, s.evidence -> 0 AS evidence
				   FROM species_tag_state s
				   JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
				   LEFT JOIN taxonomy_cache tc ON tc.species_code = s.species_code
				  WHERE s.tag = $1 AND s.revision_id = $2 AND s.status = 'assigned'
				  ORDER BY md5(s.species_code) LIMIT 10`,
        [tag, sampleRevision],
      ),
      query<{ code: string; name: string | null; reason: string | null }>(
        `SELECT s.species_code AS code, tc.com_name AS name, s.reason
				   FROM species_tag_state s
				   JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
				   LEFT JOIN taxonomy_cache tc ON tc.species_code = s.species_code
				  WHERE s.tag = $1 AND s.revision_id = $2 AND s.status <> 'assigned'
				  ORDER BY md5(s.species_code) LIMIT 10`,
        [tag, sampleRevision],
      ),
    ]);
    samples = { assigned: a.rows, notAssigned: n.rows };
  }
  return {
    tag,
    owned: o
      ? { activationId: o.activation_id, revisionId: o.revision_id }
      : null,
    history: history.rows.map((h) => ({
      id: h.id,
      action: h.action,
      revisionId: h.revision_id,
      at: h.at,
      by: h.by,
      gateReportId: h.gate,
      benchmarkReportId: h.bench,
    })),
    revisions: revisions.rows.map((r) => ({
      id: r.id,
      approvedAt: r.approved_at,
      by: r.by,
      artifact: r.artifact,
      source: r.source,
    })),
    proposals: proposals.rows.map((p) => ({
      id: p.id,
      status: p.status,
      source: p.source,
      createdAt: p.created_at,
      artifact: p.artifact,
      sha: p.sha,
      schemaVersion: p.schema_version,
      crosscheck: p.verdict
        ? {
            reviewer: p.reviewer!,
            verdict: p.verdict,
            text: p.text!,
            matches: p.reviewed_sha256 === p.sha,
            at: p.checked_at!,
            previewId: p.check_preview_id,
            previewCurrent:
              p.check_preview_id != null &&
              p.check_preview_id === p.pv_id &&
              p.pv_current === true,
          }
        : null,
      preview:
        p.pv_id && p.pv_body
          ? {
              id: p.pv_id,
              at: p.pv_at!,
              current: p.pv_current === true,
              body: p.pv_body,
            }
          : null,
    })),
    reports: reports.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      revisionId: r.revision_id,
      at: r.at,
      body: r.body,
    })),
    jobs: jobs.rows.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      enqueuedAt: j.enqueued_at,
      error: j.error,
      result: j.result,
    })),
    samples,
  };
}

// ── "why does species X have or lack this tag?" ───────────────────────────

export interface TagWhy {
  code: string;
  name: string | null;
  member: boolean;
  carries: boolean;
  legacy: "has" | "lacks" | "no_baseline";
  articleRevId: string | null;
  state: {
    status: string;
    reason: string | null;
    evidence: { sentence?: string; section?: string }[];
  } | null;
  matches: { code: string; name: string }[];
}

/** Resolve a species by exact code or name fragment; explain its tag. */
export async function tagWhy(tag: string, q: string): Promise<TagWhy | null> {
  const needle = q.trim();
  if (!ALL_TAGS.has(tag) || needle.length < 2 || needle.length > 80)
    return null;
  const found = (
    await query<{ code: string; name: string }>(
      `SELECT species_code AS code, com_name AS name FROM taxonomy_cache
			  WHERE category = 'species' AND (species_code = $1 OR com_name ILIKE '%' || $2 || '%')
			  ORDER BY (species_code = $1) DESC, (lower(com_name) = lower($1)) DESC, com_name LIMIT 10`,
      [needle, needle.replace(/[\\%_]/g, (c) => `\\${c}`)],
    )
  ).rows;
  if (!found.length) return null;
  const code = found[0].code;
  const r = (
    await query<{
      tags: string[] | null;
      legacy_tags: string[] | null;
      rev: string | null;
      member: boolean;
      status: string | null;
      reason: string | null;
      evidence: { sentence?: string; section?: string }[] | null;
    }>(
      `SELECT se.tags, se.legacy_tags, se.wikipedia_rev_id::text AS rev,
			        EXISTS (SELECT 1 FROM public.tag_universe_codes() u(c) WHERE u.c = se.species_code) AS member,
			        st.status, st.reason, st.evidence
			   FROM species_enrichment se
			   LEFT JOIN LATERAL (
			     SELECT s.status, s.reason, s.evidence
			       FROM tag_ownership o JOIN tag_activation a ON a.id = o.activation_id
			       JOIN species_tag_input i ON i.species_code = se.species_code
			       JOIN species_tag_state s ON s.species_code = se.species_code AND s.tag = o.tag
			        AND s.revision_id = a.revision_id AND s.input_hash = i.input_hash
			      WHERE o.tag = $2) st ON true
			  WHERE se.species_code = $1`,
      [code, tag],
    )
  ).rows[0];
  return {
    code,
    name: found[0].name,
    member: r?.member ?? false,
    carries: r?.tags?.includes(tag) ?? false,
    legacy:
      r?.legacy_tags == null
        ? "no_baseline"
        : r.legacy_tags.includes(tag)
          ? "has"
          : "lacks",
    articleRevId: r?.rev ?? null,
    state: r?.status
      ? { status: r.status, reason: r.reason, evidence: r.evidence ?? [] }
      : null,
    matches: found.slice(1),
  };
}

// ── owner actions ─────────────────────────────────────────────────────────

type TagOp = Extract<
  JobType,
  "tag_stage" | "tag_benchmark" | "tag_activate" | "tag_retire" | "tag_rollback"
>;

const OP_LABEL: Record<TagOp, string> = {
  tag_stage: "stage report",
  tag_benchmark: "switch benchmark",
  tag_activate: "activate",
  tag_retire: "retire to legacy",
  tag_rollback: "roll back",
};

/** Enqueue one owner operation (dedup: a second click joins the queued one). */
export async function enqueueTagOp(
  type: TagOp,
  payload: {
    tag: string;
    revisionId?: string;
    gateReportId?: string;
    benchmarkReportId?: string;
  },
  userId: number,
): Promise<{ jobId: number; deduped: boolean }> {
  const key =
    type === "tag_stage"
      ? dedupKeys.tagStage(payload.tag, payload.revisionId!)
      : type === "tag_benchmark"
        ? dedupKeys.tagBenchmark(payload.tag, payload.revisionId!)
        : type === "tag_activate"
          ? dedupKeys.tagActivate(payload.tag)
          : type === "tag_retire"
            ? dedupKeys.tagRetire(payload.tag)
            : dedupKeys.tagRollback(payload.tag);
  return enqueueJob({
    type,
    payload,
    dedupKey: key,
    requestedBy: userId,
    label: `${payload.tag} — ${OP_LABEL[type]}`,
    maxAttempts: 1,
  });
}

/** "Preview" — what a proposal would do to every species (plan §3d). */
export async function enqueuePreview(
  tag: string,
  proposalId: string,
  userId: number,
): Promise<{ jobId: number; deduped: boolean }> {
  return enqueueJob({
    type: "tag_preview",
    // tag rides along so the job shows in the tag page's Recent work.
    payload: { proposalId, tag },
    dedupKey: dedupKeys.tagPreview(proposalId),
    requestedBy: userId,
    label: `${tag} — preview proposal`,
    maxAttempts: 2,
  });
}

/** "Fetch family articles" — only families without a usable reference (plan §4). */
export async function enqueueFamilyRefs(
  userId: number,
): Promise<{ jobId: number; deduped: boolean }> {
  return enqueueJob({
    type: "tag_family_refs",
    payload: {},
    dedupKey: dedupKeys.tagFamilyRefs(),
    requestedBy: userId,
    label: "family articles for blind tests",
    maxAttempts: 2,
  });
}

/** "Draft rules with AI" — one queued draft per tag; the job re-checks everything. */
export async function enqueueTagDraft(
  tag: string,
  userId: number,
): Promise<{ jobId: number; deduped: boolean }> {
  return enqueueJob({
    type: "tag_draft_rules",
    payload: { tag },
    dedupKey: dedupKeys.tagDraftRules(tag),
    requestedBy: userId,
    label: `${tag} — draft rules (AI)`,
    // 2, not 1: failJob is terminal either way, so the only effect is that a
    // hard worker crash mid-call is reclaimed to pending once instead of
    // failing (a drain requeues and refunds on its own; tag-draft-job.ts).
    maxAttempts: 2,
  });
}

type Exec = <T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

/** The owner-facing reason approval must refuse, or null (plan §3a: loader + taxonomy). */
export async function approvalRefusal(
  proposalId: string,
  exec: Exec = query as never,
): Promise<string | null> {
  const p = (
    await exec<{ artifact_text: string }>(
      "SELECT artifact::text AS artifact_text FROM tag_rule_proposal WHERE id = $1",
      [proposalId],
    )
  ).rows[0];
  if (!p) return "No such proposal.";
  let rs;
  try {
    rs = parseRuleset(JSON.parse(p.artifact_text), ALL_TAGS);
  } catch (e) {
    if (e instanceof RulesetError) return `These rules do not load: ${e.message}`;
    throw e;
  }
  const check = checkTaxonRules(rs, await loadTaxonomyForCheck(exec));
  return check.problems.length
    ? `These rules do not fit the current taxonomy: ${check.problems[0]}`
    : null;
}

/**
 * Approve: the loader + taxonomy check and the approving definer run in ONE
 * transaction under the EXCLUSIVE engine lock (CODEX1 B5 review P1-1), so the
 * taxonomy (only replaceTaxonomy changes it, under the same lock) cannot move
 * between the check and the approval. The definer re-verifies everything it
 * can itself (newest cross-check, current Preview, its clean taxonomy check).
 */
export async function approveProposal(
  proposalId: string,
  userId: number,
): Promise<string> {
  try {
    return await withTagWriteTx(
      "exclusive",
      `approve:${proposalId}`,
      "approve",
      async (tx) => {
        const refusal = await approvalRefusal(proposalId, tx.exec as never);
        if (refusal) throw new TagTxRefusal(refusal);
        try {
          return (
            await tx.exec<{ id: string }>(
              "SELECT public.approve_tag_proposal($1, $2)::text AS id",
              [proposalId, userId],
            )
          ).rows[0].id;
        } catch (e) {
          // Every definer refusal is an owner-facing answer, not a failure to record.
          throw new TagTxRefusal(e instanceof Error ? e.message : String(e));
        }
      },
    );
  } catch (e) {
    if (e instanceof TagTxRefusal) throw new Error(e.reason);
    throw e;
  }
}

export async function rejectProposal(
  proposalId: string,
  userId: number,
): Promise<void> {
  await query("SELECT public.reject_tag_proposal($1, $2)", [
    proposalId,
    userId,
  ]);
}

export { ensureTagRepairJob, runTagConsistencyNow };

/** Latest passing gate / benchmark reports for a revision (Activate's preconditions). */
export async function activationReadiness(
  tag: string,
  revisionId: string,
): Promise<{ gateReportId: string | null; benchmarkReportId: string | null }> {
  const r = (
    await query<{ kind: string; id: string }>(
      `SELECT DISTINCT ON (kind) kind, id::text FROM tag_report
			  WHERE tag = $1 AND revision_id = $2 AND kind IN ('gate', 'benchmark')
			    AND body->>'passed' = 'true' AND body->>'provisional' IS NULL
			  ORDER BY kind, id DESC`,
      [tag, revisionId],
    )
  ).rows;
  return {
    gateReportId: r.find((x) => x.kind === "gate")?.id ?? null,
    benchmarkReportId: r.find((x) => x.kind === "benchmark")?.id ?? null,
  };
}

// ── B4: drafting, blind tests, labelling (plan rev 26) ─────────────────────

export interface EvalSetSummary {
  id: string;
  revisionId: string;
  status: "labelling" | "frozen" | "abandoned";
  createdAt: string;
  total: number;
  labelled: number;
  perStratum: Record<string, { n: number; labelled: number }>;
  gates: unknown;
  lastGate: { reportId: string; passed: boolean } | null;
  /** Answers given by a whole-family confirmation (0076, set-local), not page by page. */
  fromTaxa: number;
  /**
   * Labelling sets only: the taxa the revision lists whole (assign rules),
   * with this set's pages from each — what the owner may confirm at once.
   */
  listedTaxa: ListedTaxon[];
}

export interface ListedTaxon {
  rank: string;
  value: string;
  /** Common family name from the taxonomy, when the rank is family. */
  name: string | null;
  pages: number;
  unanswered: number;
}

/** Listed (assign) taxa of the set's revision, with the set's pages in each. */
async function listedTaxaFor(
  setId: string,
  revisionId: string,
  tag: string,
): Promise<ListedTaxon[]> {
  return (
    await query<ListedTaxon>(
      `WITH listed AS (
         SELECT DISTINCT t->>'rank' AS rank, v AS value
           FROM tag_revision r, jsonb_array_elements(r.artifact->'taxon') t,
                jsonb_array_elements_text(t->'values') v
          WHERE r.id = $1 AND t->>'action' = 'assign'
       ), items AS (
         SELECT si.order_name, si.family_sci_name, si.genus,
                (l.id IS NOT NULL OR ta.item_id IS NOT NULL) AS answered
           FROM tag_eval_item i
           JOIN species_tag_input si ON si.species_code = i.species_code AND si.input_hash = i.input_hash
           LEFT JOIN tag_eval_label l
             ON l.tag = $3 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
           LEFT JOIN tag_eval_taxon_answer ta ON ta.item_id = i.id
          WHERE i.set_id = $2
       )
       SELECT ls.rank, ls.value,
              (SELECT min(tc.family) FROM taxonomy_cache tc
                WHERE ls.rank = 'family' AND tc.family_sci_name = ls.value) AS name,
              count(it.*)::int AS pages,
              count(it.*) FILTER (WHERE NOT it.answered)::int AS unanswered
         FROM listed ls
         LEFT JOIN items it
           ON (ls.rank = 'order' AND it.order_name = ls.value)
           OR (ls.rank = 'family' AND it.family_sci_name = ls.value)
           OR (ls.rank = 'genus' AND it.genus = ls.value)
        GROUP BY ls.rank, ls.value
        ORDER BY unanswered DESC, ls.rank, ls.value`,
      [revisionId, setId, tag],
    )
  ).rows;
}

export async function evalSetsFor(tag: string): Promise<EvalSetSummary[]> {
  const sets = (
    await query<{
      id: string;
      revision_id: string;
      status: EvalSetSummary["status"];
      created_at: string;
      gates: unknown;
    }>(
      `SELECT id::text, revision_id::text, status, created_at::text, gates
         FROM tag_eval_set WHERE tag = $1 ORDER BY id DESC LIMIT 20`,
      [tag],
    )
  ).rows;
  const out: EvalSetSummary[] = [];
  for (const s of sets) {
    const strata = (
      await query<{ stratum: string; n: number; labelled: number; from_taxa: number }>(
        `SELECT i.stratum, count(*)::int AS n,
                count(*) FILTER (WHERE l.id IS NOT NULL OR ta.item_id IS NOT NULL)::int AS labelled,
                count(ta.item_id)::int AS from_taxa
           FROM tag_eval_item i
           LEFT JOIN tag_eval_label l
             ON l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
           LEFT JOIN tag_eval_taxon_answer ta ON ta.item_id = i.id
          WHERE i.set_id = $1 GROUP BY i.stratum ORDER BY i.stratum`,
        [s.id, tag],
      )
    ).rows;
    const gate = (
      await query<{ id: string; passed: boolean }>(
        `SELECT id::text, (body->>'passed')::boolean AS passed FROM tag_report
          WHERE kind = 'gate' AND tag = $1 AND body->>'setId' = $2 ORDER BY id DESC LIMIT 1`,
        [tag, s.id],
      )
    ).rows[0];
    out.push({
      id: s.id,
      revisionId: s.revision_id,
      status: s.status,
      createdAt: s.created_at,
      total: strata.reduce((a, r) => a + r.n, 0),
      labelled: strata.reduce((a, r) => a + r.labelled, 0),
      perStratum: Object.fromEntries(
        strata.map((r) => [r.stratum, { n: r.n, labelled: r.labelled }]),
      ),
      gates: s.gates,
      lastGate: gate ? { reportId: gate.id, passed: gate.passed } : null,
      fromTaxa: strata.reduce((a, r) => a + r.from_taxa, 0),
      listedTaxa:
        s.status === "labelling"
          ? await listedTaxaFor(s.id, s.revision_id, tag)
          : [],
    });
  }
  return out;
}

/** The latest design (simulation) report per revision of a tag. */
export async function latestDesigns(
  tag: string,
): Promise<
  Record<string, { reportId: string; body: Record<string, unknown> }>
> {
  const rows = (
    await query<{
      revision_id: string;
      id: string;
      body: Record<string, unknown>;
    }>(
      `SELECT DISTINCT ON (revision_id) revision_id::text, id::text, body
         FROM tag_report WHERE tag = $1 AND kind = 'simulation' ORDER BY revision_id, id DESC`,
      [tag],
    )
  ).rows;
  return Object.fromEntries(
    rows.map((r) => [r.revision_id, { reportId: r.id, body: r.body }]),
  );
}

export function enqueueEvalJob(
  type: "tag_design_simulation" | "tag_eval_create" | "tag_gate_report",
  payload: Record<string, unknown>,
  dedupKey: string,
  label: string,
  userId: number,
): Promise<{ jobId: number; deduped: boolean }> {
  return enqueueJob({
    type,
    payload,
    dedupKey,
    requestedBy: userId,
    label,
    maxAttempts: 1,
  });
}

export interface LabelPageItem {
  setId: string;
  itemId: string;
  position: number;
  total: number;
  labelled: number;
  sections: { title: string; text: string }[];
  cueWords: string[];
  /** The question frozen into the set's design at creation. */
  question: string;
  /** The frozen family reference this page shows (null for pre-B5 sets). */
  familyReference: { title: string; displayLead: string } | null;
  /** The bird being judged (owner 2026-10-03: shown, never masked). */
  species: { comName: string; sciName: string };
}

/**
 * The next page to label in a set: the lowest display position whose page has
 * no answer yet. It names the bird, but carries NO system output — no stratum,
 * rules result, legacy value, matched rule or evidence.
 *
 * The text shown is rebuilt, unmasked, from the stored article whenever that
 * article is still the one the set froze (same input_hash). Sets made before
 * v3 froze their text with the names masked; this shows those pages unmasked
 * too, without changing what was sampled. If the article has moved since, the
 * frozen text is shown.
 */
export async function nextLabelItem(
  tag: string,
  setId: string,
): Promise<LabelPageItem | null> {
  const set = (
    await query<{ status: string; cue: string[] | null; question: string | null }>(
      `SELECT status, ARRAY(SELECT jsonb_array_elements_text(design->'cueWords')) AS cue,
              design->>'question' AS question
         FROM tag_eval_set WHERE id = $1 AND tag = $2`,
      [setId, tag],
    )
  ).rows[0];
  if (!set || set.status !== "labelling") return null;
  const counts = (
    await query<{ total: number; labelled: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE l.id IS NOT NULL OR ta.item_id IS NOT NULL)::int AS labelled
         FROM tag_eval_item i
         LEFT JOIN tag_eval_label l ON l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
         LEFT JOIN tag_eval_taxon_answer ta ON ta.item_id = i.id
        WHERE i.set_id = $1`,
      [setId, tag],
    )
  ).rows[0];
  const it = (
    await query<{
      id: string;
      display_position: number;
      article: { title: string; text: string }[];
      family_reference: { title?: string; lead?: string; displayLead?: string } | null;
      com_name: string | null;
      sci_name: string | null;
      code: string;
      current: boolean;
      wikipedia_extract: string | null;
      wikipedia_sections: { title: string; text: string }[] | null;
    }>(
      `SELECT i.id::text, i.display_position, i.article, i.family_reference,
              tc.com_name, tc.sci_name, i.species_code AS code,
              (si.input_hash = i.input_hash) AS current,
              se.wikipedia_extract, se.wikipedia_sections
         FROM tag_eval_item i
         LEFT JOIN taxonomy_cache tc ON tc.species_code = i.species_code
         LEFT JOIN species_tag_input si ON si.species_code = i.species_code
         LEFT JOIN species_enrichment se ON se.species_code = i.species_code
        WHERE i.set_id = $1 AND NOT EXISTS (
              SELECT 1 FROM tag_eval_label l
               WHERE l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash)
          AND NOT EXISTS (SELECT 1 FROM tag_eval_taxon_answer ta WHERE ta.item_id = i.id)
        ORDER BY i.display_position LIMIT 1`,
      [setId, tag],
    )
  ).rows[0];
  if (!it)
    return {
      setId,
      itemId: "",
      position: 0,
      total: counts.total,
      labelled: counts.labelled,
      sections: [],
      cueWords: [],
      question: set.question ?? "",
      familyReference: null,
      species: { comName: "", sciName: "" },
    };
  const ref = it.family_reference;
  return {
    setId,
    itemId: it.id,
    position: it.display_position,
    total: counts.total,
    labelled: counts.labelled,
    sections: it.current
      ? evalSections({ extract: it.wikipedia_extract, sections: it.wikipedia_sections })
      : it.article,
    cueWords: set.cue ?? [],
    question: set.question ?? "",
    familyReference:
      ref?.title && (ref.lead || ref.displayLead)
        ? {
            title: ref.title,
            // The stored lead, normalized: never masked (v2 snapshots masked displayLead).
            displayLead: ref.lead ? normalizeDisplay(ref.lead) : ref.displayLead!,
          }
        : null,
    species: { comName: it.com_name ?? it.code, sciName: it.sci_name ?? "" },
  };
}

/** After an answer is saved: reveal which bird it was (context only, never a question). */
export async function revealItem(
  setId: string,
  itemId: string,
): Promise<{ name: string; code: string } | null> {
  return (
    (
      await query<{ name: string; code: string }>(
        `SELECT coalesce(tc.com_name, i.species_code) AS name, i.species_code AS code
           FROM tag_eval_item i LEFT JOIN taxonomy_cache tc ON tc.species_code = i.species_code
          WHERE i.set_id = $1 AND i.id = $2`,
        [setId, itemId],
      )
    ).rows[0] ?? null
  );
}

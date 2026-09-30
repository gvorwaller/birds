/**
 * Staging and activation of an approved revision (td-894144 Release B, plan
 * rev 18 §B2 "Activation protocol").
 *
 *  stage    — under the SHARED engine lock (wiki writes continue): evaluate
 *             the revision for every universe member that has no state for
 *             (revision, current input_hash) and record it. Idempotent.
 *  activate — under the EXCLUSIVE lock: re-hash the artifact, give any member
 *             without an input one, complete only the drift since staging,
 *             then switch_tag_ownership (coverage, reports, dependencies) and
 *             apply the candidate set. Cancel is honoured only before this.
 *
 * States are written in batches through the record_tag_state definer (one
 * round trip per batch), so the exclusive hold stays short.
 */
import { createHash } from "node:crypto";
import { ALL_TAGS } from "$lib/species-tags";
import { focalExemptions, lexiconFor, materializeMany } from "./materialize";
import { parseRuleset, type Ruleset } from "./rules";
import {
  TAG_ENGINE_KEY,
  TagTxRollback,
  withTagWriteTx,
  type TagWriteTx,
} from "./runtime";
import { evaluateTag } from "./scanner";

const sha256 = (s: string) =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

export async function loadRevision(
  tx: TagWriteTx,
  tag: string,
  revisionId: string,
): Promise<Ruleset> {
  const r = (
    await tx.exec<{ artifact_text: string; artifact_sha256: string }>(
      "SELECT artifact::text AS artifact_text, artifact_sha256 FROM tag_revision WHERE id = $1 AND tag = $2",
      [revisionId, tag],
    )
  ).rows[0];
  if (!r) throw new Error(`no approved revision ${revisionId} for ${tag}`);
  if (sha256(r.artifact_text) !== r.artifact_sha256)
    throw new Error(`revision ${revisionId}: artifact hash mismatch`);
  const rs = parseRuleset(JSON.parse(r.artifact_text), ALL_TAGS);
  if (rs.tag !== tag)
    throw new Error(`revision ${revisionId}: ruleset tag mismatch`);
  return rs;
}

interface PendingRow {
  species_code: string;
  wikipedia_extract: string;
  wikipedia_sections: { title: string; text: string }[] | null;
  order_name: string | null;
  family_sci_name: string | null;
  com_name: string | null;
  sci_name: string | null;
  family: string | null;
}

/**
 * Evaluate + record the revision for members lacking a current state.
 * The pending list is read ONCE (one universe scan), then articles are loaded
 * and states written in batches — one round trip per batch.
 */
export async function completeRevisionStates(
  tx: TagWriteTx,
  tag: string,
  revisionId: string,
  ruleset: Ruleset,
  batch = 500,
): Promise<number> {
  const lex = await lexiconFor(tx);
  const pending = (
    await tx.exec<{ code: string; input_hash: string }>(
      `SELECT u.code, i.input_hash
			   FROM public.tag_universe_codes() u(code)
			   JOIN species_tag_input i ON i.species_code = u.code
			   LEFT JOIN species_tag_state s
			     ON s.species_code = u.code AND s.tag = $1 AND s.revision_id = $2 AND s.input_hash = i.input_hash
			  WHERE s.state_id IS NULL
			  ORDER BY u.code`,
      [tag, revisionId],
    )
  ).rows;
  const inputOf = new Map(pending.map((p) => [p.code, p.input_hash]));
  for (let i = 0; i < pending.length; i += batch) {
    const rows = (
      await tx.exec<PendingRow>(
        `SELECT se.species_code, se.wikipedia_extract, se.wikipedia_sections,
				        tc.order_name, tc.family_sci_name, tc.com_name, tc.sci_name, tc.family
				   FROM species_enrichment se JOIN taxonomy_cache tc ON tc.species_code = se.species_code
				  WHERE se.species_code = ANY($1::text[])`,
        [pending.slice(i, i + batch).map((p) => p.code)],
      )
    ).rows;
    const results = rows.map((row) => {
      const res = evaluateTag(
        {
          article: {
            extract: row.wikipedia_extract,
            sections: row.wikipedia_sections ?? [],
          },
          taxon: { order: row.order_name, family: row.family_sci_name },
          lexicon: lex.lexicon,
          exempt: focalExemptions(row),
        },
        ruleset,
      );
      return {
        code: row.species_code,
        input_hash: inputOf.get(row.species_code),
        status: res.status,
        reason: res.reason,
        evidence: res.evidence,
        scanner_rev: res.scannerRev,
      };
    });
    await tx.exec(
      `SELECT public.record_tag_state(x.code, $2::bigint, $3, x.input_hash, x.status, x.reason, x.evidence, x.scanner_rev)
			   FROM jsonb_to_recordset($1::jsonb)
			     AS x(code text, input_hash text, status text, reason text, evidence jsonb, scanner_rev text)`,
      [JSON.stringify(results), revisionId, tag],
    );
  }
  return pending.length;
}

/** Members with a stored article and species taxonomy but no input pointer yet. */
async function membersWithoutInput(tx: TagWriteTx): Promise<string[]> {
  return (
    await tx.exec<{ code: string }>(
      `SELECT u.code FROM public.tag_universe_codes() u(code)
			  LEFT JOIN species_tag_input i ON i.species_code = u.code
			 WHERE i.species_code IS NULL`,
    )
  ).rows.map((r) => r.code);
}

/** Staging (shared lock): make sure every member has an input and a state for the revision. */
export async function stageRevision(
  tag: string,
  revisionId: string,
): Promise<{ inputs: number; states: number }> {
  return withTagWriteTx(
    "shared",
    `global:stage:${tag}`,
    "stage",
    async (tx) => {
      const ruleset = await loadRevision(tx, tag, revisionId);
      const missing = await membersWithoutInput(tx);
      if (missing.length) await materializeMany(tx, missing);
      const states = await completeRevisionStates(tx, tag, revisionId, ruleset);
      return { inputs: missing.length, states };
    },
  );
}

/**
 * Activation (exclusive lock). `dryRun` rolls everything back (benchmarks,
 * tests). `benchmark` implies dryRun and records PROVISIONAL passing gate and
 * benchmark reports inside the doomed transaction, so the switch benchmark can
 * run the real switch before those reports exist; they roll back with it.
 */
export async function activateRevision(opts: {
  tag: string;
  revisionId: string;
  gateReportId?: string;
  benchmarkReportId?: string;
  userId: number;
  dryRun?: boolean;
  benchmark?: boolean;
  onTiming?: (t: Record<string, number>) => void;
}): Promise<string | null> {
  if (opts.benchmark) opts = { ...opts, dryRun: true };
  else if (!opts.gateReportId || !opts.benchmarkReportId)
    throw new Error(
      "activateRevision: gate and benchmark report ids are required",
    );
  let lockStartedAt: number | null = null;
  const timingRef: { current: Record<string, number> | null } = {
    current: null,
  };
  const finishTiming = () => {
    const timing = timingRef.current;
    if (!timing || lockStartedAt == null) return;
    timing.totalMs = performance.now() - lockStartedAt;
    opts.onTiming?.(timing);
  };
  try {
    const activationId = await withTagWriteTx(
      "exclusive",
      `global:activate:${opts.tag}`,
      "activate",
      async (tx) => {
        const t0 = (lockStartedAt = performance.now());
        const lsn0 = (
          await tx.exec<{ l: string }>(
            "SELECT pg_current_wal_insert_lsn()::text AS l",
          )
        ).rows[0].l;
        const ruleset = await loadRevision(tx, opts.tag, opts.revisionId);
        const missing = await membersWithoutInput(tx);
        if (missing.length) await materializeMany(tx, missing);
        const t1 = performance.now();
        const drift = await completeRevisionStates(
          tx,
          opts.tag,
          opts.revisionId,
          ruleset,
        );
        const t2 = performance.now();
        let gateReportId = opts.gateReportId;
        let benchmarkReportId = opts.benchmarkReportId;
        if (opts.benchmark) {
          const provisional = async (kind: string) =>
            (
              await tx.exec<{ id: string }>(
                `SELECT public.record_tag_report($1, $2, $3, '{"passed":true,"provisional":true}'::jsonb)::text AS id`,
                [kind, opts.tag, opts.revisionId],
              )
            ).rows[0].id;
          gateReportId = await provisional("gate");
          benchmarkReportId = await provisional("benchmark");
        }
        const act = (
          await tx.exec<{ id: string }>(
            "SELECT public.switch_tag_ownership($1, $2, $3, $4, $5, $6) AS id",
            [
              opts.tag,
              opts.revisionId,
              gateReportId,
              benchmarkReportId,
              opts.userId,
              TAG_ENGINE_KEY.toString(),
            ],
          )
        ).rows[0].id;
        const t3 = performance.now();
        const walBytes = Number(
          (
            await tx.exec<{ b: string }>(
              "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::text AS b",
              [lsn0],
            )
          ).rows[0].b,
        );
        timingRef.current = {
          inputsMs: t1 - t0,
          driftMs: t2 - t1,
          driftStates: drift,
          switchMs: t3 - t2,
          missingInputs: missing.length,
          walBytes,
        };
        if (opts.dryRun) throw new TagTxRollback();
        return act;
      },
    );
    finishTiming();
    return activationId;
  } catch (err) {
    if (err instanceof TagTxRollback) {
      finishTiming();
      return null;
    }
    throw err;
  }
}

/**
 * Retire a tag to legacy (exclusive lock): the emergency escape, available
 * even while a repair generation is pending (plan rev 21). Ownership is
 * removed and the candidate set re-applied in the same transaction.
 */
export async function retireTagToLegacy(
  tag: string,
  userId: number,
): Promise<string> {
  return withTagWriteTx(
    "exclusive",
    `global:retire:${tag}`,
    "retire",
    async (tx) =>
      (
        await tx.exec<{ id: string }>(
          "SELECT public.retire_tag_to_legacy($1, $2, $3)::text AS id",
          [tag, userId, TAG_ENGINE_KEY.toString()],
        )
      ).rows[0].id,
  );
}

/**
 * Roll a tag back one step (exclusive lock): to the previous activation's
 * revision, or to legacy when there is none. A revision target is refused
 * while a repair generation is pending (0067 guard); legacy never is.
 */
export async function rollbackTag(
  tag: string,
  userId: number,
): Promise<string> {
  return withTagWriteTx(
    "exclusive",
    `global:rollback:${tag}`,
    "rollback",
    async (tx) =>
      (
        await tx.exec<{ id: string }>(
          "SELECT public.rollback_tag($1, $2, $3)::text AS id",
          [tag, userId, TAG_ENGINE_KEY.toString()],
        )
      ).rows[0].id,
  );
}

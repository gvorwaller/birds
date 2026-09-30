/**
 * Nightly tag consistency (td-894144 Release B3; plan "Nightly tag
 * consistency job"). An independent safety net that does not trust the
 * writers: it re-derives every species from the authoritative sources, in
 * short exclusive batches through the one executable path, and counts every
 * difference it had to fix. A fix is a code-path bug signal — the entry points
 * should have prevented it — so any fix or failure raises the Tags-tab badge.
 *
 *  0. lexicon: rebuild it from the taxonomy; if it moved (or a pending
 *     generation's target is stale), open a repair generation (plan rev 21)
 *     and defer to its job;
 *  –  a pending generation defers the pass (re-enqueuing its job if none is
 *     active), so a mid-repair row is never reported as drift;
 *  1–3. per batch: snapshot, materializeMany (input pointer, owned states,
 *     non-member pointers, effective tags), snapshot again, classify;
 *  4. integrity: legacy baseline + runtime-role grants (catalog).
 */
import { query } from "$lib/db";
import { sanitizeErrorText } from "$server/job-policy";
import { lexiconFor, materializeMany } from "./materialize";
import { beginTagRepair, ensureTagRepairJob, tagRepairState } from "./repair";
import { withTagWriteTx, type TagWriteTx } from "./runtime";

export const TAG_CONSISTENCY_BATCH = 100;

export type ConsistencyStatus = "clean" | "fixed" | "failed" | "deferred";

export interface ConsistencyResult {
  runId: string;
  status: ConsistencyStatus;
  checked: number;
  fixed: Record<string, number>;
  failures: { kind: string; detail: string }[];
  durationMs: number;
  details: Record<string, unknown>;
}

async function recordRun(
  startedAt: Date,
  checked: number,
  fixed: Record<string, number>,
  failures: readonly { kind: string; detail: string }[],
  status: ConsistencyStatus,
  durationMs: number,
  details: Record<string, unknown>,
): Promise<string> {
  return (
    await query<{ id: string }>(
      "SELECT public.record_tag_consistency_run($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb)::text AS id",
      [
        startedAt.toISOString(),
        checked,
        JSON.stringify(fixed),
        JSON.stringify(failures.slice(0, 200)),
        status,
        durationMs,
        JSON.stringify(details),
      ],
    )
  ).rows[0].id;
}

interface Snap {
  tags: string[] | null;
  input_hash: string | null;
  text_hash: string | null;
  order_name: string | null;
  family_sci_name: string | null;
  lexicon_hash: string | null;
  focal_exempt_hash: string | null;
  scanner_rev: string | null;
  states: number;
}

const INPUT_FIELDS = [
  ["text_hash", "input_text"],
  ["order_name", "input_order"],
  ["family_sci_name", "input_family"],
  ["lexicon_hash", "input_lexicon"],
  ["focal_exempt_hash", "input_focal"],
  ["scanner_rev", "input_scanner"],
] as const;

async function snapshot(
  tx: TagWriteTx,
  codes: readonly string[],
): Promise<Map<string, Snap>> {
  const r = await tx.exec<Snap & { code: string }>(
    `SELECT se.species_code AS code, se.tags, i.input_hash, i.text_hash, i.order_name, i.family_sci_name,
		        i.lexicon_hash, i.focal_exempt_hash, i.scanner_rev,
		        (SELECT count(*) FROM species_tag_state s WHERE s.species_code = se.species_code)::int AS states
		   FROM species_enrichment se
		   LEFT JOIN species_tag_input i ON i.species_code = se.species_code
		  WHERE se.species_code = ANY($1::text[])`,
    [codes],
  );
  return new Map(r.rows.map(({ code, ...s }) => [code, s]));
}

const sameArray = (a: string[] | null, b: string[] | null) =>
  a === b ||
  (a != null &&
    b != null &&
    a.length === b.length &&
    a.every((x, i) => x === b[i]));

/** Count what the batch had to change, by reason. */
export function classifyFixes(
  before: Map<string, Snap>,
  after: Map<string, Snap>,
  fixed: Record<string, number>,
): void {
  const bump = (k: string, n = 1) => (fixed[k] = (fixed[k] ?? 0) + n);
  for (const [code, b] of before) {
    const a = after.get(code);
    if (!a) continue; // row deleted concurrently — not ours to judge
    if (b.input_hash == null && a.input_hash != null) bump("input_missing");
    else if (b.input_hash != null && a.input_hash == null)
      bump("pointer_non_member");
    else if (b.input_hash != null && b.input_hash !== a.input_hash)
      for (const [field, reason] of INPUT_FIELDS)
        if (b[field] !== a[field]) bump(reason);
    if (a.states > b.states) bump("state_missing", a.states - b.states);
    if (!sameArray(b.tags, a.tags)) bump("effective_drift");
  }
}

/**
 * One consistency pass. `requesterId` owns any repair job it opens or
 * re-enqueues (the recurring singleton's owner, the lowest admin).
 */
export async function runTagConsistency(opts: {
  requesterId: number;
  batch?: number;
  /** Restrict the re-derivation pass to these codes (tests, targeted rechecks). */
  scope?: readonly string[];
  /** Test hook: runs inside each batch's exclusive transaction, after the first snapshot. */
  onBatch?: (codes: readonly string[]) => Promise<void>;
}): Promise<ConsistencyResult> {
  const t0 = Date.now();
  const startedAt = new Date();
  const batch = opts.batch ?? TAG_CONSISTENCY_BATCH;
  const fixed: Record<string, number> = {};
  const failures: { kind: string; detail: string }[] = [];
  const details: Record<string, unknown> = {};
  let checked = 0;
  let deferred = false;

  try {
    // 0. The lexicon, from the taxonomy as it is now. A moved lexicon — or a
    // pending generation whose target it has moved past, which its job could
    // never complete — opens a fresh generation; the tag_repair job re-derives
    // the universe in batches and the pass defers to it.
    const lexStep = await withTagWriteTx(
      "exclusive",
      "global:consistency",
      "tag_consistency",
      async (tx) => {
        const s = (
          await tx.exec<{
            lexicon_hash: string;
            target: string | null;
            pending: boolean;
          }>(
            `SELECT lexicon_hash, repair_target_lexicon_hash AS target,
				        repaired_generation < repair_generation AS pending
				   FROM tag_lexicon_state WHERE id = 1`,
          )
        ).rows[0];
        if (!s) details.bootstrap = true; // first pass ever: every input is built here, not drift
        const lex = await lexiconFor(tx, { rebuild: true });
        const moved = s != null && lex.hash !== s.lexicon_hash;
        const staleTarget = s != null && s.pending && s.target !== lex.hash;
        if (!moved && !staleTarget) return null;
        const r = await beginTagRepair(tx, lex.hash, opts.requesterId);
        return {
          moved,
          staleTarget,
          generation: r.generation.toString(),
          jobId: r.jobId,
        };
      },
    );
    if (lexStep) {
      if (lexStep.moved) fixed.lexicon_drift = 1;
      if (lexStep.staleTarget) fixed.repair_target_stale = 1;
      details.lexiconDrift = lexStep;
    }

    const repair = await tagRepairState();
    if (repair?.pending) {
      deferred = true;
      details.repairPending = await ensureTagRepairJob(opts.requesterId);
    } else {
      const codes = (
        await query<{ c: string }>(
          `SELECT species_code AS c FROM species_enrichment
				  WHERE $1::text[] IS NULL OR species_code = ANY($1::text[])
				  ORDER BY species_code`,
          [opts.scope ?? null],
        )
      ).rows.map((r) => r.c);
      if (opts.scope) details.scope = codes.length;
      for (let i = 0; i < codes.length; i += batch) {
        const slice = codes.slice(i, i + batch);
        await withTagWriteTx(
          "exclusive",
          "global:consistency",
          "tag_consistency",
          async (tx) => {
            const before = await snapshot(tx, slice);
            await opts.onBatch?.(slice);
            await materializeMany(tx, slice);
            classifyFixes(before, await snapshot(tx, slice), fixed);
          },
        );
        checked += slice.length;
      }
    }

    // 4. Integrity (read-only).
    const violations = (
      await query<{ kind: string; detail: string }>(
        "SELECT kind, detail FROM tag_integrity_violations()",
      )
    ).rows;
    failures.push(...violations);
    const uncleared = Number(
      (
        await query<{ n: string }>(
          "SELECT count(*)::text AS n FROM tag_materialization_failure WHERE cleared_at IS NULL",
        )
      ).rows[0].n,
    );
    details.unclearedFailures = uncleared;

    const anyFix = Object.values(fixed).some((n) => n > 0);
    const status: ConsistencyStatus =
      failures.length > 0
        ? "failed"
        : deferred
          ? "deferred"
          : anyFix
            ? "fixed"
            : "clean";
    const durationMs = Date.now() - t0;
    const runId = await recordRun(
      startedAt,
      checked,
      fixed,
      failures,
      status,
      durationMs,
      details,
    );
    return { runId, status, checked, fixed, failures, durationMs, details };
  } catch (err) {
    const detail = sanitizeErrorText(
      err instanceof Error ? err.message : String(err),
    ).slice(0, 500);
    failures.push({ kind: "execution", detail });
    details.executionFailure = detail;
    try {
      await recordRun(
        startedAt,
        checked,
        fixed,
        failures,
        "failed",
        Date.now() - t0,
        details,
      );
    } catch {
      // Best effort: preserve the execution error that controls retry behavior.
    }
    throw err;
  }
}

/** Next run at the quiet hour (08:30 UTC ≈ 04:30 US Eastern), strictly in the future. */
export function msUntilQuietHour(
  now: Date = new Date(),
  hourUtc = 8,
  minuteUtc = 30,
): number {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      minuteUtc,
    ),
  );
  if (next.getTime() <= now.getTime() + 60_000)
    next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

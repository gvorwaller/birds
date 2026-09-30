/**
 * `tag_family_refs` worker job (td-894144 B5, plan §4 option b): fetch the
 * lead of each bird family's Wikipedia article once, for the blind-test
 * family reference. Never AI.
 *
 * By default it fills only families with no usable reference yet (never
 * fetched, missing, ambiguous, failed): re-fetching a family that already has
 * one would change its revision and therefore the frame of any blind test in
 * progress (activation would then refuse on drift). `refresh: true` refetches
 * everything and is not offered in the UI.
 *
 * Writes go through the record_tag_family_reference definer, which computes
 * the reference hash itself.
 */
import { query } from "$lib/db";
import { sanitizeErrorText, type JobRow } from "$server/job-policy";
import {
  completeJob,
  currentClaim,
  failJob,
  isStaleClaim,
  recordClaimedEvent,
  updateProgress,
} from "$server/jobs";
import { fetchFamilyLead, WikipediaError } from "$server/wikipedia";

/** Spacing between Wikipedia requests (polite; ~250 families ≈ 1–2 min). */
const SPACING_MS = 250;
const MAX_TRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FamilyReferenceStatus {
  families: number;
  ok: number;
  /** Families with no usable reference (never fetched, missing, ambiguous, failed). */
  problems: { familyCode: string; family: string; status: string; error: string | null }[];
}

export async function familyReferenceStatus(): Promise<FamilyReferenceStatus> {
  const rows = (
    await query<{
      family_code: string;
      family: string;
      status: string | null;
      error: string | null;
    }>(
      `SELECT f.family_code, f.family, r.status, r.error
         FROM (SELECT DISTINCT family_code, family_sci_name AS family FROM taxonomy_cache
                WHERE category = 'species' AND family_code IS NOT NULL) f
         LEFT JOIN tag_family_reference r ON r.family_code = f.family_code
        ORDER BY f.family_code`,
    )
  ).rows;
  return {
    families: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    problems: rows
      .filter((r) => r.status !== "ok")
      .map((r) => ({
        familyCode: r.family_code,
        family: r.family,
        status: r.status ?? "not fetched",
        error: r.error,
      })),
  };
}

export async function runTagFamilyRefsJob(job: JobRow): Promise<void> {
  const attempts = job.attempts;
  const refresh = (job.payload as { refresh?: unknown } | null)?.refresh === true;
  await recordClaimedEvent(job.id, { attempt: attempts, refresh });
  const admin = (
    await query<{ role: string }>("SELECT role FROM users WHERE id = $1", [job.requested_by])
  ).rows[0]?.role === "admin";
  if (!admin) {
    await failJob(job.id, attempts, "tag_family_refs: requester is no longer an admin");
    return;
  }
  const families = (
    await query<{ family_code: string; family: string }>(
      `SELECT DISTINCT tc.family_code, tc.family_sci_name AS family
         FROM taxonomy_cache tc
         LEFT JOIN tag_family_reference r ON r.family_code = tc.family_code
        WHERE tc.category = 'species' AND tc.family_code IS NOT NULL AND tc.family_sci_name IS NOT NULL
          AND ($1 OR r.status IS DISTINCT FROM 'ok')
        ORDER BY tc.family_code`,
      [refresh],
    )
  ).rows;
  const counts = { ok: 0, missing: 0, ambiguous: 0, failed: 0 };
  try {
    for (const [i, f] of families.entries()) {
      const { cancelRequested } = await updateProgress(job.id, {
        phase: "fetching",
        unitsTotal: families.length,
        unitsDone: i,
        unitsFailed: counts.failed,
        unitsSkipped: 0,
        currentUnit: { code: f.family_code, name: f.family },
        round: attempts,
      });
      if (cancelRequested) break;
      let outcome: Awaited<ReturnType<typeof fetchFamilyLead>> | null = null;
      let error: string | null = null;
      for (let t = 1; t <= MAX_TRIES && !outcome; t++) {
        try {
          outcome = await fetchFamilyLead(f.family);
        } catch (err) {
          error = sanitizeErrorText(
            err instanceof Error ? err.message : String(err),
          ).slice(0, 300);
          const wait =
            err instanceof WikipediaError && err.rateLimited
              ? (err.retryAfterMs ?? 5_000)
              : 1_000 * t;
          if (t < MAX_TRIES) await sleep(wait);
        }
      }
      const status = outcome?.status ?? "failed";
      counts[status]++;
      // Fenced to this job's live claim and requester (0073, CODEX1 P2-2).
      await query(
        "SELECT public.record_tag_family_reference_for_job($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [
          job.id,
          attempts,
          currentClaim(job.id)?.claimSeq ?? String(job.claim_seq ?? "0"),
          f.family_code,
          f.family,
          status,
          outcome && "title" in outcome ? outcome.title : null,
          outcome?.status === "ok" ? outcome.revId : null,
          outcome?.status === "ok" ? outcome.lead : null,
          outcome ? null : error,
        ],
      );
      await sleep(SPACING_MS);
    }
    await completeJob(job.id, attempts, { families: families.length, ...counts });
  } catch (err) {
    if (isStaleClaim(err)) throw err;
    await failJob(
      job.id,
      attempts,
      sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(0, 300),
      { families: families.length, ...counts },
    );
  }
}

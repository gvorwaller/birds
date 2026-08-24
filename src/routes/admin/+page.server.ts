import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { adminLiveStatus } from "$server/admin-status";
import { galleryHealth } from "$server/gallery";
import { nudgeEnrichmentScan } from "$server/job-handlers";

// Admin observability (td-eb9e1d MVP, plan §9). 404 — not 403 — for
// non-admins: the page's existence is nobody else's business.
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  const [
    liveStatus,
    historyRes,
    startupsRes,
    attemptsRes,
    cacheRes,
    taxonomyRes,
    gallerySource,
  ] = await Promise.all([
    adminLiveStatus(),
    query<{
      id: number;
      at: string;
      pid: number | null;
      version: string | null;
      state: string;
      current_job_id: number | null;
      note: string | null;
    }>(
      `SELECT id, at, pid, version, state, current_job_id, note
         FROM worker_status_history ORDER BY id DESC LIMIT 25`,
    ),
    // Crash-loop detector: startups in the last hour (plan §9 — >3 is a banner).
    query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM worker_status_history
        WHERE note = 'startup' AND at > NOW() - interval '1 hour'`,
    ),
    query<{
      loc_code: string;
      loc_kind: string | null;
      loc_name: string | null;
      region_code: string | null;
      status: string;
      error: string | null;
      last_attempt_at: string;
    }>(
      `SELECT loc_code, loc_kind, loc_name, region_code, status, error, last_attempt_at
         FROM frequency_fetch_attempts ORDER BY last_attempt_at DESC LIMIT 50`,
    ),
    query<{ ns: string; n: number; oldest: string; newest: string }>(
      `SELECT split_part(cache_key, ':', 1) AS ns, COUNT(*)::int AS n,
              MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest
         FROM ebird_cache GROUP BY 1 ORDER BY n DESC`,
    ),
    query<{ n: number; newest: string | null }>(
      `SELECT COUNT(*)::int AS n, MAX(fetched_at) AS newest FROM taxonomy_cache`,
    ),
    galleryHealth(),
  ]);

  return {
    now: liveStatus.now,
    worker: liveStatus.worker,
    workerHistory: historyRes.rows,
    startupsLastHour: startupsRes.rows[0]?.n ?? 0,
    jobs: liveStatus.jobs,
    attempts: attemptsRes.rows,
    cacheStats: cacheRes.rows,
    taxonomy: taxonomyRes.rows[0] ?? { n: 0, newest: null },
    gallerySource,
  };
};

export const actions: Actions = {
  /**
   * "Impatient nudge" (Gaylon): run an enrichment scan pass NOW instead of
   * waiting out the idle 24h cadence — e.g. right after new hotspot loads
   * put fresh species in scope. Admin-gated in the action itself (the
   * loader's 404 does not protect POSTs).
   */
  nudge_enrichment: async ({ locals }) => {
    if (locals.user?.role !== "admin")
      return fail(403, { error: "Admins only." });
    // Runs a scan pass SYNCHRONOUSLY — all currently-due work is queued
    // when this returns, regardless of what the recurring scan is doing
    // (CODEX1: timer nudges race a running scan's stale snapshot).
    const s = await nudgeEnrichmentScan();
    return {
      ok: true as const,
      message:
        s.candidates === 0
          ? "Nothing is due to enrich right now."
          : `Scan pass complete: ${s.chunksEnqueued} chunk${s.chunksEnqueued === 1 ? "" : "s"} queued` +
            ` for ${s.candidates} work item${s.candidates === 1 ? "" : "s"} (${s.wikiCandidates} wiki, ${s.aiCandidates} AI, ${s.mediaCandidates} media` +
            `${s.deduped > 0 ? `; ${s.deduped} already queued` : ""}` +
            `${s.remaining > 0 ? `; ${s.remaining} follow on the 15-min cadence` : ""}).`,
    };
  },
};

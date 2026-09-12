/** Automatic family reference enrichment. One family per durable scheduler run,
 * with paid-call checkpoints, FIFO fairness, and independent persistent pause. */
import { EnrichmentAiError } from "./ai-enrichment";
import { createHash } from "node:crypto";
import { query, withTransaction } from "$lib/db";
import { taxonomySummary, type TaxonomyFamily } from "./taxonomy-reference";
import { isRateLimitedError } from "./wikidata";
import {
  discoverFamilySources,
  sourceDependencies,
  FAMILY_RESOLVER_VERSION,
  FamilySourceInterrupted,
  type DiscoveryDiagnostic,
} from "./family-source-discovery";
import {
  FamilySourceInsufficient,
  FamilyValidationError,
  generateFamilyDescription,
  verifyFamilyDescription,
  type FamilyDescription,
  type FamilySource,
} from "./family-enrichment-ai";
import {
  enqueueJob,
  terminalizeAndReschedule,
  requeueInterrupted,
  updateProgress,
  cancelRunningJob,
} from "./jobs";
import { scrubStoredValue, type JobRow } from "./job-policy";

class FamilyAuditError extends Error {}
const DAY = 86400_000;
const KEY = "system:family-enrichment";
// Existing publication compatibility contract. Resolver/prompt improvements
// record their own version on new sources; never invalidate all successes here.
export const FAMILY_PROMPT_VERSION = "2";
interface FamilyState {
  family_code: string;
  input_hash: string;
  published_hash: string | null;
  content: FamilyDescription | null;
  source: FamilySource | null;
  model: string | null;
  verifier_model: string | null;
  generated_at: string | null;
  status: "pending" | "ready" | "no_source" | "error";
  last_error: string | null;
  next_attempt_at: string;
  failures: number;
  pending_source: FamilySource | null;
  pending_draft: (FamilyDescription & { audit?: string }) | null;
  pending_model: string | null;
}
export function familyInputHash(
  family: TaxonomyFamily,
  members: readonly string[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        FAMILY_PROMPT_VERSION,
        family.code,
        family.scientificName,
        family.order,
        [...members].sort(),
      ]),
    )
    .digest("hex");
}
export async function familyControl() {
  const row = (
    await query<{
      paused: boolean;
      blocked_until: string | null;
      reason: string | null;
    }>(
      "SELECT paused,blocked_until::text,reason FROM family_enrichment_control WHERE singleton",
    )
  ).rows[0];
  if (!row) throw Error("Family enrichment control is missing");
  return row;
}
export async function setFamilyPaused(paused: boolean) {
  await query(
    "UPDATE family_enrichment_control SET paused=$1,blocked_until=NULL,reason=NULL WHERE singleton",
    [paused],
  );
  if (!paused) await ensureFamilyEnrichment(true);
}
export class FamilyRetrySelectionError extends Error {}
export async function retryFamilyGaps(codes?: string[]) {
  if (
    codes &&
    (!codes.length || codes.some((code) => !/^[a-z0-9]+$/.test(code)))
  )
    throw new FamilyRetrySelectionError("Select valid family codes.");
  const selected = await withTransaction(async (c) => {
    await c.query("LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE");
    if (
      (
        await c.query(
          "SELECT 1 FROM jobs WHERE type='enrich_families' AND status='running' LIMIT 1",
        )
      ).rowCount
    )
      throw new FamilyRetrySelectionError(
        "A family is being processed. Pause family enrichment and retry after the current family finishes.",
      );
    if (codes) {
      const known = await c.query(
        "SELECT DISTINCT family_code FROM taxonomy_cache WHERE category='species' AND family_code=ANY($1::text[])",
        [codes],
      );
      if (known.rows.length !== new Set(codes).size)
        throw new FamilyRetrySelectionError(
          "Unknown family code in retry selection.",
        );
    }
    const rows = await c.query<FamilyState>(
      `SELECT e.* FROM family_enrichment e WHERE status IN ('error','no_source')
      AND (published_hash IS DISTINCT FROM input_hash OR generated_at<=NOW()-interval '180 days')
      AND ($1::text[] IS NULL OR family_code=ANY($1))
      AND EXISTS(SELECT 1 FROM taxonomy_cache t WHERE t.category='species' AND t.family_code=e.family_code)
      FOR UPDATE`,
      [codes ?? null],
    );
    for (const row of rows.rows) {
      await c.query(
        `INSERT INTO family_enrichment_diagnostics(family_code,input_hash,resolver_version,outcome,source,draft,diagnostics)
        VALUES($1,$2,$3,'retry_snapshot',$4,$5,$6)`,
        [
          row.family_code,
          row.input_hash,
          FAMILY_RESOLVER_VERSION,
          row.pending_source,
          row.pending_draft,
          JSON.stringify([{ detail: row.last_error }]),
        ],
      );
      await c.query(
        `UPDATE family_enrichment SET status='pending',last_error=NULL,next_attempt_at=NOW(),failures=0,pending_source=CASE WHEN $2 THEN NULL ELSE pending_source END,pending_draft=CASE WHEN $2 THEN NULL ELSE pending_draft END,pending_model=CASE WHEN $2 THEN NULL ELSE pending_model END WHERE family_code=$1`,
        [
          row.family_code,
          row.status === "no_source" ||
            row.pending_source?.resolverVersion !== FAMILY_RESOLVER_VERSION,
        ],
      );
    }
    return rows.rows.map((r) => r.family_code);
  });
  await ensureFamilyEnrichment(true);
  return selected;
}
export async function familyReference(code: string) {
  const [counts, note, control] = await Promise.all([
    query<{
      ready: number;
    }>(`SELECT count(*)::int AS ready FROM family_enrichment e WHERE content IS NOT NULL
   AND EXISTS(SELECT 1 FROM taxonomy_cache t WHERE t.category='species' AND t.family_code=e.family_code)`),
    query<FamilyState>(
      "SELECT *,generated_at::text,next_attempt_at::text FROM family_enrichment WHERE family_code=$1",
      [code],
    ),
    familyControl(),
  ]);
  const row = note.rows[0];
  // Do not send cached full source prose/drafts to the browser.
  return {
    ready: counts.rows[0].ready,
    paused: control.paused,
    note: row
      ? {
          content: row.content,
          source: row.source
            ? {
                title: row.source.title,
                attribution: row.source.attribution ?? "Wikipedia contributors",
                license: row.source.license ?? "CC BY-SA 4.0",
                licenseUrl:
                  row.source.licenseUrl ??
                  "https://creativecommons.org/licenses/by-sa/4.0/",
                url: row.source.url,
                revision: row.source.revision,
                fetchedAt: row.source.fetchedAt,
              }
            : null,
          sources: row.source
            ? (row.source.documents ?? [row.source]).map((source) => ({
                title: source.title,
                url: source.url,
                attribution: source.attribution ?? "Wikipedia contributors",
                license: source.license ?? "CC BY-SA 4.0",
                licenseUrl:
                  source.licenseUrl ??
                  "https://creativecommons.org/licenses/by-sa/4.0/",
              }))
            : [],
          generatedAt: row.generated_at,
          status: row.status,
          stale:
            row.input_hash !== row.published_hash || row.status !== "ready",
          retryAt: row.next_attempt_at,
        }
      : null,
  };
}
export async function familyEnrichmentStatus() {
  const [control, rows] = await Promise.all([
    familyControl(),
    query<{
      code: string;
      name: string;
      status: string;
      available: boolean;
      nextAttempt: string | null;
      error: string | null;
    }>(
      `SELECT t.family_code AS code,min(t.family) AS name,coalesce(e.status,'pending') AS status,
   e.content IS NOT NULL AS available,e.next_attempt_at::text AS "nextAttempt",e.last_error AS error
   FROM taxonomy_cache t LEFT JOIN family_enrichment e ON e.family_code=t.family_code
   WHERE t.category='species' AND t.family_code IS NOT NULL
   GROUP BY t.family_code,e.family_code ORDER BY min(t.family),t.family_code`,
    ),
  ]);
  return {
    ...control,
    total: rows.rows.length,
    ready: rows.rows.filter((r) => r.available).length,
    pending: rows.rows.filter((r) => r.status === "pending").length,
    noSource: rows.rows.filter((r) => r.status === "no_source").length,
    errors: rows.rows.filter((r) => r.status === "error").length,
    issues: rows.rows.filter(
      (r) => r.status === "error" || r.status === "no_source",
    ),
  };
}
function params(admin: number, delay: number) {
  return {
    type: "enrich_families" as const,
    payload: {},
    dedupKey: KEY,
    requestedBy: admin,
    label: "Family descriptions",
    runAfterMs: delay,
  };
}
export async function ensureFamilyEnrichment(nudge = false) {
  const active = await query<{ id: number }>(
    "SELECT id FROM jobs WHERE dedup_key=$1 AND status IN ('pending','running')",
    [KEY],
  );
  if (active.rows.length) {
    if (nudge)
      await query(
        "UPDATE jobs SET next_retry_at=NOW() WHERE id=$1 AND status='pending'",
        [active.rows[0].id],
      );
    return;
  }
  const admin = (
    await query<{ id: number }>(
      "SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1",
    )
  ).rows[0];
  if (admin) await enqueueJob(params(admin.id, 0));
}
/** Reconcile ALL current families; metadata/membership changes invalidate freshness. */
export async function reconcileFamilyInputs() {
  const families = (await taxonomySummary()).families;
  const members = (
    await query<{
      family_code: string;
      species_code: string;
      sci_name: string;
    }>(
      "SELECT family_code,species_code,sci_name FROM taxonomy_cache WHERE category='species' AND family_code IS NOT NULL",
    )
  ).rows;
  await withTransaction(async (c) => {
    for (const f of families) {
      const hash = familyInputHash(
        f,
        members
          .filter((m) => m.family_code === f.code)
          .map((m) => m.species_code + ":" + m.sci_name),
      );
      await c.query(
        `INSERT INTO family_enrichment(family_code,input_hash,status) VALUES($1,$2,'pending')
    ON CONFLICT(family_code) DO UPDATE SET input_hash=$2,status='pending',next_attempt_at=NOW(),failures=0,
     pending_source=NULL,pending_draft=NULL,pending_model=NULL,last_error=NULL
    WHERE family_enrichment.input_hash<>$2`,
        [f.code, hash],
      );
    }
  });
  return families;
}
export const familyDependencies = {
  ...sourceDependencies,
  generate: generateFamilyDescription,
  verify: verifyFamilyDescription,
};
export async function collectFamilySource(
  family: TaxonomyFamily,
  deps = familyDependencies,
  members?: string[],
  diagnostics: DiscoveryDiagnostic[] = [],
  shouldStop?: () => Promise<boolean>,
) {
  const currentMembers =
    members ??
    (
      await query<{ sci_name: string }>(
        "SELECT sci_name FROM taxonomy_cache WHERE category='species' AND family_code=$1 ORDER BY sci_name",
        [family.code],
      )
    ).rows.map((r) => r.sci_name);
  return discoverFamilySources(
    family,
    currentMembers,
    deps,
    diagnostics,
    shouldStop,
  );
}
interface FamilyContext {
  isDraining(): boolean;
  isPauseRequested?: () => Promise<boolean>;
}
export async function runFamilyEnrichment(
  job: JobRow,
  ctx: FamilyContext,
  deps = familyDependencies,
) {
  const finish = async (result: unknown, delay: number) => {
    const outcome = result as { family?: string; outcome?: string };
    await updateProgress(job.id, {
      phase: "fetching",
      unitsTotal: outcome.family ? 1 : 0,
      unitsDone: outcome.outcome === "ready" ? 1 : 0,
      unitsFailed: 0,
      unitsSkipped: outcome.family && outcome.outcome !== "ready" ? 1 : 0,
      round: 1,
    });
    return terminalizeAndReschedule(
      job.id,
      job.attempts,
      { kind: "complete", result },
      params(job.requested_by, delay),
    );
  };

  const stop = async (phase: string) => {
    const { cancelRequested } = await updateProgress(job.id, {
      phase: "fetching",
      unitsTotal: 1,
      unitsDone: 0,
      unitsFailed: 0,
      unitsSkipped: 0,
      round: 1,
      currentUnit: { code: "family", name: phase },
    });
    if (cancelRequested) {
      await cancelRunningJob(job.id, job.attempts);
      return true;
    }
    const control = await familyControl();
    if (
      ctx.isDraining() ||
      (await ctx.isPauseRequested?.()) ||
      control.paused ||
      (control.blocked_until && Date.parse(control.blocked_until) > Date.now())
    ) {
      await requeueInterrupted(
        job.id,
        job.attempts,
        "Family enrichment paused or worker draining",
      );
      return true;
    }
    return false;
  };
  if (await stop("Finding families needing descriptions")) return;
  const families = await reconcileFamilyInputs();
  const due = (
    await query<FamilyState>(`SELECT e.* FROM family_enrichment e WHERE e.next_attempt_at<=NOW()
  AND EXISTS(SELECT 1 FROM taxonomy_cache t WHERE t.category='species' AND t.family_code=e.family_code)
  ORDER BY (e.content IS NULL) DESC,e.next_attempt_at,e.family_code LIMIT 1`)
  ).rows[0];
  if (!due) {
    await finish(
      { message: "All family descriptions are current or awaiting retry" },
      3600_000,
    );
    return;
  }
  const family = families.find((f) => f.code === due.family_code)!;
  await query("UPDATE jobs SET label=$2 WHERE id=$1", [
    job.id,
    family.name ?? family.code,
  ]);
  const discovery: DiscoveryDiagnostic[] = [];
  let stage = "Source retrieval";
  try {
    let source = due.pending_source;
    if (!source) {
      source = await depsSource();
      if (!source) {
        await query(
          "UPDATE family_enrichment SET status='no_source',attempted_at=NOW(),next_attempt_at=NOW()+interval '30 days',last_error=$3 WHERE family_code=$1 AND input_hash=$2",
          [
            family.code,
            due.input_hash,
            discovery
              .filter((d) => d.outcome !== "accepted")
              .map((d) => `${d.candidate}: ${d.detail}`)
              .join("; ")
              .slice(0, 3000) || "No verified source found",
          ],
        );
        await finish({ family: family.code, outcome: "no_source" }, 1000);
        return;
      }
      await query(
        "UPDATE family_enrichment SET pending_source=$3,attempted_at=NOW() WHERE family_code=$1 AND input_hash=$2",
        [family.code, due.input_hash, JSON.stringify(source)],
      );
    }
    if (await stop("Writing " + family.name)) return;
    stage = "AI drafting";
    let draft = due.pending_draft,
      model = due.pending_model;
    const rejectedDraft = draft?.audit ? draft : null;
    if (!draft || rejectedDraft) {
      const generated = await deps.generate(
        job.id,
        family.scientificName!,
        source,
        rejectedDraft
          ? { draft: rejectedDraft, feedback: rejectedDraft.audit! }
          : undefined,
      );
      draft = generated.result;
      model = generated.servedModel ?? generated.requestedModel;
      await query(
        "UPDATE family_enrichment SET pending_draft=$3,pending_model=$4 WHERE family_code=$1 AND input_hash=$2",
        [family.code, due.input_hash, JSON.stringify(draft), model],
      );
    }
    if (await stop("Checking source support for " + family.name)) return;
    stage = "AI source-support audit";
    const checked = await deps.verify(
      job.id,
      family.scientificName!,
      source,
      draft,
    );
    if (!checked.result.supported) {
      await query(
        `INSERT INTO family_enrichment_diagnostics(family_code,input_hash,resolver_version,outcome,source,draft,diagnostics)
        VALUES($1,$2,$3,'audit_rejected',$4,$5,$6)`,
        [
          family.code,
          due.input_hash,
          FAMILY_RESOLVER_VERSION,
          source,
          draft,
          JSON.stringify(scrubStoredValue([{ detail: checked.result.reason }])),
        ],
      );
      await query(
        "UPDATE family_enrichment SET pending_draft=$2 WHERE family_code=$1",
        [
          family.code,
          JSON.stringify({
            ...draft,
            audit: String(scrubStoredValue(checked.result.reason)).slice(
              0,
              1500,
            ),
          }),
        ],
      );
      throw new FamilyAuditError(
        "Source-support check: " +
          String(scrubStoredValue(checked.result.reason)).slice(0, 1500),
      );
    }
    stage = "Saving family description";
    // Re-read taxonomy before publishing: a concurrent sync may have changed it.
    await reconcileFamilyInputs();
    const published = await withTransaction(async (client) => {
      // Prevent taxonomy replacement between the final input check and publication.
      // No network work occurs under this short database lock.
      await client.query("LOCK TABLE taxonomy_cache IN SHARE MODE");
      const current = (
        await client.query<{
          species_code: string;
          sci_name: string;
          family_sci_name: string | null;
          order_name: string | null;
        }>(
          "SELECT species_code,sci_name,family_sci_name,order_name FROM taxonomy_cache WHERE category='species' AND family_code=$1 ORDER BY species_code",
          [family.code],
        )
      ).rows;
      if (
        !current.length ||
        familyInputHash(
          {
            ...family,
            scientificName: current[0].family_sci_name,
            order: current[0].order_name,
          },
          current.map((r) => r.species_code + ":" + r.sci_name),
        ) !== due.input_hash
      )
        return { rows: [] };
      return client.query(
        `UPDATE family_enrichment e SET content=$3,source=$4,model=$5,verifier_model=$6,
   published_hash=input_hash,generated_at=NOW(),status='ready',last_error=NULL,failures=0,
   next_attempt_at=NOW()+interval '180 days',pending_source=NULL,pending_draft=NULL,pending_model=NULL
   WHERE family_code=$1 AND input_hash=$2 AND EXISTS(SELECT 1 FROM jobs WHERE id=$7 AND status='running' AND attempts=$8 AND NOT cancel_requested)
   RETURNING family_code`,
        [
          family.code,
          due.input_hash,
          JSON.stringify(draft),
          JSON.stringify(source),
          model,
          checked.servedModel ?? checked.requestedModel,
          job.id,
          job.attempts,
        ],
      );
    });
    await finish(
      {
        family: family.code,
        outcome: published.rows.length ? "ready" : "superseded",
      },
      1000,
    );
  } catch (err) {
    if (err instanceof FamilySourceInterrupted) return;
    if (err instanceof FamilySourceInsufficient) {
      await query(
        `INSERT INTO family_enrichment_diagnostics(family_code,input_hash,resolver_version,outcome,source,draft)
        SELECT family_code,input_hash,$2,'insufficient_source',pending_source,pending_draft FROM family_enrichment WHERE family_code=$1`,
        [family.code, FAMILY_RESOLVER_VERSION],
      );
      await query(
        "UPDATE family_enrichment SET status='no_source',last_error='Source lacks enough supported family information',attempted_at=NOW(),next_attempt_at=NOW()+interval '30 days',pending_source=NULL,pending_draft=NULL,pending_model=NULL WHERE family_code=$1 AND input_hash=$2",
        [family.code, due.input_hash],
      );
      await finish(
        { family: family.code, outcome: "insufficient_source" },
        1000,
      );
      return;
    }
    const e = err as Error & { status?: number };
    const rate = isRateLimitedError(err);
    const auth =
      e instanceof EnrichmentAiError && (e.status === 401 || e.status === 403);
    const failures = due.failures + 1;
    const delay = rate
      ? Math.max(err.retryAfterMs ?? 0, 30 * 60_000)
      : failures < 3
        ? failures * 15 * 60_000
        : 7 * DAY;
    // Service errors are fixed messages; audit feedback is scrubbed and bounded.
    const reason = auth
      ? "AI credentials need attention; resume after correcting them"
      : rate
        ? "Source or AI service requested a cooldown"
        : e instanceof FamilyAuditError || e instanceof FamilyValidationError
          ? e.message
          : `${stage} failed${e instanceof EnrichmentAiError ? ` (HTTP ${e.status})` : ""}; automatic retry scheduled`;
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE family_enrichment SET status='error',last_error=$3,failures=$4,attempted_at=NOW(),
    next_attempt_at=NOW()+make_interval(secs=>$5)
    WHERE family_code=$1 AND input_hash=$2`,
        [family.code, due.input_hash, reason, failures, delay / 1000],
      );
      if (auth || rate)
        await c.query(
          `UPDATE family_enrichment_control SET paused=paused OR $1,
    blocked_until=CASE WHEN $1 THEN NULL ELSE NOW()+make_interval(secs=>$2) END,reason=$3 WHERE singleton`,
          [auth, delay / 1000, reason],
        );
    });
    await updateProgress(job.id, {
      phase: "fetching",
      unitsTotal: 1,
      unitsDone: 0,
      unitsFailed: 1,
      unitsSkipped: 0,
      round: 1,
      lastError: reason,
    });
    await terminalizeAndReschedule(
      job.id,
      job.attempts,
      {
        kind: "fail",
        error: reason,
        result: { family: family.code, outcome: "error" },
      },
      params(job.requested_by, auth || rate ? delay : 1000),
    );
  }
  async function depsSource() {
    let collected: FamilySource | null = null;
    try {
      collected = await collectFamilySource(
        family,
        deps,
        undefined,
        discovery,
        () => stop("Finding family sources"),
      );
      return collected;
    } finally {
      await query(
        `INSERT INTO family_enrichment_diagnostics(family_code,input_hash,resolver_version,outcome,source,diagnostics)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          family.code,
          due.input_hash,
          FAMILY_RESOLVER_VERSION,
          collected ? "source_found" : "source_unavailable",
          collected,
          JSON.stringify(discovery),
        ],
      );
    }
  }
}

import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { adminLiveStatus } from "$server/admin-status";
import { galleryHealth } from "$server/gallery";
import { nudgeEnrichmentScan } from "$server/job-handlers";
import {
  SELECTABLE_MODELS,
  DEFAULT_MODEL_IDS,
  dollarsForRow,
  modelById,
  rateFor,
  resolveModel,
  type CallEnvelope,
} from "$server/ai-models";
import { CONFIG_KEYS, getConfig, setConfig } from "$server/app-config";
import { usageAggregates } from "$server/ai-usage";
import { meteredAiCall } from "$server/ai-call";
import { generateSpeciesAnnotation } from "$server/ai-enrichment";
import { aiStageInputFor, similarCandidatesFor } from "$server/species-enrichment";

/**
 * Burn badge threshold for the AI & Cost tab (AGY correction 7: a named
 * constant, not a magic number). Context: steady state is ~$50/YEAR; a $15
 * day means a drain or a runaway is in progress and deserves a visible flag.
 */
const HIGH_BURN_PER_DAY_USD = 15; // not exported: SvelteKit rejects extra runtime exports here; it reaches the UI via the loader payload

/**
 * Per-model cap for the compare runner. Compare calls run in PARALLEL
 * (Promise.all) so worst-case wall time ≈ one call — sequential calls would
 * blow nginx's 60s proxy_read_timeout and 504 while still billing.
 */
const COMPARE_TIMEOUT_MS = 45_000;

/** One compare in flight at a time (per process) — each click costs real
 * money across up to four models, and double-submits are the easiest way to
 * double-spend. */
let compareInFlight = false;

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
    usage,
    enrichmentCfg,
    guidanceCfg,
    quickPickRes,
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
    usageAggregates(),
    getConfig(CONFIG_KEYS.enrichmentModel, {
      provider: "anthropic",
      model: DEFAULT_MODEL_IDS.enrichment,
    }),
    getConfig(CONFIG_KEYS.guidanceModel, {
      provider: "anthropic",
      model: DEFAULT_MODEL_IDS.guidance,
    }),
    // Quick-pick species for the Compare Lab: FROM DATA, never hardcoded in
    // the UI (AGY correction 2 — the BTC catalog-duplication defect). Species
    // with similar notes sort first: they exercise the interesting path.
    query<{ code: string; com_name: string }>(
      `SELECT se.species_code AS code, tc.com_name
         FROM species_enrichment se
         JOIN taxonomy_cache tc ON tc.species_code = se.species_code
        WHERE se.wiki_status = 'ok' AND se.wikipedia_extract IS NOT NULL
        ORDER BY EXISTS (SELECT 1 FROM species_similar ss
                          WHERE ss.species_code = se.species_code) DESC,
                 tc.com_name
        LIMIT 6`,
    ),
  ]);

  const now = new Date();
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
    ai: {
      // Registry list FROM the server (one source; the dropdown can never
      // drift from what the actions accept). Rates are today's window.
      models: SELECTABLE_MODELS.map((m) => {
        const rate = rateFor(m.id, now);
        return {
          id: m.id,
          label: m.label,
          description: m.description,
          inPerMTok: rate?.inPerMTok ?? null,
          outPerMTok: rate?.outPerMTok ?? null,
        };
      }),
      current: {
        enrichment: resolveModel(enrichmentCfg, DEFAULT_MODEL_IDS.enrichment).id,
        guidance: resolveModel(guidanceCfg, DEFAULT_MODEL_IDS.guidance).id,
      },
      usage,
      quickPick: quickPickRes.rows.map((r) => ({ code: r.code, comName: r.com_name })),
      highBurnPerDayUsd: HIGH_BURN_PER_DAY_USD,
    },
  };
};

/** Price a compare call's envelope with the ONE formula; null = unpriceable
 * (abort / unknown model) and renders "—", never $0.00. */
function dollarsForAttempts(attempts: CallEnvelope[], at: Date): number | null {
  if (attempts.length === 0) return null;
  let total = 0;
  for (const a of attempts) {
    const d = dollarsForRow({
      billed: a.billed,
      served_model: a.servedModel,
      at,
      input_tokens: a.inputTokens,
      output_tokens: a.outputTokens,
      cache_read_tokens: a.cacheReadTokens,
      cache_write_5m_tokens: a.cacheWrite5mTokens,
      cache_write_1h_tokens: a.cacheWrite1hTokens,
    });
    if (d == null) return null;
    total += d;
  }
  return total;
}

export interface CompareColumn {
  modelId: string;
  label: string;
  ok: boolean;
  /** null = unpriceable (abort) — render "—". */
  dollars: number | null;
  durationMs: number;
  servedModel: string | null;
  /** served ≠ requested (server-side fallback answered). */
  fallback: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  fieldCraft: string | null;
  similar: { code: string; comName: string; note: string }[];
  error: string | null;
  aborted: boolean;
}

export const actions: Actions = {
  /**
   * "Impatient nudge" (Gaylon): run an enrichment scan pass NOW instead of
   * waiting out the idle 24h cadence — e.g. right after new hotspot loads
   * put fresh species in scope. Admin-gated in the action itself (the
   * loader's 404 does not protect POSTs).
   *
   * Every action returns a `kind` discriminant: SvelteKit has ONE ActionData
   * slot per page, and without it a compare result would render under the
   * nudge button (plan §Admin UI).
   */
  nudge_enrichment: async ({ locals }) => {
    if (locals.user?.role !== "admin")
      return fail(403, { kind: "nudge" as const, error: "Admins only." });
    // Runs a scan pass SYNCHRONOUSLY — all currently-due work is queued
    // when this returns, regardless of what the recurring scan is doing
    // (CODEX1: timer nudges race a running scan's stale snapshot).
    const s = await nudgeEnrichmentScan();
    return {
      kind: "nudge" as const,
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

  /** Persist a per-surface model choice. Future calls only — nothing is
   * regenerated. Validation is the registry's (setConfig rejects unknown or
   * non-selectable ids and unknown surfaces). */
  set_ai_model: async ({ locals, request }) => {
    if (locals.user?.role !== "admin")
      return fail(403, { kind: "set_model" as const, error: "Admins only." });
    const form = await request.formData();
    const surface = String(form.get("surface") ?? "");
    const model = String(form.get("model") ?? "");
    const key =
      surface === "enrichment"
        ? CONFIG_KEYS.enrichmentModel
        : surface === "guidance"
          ? CONFIG_KEYS.guidanceModel
          : null;
    if (!key) return fail(400, { kind: "set_model" as const, error: "Unknown surface." });
    try {
      await setConfig(key, { provider: "anthropic", model });
    } catch (err) {
      return fail(400, {
        kind: "set_model" as const,
        error: err instanceof Error ? err.message : "Could not save the model choice.",
      });
    }
    const entry = modelById(model);
    return {
      kind: "set_model" as const,
      ok: true as const,
      surface,
      model,
      message: `${surface === "enrichment" ? "Enrichment" : "Guidance"} now uses ${entry?.label ?? model} — future calls only; nothing is regenerated.`,
    };
  },

  /**
   * Compare Lab: dry-run the REAL annotation (same prompt, schema, answer
   * budget) for one wiki-ok species across the selected models, in parallel.
   * purpose:'compare', modelOverride (never reads or disturbs the dropdowns),
   * nothing persisted to species tables — the ai_usage rows are the receipt.
   * Labelled task-level apples-to-apples: request params deliberately differ
   * per model (thinking, effort, fallbacks), so no parameter-parity claim.
   */
  run_compare: async ({ locals, request }) => {
    if (locals.user?.role !== "admin")
      return fail(403, { kind: "compare" as const, error: "Admins only." });
    const form = await request.formData();
    const species = String(form.get("species") ?? "")
      .trim()
      .toLowerCase();
    const modelIds = form.getAll("models").map(String);
    if (modelIds.length === 0)
      return fail(400, { kind: "compare" as const, error: "Pick at least one model." });
    // The checkbox UI can submit each registry model only once, but the action
    // is the spend boundary: a forged form can repeat the same `models` field
    // hundreds of times. Without this guard one accepted compare fans out into
    // hundreds of identical, billable calls while still passing the allowlist.
    // Reject rather than silently de-duplicating so the response never claims
    // it ran the exact selection the caller submitted.
    const uniqueModelIds = new Set(modelIds);
    if (uniqueModelIds.size !== modelIds.length)
      return fail(400, {
        kind: "compare" as const,
        error: "Each model can be selected only once.",
      });
    const entries = modelIds.map((id) => SELECTABLE_MODELS.find((m) => m.id === id));
    if (entries.some((e) => !e))
      return fail(400, { kind: "compare" as const, error: "Unknown model in selection." });
    if (!species)
      return fail(400, { kind: "compare" as const, error: "Enter a species code." });

    if (compareInFlight)
      return fail(409, {
        kind: "compare" as const,
        error: "A compare is already running — wait for it to finish.",
      });
    compareInFlight = true;
    try {
      // Server-side species guard (AGY correction 3): exists + wiki-ok prose.
      const taxon = (
        await query<{ com_name: string; sci_name: string; family: string | null }>(
          `SELECT com_name, sci_name, family FROM taxonomy_cache WHERE species_code = $1`,
          [species],
        )
      ).rows[0];
      if (!taxon)
        return fail(400, {
          kind: "compare" as const,
          error: `No species with code "${species}".`,
        });
      const stage = await aiStageInputFor(species);
      if (!stage)
        return fail(400, {
          kind: "compare" as const,
          error: `${taxon.com_name} has no stored Wikipedia prose yet — enrich it first.`,
        });
      const candidates = await similarCandidatesFor(species, taxon.sci_name);
      const nameFor = new Map(candidates.map((c) => [c.code, c.comName]));
      const input = {
        comName: taxon.com_name,
        sciName: taxon.sci_name,
        family: taxon.family,
        extract: stage.extract,
        sections: stage.sections,
        candidates,
        speciesCode: species,
      };

      const at = new Date();
      const columns: CompareColumn[] = await Promise.all(
        (entries as NonNullable<(typeof entries)[number]>[]).map(async (entry) => {
          const started = Date.now();
          try {
            const attempt = await meteredAiCall({
              purpose: "compare",
              modelOverride: entry,
              speciesCode: species,
              timeoutMs: COMPARE_TIMEOUT_MS,
              run: async (model, signal) => {
                const { annotation, envelope } = await generateSpeciesAnnotation(
                  input,
                  model,
                  { signal },
                );
                return { result: annotation, envelope };
              },
            });
            const finalAtt = attempt.envelope.attempts.find((a) => a.isFinal);
            return {
              modelId: entry.id,
              label: entry.label,
              ok: true,
              dollars: dollarsForAttempts(attempt.envelope.attempts, at),
              durationMs: Date.now() - started,
              servedModel: attempt.servedModel,
              fallback: attempt.servedModel != null && attempt.servedModel !== entry.id,
              inputTokens: finalAtt?.inputTokens ?? null,
              outputTokens: finalAtt?.outputTokens ?? null,
              thinkingTokens: finalAtt?.thinkingTokens ?? null,
              fieldCraft: attempt.result.fieldCraft,
              similar: attempt.result.similar.map((s) => ({
                code: s.code,
                comName: nameFor.get(s.code) ?? s.code,
                note: s.note,
              })),
              error: null,
              aborted: false,
            } satisfies CompareColumn;
          } catch (err) {
            const envelope = (err as { envelope?: { attempts: CallEnvelope[] } }).envelope;
            const message = err instanceof Error ? err.message : String(err);
            return {
              modelId: entry.id,
              label: entry.label,
              ok: false,
              // A failed call can still carry billed tokens (kitmur); an
              // abort prices to null and renders "—", never $0.00.
              dollars: envelope ? dollarsForAttempts(envelope.attempts, at) : null,
              durationMs: Date.now() - started,
              servedModel: envelope?.attempts.find((a) => a.isFinal)?.servedModel ?? null,
              fallback: false,
              inputTokens: envelope?.attempts.find((a) => a.isFinal)?.inputTokens ?? null,
              outputTokens: envelope?.attempts.find((a) => a.isFinal)?.outputTokens ?? null,
              thinkingTokens: null,
              fieldCraft: null,
              similar: [],
              error: message,
              aborted: /timed out/i.test(message),
            } satisfies CompareColumn;
          }
        }),
      );

      return {
        kind: "compare" as const,
        ok: true as const,
        species,
        speciesName: taxon.com_name,
        columns,
      };
    } finally {
      compareInFlight = false;
    }
  },
};

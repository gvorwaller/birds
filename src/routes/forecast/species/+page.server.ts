import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, subregions, EbirdError } from "$server/ebird";
import {
  attemptMeta,
  ensureFrequencies,
  type EnsureResult,
} from "$server/barchart";
import { speciesLocForecast } from "$server/forecast";

const STATE_CODE_RE = /^US-[A-Z]{2}$/;
const SPECIES_CODE_RE = /^[a-z0-9]{4,12}$/;

interface SpeciesMatch {
  species_code: string;
  com_name: string;
  sci_name: string;
}

// IMPORTANT (loader invariant, see src/routes/+page.server.ts): read query
// params ONLY via url.searchParams.get(key) so the loader depends on the keys
// it uses, not the whole URL. This loader reads cached data only — barchart
// fetching happens exclusively in the loadState action below.
export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.scopeId!;
  const isViewer = locals.user?.role === "viewer";

  const q = (url.searchParams.get("q") ?? "").trim();
  const speciesParam = (url.searchParams.get("species") ?? "").trim();
  const regionParam = (url.searchParams.get("region") ?? "").trim();

  const apiKey = await getEbirdApiKey(userId);
  const credsRow = await query<{ login_set: boolean }>(
    `SELECT (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set
       FROM user_ebird WHERE user_id = $1`,
    [userId],
  );
  const hasLogin = credsRow.rows[0]?.login_set === true;

  // US states via the official API (cache-first, 30-day TTL, stale fallback).
  let states: { code: string; name: string }[] = [];
  let statesStale = false;
  let statesError: string | null = null;
  if (apiKey) {
    try {
      const r = await subregions(apiKey, "US", "subnational1");
      states = r.data;
      statesStale = r.stale;
    } catch (err) {
      statesError =
        err instanceof EbirdError
          ? err.message
          : "Could not load the state list.";
    }
  }

  // Species search (server-side, taxonomy cache only).
  let speciesMatches: SpeciesMatch[] = [];
  if (q) {
    const like = `%${q}%`;
    const r = await query<SpeciesMatch>(
      `SELECT species_code, com_name, sci_name FROM taxonomy_cache
        WHERE category = 'species' AND (com_name ILIKE $1 OR sci_name ILIKE $1)
        ORDER BY (com_name ILIKE $2) DESC, com_name
        LIMIT 12`,
      [like, `${q}%`],
    );
    speciesMatches = r.rows;
  }

  // Selected species (validated against the taxonomy — never echoed blindly).
  let taxon: SpeciesMatch | null = null;
  let speciesError: string | null = null;
  if (speciesParam) {
    if (!SPECIES_CODE_RE.test(speciesParam)) {
      speciesError = "Unrecognized species code.";
    } else {
      const r = await query<SpeciesMatch>(
        `SELECT species_code, com_name, sci_name FROM taxonomy_cache
          WHERE species_code = $1 AND category = 'species'`,
        [speciesParam],
      );
      taxon = r.rows[0] ?? null;
      if (!taxon)
        speciesError = `Species code "${speciesParam}" not found — is the taxonomy synced?`;
    }
  }

  // Selected region, validated by syntax + membership in the state list.
  let region: { code: string; name: string } | null = null;
  let regionError: string | null = null;
  if (regionParam) {
    if (!STATE_CODE_RE.test(regionParam)) {
      regionError = "Unrecognized region code.";
    } else {
      const match = states.find((s) => s.code === regionParam);
      if (match) region = match;
      else if (states.length > 0) regionError = "That region is not a US state.";
      // With no state list (no API key / API down) fall back to syntax-valid:
      // cached forecast data can still render read-only.
      else region = { code: regionParam, name: regionParam };
    }
  }

  const forecast =
    taxon && region
      ? await speciesLocForecast(region.code, taxon.species_code)
      : null;
  const attempt = region
    ? ((await attemptMeta([region.code])).get(region.code) ?? null)
    : null;

  return {
    q,
    speciesMatches,
    taxon,
    speciesError,
    region,
    regionError,
    states,
    statesStale,
    statesError,
    forecast,
    attempt,
    hasApiKey: !!apiKey,
    hasLogin,
    isViewer,
  };
};

export const actions: Actions = {
  /**
   * Fetch/refresh the state-level barchart (1 eBird request). Owner-only
   * (viewers are blocked from POSTs in hooks.server.ts). The region is
   * re-validated server-side against the official state list — form values
   * are never trusted as fetch targets.
   */
  loadState: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString().trim();
    const force = form.get("force") === "1";

    if (!STATE_CODE_RE.test(regionCode)) {
      return fail(400, { error: "Unrecognized region code." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required to list regions — add one in Settings.",
      });
    }
    let stateName: string | null = null;
    try {
      const r = await subregions(apiKey, "US", "subnational1");
      stateName = r.data.find((s) => s.code === regionCode)?.name ?? null;
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not verify the region against eBird.",
      });
    }
    if (!stateName) {
      return fail(400, { error: "That region is not a US state." });
    }

    const ensure: EnsureResult = await ensureFrequencies(
      userId,
      [{ code: regionCode, kind: "region", name: stateName, regionCode }],
      { force },
    );
    return { ensure };
  },
};

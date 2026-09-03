import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validSpeciesCode } from "$server/wikidata";
import { BANDS, COLUMNS, ribbonRegions } from "$server/ribbon";

/**
 * The migration ribbon's drill-down (td-59c2d0 build spec, TD-B): the loaded
 * regions inside one band/column cell, fetched when the drill panel expands.
 * Structure copied from src/routes/api/region-detail/+server.ts.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.scopeId) throw error(401, "Unauthorized");

  const species = (url.searchParams.get("species") ?? "").trim();
  if (!species || !validSpeciesCode(species)) {
    throw error(400, "species is required and must be a valid species code");
  }

  // `Number("")` is 0, and 0 is itself a valid band (the equator row), so a
  // missing/blank param must be rejected BEFORE Number() ever sees it
  // (CODEX1 P2-1 deploy-gate finding) — otherwise it silently reaches
  // ribbonRegions as band 0 instead of 400ing.
  const bandParam = (url.searchParams.get("band") ?? "").trim();
  if (!bandParam) throw error(400, "band is required");
  const band = Number(bandParam);
  if (!Number.isInteger(band) || !(BANDS as readonly number[]).includes(band)) {
    throw error(400, "band must be one of the ribbon's bands");
  }

  const cont = url.searchParams.get("cont") ?? "";
  if (cont !== "ALL" && !(COLUMNS as readonly string[]).includes(cont)) {
    throw error(400, "cont must be a ribbon column or 'ALL'");
  }

  return json(await ribbonRegions(species, band, cont as (typeof COLUMNS)[number] | "ALL"));
};

import type { PageServerLoad } from "./$types";
import {
  guideCounts,
  searchEnrichment,
  type GuideResult,
} from "$server/species-enrichment";
import { ALL_TAGS } from "$lib/species-tags";

/**
 * Field guide (plan Phase 3): read-only search over the enriched species
 * corpus — free text (names UNION prose/tags FTS) + AND-semantics tag chips.
 * Every role reads it (enrichment is communal, badges are scope-personal);
 * GET-driven so results are linkable/restorable.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  // Unknown tags are dropped, not errored — stale links degrade gracefully.
  const tags = url.searchParams.getAll("tags").filter((t) => ALL_TAGS.has(t));
  const active = q.length > 0 || tags.length > 0;

  let results: GuideResult[] = [];
  if (active) {
    results = await searchEnrichment(q, tags, locals.scopeId!);
  }
  return {
    q,
    tags,
    active,
    results,
    counts: await guideCounts(),
  };
};

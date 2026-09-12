import { specialInterestFor } from "$server/special-interest";
import { taxonomySummary } from '$server/taxonomy-reference';
import { speciesViewsFor } from "$server/species-views";
import type { SpeciesView } from "$lib/species-views";
import type { PageServerLoad } from "./$types";
import {
  guideCounts,
  searchGuide,
  type GuideResult,
} from "$server/species-enrichment";
import { ALL_TAGS } from "$lib/species-tags";
import { error } from "@sveltejs/kit";
import {
  countriesList,
  getRegion,
  regionLabel,
  subnational1Of,
} from "$server/regions";
import { guideLocationCoverage } from "$server/guide-location";

/**
 * Field guide (plan Phase 3): read-only search over the enriched species
 * corpus — free text (names UNION prose/tags FTS) + AND-semantics tag chips.
 * Every role reads it (enrichment is communal, badges are scope-personal);
 * GET-driven so results are linkable/restorable.
 */
export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends("app:species-views");
  depends("app:special-interest");
  const interestOnly = url.searchParams.get("interest") === "1";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  // Unknown tags are dropped, not errored — stale links degrade gracefully.
  const tags = [
    ...new Set(url.searchParams.getAll("tags").filter((t) => ALL_TAGS.has(t))),
  ];
  let country = (url.searchParams.get("country") ?? "").trim().toUpperCase();
  const region = (url.searchParams.get("region") ?? "").trim().toUpperCase();
  if (region) {
    const selectedRegion = await getRegion(region);
    if (
      !selectedRegion ||
      selectedRegion.level !== "subnational1" ||
      !selectedRegion.parent
    ) {
      error(400, "Choose a recognized state or region.");
    }
    if (country && country !== selectedRegion.parent)
      error(400, "That region is not in the selected country.");
    country = selectedRegion.parent;
  }
  if (country && (await getRegion(country))?.level !== "country")
    error(400, "Choose a recognized country.");
  const locationCode = region || country;
  const coverage = locationCode
    ? await guideLocationCoverage(locationCode)
    : null;
  const taxonomy = await taxonomySummary();
  const family = url.searchParams.get('family') ?? '';
  if (family && !taxonomy.families.some(f => f.code === family)) error(400, 'Choose a recognized bird family.');
  const requestedSort = url.searchParams.get('sort');
  const sort = requestedSort === 'name' || requestedSort === 'taxonomic' ? requestedSort : 'relevance';
  const rawPage = url.searchParams.get('page') ?? '1';
  if (!/^[1-9][0-9]*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)) || Number(rawPage)>21474836) error(400,'Invalid results page.');
  const page = Number(rawPage);
  const active = interestOnly || !!family || q.length > 0 || tags.length > 0 || !!locationCode;

  const countsP = guideCounts();
  let results: GuideResult[] = [];
  let total = 0;
  if (active) {
    const found = await searchGuide(q, tags, locals.scopeId!, coverage?.locCodes ?? null, {family,sort,page,interestUserId:interestOnly ? locals.user!.id : undefined});
    results = found.rows; total = found.total;
    if (page > 1 && !results.length) error(404, 'Results page unavailable. Return to page one.');
  }
  const pageHref = (n:number) => { const p = new URLSearchParams(url.searchParams); p.set('page',String(n)); return '/species?' + p; };
  let viewed: Record<string, SpeciesView> = {};
  let viewedUnavailable = false;
  try { viewed = await speciesViewsFor(locals.user!.id, results.map(r => r.species_code)); }
  catch { viewedUnavailable = true; }
  let interests: string[] | null;
  try { interests = await specialInterestFor(locals.user!.id, results.map(r => r.species_code)); }
  catch { interests = null; }
  return {
    interestOnly, interests,
    family, sort, page, total, families: taxonomy.families, taxonomyAvailable: taxonomy.ordered>0,
    previous: page>1 ? pageHref(page-1) : null, next: page*100<total ? pageHref(page+1) : null,
    viewed,
    viewedUnavailable,
    q,
    tags,
    active,
    country,
    region,
    countries: (await countriesList())
      .map(({ code, name }) => ({ code, name }))
      // Pin US without changing the shared country list or its remaining order.
      .sort((a, b) => Number(b.code === "US") - Number(a.code === "US")),
    regions: country
      ? (await subnational1Of(country)).map(({ code, name }) => ({
          code,
          name,
        }))
      : [],
    location: coverage
      ? {
          label: await regionLabel(locationCode),
          sourceCount: coverage.locCodes.length,
          wholeArea: coverage.wholeArea,
          beginYear: coverage.beginYear,
          endYear: coverage.endYear,
        }
      : null,
    results,
    counts: await countsP,
  };
};

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
import { parseGuideList } from "$lib/guide-list";
import { error, redirect } from "@sveltejs/kit";
import { countriesList } from "$server/regions";
import {
  guideCounties,
  guideHotspots,
  guideRegions,
  resolveGuideLocation,
} from "$server/guide-location";
import {
  canonicalizeGuideLevelChange,
  guideResultsHref,
  parseGuideLocation,
} from "$lib/guide-location";
import { comparePlaceChoices } from "$lib/place-filter";

/**
 * Field guide (plan Phase 3): read-only search over the enriched species
 * corpus — free text (names UNION prose/tags FTS) + AND-semantics tag chips.
 * Every role reads it (enrichment is communal, badges are scope-personal);
 * GET-driven so results are linkable/restorable.
 */
export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends("app:species-views");
  depends("app:special-interest");
  // A native (no-JavaScript) filter form submits the applied hierarchy next to
  // the selects; canonicalize a changed level (clearing deeper ones) before
  // anything is validated, so the person never meets a stale-descendant 400.
  const canonical = canonicalizeGuideLevelChange(url.searchParams);
  if (canonical) {
    if (!canonical.ok) error(400, canonical.message);
    redirect(303, guideResultsHref(canonical.params));
  }
  // List scope (Phase 9A): All / Need / Seen over the DISPLAY-scope life list.
  // Unknown, blank or repeated values are a 400; an absent one is All.
  const parsedList = parseGuideList(url.searchParams);
  if (!parsedList.ok) error(400, parsedList.message);
  const { list, explicit: listExplicit } = parsedList;
  const interestOnly = url.searchParams.get("interest") === "1";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  // Unknown tags are dropped, not errored — stale links degrade gracefully.
  const tags = [
    ...new Set(url.searchParams.getAll("tags").filter((t) => ALL_TAGS.has(t))),
  ];
  // Geography is one strict contract (hierarchy XOR map + radius): malformed,
  // incomplete, mixed or unverifiable selections are a 400, never a guess.
  const parsedLocation = parseGuideLocation(url.searchParams);
  if (!parsedLocation.ok) error(400, parsedLocation.message);
  const selection = parsedLocation.selection;
  const location = await resolveGuideLocation(selection);
  const country = location?.ancestry.country ?? "";
  const region = location?.ancestry.region ?? "";
  const county = location?.ancestry.county ?? "";
  const hotspot = location?.ancestry.hotspot ?? "";
  const taxonomy = await taxonomySummary();
  const family = url.searchParams.get('family') ?? '';
  if (family && !taxonomy.families.some(f => f.code === family)) error(400, 'Choose a recognized bird family.');
  const requestedSort = url.searchParams.get('sort');
  const sort = requestedSort === 'name' || requestedSort === 'taxonomic' ? requestedSort : 'relevance';
  const rawPage = url.searchParams.get('page') ?? '1';
  if (!/^[1-9][0-9]*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)) || Number(rawPage)>21474836) error(400,'Invalid results page.');
  const page = Number(rawPage);
  const active =
    interestOnly || !!family || q.length > 0 || tags.length > 0 || !!location || listExplicit;

  const countsP = guideCounts();
  let results: GuideResult[] = [];
  let total = 0;
  if (active) {
    const found = await searchGuide(q, tags, locals.scopeId!, location?.locCodes ?? null, {family,sort,page,interestUserId:interestOnly ? locals.user!.id : undefined,list,listBrowse:listExplicit});
    results = found.rows; total = found.total;
    if (page > 1 && !results.length) error(404, 'Results page unavailable. Return to page one.');
  }
  const pageHref = (n:number) => {
    const p = new URLSearchParams(url.searchParams);
    p.set('page', String(n));
    return `/species?${p}#results`;
  };
  let viewed: Record<string, SpeciesView> = {};
  let viewedUnavailable = false;
  try { viewed = await speciesViewsFor(locals.user!.id, results.map(r => r.species_code)); }
  catch { viewedUnavailable = true; }
  let interests: string[] | null;
  try { interests = await specialInterestFor(locals.user!.id, results.map(r => r.species_code)); }
  catch { interests = null; }
  return {
    interestOnly, interests,
    list, listExplicit,
    family, sort, page, total, families: taxonomy.families, taxonomyAvailable: taxonomy.ordered>0,
    previous: page>1 ? pageHref(page-1) : null, next: page*100<total ? pageHref(page+1) : null,
    viewed,
    viewedUnavailable,
    q,
    tags,
    active,
    selection,
    country,
    region,
    county,
    hotspot,
    map: location?.map ?? null,
    countries: (await countriesList())
      .map(({ code, name }) => ({ code, name }))
      .sort(comparePlaceChoices)
      // Owner decision (Phase 8A, reaffirmed 2026-09-25 for td-daff98): the
      // United States stays first; the rest keep the one shared order.
      .sort((a, b) => Number(b.code === "US") - Number(a.code === "US")),
    regions: country ? await guideRegions(country) : [],
    counties: region ? await guideCounties(region) : [],
    hotspots: county ? await guideHotspots(county) : [],
    location: location
      ? {
          kind: location.kind,
          label: location.label,
          officialCountyName: location.officialCountyName,
          sourceCount: location.locCodes.length,
          wholeArea: location.wholeArea,
          beginYear: location.beginYear,
          endYear: location.endYear,
          map: location.map,
        }
      : null,
    results,
    counts: await countsP,
  };
};

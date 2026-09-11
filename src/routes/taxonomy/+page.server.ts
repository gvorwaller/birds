import { familyReference } from "$server/family-enrichment";
import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { taxonomySummary } from "$server/taxonomy-reference";
import { speciesViewsFor } from "$server/species-views";
import { taxonomyHref } from "$lib/taxonomy";

export const load = async ({
  locals,
  url,
  depends,
}: Parameters<PageServerLoad>[0]) => {
  depends("app:species-views");
  const summary = await taxonomySummary();
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const family = url.searchParams.get("family") ?? "";
  const focus = url.searchParams.get("focus") ?? "";
  const selected = summary.families.find((f) => f.code === family);
  const unavailableFamily =
    !!family && !selected && !(family === "unclassified" && summary.missing);
  const order = selected?.order ?? (url.searchParams.get("order") || "");
  const pattern = "%" + q.replace(/[%_\\]/g, "\\$&") + "%";
  // Membership searches include classification labels, with no enrichment dependency.
  const matching = q
    ? await query<{ family_code: string | null; count: number }>(
        `SELECT family_code,count(*)::int AS count FROM taxonomy_cache
    WHERE category='species' AND (com_name ILIKE $1 OR sci_name ILIKE $1 OR species_code ILIKE $1
      OR family ILIKE $1 OR family_sci_name ILIKE $1 OR order_name ILIKE $1 OR banding_codes @> ARRAY[upper($2)]) GROUP BY family_code`,
        [pattern, q],
      )
    : null;
  const matchingCounts = matching
    ? new Map(matching.rows.map((r) => [r.family_code, r.count]))
    : null;
  const families = summary.families
    .filter((f) => !matchingCounts || matchingCounts.has(f.code))
    .map((f) => ({ ...f, matching: matchingCounts?.get(f.code) ?? f.count }));
  const rows =
    family && !unavailableFamily
      ? (
          await query<{
            code: string;
            name: string;
            scientificName: string;
            extinct: boolean | null;
            matchedBandingCode: string | null;
          }>(
            `SELECT species_code AS code,com_name AS name,sci_name AS "scientificName",extinct,
    CASE WHEN banding_codes @> ARRAY[upper($3)] THEN upper($3) END AS "matchedBandingCode"
    FROM taxonomy_cache WHERE category='species' AND (family_code=$1 OR ($1='unclassified' AND family_code IS NULL))
    AND ($3='' OR com_name ILIKE $2 OR sci_name ILIKE $2 OR species_code ILIKE $2 OR family ILIKE $2 OR family_sci_name ILIKE $2 OR order_name ILIKE $2 OR banding_codes @> ARRAY[upper($3)])
    ORDER BY taxon_order NULLS LAST,com_name,species_code`,
            [family, pattern, q],
          )
        ).rows
      : [];
  let viewed: Awaited<ReturnType<typeof speciesViewsFor>> = {},
    viewedUnavailable = false;
  try {
    viewed = await speciesViewsFor(
      locals.user!.id,
      rows.map((r) => r.code),
    );
  } catch {
    viewedUnavailable = true;
  }
  const groups = new Map<string, typeof families>();
  for (const f of families) {
    const key = f.order ?? "Classification unavailable";
    const members = groups.get(key) ?? [];
    members.push(f);
    groups.set(key, members);
  }
  const returnParams = new URLSearchParams({ family });
  if (q) returnParams.set("q", q);
  if (order) returnParams.set("order", order);
  return {
    summary,
    enrichment: await familyReference(family),
    groups: [...groups].map(([name, families]) => ({
      name,
      families,
      count: families.reduce((n, f) => n + f.count, 0),
    })),
    q,
    family,
    order,
    focus,
    selected,
    rows,
    viewed,
    viewedUnavailable,
    unavailableFamily,
    unavailableOrder:
      !!order &&
      !summary.families.some(
        (f) => (f.order ?? "Classification unavailable") === order,
      ),
    missingMatches: matchingCounts
      ? (matchingCounts.get(null) ?? 0)
      : summary.missing,
    focusUnavailable: !!focus && !rows.some((r) => r.code === focus),
    returnTo: "/taxonomy?" + returnParams,
    overview: taxonomyHref(),
  };
};

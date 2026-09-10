import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { studyOptions } from "$lib/species-study";
import { studyCountrySpecies } from "$server/species-study";
import { getRegion } from "$server/regions";

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) error(401, "Unauthorized");
  if (url.searchParams.get("accountId") !== String(locals.user.id))
    error(409, "Account changed; reload this page.");
  const country = url.searchParams.get("country") ?? "";
  if ((await getRegion(country))?.level !== "country")
    error(400, "Choose a recognized country.");
  const { status, sort, q } = studyOptions(url.searchParams);
  try {
    const result = await studyCountrySpecies(
      locals.user.id,
      q,
      status,
      sort === "name",
      country,
    );
    return json(
      {
        rows: result.rows,
        sourceCount: result.locCodes.length,
        wholeArea: result.wholeArea,
        beginYear: result.beginYear,
        endYear: result.endYear,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    error(503, "Could not load this country. Please retry.");
  }
};

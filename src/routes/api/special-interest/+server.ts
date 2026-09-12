import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { setSpecialInterest } from "$server/special-interest";
import { validSpeciesCode } from "$server/wikidata";

export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) error(401, "Unauthorized");
  if (request.headers.get("origin") !== url.origin)
    error(403, "Same-origin request required");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    error(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    error(400, "Invalid selection");
  const b = body as Record<string, unknown>;
  if (b.accountId !== locals.user.id)
    error(409, "Account changed; reload this page");
  if (
    typeof b.speciesCode !== "string" ||
    !validSpeciesCode(b.speciesCode) ||
    typeof b.saved !== "boolean"
  )
    error(400, "Invalid species or selection");
  return json(await setSpecialInterest(locals.user.id, b.speciesCode, b.saved));
};

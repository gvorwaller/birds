import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { recordSpeciesView } from "$server/species-views";
import { validSpeciesCode } from "$server/wikidata";

export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) error(401, "Unauthorized");
  // JSON POSTs need an explicit same-origin check (form CSRF protection does
  // not cover application/json). This also rejects stale cross-origin pages.
  if (request.headers.get("origin") !== url.origin)
    error(403, "Same-origin request required");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    error(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    error(400, "Invalid visit");
  const b = body as Record<string, unknown>;
  if (b.accountId !== locals.user.id)
    error(409, "Account changed; reload this page");
  if (
    typeof b.speciesCode !== "string" ||
    !validSpeciesCode(b.speciesCode) ||
    typeof b.visitId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      b.visitId,
    )
  )
    error(400, "Invalid species or visit ID");
  return json(
    await recordSpeciesView(locals.user.id, b.speciesCode, b.visitId),
  );
};

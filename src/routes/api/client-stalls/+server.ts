import type { RequestHandler } from "./$types";
import { MAX_EVENTS_PER_POST, parseStallEvent } from "$lib/client-stalls";
import { recordClientStalls } from "$server/client-stalls";

/**
 * POST { events: StallEvent[] } — the browser reports its own slow, unfinished
 * and frozen navigations (td-1cb094; src/lib/nav-watch.ts). Any signed-in
 * account, viewers too. Malformed events are skipped, not refused, so one bad
 * report never blocks the rest of a queue. The device is this request's
 * User-Agent. `accountId` is the account the browser recorded the events
 * under: a tab still open from before an account switch would otherwise send
 * them under the new session, so a mismatch is refused (409) and the browser
 * keeps them. It is never permission to write for another account. 503 when
 * the write failed, so the browser keeps the queue.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const { events: raw, accountId } = (body ?? {}) as { events?: unknown; accountId?: unknown };
  if (!Array.isArray(raw) || raw.length > MAX_EVENTS_PER_POST) return new Response(null, { status: 400 });
  if (accountId !== locals.user.id) return new Response(null, { status: 409 });
  const now = Date.now();
  const events = raw.map((e) => parseStallEvent(e, now)).filter((e) => e !== null);
  try {
    await recordClientStalls(locals.user.id, request.headers.get("user-agent") ?? "", events);
  } catch (err) {
    console.error("[client-stalls] write failed:", err instanceof Error ? err.message : err);
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 204 });
};

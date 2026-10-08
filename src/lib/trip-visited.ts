/**
 * Trip stop check-off (td-40a1b5): rules shared by the trip page, its
 * exports and the hooks viewer guard.
 */

/**
 * The one trip mutation a read-only viewer may make: checking a stop off on
 * the owner's trip they read, so people travelling together can tick stops
 * from either phone (the ~/trips app precedent). Exactly the FIRST action
 * `/set_visited` on `/trips/<id>` — SvelteKit dispatches the first `?/name`.
 */
export function isTripVisitedRequest(
  path: string,
  method: string,
  action?: string,
): boolean {
  return (
    method === "POST" &&
    /^\/trips\/[1-9]\d*$/.test(path) &&
    action === "/set_visited"
  );
}

/**
 * The stops a "Navigate" link should still drive through: every located stop
 * not yet checked off, in trip order. `label` names what the link covers.
 * No link when nothing is left, or when the trip only ever had one located
 * stop (its own Directions link already covers that).
 */
export function remainingRoute<T extends { visited?: boolean }>(
  located: T[],
): { stops: T[]; label: string } | null {
  if (located.length < 2) return null;
  const left = located.filter((s) => !s.visited);
  if (left.length === 0) return null;
  if (left.length === located.length)
    return { stops: left, label: "Navigate all stops" };
  return {
    stops: left,
    label:
      left.length === 1
        ? "Navigate to the last stop left"
        : `Navigate the ${left.length} stops left`,
  };
}

/** "2 / 5 visited" — the check-off count used on the trip and Trips list. */
export function visitedCountLabel(visited: number, total: number): string {
  return `${visited} / ${total} visited`;
}

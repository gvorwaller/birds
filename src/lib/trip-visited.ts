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
 * Where a "Navigate" link should still drive: every located stop not yet
 * checked off, in trip order, then back to the trip's start & end point when
 * it has one (td-0f3c63) — Google Maps starts from wherever the phone is.
 * `label` names what the link covers. Without an anchor there is no link when
 * nothing is left, or when the trip only ever had one located stop (its own
 * Directions link covers that); with one there is always a route, if only the
 * drive to the anchor.
 */
export function remainingRoute<
  T extends { lat: number; lng: number; visited?: boolean },
>(
  located: T[],
  anchor: { lat: number; lng: number; label: string } | null = null,
): { points: { lat: number; lng: number }[]; label: string } | null {
  const left = located.filter((s) => !s.visited);
  const points = left.map((s) => ({ lat: s.lat, lng: s.lng }));
  if (anchor) {
    const there = [{ lat: anchor.lat, lng: anchor.lng }];
    // No located stops yet: the route is just the drive to the anchor.
    if (located.length === 0)
      return { points: there, label: `Navigate to ${anchor.label}` };
    const back = `back to ${anchor.label}`;
    const label =
      left.length === 0
        ? `Navigate ${back}`
        : left.length === located.length
          ? `Navigate all stops and ${back}`
          : left.length === 1
            ? `Navigate the last stop left and ${back}`
            : `Navigate the ${left.length} stops left and ${back}`;
    return { points: [...points, ...there], label };
  }
  if (located.length < 2 || left.length === 0) return null;
  if (left.length === located.length)
    return { points, label: "Navigate all stops" };
  return {
    points,
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

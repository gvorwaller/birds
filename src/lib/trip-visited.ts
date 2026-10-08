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
 * Is `today` (YYYY-MM-DD) one of the trip's own days? Inclusive; a trip with
 * only one date set has just that day; a trip with no dates has none.
 */
export function isTripDay(
  start: string | null,
  end: string | null,
  today: string,
): boolean {
  const lo = start ?? end;
  const hi = end ?? start;
  return lo != null && hi != null && lo <= today && today <= hi;
}

/**
 * Where a "Navigate" link should still drive: every located stop not yet
 * checked off, in trip order, then back to the trip's start & end point when
 * it has one (td-0f3c63). It starts from wherever the phone is — except when
 * `fromAnchor`: on any day that isn't one of the trip's own days (planning
 * from home), a trip with an anchor starts there, so the link is the planned
 * day, matching the map's drive total (owner, 2026-10-08). `label` names what
 * the link covers. Without an anchor there is no link when nothing is left,
 * or when the trip only ever had one located stop (its own Directions link
 * covers that); with one there is always a route, if only the drive to it.
 */
export function remainingRoute<
  T extends { lat: number; lng: number; visited?: boolean },
>(
  located: T[],
  anchor: { lat: number; lng: number; label: string } | null = null,
  fromAnchor = false,
): {
  origin: { lat: number; lng: number } | null;
  points: { lat: number; lng: number }[];
  label: string;
} | null {
  const left = located.filter((s) => !s.visited);
  const points = left.map((s) => ({ lat: s.lat, lng: s.lng }));
  if (anchor) {
    const there = { lat: anchor.lat, lng: anchor.lng };
    // Nothing left to visit: the only drive is to the anchor, from here.
    if (left.length === 0)
      return {
        origin: null,
        points: [there],
        label:
          located.length === 0
            ? `Navigate to ${anchor.label}`
            : `Navigate back to ${anchor.label}`,
      };
    const which =
      left.length === located.length
        ? "all stops"
        : left.length === 1
          ? "the last stop left"
          : `the ${left.length} stops left`;
    return fromAnchor
      ? {
          origin: there,
          points: [...points, there],
          label: `Navigate from ${anchor.label} through ${which} and back`,
        }
      : {
          origin: null,
          points: [...points, there],
          label: `Navigate ${which} and back to ${anchor.label}`,
        };
  }
  if (located.length < 2 || left.length === 0) return null;
  if (left.length === located.length)
    return { origin: null, points, label: "Navigate all stops" };
  return {
    origin: null,
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

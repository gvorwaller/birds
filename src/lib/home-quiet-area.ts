/**
 * Home's line for an area with no eBird reports at all in range (td-a54f8c).
 * Without it the species list is simply blank, which reads as broken
 * (Sandnessjøen, 2026-10-12: nothing reported within 50 km in 30 days). The
 * hotspots in range are already loaded for the map, so naming the latest
 * report among them costs no eBird call.
 */
export interface QuietAreaHotspot {
  locName: string;
  /** eBird's "2026-09-09 14:12", or null for a hotspot with no reports. */
  latestObsDt: string | null;
}

/** eBird's "2026-09-09 14:12" as "Sep 9, 2026"; null when absent or malformed. */
export function reportDay(obsDt: string | null | undefined): string | null {
  const day = obsDt?.slice(0, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;
}

/** `within` is the formatted radius ("50 km"), `window` the phrase ("last 30 days"). */
export function quietAreaMessage(
  within: string,
  window: string,
  hotspots: readonly QuietAreaHotspot[],
): string {
  const none = `No eBird reports within ${within} in the ${window}.`;
  if (hotspots.length === 0) return none;
  const latest = hotspots
    .filter((h) => reportDay(h.latestObsDt))
    .sort((a, b) => b.latestObsDt!.localeCompare(a.latestObsDt!))[0];
  const day = reportDay(latest?.latestObsDt);
  if (hotspots.length === 1)
    return `${none} The eBird hotspot in range, ${hotspots[0].locName}, is on the map${
      day ? `; its most recent report was on ${day}` : ""
    }.`;
  return `${none} The ${hotspots.length} eBird hotspots in range are on the map${
    latest && day ? `; the most recent report at one of them was ${latest.locName} on ${day}` : ""
  }.`;
}

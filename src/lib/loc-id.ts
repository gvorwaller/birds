/**
 * eBird location-id shape test: L-prefixed numeric ids are public
 * hotspots/locations with real pages; anything else (personal "P…" etc.)
 * is not linkable. Used by nearest-lifer rows on /nearest and the species
 * page (GROK td-a6c322 pin 4: do NOT use the radius-bounded verified-set —
 * nearest is unbounded, links derive from the id shape alone).
 */
export function isHotspotLocId(locId: string | null | undefined): boolean {
  return typeof locId === "string" && /^L\d+$/.test(locId);
}

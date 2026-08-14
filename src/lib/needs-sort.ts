/**
 * Client-side sort for the Home page's Needs list. Pulled out of
 * `+page.svelte` so the comparator is unit-testable without a component
 * harness — matching the pattern in `place-search.ts`.
 *
 * Types are declared structurally rather than imported from `$server/needs`:
 * importing a server module into client code would drag its module graph
 * (including the DB client) into the browser bundle.
 */

export interface NearestSortablePlace {
  distanceKm: number | null;
}

export interface NearestSortable {
  places: NearestSortablePlace[];
}

/**
 * The species' nearest reported place, in km. Computed as a min over
 * `places` rather than trusting `places[0]` — `places` is only distance-sorted
 * when an origin was available server-side; falling back to "first place" in
 * its absence would silently pick an arbitrary distance instead of the true
 * nearest one.
 */
export function nearestDistanceKm(species: NearestSortable): number | null {
  let min: number | null = null;
  for (const place of species.places) {
    if (place.distanceKm == null) continue;
    if (min == null || place.distanceKm < min) min = place.distanceKm;
  }
  return min;
}

/**
 * Ascending by nearest-place distance; species with no distance (no origin,
 * or no place carried one) sort last, after every species with a real
 * distance. A plain `Array.prototype.sort` is stable in every JS engine this
 * app targets, so ties (including "no distance at all") keep their incoming
 * relative order — which is the Activity order, since that is what feeds this
 * function.
 */
export function sortNeedsByNearest<T extends NearestSortable>(
  needs: T[],
): T[] {
  return [...needs].sort((a, b) => {
    const da = nearestDistanceKm(a);
    const db = nearestDistanceKm(b);
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  });
}

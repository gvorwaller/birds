import type { EbirdObs } from "$server/ebird";
import { haversineKm } from "$lib/geo";
import {
  observationIdentity,
  reportStatus,
  type ReportStatus,
} from "$lib/observation-evidence";

export interface SpeciesObservationDetail extends EbirdObs {
  distanceKm: number | null;
  googlePlaceId: string | null;
  isHotspot: boolean;
}

export { observationIdentity, reportStatus, type ReportStatus } from "$lib/observation-evidence";

/**
 * Identity of one observation: species + place + timestamp.
 *
 * Exported because the nearest ladder (td-73e6f9) probes overlapping regions
 * (a country probe covers its own subnational1s) and must dedupe BEFORE
 * counting hits — five copies of one report must not look like five places.
 * Reused rather than reimplemented so the two paths cannot disagree.
 */
export function obsKey(o: EbirdObs): string {
  return observationIdentity(o);
}

/** Deduplicate copies while preserving conservative status and provenance. */
export function dedupeObservations(rows: EbirdObs[]): EbirdObs[] {
  const byId = new Map<string, EbirdObs>();
  for (const row of rows) {
    const id = observationIdentity(row);
    const prior = byId.get(id);
    if (!prior) {
      byId.set(id, {
        ...row,
        sources: [...new Set([...(row.sources ?? []), ...(row.source ? [row.source] : [])])],
      });
      continue;
    }
    const sources = [...new Set([
      ...(prior.sources ?? []),
      ...(prior.source ? [prior.source] : []),
      ...(row.sources ?? []),
      ...(row.source ? [row.source] : []),
    ])];
    // Explicit false wins; true is retained only when no false is present;
    // absence stays unknown.
    const obsValid = prior.obsValid === false || row.obsValid === false
      ? false
      : prior.obsValid === true || row.obsValid === true
        ? true
        : undefined;
    // The first feed is primary for count/time/location payload fields. Only
    // evidence metadata is merged from a duplicate secondary copy.
    byId.set(id, { ...prior, obsValid, sources });
  }
  return [...byId.values()];
}

export function mergeSpeciesObservations(
  speciesCode: string,
  primary: EbirdObs[],
  secondary: EbirdObs[],
): EbirdObs[] {
  return dedupeObservations([
    ...primary.filter((o) => o.speciesCode === speciesCode).map((o) => ({ ...o, source: o.source ?? "recent" })),
    ...secondary.filter((o) => o.speciesCode === speciesCode).map((o) => ({ ...o, source: o.source ?? "notable" })),
  ]);
}

export function speciesObservationDetails(
  observations: EbirdObs[],
  home: { lat: number; lon: number } | null,
  locationPlaceIds: Map<string, string> = new Map(),
  hotspotLocIds: Set<string> = new Set(),
): SpeciesObservationDetail[] {
  return observations
    .map((o) => ({
      ...o,
      isHotspot: o.locId ? hotspotLocIds.has(o.locId) : false,
      distanceKm: home ? haversineKm(home.lat, home.lon, o.lat, o.lng) : null,
      googlePlaceId: o.locId ? (locationPlaceIds.get(o.locId) ?? null) : null,
    }))
    .sort((a, b) =>
      home
        ? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)
        : b.obsDt.localeCompare(a.obsDt),
    );
}

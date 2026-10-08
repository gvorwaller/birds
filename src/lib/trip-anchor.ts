/**
 * A trip's start & end point (td-0f3c63), e.g. the hotel on a birding trip.
 * Pure (no DB) so the page, the export builder and tests can share it.
 */
export type AnchorSource = "place" | "stop" | "home";

export interface TripAnchor {
  source: AnchorSource;
  label: string;
  lat: number;
  lon: number;
}

/** The trip row's anchor as one value, or null when it has none. */
export function tripAnchor(trip: {
  anchor_source: AnchorSource | null;
  anchor_label: string | null;
  anchor_lat: number | null;
  anchor_lon: number | null;
}): TripAnchor | null {
  return trip.anchor_source != null &&
    trip.anchor_label != null &&
    trip.anchor_lat != null &&
    trip.anchor_lon != null
    ? {
        source: trip.anchor_source,
        label: trip.anchor_label,
        lat: trip.anchor_lat,
        lon: trip.anchor_lon,
      }
    : null;
}

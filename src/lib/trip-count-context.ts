export type TripCountSource = "area-recent-preview" | "area-notable-preview";
export type TripCountSeenStatus = "needs" | "all";
export type HotspotTripCountSource = "hotspot-recent" | "hotspot-notable";

export interface TripCountContext {
  version: 1;
  source: TripCountSource;
  seenStatus: TripCountSeenStatus;
  daysBack: number;
  anchorLat: number;
  anchorLng: number;
  radiusKm: number;
  anchorLabel: string;
  locationId: string | null;
  locationLat: number;
  locationLng: number;
  count: number;
  fetchedAt: string;
  plannedAt: string;
  stale: boolean;
}

export interface HotspotTripCountContext extends Omit<
  TripCountContext,
  "version" | "source" | "locationId"
> {
  version: 2;
  source: HotspotTripCountSource;
  reportPolicy: "including-unconfirmed";
  locationId: string;
}

export type AnyTripCountContext = TripCountContext | HotspotTripCountContext;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseTripCountContext(value: unknown): TripCountContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  const keys = [
    "version",
    "source",
    "seenStatus",
    "daysBack",
    "anchorLat",
    "anchorLng",
    "radiusKm",
    "anchorLabel",
    "locationId",
    "locationLat",
    "locationLng",
    "count",
    "fetchedAt",
    "plannedAt",
    "stale",
  ];
  if (Object.keys(x).some((key) => !keys.includes(key))) return null;
  if (x.version !== 1) return null;
  if (x.source !== "area-recent-preview" && x.source !== "area-notable-preview")
    return null;
  if (x.seenStatus !== "needs" && x.seenStatus !== "all") return null;
  if (
    !Number.isInteger(x.daysBack) ||
    (x.daysBack as number) < 1 ||
    (x.daysBack as number) > 30
  )
    return null;
  if (!finite(x.anchorLat) || x.anchorLat < -90 || x.anchorLat > 90)
    return null;
  if (!finite(x.anchorLng) || x.anchorLng < -180 || x.anchorLng > 180)
    return null;
  if (!finite(x.radiusKm) || x.radiusKm <= 0 || x.radiusKm > 50) return null;
  if (
    typeof x.anchorLabel !== "string" ||
    !x.anchorLabel.trim() ||
    x.anchorLabel.length > 200
  )
    return null;
  if (x.locationId !== null && typeof x.locationId !== "string") return null;
  if (!finite(x.locationLat) || x.locationLat < -90 || x.locationLat > 90)
    return null;
  if (!finite(x.locationLng) || x.locationLng < -180 || x.locationLng > 180)
    return null;
  if (!Number.isSafeInteger(x.count) || (x.count as number) < 0) return null;
  if (!validDate(x.fetchedAt) || !validDate(x.plannedAt)) return null;
  if (typeof x.stale !== "boolean") return null;
  return {
    version: 1,
    source: x.source as TripCountSource,
    seenStatus: x.seenStatus as TripCountSeenStatus,
    daysBack: x.daysBack as number,
    anchorLat: x.anchorLat as number,
    anchorLng: x.anchorLng as number,
    radiusKm: x.radiusKm as number,
    anchorLabel: x.anchorLabel as string,
    locationId: x.locationId as string | null,
    locationLat: x.locationLat as number,
    locationLng: x.locationLng as number,
    count: x.count as number,
    fetchedAt: x.fetchedAt as string,
    plannedAt: x.plannedAt as string,
    stale: x.stale as boolean,
  };
}

export function parseAnyTripCountContext(
  value: unknown,
): AnyTripCountContext | null {
  const v1 = parseTripCountContext(value);
  if (v1) return v1;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  const keys = [
    "version",
    "source",
    "reportPolicy",
    "seenStatus",
    "daysBack",
    "anchorLat",
    "anchorLng",
    "radiusKm",
    "anchorLabel",
    "locationId",
    "locationLat",
    "locationLng",
    "count",
    "fetchedAt",
    "plannedAt",
    "stale",
  ];
  if (Object.keys(x).some((key) => !keys.includes(key))) return null;
  if (
    x.version !== 2 ||
    (x.source !== "hotspot-recent" && x.source !== "hotspot-notable") ||
    x.reportPolicy !== "including-unconfirmed"
  )
    return null;
  if (x.seenStatus !== "needs" && x.seenStatus !== "all") return null;
  if (
    !Number.isInteger(x.daysBack) ||
    (x.daysBack as number) < 1 ||
    (x.daysBack as number) > 30
  )
    return null;
  if (
    !finite(x.anchorLat) ||
    x.anchorLat < -90 ||
    x.anchorLat > 90 ||
    !finite(x.anchorLng) ||
    x.anchorLng < -180 ||
    x.anchorLng > 180
  )
    return null;
  if (
    !finite(x.radiusKm) ||
    x.radiusKm <= 0 ||
    x.radiusKm > 50 ||
    typeof x.anchorLabel !== "string" ||
    !x.anchorLabel.trim() ||
    x.anchorLabel.length > 200
  )
    return null;
  if (typeof x.locationId !== "string" || !x.locationId.trim()) return null;
  if (
    !finite(x.locationLat) ||
    x.locationLat < -90 ||
    x.locationLat > 90 ||
    !finite(x.locationLng) ||
    x.locationLng < -180 ||
    x.locationLng > 180
  )
    return null;
  if (
    !Number.isSafeInteger(x.count) ||
    (x.count as number) < 0 ||
    !validDate(x.fetchedAt) ||
    !validDate(x.plannedAt) ||
    typeof x.stale !== "boolean"
  )
    return null;
  return {
    version: 2,
    source: x.source as HotspotTripCountSource,
    reportPolicy: "including-unconfirmed",
    seenStatus: x.seenStatus as TripCountSeenStatus,
    daysBack: x.daysBack as number,
    anchorLat: x.anchorLat as number,
    anchorLng: x.anchorLng as number,
    radiusKm: x.radiusKm as number,
    anchorLabel: x.anchorLabel as string,
    locationId: x.locationId as string,
    locationLat: x.locationLat as number,
    locationLng: x.locationLng as number,
    count: x.count as number,
    fetchedAt: x.fetchedAt as string,
    plannedAt: x.plannedAt as string,
    stale: x.stale as boolean,
  };
}

export function countModeLabel(
  status: TripCountSeenStatus,
  count?: number,
): string {
  if (status === "all") return "species";
  return count === 1 ? "need" : "needs";
}

export function countModeDescription(status: TripCountSeenStatus): string {
  return status === "all" ? "All species" : "My needs";
}

export function formatPlannedCountSnapshot(
  context: AnyTripCountContext,
  radiusLabel: string,
  neutral = false,
): string {
  const noun = countModeLabel(context.seenStatus, context.count);
  const source =
    context.source === "area-notable-preview"
      ? "notable reports"
      : context.source === "hotspot-recent" ||
          context.source === "hotspot-notable"
        ? "hotspot reports"
        : "area-feed preview";
  const ownerNoun =
    neutral && context.seenStatus === "needs"
      ? context.count === 1
        ? "need"
        : "needs"
      : noun;
  const stale = context.stale ? " · cached/stale feed" : "";
  const fetched = new Date(context.fetchedAt).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const hotspot =
    context.version === 2
      ? ` reported at this hotspot · ${context.source === "hotspot-notable" ? "notable/rare reports" : "recent reports"} · includes unconfirmed reports`
      : ` in the ${source} at this location · within ${radiusLabel} of ${context.anchorLabel}`;
  return `When planned: ${context.count} ${ownerNoun}${hotspot} · last ${context.daysBack} days${stale} · fetched ${fetched}`;
}

export function formatLegacyCountSnapshot(count: number): string {
  return `When planned: ${count} matches; original scope and window were not recorded.`;
}

export function contextMatchesStop(
  context: AnyTripCountContext,
  stop: {
    hotspot_id: string | null;
    lat: number | null;
    lon: number | null;
    target_count_at_save: number | null;
  },
): boolean {
  return (
    stop.lat != null &&
    stop.lon != null &&
    context.locationId === stop.hotspot_id &&
    context.locationLat === stop.lat &&
    context.locationLng === stop.lon &&
    context.count === stop.target_count_at_save
  );
}

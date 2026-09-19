export type TripCountSource = "area-recent-preview" | "area-notable-preview";
export type TripCountSeenStatus = "needs" | "all";

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

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

export function parseTripCountContext(value: unknown): TripCountContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  const keys = ["version", "source", "seenStatus", "daysBack", "anchorLat", "anchorLng", "radiusKm", "anchorLabel", "locationId", "locationLat", "locationLng", "count", "fetchedAt", "plannedAt", "stale"];
  if (Object.keys(x).some((key) => !keys.includes(key))) return null;
  if (x.version !== 1) return null;
  if (x.source !== "area-recent-preview" && x.source !== "area-notable-preview") return null;
  if (x.seenStatus !== "needs" && x.seenStatus !== "all") return null;
  if (!Number.isInteger(x.daysBack) || (x.daysBack as number) < 1 || (x.daysBack as number) > 30) return null;
  if (!finite(x.anchorLat) || x.anchorLat < -90 || x.anchorLat > 90) return null;
  if (!finite(x.anchorLng) || x.anchorLng < -180 || x.anchorLng > 180) return null;
  if (!finite(x.radiusKm) || x.radiusKm <= 0 || x.radiusKm > 50) return null;
  if (typeof x.anchorLabel !== "string" || !x.anchorLabel.trim() || x.anchorLabel.length > 200) return null;
  if (x.locationId !== null && typeof x.locationId !== "string") return null;
  if (!finite(x.locationLat) || x.locationLat < -90 || x.locationLat > 90) return null;
  if (!finite(x.locationLng) || x.locationLng < -180 || x.locationLng > 180) return null;
  if (!Number.isSafeInteger(x.count) || (x.count as number) < 0) return null;
  if (!validDate(x.fetchedAt) || !validDate(x.plannedAt)) return null;
  if (typeof x.stale !== "boolean") return null;
  return x as unknown as TripCountContext;
}

export function countModeLabel(status: TripCountSeenStatus, count?: number): string {
  if (status === "all") return "species";
  return count === 1 ? "need" : "needs";
}

export function countModeDescription(status: TripCountSeenStatus): string {
  return status === "all" ? "All species" : "My needs";
}

export function formatPlannedCountSnapshot(
  context: TripCountContext,
  radiusLabel: string,
  neutral = false,
): string {
  const noun = countModeLabel(context.seenStatus, context.count);
  const source = context.source === "area-notable-preview" ? "notable reports" : "area-feed preview";
  const ownerNoun = neutral && context.seenStatus === "needs" ? (context.count === 1 ? "need" : "needs") : noun;
  const stale = context.stale ? " · cached/stale feed" : "";
  const fetched = new Date(context.fetchedAt).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `When planned: ${context.count} ${ownerNoun} in the ${source} at this location · last ${context.daysBack} days · within ${radiusLabel} of ${context.anchorLabel}${stale} · fetched ${fetched}`;
}

export function formatLegacyCountSnapshot(count: number): string {
  return `When planned: ${count} matches; original scope and window were not recorded.`;
}

export function contextMatchesStop(
  context: TripCountContext,
  stop: { hotspot_id: string | null; lat: number | null; lon: number | null; target_count_at_save: number | null },
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

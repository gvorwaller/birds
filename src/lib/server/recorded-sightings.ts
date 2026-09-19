import { haversineKm } from "$lib/geo";

export interface RecordedSighting {
  speciesCode: string;
  comName: string;
  firstSeen: string | null;
  locationName: string | null;
  locId: string | null;
  subId: string | null;
  obsCount: number | null;
  lat: number | null;
  lng: number | null;
}

export interface RecordedSightingView extends RecordedSighting {
  distanceKm: number | null;
  inWindow: boolean;
  inRadius: boolean;
  locationUnavailable: boolean;
  undated: boolean;
}

export function recordedDateBounds(days: number, today = new Date()): { start: string; end: string } {
  const end = today.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days + 1))
    .toISOString().slice(0, 10);
  return { start, end };
}

function validIsoDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function recordedSightingsInWindow(
  rows: readonly RecordedSighting[],
  home: { lat: number; lng: number } | null,
  days: number,
  today = new Date(),
): RecordedSightingView[] {
  const { start, end } = recordedDateBounds(days, today);
  return rows.map((row) => {
    const validDate = validIsoDate(row.firstSeen);
    const inWindow = !!validDate && row.firstSeen! >= start && row.firstSeen! <= end;
    const hasCoords = Number.isFinite(row.lat) && Number.isFinite(row.lng)
      && row.lat! >= -90 && row.lat! <= 90 && row.lng! >= -180 && row.lng! <= 180;
    const distanceKm = home && hasCoords ? haversineKm(home.lat, home.lng, row.lat!, row.lng!) : null;
    return {
      ...row,
      distanceKm,
      inWindow,
      inRadius: distanceKm != null && distanceKm <= Number.POSITIVE_INFINITY,
      locationUnavailable: !hasCoords,
      undated: !validDate,
    };
  });
}

export function recordedSightingsForHome(
  rows: readonly RecordedSighting[],
  home: { lat: number; lng: number } | null,
  radiusKm: number,
  days: number,
  today = new Date(),
): RecordedSightingView[] {
  return recordedSightingsInWindow(rows, home, days, today).map((row) => ({
    ...row,
    inRadius: row.distanceKm != null && row.distanceKm <= radiusKm,
  }));
}

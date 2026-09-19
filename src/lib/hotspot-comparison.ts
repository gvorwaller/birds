/** Client safe contracts and pure helpers for the comparable hotspot view. */

export type ComparisonSeenStatus = "all" | "needs";
export type ComparisonState = "unqueried" | "fresh" | "stale" | "failed";

export interface HotspotReference {
  locId: string;
  locName: string;
  lat: number;
  lng: number;
  distanceKm: number;
  googlePlaceId: string | null;
}

export interface ComparisonSpecies {
  code: string;
  comName: string;
  sciName: string;
  obsDt: string;
  obsValid?: boolean;
}

export interface HotspotComparisonRow extends HotspotReference {
  state: ComparisonState;
  count: number | null;
  species: ComparisonSpecies[];
  latestObsDt: string | null;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  token: string | null;
}

export interface ComparisonFilters {
  lat: number;
  lng: number;
  radiusKm: number;
  daysBack: number;
  seenStatus: ComparisonSeenStatus;
  rareOnly: boolean;
  anchorLabel: string;
}

export interface ComparisonProgress {
  total: number;
  checked: number;
  fresh: number;
  stale: number;
  failed: number;
  unqueried: number;
}

export interface ComparisonInitResponse {
  status: "ready" | "unavailable" | "restart-required";
  message?: string;
  identity?: string;
  references?: HotspotReference[];
  referenceFetchedAt?: string;
  referenceStale?: boolean;
}

export interface ComparisonBatchResponse extends ComparisonInitResponse {
  rows?: HotspotComparisonRow[];
  stopScheduling?: boolean;
}

export interface RawComparisonObservation {
  speciesCode: string;
  comName: string;
  sciName: string;
  locId: string;
  obsDt: string;
  lat: number;
  lng: number;
  obsValid?: boolean;
}

export function comparisonQueryKey(filters: ComparisonFilters): string {
  return [
    filters.lat,
    filters.lng,
    filters.radiusKm,
    filters.daysBack,
    filters.seenStatus,
    filters.rareOnly ? 1 : 0,
    filters.anchorLabel,
  ].join("|");
}

export function progressForRows(
  rows: HotspotComparisonRow[],
): ComparisonProgress {
  const progress: ComparisonProgress = {
    total: rows.length,
    checked: 0,
    fresh: 0,
    stale: 0,
    failed: 0,
    unqueried: 0,
  };
  for (const row of rows) {
    if (row.state === "fresh") {
      progress.checked++;
      progress.fresh++;
    } else if (row.state === "stale") {
      progress.checked++;
      progress.stale++;
    } else if (row.state === "failed") {
      progress.checked++;
      progress.failed++;
    } else progress.unqueried++;
  }
  return progress;
}

export function comparisonComplete(
  rows: HotspotComparisonRow[],
  referenceStale: boolean,
): boolean {
  return (
    rows.length > 0 &&
    !referenceStale &&
    rows.every((row) => row.state === "fresh")
  );
}

export function compareRows(
  a: HotspotComparisonRow,
  b: HotspotComparisonRow,
): number {
  const aCount = a.count ?? -1;
  const bCount = b.count ?? -1;
  return (
    bCount - aCount ||
    (b.latestObsDt ?? "").localeCompare(a.latestObsDt ?? "") ||
    a.distanceKm - b.distanceKm ||
    a.locId.localeCompare(b.locId)
  );
}

export function sortedComparisonRows(
  rows: HotspotComparisonRow[],
): HotspotComparisonRow[] {
  return [...rows].sort(compareRows);
}

export function aggregateComparisonObservations(
  observations: unknown,
  locationId: string,
  seen: ReadonlySet<string>,
  seenStatus: ComparisonSeenStatus,
):
  | {
      ok: true;
      species: ComparisonSpecies[];
      count: number;
      latestObsDt: string | null;
    }
  | { ok: false; error: string } {
  if (!Array.isArray(observations))
    return {
      ok: false,
      error: "The hotspot feed returned an invalid response.",
    };
  const byCode = new Map<string, ComparisonSpecies>();
  for (const raw of observations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return {
        ok: false,
        error: "The hotspot feed contained an invalid observation.",
      };
    const row = raw as Record<string, unknown>;
    if (
      typeof row.speciesCode !== "string" ||
      !row.speciesCode.trim() ||
      typeof row.comName !== "string" ||
      !row.comName.trim() ||
      typeof row.sciName !== "string" ||
      !row.sciName.trim() ||
      typeof row.locId !== "string" ||
      !row.locId.trim() ||
      typeof row.obsDt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(row.obsDt) ||
      typeof row.lat !== "number" ||
      !Number.isFinite(row.lat) ||
      typeof row.lng !== "number" ||
      !Number.isFinite(row.lng) ||
      row.lat < -90 ||
      row.lat > 90 ||
      row.lng < -180 ||
      row.lng > 180
    ) {
      return {
        ok: false,
        error: "The hotspot feed contained an incomplete observation.",
      };
    }
    if (row.locId !== locationId) continue;
    if (seenStatus === "needs" && seen.has(row.speciesCode)) continue;
    const existing = byCode.get(row.speciesCode);
    if (!existing || row.obsDt > existing.obsDt) {
      byCode.set(row.speciesCode, {
        code: row.speciesCode,
        comName: row.comName,
        sciName: row.sciName,
        obsDt: row.obsDt,
        ...(typeof row.obsValid === "boolean"
          ? { obsValid: row.obsValid }
          : {}),
      });
    }
  }
  const species = [...byCode.values()].sort(
    (a, b) => b.obsDt.localeCompare(a.obsDt) || a.code.localeCompare(b.code),
  );
  return {
    ok: true,
    species,
    count: species.length,
    latestObsDt: species[0]?.obsDt ?? null,
  };
}

export function chunkIds(ids: string[], size = 4): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size)
    chunks.push(ids.slice(i, i + size));
  return chunks;
}

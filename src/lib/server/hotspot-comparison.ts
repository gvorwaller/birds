import { createHash } from "node:crypto";
import { haversineKm } from "$lib/geo";
import {
  aggregateComparisonObservations,
  type ComparisonFilters,
  type HotspotComparisonRow,
  type HotspotReference,
} from "$lib/hotspot-comparison";
import { issueTripCountToken } from "$server/trip-count-token";
import { googlePlaceIdsForLocIds } from "$server/location-placeids";
import { seenSet } from "$server/needs";
import {
  EbirdError,
  hotspotsNear,
  notableObs,
  recentHotspotObs,
} from "$server/ebird";

export class ComparisonError extends Error {
  constructor(
    message: string,
    public status = 400,
    public stopScheduling = false,
  ) {
    super(message);
    this.name = "ComparisonError";
  }
}

export interface ComparisonIdentity {
  value: string;
  references: HotspotReference[];
  referenceFetchedAt: string;
  referenceStale: boolean;
  referenceRefreshErrorStatus?: number;
  seen: Set<string>;
}

interface AccountScope {
  accountId: number;
  scopeOwnerId: number;
}

function validFilters(filters: ComparisonFilters): void {
  if (!Number.isFinite(filters.lat) || filters.lat < -90 || filters.lat > 90)
    throw new ComparisonError("Invalid comparison latitude.");
  if (!Number.isFinite(filters.lng) || filters.lng < -180 || filters.lng > 180)
    throw new ComparisonError("Invalid comparison longitude.");
  if (
    !Number.isFinite(filters.radiusKm) ||
    filters.radiusKm < 1 ||
    filters.radiusKm > 50
  )
    throw new ComparisonError("Invalid comparison radius.");
  if (
    !Number.isInteger(filters.daysBack) ||
    filters.daysBack < 1 ||
    filters.daysBack > 30
  )
    throw new ComparisonError("Invalid comparison window.");
  if (filters.seenStatus !== "all" && filters.seenStatus !== "needs")
    throw new ComparisonError("Invalid comparison scope.");
  if (typeof filters.rareOnly !== "boolean")
    throw new ComparisonError("Invalid comparison report mode.");
  if (
    typeof filters.anchorLabel !== "string" ||
    !filters.anchorLabel.trim() ||
    filters.anchorLabel.length > 200
  )
    throw new ComparisonError("Invalid comparison location label.");
}

function referenceRows(
  raw: unknown,
  filters: ComparisonFilters,
): HotspotReference[] {
  if (!Array.isArray(raw))
    throw new ComparisonError(
      "eBird hotspot references were unavailable.",
      503,
    );
  const byId = new Map<string, HotspotReference>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ComparisonError(
        "eBird hotspot references were malformed.",
        503,
      );
    const x = item as Record<string, unknown>;
    if (
      typeof x.locId !== "string" ||
      !/^L\d+$/.test(x.locId) ||
      typeof x.locName !== "string" ||
      !x.locName.trim() ||
      typeof x.lat !== "number" ||
      !Number.isFinite(x.lat) ||
      x.lat < -90 ||
      x.lat > 90 ||
      typeof x.lng !== "number" ||
      !Number.isFinite(x.lng) ||
      x.lng < -180 ||
      x.lng > 180
    )
      throw new ComparisonError(
        "eBird hotspot references were malformed.",
        503,
      );
    const distanceKm = haversineKm(filters.lat, filters.lng, x.lat, x.lng);
    if (distanceKm > filters.radiusKm + 0.5 || byId.has(x.locId)) continue;
    byId.set(x.locId, {
      locId: x.locId,
      locName: x.locName,
      lat: x.lat,
      lng: x.lng,
      distanceKm,
      googlePlaceId: null,
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.distanceKm - b.distanceKm || a.locId.localeCompare(b.locId),
  );
}

function identityText(
  filters: ComparisonFilters,
  account: AccountScope,
  refs: HotspotReference[],
  seen: Set<string>,
): string {
  const normalized = {
    accountId: account.accountId,
    scopeOwnerId: account.scopeOwnerId,
    lat: Number(filters.lat.toFixed(2)),
    lng: Number(filters.lng.toFixed(2)),
    radiusKm: filters.radiusKm,
    daysBack: filters.daysBack,
    seenStatus: filters.seenStatus,
    rareOnly: filters.rareOnly,
    anchorLabel: filters.anchorLabel,
    refs: refs
      .map((r) => [r.locId, r.lat, r.lng])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    seen: filters.seenStatus === "needs" ? [...seen].sort() : [],
  };
  return JSON.stringify(normalized);
}

function identityHash(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

export async function resolveComparison(
  apiKey: string,
  filters: ComparisonFilters,
  account: AccountScope,
): Promise<ComparisonIdentity> {
  validFilters(filters);
  const [reference, seen] = await Promise.all([
    hotspotsNear(apiKey, filters.lat, filters.lng, filters.radiusKm),
    seenSet(account.scopeOwnerId),
  ]);
  const refs = referenceRows(reference.data, filters);
  const mapped = await googlePlaceIdsForLocIds(refs.map((r) => r.locId));
  for (const ref of refs) ref.googlePlaceId = mapped.get(ref.locId) ?? null;
  const value = identityHash(identityText(filters, account, refs, seen));
  return {
    value,
    references: refs,
    referenceFetchedAt: reference.fetchedAt.toISOString(),
    referenceStale: reference.stale,
    referenceRefreshErrorStatus: reference.refreshErrorStatus,
    seen,
  };
}

class Semaphore {
  private active = 0;
  private waiters: Array<(release: () => void) => void> = [];
  async acquire(): Promise<() => void> {
    if (this.active < 4) return this.makeRelease();
    return new Promise<() => void>((resolve) => this.waiters.push(resolve));
  }
  private makeRelease(addSlot = true): () => void {
    if (addSlot) this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) waiter(this.makeRelease(false));
      else this.active--;
    };
  }
}

const fetchSlots = new Semaphore();

function emptyRows(refs: HotspotReference[]): HotspotComparisonRow[] {
  return refs.map((ref) => ({
    ...ref,
    state: "unqueried",
    count: null,
    species: [],
    latestObsDt: null,
    fetchedAt: null,
    stale: false,
    error: null,
    token: null,
  }));
}

export async function compareHotspotBatch(
  apiKey: string,
  filters: ComparisonFilters,
  account: AccountScope,
  ids: string[],
  expectedIdentity: string,
  signal?: AbortSignal,
): Promise<{
  rows: HotspotComparisonRow[];
  stopScheduling: boolean;
  identity: ComparisonIdentity;
}> {
  if (ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length)
    throw new ComparisonError("Choose one to four unique hotspots.");
  const identity = await resolveComparison(apiKey, filters, account);
  if (identity.value !== expectedIdentity)
    throw new ComparisonError(
      "The comparison scope changed. Restart the comparison.",
      409,
    );
  if (
    identity.referenceRefreshErrorStatus === 401 ||
    identity.referenceRefreshErrorStatus === 403 ||
    identity.referenceRefreshErrorStatus === 429
  ) {
    return { rows: [], stopScheduling: true, identity };
  }
  const refs = ids.map((id) =>
    identity.references.find((ref) => ref.locId === id),
  );
  if (refs.some((ref) => !ref))
    throw new ComparisonError(
      "One or more hotspots are outside the comparison references.",
    );
  let stopScheduling = false;
  const runOne = async (
    ref: HotspotReference,
  ): Promise<HotspotComparisonRow | null> => {
    if (signal?.aborted || stopScheduling) return null;
    const release = await fetchSlots.acquire();
    try {
      if (signal?.aborted || stopScheduling) return null;
      let result;
      try {
        result = filters.rareOnly
          ? await notableObs(apiKey, ref.locId, filters.daysBack)
          : await recentHotspotObs(apiKey, ref.locId, filters.daysBack);
      } catch (err) {
        const status = err instanceof EbirdError ? err.status : undefined;
        if (status === 401 || status === 403 || status === 429)
          stopScheduling = true;
        return {
          ...ref,
          state: "failed",
          count: null,
          species: [],
          latestObsDt: null,
          fetchedAt: null,
          stale: false,
          error:
            status === 401 || status === 403
              ? "eBird authorization failed."
              : status === 429
                ? "eBird rate limit reached."
                : "This hotspot could not be checked.",
          token: null,
        };
      }
      const aggregate = aggregateComparisonObservations(
        result.data,
        ref.locId,
        identity.seen,
        filters.seenStatus,
      );
      if (!aggregate.ok)
        return {
          ...ref,
          state: "failed",
          count: null,
          species: [],
          latestObsDt: null,
          fetchedAt: result.fetchedAt.toISOString(),
          stale: result.stale,
          error: aggregate.error,
          token: null,
        };
      const context = {
        version: 2 as const,
        source: filters.rareOnly
          ? ("hotspot-notable" as const)
          : ("hotspot-recent" as const),
        reportPolicy: "including-unconfirmed" as const,
        seenStatus: filters.seenStatus,
        daysBack: filters.daysBack,
        anchorLat: Number(filters.lat.toFixed(2)),
        anchorLng: Number(filters.lng.toFixed(2)),
        radiusKm: filters.radiusKm,
        anchorLabel: filters.anchorLabel,
        locationId: ref.locId,
        locationLat: ref.lat,
        locationLng: ref.lng,
        count: aggregate.count,
        fetchedAt: result.fetchedAt.toISOString(),
        plannedAt: new Date().toISOString(),
        stale: result.stale,
      };
      const staleStatus = result.refreshErrorStatus;
      if (staleStatus === 401 || staleStatus === 403 || staleStatus === 429)
        stopScheduling = true;
      return {
        ...ref,
        state: result.stale ? "stale" : "fresh",
        count: aggregate.count,
        species: aggregate.species,
        latestObsDt: aggregate.latestObsDt,
        fetchedAt: result.fetchedAt.toISOString(),
        stale: result.stale,
        error: result.stale ? "Cached hotspot data; refresh failed." : null,
        token: issueTripCountToken(
          account.accountId,
          account.scopeOwnerId,
          context,
        ),
      };
    } finally {
      release();
    }
  };
  const out = (
    await Promise.all((refs as HotspotReference[]).map(runOne))
  ).filter((row): row is HotspotComparisonRow => !!row);
  return { rows: out, stopScheduling, identity };
}

export { emptyRows };

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
  type FeedOpts,
} from "$server/ebird";
import {
  belowHourlyReserve,
  comparisonPacer,
  ebirdRateState,
  HOURLY_RESERVE,
  PaceAborted,
  PaceDeferred,
} from "$server/ebird-rate";

/**
 * Why a batch stopped scheduling further hotspots (td-5003e2):
 * - auth: eBird rejected the key (401/403) — nothing will work until it is fixed.
 * - rate: eBird asked for a wait longer than a request should hold open;
 *   `resumeAfterMs` says when the client may continue.
 * - quota: the key's hourly allowance is down to the reserve kept for the
 *   rest of the app; `quotaRemaining` is eBird's own count.
 */
export type ComparisonStopReason = "auth" | "rate" | "quota";

/** A 429 wait up to this long is absorbed inside the request. */
export const MAX_INLINE_WAIT_MS = 15_000;
/** 429s on one hotspot before it is given up for this run. */
const MAX_RATE_RETRIES = 3;

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
  feedOpts: FeedOpts = {},
): Promise<ComparisonIdentity> {
  validFilters(filters);
  const [reference, seen] = await Promise.all([
    hotspotsNear(apiKey, filters.lat, filters.lng, filters.radiusKm, feedOpts),
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
  stopReason: ComparisonStopReason | null;
  resumeAfterMs?: number;
  quotaRemaining?: number;
  identity: ComparisonIdentity;
}> {
  if (ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length)
    throw new ComparisonError("Choose one to four unique hotspots.");
  let stopReason: ComparisonStopReason | null = null;
  let resumeAfterMs: number | undefined;
  let quotaRemaining: number | undefined;
  // Stopping also cancels siblings still waiting for a pacing slot. A live
  // fetch is deliberately not cancelled because another request may share it
  // through cachedFetch.
  const stopped = new AbortController();
  const paceSignal = signal
    ? AbortSignal.any([signal, stopped.signal])
    : stopped.signal;
  const inlineWaitUntil = Date.now() + MAX_INLINE_WAIT_MS;
  const stop = (reason: ComparisonStopReason) => {
    // auth outranks the others: it is the one the user must act on.
    if (!stopReason || reason === "auth") stopReason = reason;
    stopped.abort();
  };
  const pace = () =>
    comparisonPacer.acquire(apiKey, paceSignal, {
      maxBlockMs: Math.max(0, inlineWaitUntil - Date.now()),
      preserveHourlyReserve: true,
    });
  const identity = await resolveComparison(apiKey, filters, account, {
    pace,
    paceSignal,
  });
  if (identity.value !== expectedIdentity)
    throw new ComparisonError(
      "The comparison scope changed. Restart the comparison.",
      409,
    );
  const refStatus = identity.referenceRefreshErrorStatus;
  if (refStatus === 401 || refStatus === 403)
    return { rows: [], stopScheduling: true, stopReason: "auth", identity };
  if (refStatus === 429) {
    const left = belowHourlyReserve(apiKey);
    if (left != null)
      return {
        rows: [],
        stopScheduling: true,
        stopReason: "quota",
        quotaRemaining: left,
        identity,
      };
    const wait = Math.max(0, ebirdRateState(apiKey).blockedUntil - Date.now());
    return {
      rows: [],
      stopScheduling: true,
      stopReason: "rate",
      resumeAfterMs: Math.max(wait, 1000),
      identity,
    };
  }
  const refs = ids.map((id) =>
    identity.references.find((ref) => ref.locId === id),
  );
  if (refs.some((ref) => !ref))
    throw new ComparisonError(
      "One or more hotspots are outside the comparison references.",
    );
  const failedRow = (
    ref: HotspotReference,
    error: string,
  ): HotspotComparisonRow => ({
    ...ref,
    state: "failed",
    count: null,
    species: [],
    latestObsDt: null,
    fetchedAt: null,
    stale: false,
    error,
    token: null,
  });
  /**
   * After a 429 (thrown, or a stale row whose refresh got one): keep going
   * when the wait is short, otherwise stop with the reason. eBird's
   * Retry-After was recorded per key by the fetch itself, so this reads it
   * from there — the stale path carries only the status.
   */
  const afterRateLimit = (): "retry" | "stop" => {
    const left = belowHourlyReserve(apiKey);
    if (left != null) {
      quotaRemaining = left;
      stop("quota");
      return "stop";
    }
    const wait = ebirdRateState(apiKey).blockedUntil - Date.now();
    if (wait > Math.max(0, inlineWaitUntil - Date.now())) {
      resumeAfterMs = Math.max(resumeAfterMs ?? 0, wait);
      stop("rate");
      return "stop";
    }
    return "retry";
  };
  const stopForRate = () => {
    const wait = Math.max(0, ebirdRateState(apiKey).blockedUntil - Date.now());
    resumeAfterMs = Math.max(resumeAfterMs ?? 0, wait, 1000);
    stop("rate");
  };
  const runOne = async (
    ref: HotspotReference,
  ): Promise<HotspotComparisonRow | null> => {
    if (signal?.aborted || stopReason) return null;
    const release = await fetchSlots.acquire();
    try {
      let result;
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted || stopReason) return null;
        // Don't start a hotspot that would spend the rest of the app's hour,
        // or one that would sit out a long Retry-After inside this request.
        const left = belowHourlyReserve(apiKey);
        if (left != null) {
          quotaRemaining = left;
          stop("quota");
          return null;
        }
        const blocked = ebirdRateState(apiKey).blockedUntil - Date.now();
        if (blocked > Math.max(0, inlineWaitUntil - Date.now())) {
          resumeAfterMs = Math.max(resumeAfterMs ?? 0, blocked);
          stop("rate");
          return null;
        }
        try {
          result = filters.rareOnly
            ? await notableObs(apiKey, ref.locId, filters.daysBack, {
                pace,
                paceSignal,
              })
            : await recentHotspotObs(apiKey, ref.locId, filters.daysBack, {
                pace,
                paceSignal,
              });
        } catch (err) {
          if (signal?.aborted) return null;
          const status = err instanceof EbirdError ? err.status : undefined;
          if (status === 401 || status === 403) {
            stop("auth");
            return failedRow(
              ref,
              "eBird authorization failed — check your eBird API key in Settings.",
            );
          }
          if (err instanceof PaceDeferred) {
            if (stopReason) return null;
            if (err.reason === "quota") {
              quotaRemaining = err.quotaRemaining;
              stop("quota");
            } else {
              resumeAfterMs = Math.max(
                resumeAfterMs ?? 0,
                err.retryAfterMs ?? 0,
                1000,
              );
              stop("rate");
            }
            return null;
          }
          if (err instanceof PaceAborted || stopReason) return null;
          if (status === 429) {
            const action = afterRateLimit();
            if (attempt < MAX_RATE_RETRIES && action === "retry") continue;
            if (!stopReason) stopForRate();
            // Stopped before this hotspot got an answer: leave it for later.
            return null;
          }
          return failedRow(ref, "This hotspot could not be checked.");
        }
        if (result.refreshErrorStatus === 429) {
          const action = afterRateLimit();
          if (attempt < MAX_RATE_RETRIES && action === "retry") continue;
          if (!stopReason) stopForRate();
        }
        break;
      }
      if (signal?.aborted) return null;
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
      if (staleStatus === 401 || staleStatus === 403) stop("auth");
      else if (staleStatus === 429 && !stopReason) stop("rate");
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
  const reason = stopReason as ComparisonStopReason | null;
  return {
    rows: out,
    stopScheduling: reason != null,
    stopReason: reason,
    ...(reason === "rate"
      ? { resumeAfterMs: Math.max(resumeAfterMs ?? 0, 1000) }
      : {}),
    ...(reason === "quota" && quotaRemaining != null ? { quotaRemaining } : {}),
    identity,
  };
}

export { emptyRows, HOURLY_RESERVE };

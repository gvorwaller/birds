import { haversineKm } from "$lib/geo";
import { observationDateInWindow } from "$lib/report-window";
import { dedupeObservations, observationIdentity } from "$server/observations";
import type { EbirdObs, CachedResult } from "$server/ebird";
import { notableNearbyObs } from "$server/ebird";
import { nearestSpeciesReports, type NearestLadderResult, type ProbeGate } from "$server/nearest-ladder";

export const NEAREST_DISTANCE_OPTIONS = ["any", 25, 50, 100, 250, 500] as const;
export type NearestDistance = (typeof NEAREST_DISTANCE_OPTIONS)[number];
export interface NearestControls {
  backDays: 1 | 7 | 14 | 30;
  nearestKm: NearestDistance;
}

export function parseNearestControls(
  back: string | null,
  nearestKm: string | null,
): { ok: true; value: NearestControls } | { ok: false; message: string } {
  const backValue = back == null ? 14 : Number(back);
  if (![1, 7, 14, 30].includes(backValue)) {
    return { ok: false, message: "Choose a report window of 1, 7, 14, or 30 days." };
  }
  const distance = nearestKm == null ? "any" : nearestKm;
  const parsed = distance === "any" ? distance : Number(distance);
  if (parsed !== "any" && ![25, 50, 100, 250, 500].includes(parsed)) {
    return { ok: false, message: "Choose a nearby distance of any, 25, 50, 100, 250, or 500 km." };
  }
  return { ok: true, value: { backDays: backValue as NearestControls["backDays"], nearestKm: parsed as NearestDistance } };
}

export function filterNearbyEvidence(
  rows: EbirdObs[],
  speciesCodes: Set<string>,
  home: { lat: number; lon: number },
  backDays: number,
  nearestKm: NearestDistance,
  now = new Date(),
): EbirdObs[] {
  const radius = nearestKm === "any" ? Infinity : nearestKm;
  return dedupeObservations(rows).filter((row) => {
    if (!speciesCodes.has(row.speciesCode)) return false;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng) || row.lat < -90 || row.lat > 90 || row.lng < -180 || row.lng > 180) return false;
    if (!observationDateInWindow(row.obsDt, backDays, now)) return false;
    return haversineKm(home.lat, home.lon, row.lat, row.lng) <= radius;
  }).sort((a, b) => {
    const d = haversineKm(home.lat, home.lon, a.lat, a.lng) - haversineKm(home.lat, home.lon, b.lat, b.lng);
    return d || observationIdentity(a).localeCompare(observationIdentity(b));
  }).slice(0, 5);
}

export interface NearbyEvidenceResult {
  rows: EbirdObs[];
  stale: boolean;
  partial: boolean;
  engineFailed: boolean;
  notableFailed: boolean;
  notableRefreshErrorStatus?: number;
}

export function mergeNearbyEvidence(
  engine: Pick<NearestLadderResult, "rows" | "stale" | "partial"> | null,
  notable: CachedResult<EbirdObs[]> | null,
  speciesCodes: Set<string>,
  home: { lat: number; lon: number },
  backDays: number,
  nearestKm: NearestDistance,
): NearbyEvidenceResult {
  const rows = filterNearbyEvidence(
    [...(engine?.rows ?? []), ...(notable?.data ?? [])],
    speciesCodes,
    home,
    backDays,
    nearestKm,
  );
  const engineFailed = !engine;
  const notableFailed = !notable;
  return {
    rows,
    stale: !!engine?.stale || !!notable?.stale,
    partial: engineFailed || notableFailed || !!engine?.stale || !!notable?.stale || !!engine?.partial,
    engineFailed,
    notableFailed,
    notableRefreshErrorStatus: notable?.refreshErrorStatus,
  };
}

/** Shared orchestration for /nearest and the species Nearest card. */
export async function nearestWithEvidence(
  apiKey: string,
  speciesCode: string,
  home: { lat: number; lon: number },
  controls: { backDays: number; nearestKm: NearestDistance },
  opts: {
    gate?: ProbeGate;
    signal?: AbortSignal;
    notablePromise?: Promise<CachedResult<EbirdObs[]>>;
    probeBudget?: number;
    ladderDeadlineMs?: number;
  } = {},
) {
  if (opts.signal?.aborted) {
    throw Object.assign(new Error("Lookup aborted."), { name: "AbortError" });
  }
  const evidenceAbort = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, evidenceAbort.signal])
    : evidenceAbort.signal;
  const notablePromise = opts.notablePromise ?? notableNearbyObs(
    apiKey,
    home.lat,
    home.lon,
    controls.nearestKm === "any" ? 50 : Math.min(controls.nearestKm, 50),
    controls.backDays,
    { deadlineMs: 8_000 },
  );
  const isFatal = (status?: number) => status === 401 || status === 403 || status === 429;
  // A shared notable read must not cancel its provider request for other page
  // consumers, but a fatal result must stop this wrapper from scheduling new
  // regional ladder work.
  void notablePromise.then(
    (result) => {
      if (isFatal(result.refreshErrorStatus)) evidenceAbort.abort();
    },
    (err) => {
      if (isFatal((err as { status?: number })?.status)) evidenceAbort.abort();
    },
  );
  const enginePromise = nearestSpeciesReports(apiKey, speciesCode, home, controls.backDays, {
    headStartMs: 3_000,
    probeBudget: opts.probeBudget ?? 8,
    ladderDeadlineMs: opts.ladderDeadlineMs ?? 15_000,
    gate: opts.gate,
    signal,
  });
  const [engineSettled, notableSettled] = await Promise.allSettled([enginePromise, notablePromise]);
  const engine = engineSettled.status === "fulfilled" ? engineSettled.value : null;
  const notableRaw = notableSettled.status === "fulfilled" ? notableSettled.value : null;
  const notable = notableRaw && {
    ...notableRaw,
    data: notableRaw.data.map((row) => ({ ...row, source: row.source ?? "notable", fetchedAt: row.fetchedAt ?? notableRaw.fetchedAt.toISOString() })),
  };
  const annotatedEngine = engine && {
    ...engine,
    rows: engine.rows.map((row) => ({
      ...row,
      source: row.source ?? (engine.via === "nearest" ? "nearest endpoint" : "regional search"),
      fetchedAt: row.fetchedAt ?? engine.fetchedAt?.toISOString(),
    })),
  };
  if (!annotatedEngine && !notable) {
    throw engineSettled.status === "rejected" ? engineSettled.reason : new Error("Lookup failed.");
  }
  return {
    engine,
    notable,
    evidence: mergeNearbyEvidence(
      annotatedEngine,
      notable,
      new Set([speciesCode]),
      home,
      controls.backDays,
      controls.nearestKm,
    ),
  };
}

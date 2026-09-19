import type { HotspotComparisonRow } from "$lib/hotspot-comparison";

export interface PlannerComparisonCandidate {
  locId: string | null;
  locName: string;
  lat: number;
  lng: number;
  googlePlaceId: string | null;
  distanceKm: number;
  matchCount: number;
  triggerSpecies: {
    code: string;
    comName: string;
    sciName: string;
    lastObsDt: string;
  }[];
  lastObsDt: string;
  eligible: boolean;
  isVerifiedHotspot: boolean;
}

export function plannerCandidateKey(candidate: {
  locId: string | null;
  lat: number;
  lng: number;
}): string {
  return candidate.locId ?? `${candidate.lat},${candidate.lng}`;
}

export function applyComparedRanking(args: {
  rows: HotspotComparisonRow[];
  originalCandidates: PlannerComparisonCandidate[];
  previousCandidates: PlannerComparisonCandidate[];
  selectedKeys: ReadonlySet<string>;
  existingTokens: Record<string, string>;
  minNeeds: number;
  requestedStops: number;
}): {
  candidates: PlannerComparisonCandidate[];
  tokens: Record<string, string>;
  selectedKeys: Set<string>;
  shortage: string | null;
} {
  const compared = args.rows
    .filter((row) => row.state === "fresh" && row.count != null)
    .map((row) => ({
      locId: row.locId,
      locName: row.locName,
      lat: row.lat,
      lng: row.lng,
      googlePlaceId: row.googlePlaceId,
      distanceKm: row.distanceKm,
      matchCount: row.count ?? 0,
      triggerSpecies: row.species.map((species) => ({
        code: species.code,
        comName: species.comName,
        sciName: species.sciName,
        lastObsDt: species.obsDt,
      })),
      lastObsDt: row.latestObsDt ?? "",
      eligible: (row.count ?? 0) >= args.minNeeds,
      isVerifiedHotspot: true,
    }));
  const comparedIds = new Set(compared.map((candidate) => candidate.locId));
  const other = args.originalCandidates.filter(
    (candidate) => !candidate.locId || !comparedIds.has(candidate.locId),
  );
  const candidates = [...compared, ...other];
  const previousByKey = new Map(
    args.previousCandidates.map((candidate) => [
      plannerCandidateKey(candidate),
      candidate,
    ]),
  );
  const originalByKey = new Map(
    args.originalCandidates.map((candidate) => [
      plannerCandidateKey(candidate),
      candidate,
    ]),
  );
  const keep = new Set<string>();
  for (const key of args.selectedKeys) {
    const previous = previousByKey.get(key);
    if (!previous) continue;
    const original = originalByKey.get(key);
    if (!previous.isVerifiedHotspot || original?.isVerifiedHotspot === false)
      keep.add(key);
  }
  const slots = Math.max(0, Math.trunc(args.requestedStops) - keep.size);
  let added = 0;
  for (const candidate of compared.filter((candidate) => candidate.eligible)) {
    if (added >= slots) break;
    const key = plannerCandidateKey(candidate);
    if (keep.has(key)) continue;
    keep.add(key);
    if (++added >= slots) break;
  }
  const eligibleCount = compared.filter(
    (candidate) => candidate.eligible,
  ).length;
  const shortage =
    eligibleCount < Math.trunc(args.requestedStops)
      ? `Only ${eligibleCount} of ${Math.trunc(args.requestedStops)} requested stops meet the compared minimum; other reported locations remain available for manual selection.`
      : null;
  const tokens = {
    ...args.existingTokens,
    ...Object.fromEntries(
      args.rows
        .filter((row): row is typeof row & { token: string } => !!row.token)
        .map((row) => [row.locId, row.token]),
    ),
  };
  return { candidates, tokens, selectedKeys: keep, shortage };
}

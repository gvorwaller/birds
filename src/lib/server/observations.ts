import type { EbirdObs } from "$server/ebird";

function obsKey(o: EbirdObs): string {
  const loc = o.locId || `${o.lat.toFixed(5)},${o.lng.toFixed(5)}`;
  return `${o.speciesCode}|${loc}|${o.obsDt}`;
}

export function mergeSpeciesObservations(
  speciesCode: string,
  primary: EbirdObs[],
  secondary: EbirdObs[],
): EbirdObs[] {
  const merged: EbirdObs[] = [];
  const seen = new Set<string>();
  for (const o of [...primary, ...secondary]) {
    if (o.speciesCode !== speciesCode) continue;
    const key = obsKey(o);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(o);
  }
  return merged;
}

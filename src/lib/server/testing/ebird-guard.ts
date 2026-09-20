/**
 * Test support: wraps `$server/ebird` so that a page/API path can be proven not
 * to reach eBird. Every function that can touch the network records its name and
 * throws; `getEbirdApiKey` returns a placeholder so the code under test takes
 * its KEYED branch (the branch a real owner account has), which is exactly where
 * an unintended eBird call would happen. Never used by production code.
 */
type Module = Record<string, unknown>;

/** Every export of `$server/ebird` that performs (or can perform) a request. */
export const EBIRD_NETWORK_FUNCTIONS = [
  "ebirdFetchOrNull",
  "recentObs",
  "notableObs",
  "recentNearbyObs",
  "notableNearbyObs",
  "recentNearbySpeciesObs",
  "hotspotsInRegion",
  "recentHotspotObs",
  "nearestObsOfSpecies",
  "recentSpeciesInRegion",
  "hotspotsNear",
  "subregions",
  "countries",
  "syncTaxonomy",
] as const;

export function guardEbird<T extends Module>(actual: T, calls: string[], key: string | null = "placeholder-key"): T {
  const wrapped: Module = { ...actual, getEbirdApiKey: async () => key };
  for (const name of EBIRD_NETWORK_FUNCTIONS) {
    wrapped[name] = (..._args: unknown[]) => {
      calls.push(name);
      throw new Error(`external eBird call: ${name}`);
    };
  }
  return wrapped as T;
}

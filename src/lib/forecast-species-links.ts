interface SpeciesPageState {
  country: string;
  region: string | null;
  county: string | null;
  month: number;
}

/**
 * Query string for the species forecast page with the current country,
 * region, month and county kept. The loader infers the country from the
 * region, so without an explicit country a link with no region picked
 * falls back to the United States. The county is kept only while it
 * belongs to the region.
 */
export function speciesPageHref(
  state: SpeciesPageState,
  speciesCode: string | null = null,
): string {
  const p = new URLSearchParams();
  if (speciesCode) p.set("species", speciesCode);
  p.set("country", state.country);
  if (state.region) p.set("region", state.region);
  p.set("month", String(state.month));
  if (state.county && state.region && state.county.startsWith(`${state.region}-`)) {
    p.set("county", state.county);
  }
  return `?${p.toString()}`;
}

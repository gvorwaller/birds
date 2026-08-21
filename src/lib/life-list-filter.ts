export interface LifeListFilterRow {
  com_name: string;
  location_name: string | null;
  loc_id: string | null;
  region_code: string | null;
  first_seen: string | null;
}

export interface LifeListFilters {
  species: string;
  location: string;
  from: string;
  to: string;
  region: string | null;
}

export type DateBoundary = "start" | "end";

/**
 * Parse a Life List date filter without relying on the browser's segmented
 * date editor. A year alone is useful shorthand for the full calendar year;
 * full dates accept either ISO or the US format shown in the UI.
 */
export function parseLifeListDateInput(
  input: string,
  boundary: DateBoundary,
): string | null {
  const value = input.trim();
  if (!value) return "";

  const yearOnly = /^(\d{4})$/.exec(value);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    if (year < 1000) return null;
    return boundary === "start" ? `${year}-01-01` : `${year}-12-31`;
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!iso && !us) return null;

  const year = Number(iso?.[1] ?? us![3]);
  const month = Number(iso?.[2] ?? us![1]);
  const day = Number(iso?.[3] ?? us![2]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function matchesSpecies(name: string, query: string): boolean {
  const nameTokens = tokens(name);
  return tokens(query).every((part) =>
    nameTokens.some((namePart) => namePart.startsWith(part)),
  );
}

export function filterLifeList<T extends LifeListFilterRow>(
  rows: T[],
  filters: LifeListFilters,
): T[] {
  const species = filters.species.trim().toLocaleLowerCase();
  const location = filters.location.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filters.region && row.region_code !== filters.region) return false;
    if (species && !matchesSpecies(row.com_name, species)) return false;
    if (location) {
      const haystack = [row.location_name, row.loc_id, row.region_code]
        .filter((value): value is string => value != null)
        .join(" ")
        .toLocaleLowerCase();
      if (!haystack.includes(location)) return false;
    }
    if (filters.from || filters.to) {
      if (!row.first_seen) return false;
      if (filters.from && row.first_seen < filters.from) return false;
      if (filters.to && row.first_seen > filters.to) return false;
    }
    return true;
  });
}

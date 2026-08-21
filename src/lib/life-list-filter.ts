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

import type { SpeciesView } from "$lib/species-views";

export type StudyStatus = "viewed" | "unviewed";
export type StudyGrouping = "none" | "family" | "country";
export interface StudySpecies {
  code: string;
  name: string | null;
  scientificName: string | null;
  family: string | null;
  taxonOrder?: number | null;
  matchedBandingCode?: string | null;
  current: boolean;
  view: SpeciesView | null;
}
export interface StudyCountry {
  code: string;
  name: string;
  sourceCount: number;
  speciesCount: number;
  wholeArea: boolean;
  beginYear: number | null;
  endYear: number | null;
}
export function studyOptions(params: URLSearchParams) {
  const status: StudyStatus =
    params.get("status") === "unviewed" ? "unviewed" : "viewed";
  const requested = params.get("group");
  const group: StudyGrouping =
    requested === "country" || requested === "family" || requested === "none"
      ? requested
      : status === "unviewed"
        ? "family"
        : "none";
  const sort =
    params.get("sort") === "taxonomic" ? "taxonomic" : status === "unviewed" || params.get("sort") === "name" ? "name" : "recent";
  return {
    status,
    group,
    sort,
    q: (params.get("q") ?? "").trim().slice(0, 200),
  } as const;
}
export function studyHref(options: ReturnType<typeof studyOptions>) {
  const { status, group, sort, q } = options;
  return (
    "/viewed?" + new URLSearchParams({ status, group, sort, q }).toString()
  );
}
export function familyGroups(rows: StudySpecies[], taxonomic = false) {
  const groups = new Map<string, StudySpecies[]>();
  for (const row of rows) {
    const name = row.family?.trim() || "Family unavailable";
    const members = groups.get(name) ?? [];
    members.push(row);
    groups.set(name, members);
  }
  return [...groups]
    .sort(([a, ar], [b, br]) => {
      if (taxonomic) {
        const first = (r: StudySpecies[]) => Math.min(...r.map(x => x.taxonOrder ?? Infinity));
        const diff = first(ar) - first(br);
        if (diff) return diff;
      }
      return a.localeCompare(b);
    })
    .map(([name, rows]) => ({ name, rows }));
}

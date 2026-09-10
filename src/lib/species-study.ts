import type { SpeciesView } from "$lib/species-views";

export type StudyStatus = "viewed" | "unviewed";
export type StudyGrouping = "none" | "family" | "country";
export interface StudySpecies {
  code: string;
  name: string | null;
  scientificName: string | null;
  family: string | null;
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
    status === "unviewed" || params.get("sort") === "name" ? "name" : "recent";
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
export function familyGroups(rows: StudySpecies[]) {
  const groups = new Map<string, StudySpecies[]>();
  for (const row of rows) {
    const name = row.family?.trim() || "Family unavailable";
    const members = groups.get(name) ?? [];
    members.push(row);
    groups.set(name, members);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rows]) => ({ name, rows }));
}

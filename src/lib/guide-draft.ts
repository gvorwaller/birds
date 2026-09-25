/**
 * Draft state for the Field Guide's Filters and sort panel (td-daff98).
 *
 * The panel edits a draft; only Apply filters runs the search. Client-safe
 * and pure so the rules (canonical comparison, level clearing, stale-response
 * guarding) are testable without a browser.
 */
import {
  GUIDE_LEVELS,
  descendantsOf,
  guideLocationPairs,
  type GuideChoicesLevel,
  type GuideLevel,
  type GuideLocationSelection,
} from "$lib/guide-location";
import type { PlaceChoice } from "$lib/place-filter";

export type GuideSort = "relevance" | "name" | "taxonomic";

export interface GuideDraft {
  interest: boolean;
  family: string;
  sort: GuideSort;
  /** Sorted and de-duplicated; always REPLACED, never mutated (Svelte 5
   * `$state` does not track in-place Set/array mutation of this shape). */
  tags: string[];
  place: GuideLocationSelection;
}

/** Canonical key over the draft-owned fields only: defaults omitted, tags
 * sorted, place from the canonical selection pairs. Equal keys mean "no
 * unapplied changes", whatever order or casing the URL arrived in. */
export function guideDraftKey(d: GuideDraft): string {
  const p = new URLSearchParams();
  if (d.interest) p.append("interest", "1");
  if (d.family) p.append("family", d.family);
  if (d.sort !== "relevance") p.append("sort", d.sort);
  for (const t of [...new Set(d.tags)].sort()) p.append("tags", t);
  for (const [k, v] of guideLocationPairs(d.place)) p.append(k, v);
  return p.toString();
}

/** A new sorted tag list with `tag` toggled. */
export function toggledTag(tags: readonly string[], tag: string): string[] {
  const next = new Set(tags);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  return [...next].sort();
}

/** The hierarchy codes of a selection, "" where a level is not chosen. */
export function placeLevels(place: GuideLocationSelection): Record<GuideLevel, string> {
  const out: Record<GuideLevel, string> = { country: "", region: "", county: "", hotspot: "" };
  if (place.kind === "map" || place.kind === "anywhere") return out;
  for (const [k, v] of guideLocationPairs(place)) out[k as GuideLevel] = v;
  return out;
}

/**
 * Sets one Place level in the draft: keeps its ancestors, clears every deeper
 * level and any map point. An empty code clears the level itself.
 */
export function withDraftLevel(
  place: GuideLocationSelection,
  level: GuideLevel,
  code: string,
): GuideLocationSelection {
  const levels = placeLevels(place);
  levels[level] = code.trim().toUpperCase();
  for (const lower of descendantsOf(level)) levels[lower] = "";
  const { country, region, county, hotspot } = levels;
  if (!country) return { kind: "anywhere" };
  if (!region) return { kind: "country", country };
  if (!county) return { kind: "region", country, region };
  if (!hotspot) return { kind: "county", country, region, county };
  return { kind: "hotspot", country, region, county, hotspot };
}

/** The level whose choices a chosen level unlocks, or null for the deepest. */
export function childLevel(level: GuideLevel): GuideChoicesLevel | null {
  const next = GUIDE_LEVELS[GUIDE_LEVELS.indexOf(level) + 1];
  return (next as GuideChoicesLevel | undefined) ?? null;
}

export type ChoicesResult =
  | { status: "ok"; choices: PlaceChoice[] }
  | { status: "stale" }
  | { status: "error"; message: string };

export type ChoicesFetcher = (
  level: GuideChoicesLevel,
  parent: string,
  signal: AbortSignal,
) => Promise<PlaceChoice[]>;

/**
 * Loads Place choices under ONE hierarchy generation. Any draft change at any
 * level calls `invalidate()`, which aborts every in-flight request; a result is
 * delivered only if its generation is still current AND its parent still
 * equals the draft's value at the parent level (CODEX1: a county list for an
 * old state must never fill a county field cleared by a country change, even
 * when no newer county request replaced it). Results are memoised per
 * level:parent for the page's lifetime.
 */
export class PlaceChoiceLoader {
  private generation = 0;
  private controller = new AbortController();
  private readonly memo = new Map<string, PlaceChoice[]>();

  constructor(private readonly fetchChoices: ChoicesFetcher) {}

  /** Seed the memo from lists the server already rendered. */
  seed(level: GuideChoicesLevel, parent: string, choices: PlaceChoice[]): void {
    if (parent) this.memo.set(`${level}:${parent}`, choices);
  }

  invalidate(): void {
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
  }

  cached(level: GuideChoicesLevel, parent: string): PlaceChoice[] | null {
    return this.memo.get(`${level}:${parent}`) ?? null;
  }

  async load(
    level: GuideChoicesLevel,
    parent: string,
    currentParent: () => string,
  ): Promise<ChoicesResult> {
    const key = `${level}:${parent}`;
    const hit = this.memo.get(key);
    if (hit) return { status: "ok", choices: hit };
    const generation = this.generation;
    const { signal } = this.controller;
    try {
      const choices = await this.fetchChoices(level, parent, signal);
      this.memo.set(key, choices);
      if (generation !== this.generation || currentParent() !== parent) return { status: "stale" };
      return { status: "ok", choices };
    } catch (err) {
      if (generation !== this.generation || currentParent() !== parent || signal.aborted)
        return { status: "stale" };
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Couldn't load choices.",
      };
    }
  }
}

/** The browser fetcher for `/api/guide-locations`. */
export const fetchGuideChoices: ChoicesFetcher = async (level, parent, signal) => {
  const res = await fetch(
    `/api/guide-locations?level=${encodeURIComponent(level)}&parent=${encodeURIComponent(parent)}`,
    { signal, headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Couldn't load choices (HTTP ${res.status}).`);
  const body: unknown = await res.json();
  if (
    !body ||
    typeof body !== "object" ||
    (body as { level?: unknown }).level !== level ||
    (body as { parent?: unknown }).parent !== parent ||
    !Array.isArray((body as { choices?: unknown }).choices) ||
    !(body as { choices: unknown[] }).choices.every(
      (choice) =>
        !!choice &&
        typeof choice === "object" &&
        typeof (choice as { code?: unknown }).code === "string" &&
        typeof (choice as { name?: unknown }).name === "string",
    )
  )
    throw new Error("Couldn't load choices (invalid response).");
  return (body as { choices: PlaceChoice[] }).choices;
};

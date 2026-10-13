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
  // A hotspot with no county is one eBird records directly under the region
  // (td-327dd6); the server checks it is filed exactly there.
  if (hotspot) return { kind: "hotspot", country, region, county: county || null, hotspot };
  if (!county) return { kind: "region", country, region };
  return { kind: "county", country, region, county };
}

/** The place a hotspot list hangs under: the chosen county, else the chosen
 * state or region (its hotspots recorded with no county), else none. */
export function hotspotParent(levels: Record<GuideLevel, string>): string {
  return levels.county || levels.region;
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

/** The parent each Place list hangs under in a draft, "" when not chosen. */
export function listParent(level: GuideChoicesLevel, levels: Record<GuideLevel, string>): string {
  return level === "region" ? levels.country : level === "county" ? levels.region : hotspotParent(levels);
}

export const CHOICE_LEVELS: readonly GuideChoicesLevel[] = ["region", "county", "hotspot"];

export interface PlaceListsState {
  lists: Record<GuideChoicesLevel, PlaceChoice[]>;
  loading: Record<GuideChoicesLevel, boolean>;
  errors: Partial<Record<GuideChoicesLevel, { parent: string; message: string }>>;
}

export const NO_LOADING: Readonly<Record<GuideChoicesLevel, boolean>> = Object.freeze({
  region: false,
  county: false,
  hotspot: false,
});

/**
 * The Place lists of the Filters panel (td-daff98, td-327dd6). A state change
 * can need two lists, its counties and the hotspots eBird records under it
 * with no county, so each list keeps its own loading and failure state, and
 * after every choice each empty list whose parent is chosen is (re)filled: a
 * choice cancels requests still in flight (the loader keeps one generation),
 * so a sibling that was still loading (the counties, when one of the state's
 * own hotspots is picked first) is asked for again rather than left falsely
 * empty (CODEX1). Lists already fetched come from the loader's memo, empty
 * ones included. Reads and writes the page's state through `get`/`set`, so
 * the page keeps its reactive variables and this stays testable.
 */
export class PlaceListsController {
  constructor(
    private readonly loader: PlaceChoiceLoader,
    private readonly get: () => PlaceListsState,
    private readonly set: (patch: Partial<PlaceListsState>) => void,
    private readonly levels: () => Record<GuideLevel, string>,
  ) {}

  /** Drops every request in flight and every loading/failure mark. */
  cancel(): void {
    this.loader.invalidate();
    this.set({ loading: { ...NO_LOADING }, errors: {} });
  }

  /** After the draft's `level` changed: empty the lists below it, refill. */
  afterChoice(level: GuideLevel): Promise<void> {
    this.cancel();
    const lists = { ...this.get().lists };
    for (const l of CHOICE_LEVELS)
      if (GUIDE_LEVELS.indexOf(l) > GUIDE_LEVELS.indexOf(level)) lists[l] = [];
    this.set({ lists });
    return this.fill();
  }

  /** Fills each empty list whose parent is chosen, one request at a time.
   * One list failing does not stop the next; a newer choice does. */
  async fill(): Promise<void> {
    for (const level of CHOICE_LEVELS) {
      if (this.get().lists[level].length > 0) continue;
      const parent = listParent(level, this.levels());
      if (!parent) continue;
      const hit = this.loader.cached(level, parent);
      if (hit) this.set({ lists: { ...this.get().lists, [level]: hit } });
      else if ((await this.load(level, parent)) === "stale") return;
    }
  }

  /** Loads one list (also the Retry button). "stale" when the draft moved on. */
  async load(level: GuideChoicesLevel, parent: string): Promise<"ok" | "error" | "stale"> {
    const { [level]: _cleared, ...errors } = this.get().errors;
    this.set({ loading: { ...this.get().loading, [level]: true }, errors });
    const result = await this.loader.load(level, parent, () => listParent(level, this.levels()));
    if (result.status === "stale") return "stale";
    const now = this.get();
    this.set({ loading: { ...now.loading, [level]: false } });
    if (result.status === "ok") this.set({ lists: { ...now.lists, [level]: result.choices } });
    else this.set({ errors: { ...now.errors, [level]: { parent, message: result.message } } });
    return result.status;
  }
}

/**
 * Field Guide list scope (Phase 9A, td-f02bf7): All, Need or Seen.
 *
 * Client-safe and pure. `list` is a presentation/read scope only: it never
 * writes a life list, starts a job, refreshes data or calls eBird. An absent
 * parameter means All (old links keep working); an explicit `list=all` is
 * canonical and, like Need or Seen, is enough to browse the whole taxonomy.
 * Unknown, blank or repeated values are rejected, never guessed at.
 */
import { guideResultsHref } from "$lib/guide-location";

export const GUIDE_LISTS = ["all", "need", "seen"] as const;
export type GuideList = (typeof GUIDE_LISTS)[number];

export const GUIDE_LIST_LABEL: Record<GuideList, string> = { all: "All", need: "Need", seen: "Seen" };
/** How each scope names its species in a count or an empty state. */
export const GUIDE_LIST_NOUN: Record<GuideList, string> = {
  all: "All species",
  need: "Need species",
  seen: "Seen species",
};
/** What each scope means, for a title/help line. */
export const GUIDE_LIST_MEANING: Record<GuideList, string> = {
  all: "Every matching species",
  need: "Matching species not on the life list this page displays",
  seen: "Matching species on the life list this page displays",
};

export type GuideListParse =
  | { ok: true; list: GuideList; explicit: boolean }
  | { ok: false; message: string };

interface ParamReader {
  getAll(name: string): string[];
}

export function parseGuideList(params: ParamReader): GuideListParse {
  const all = params.getAll("list");
  if (all.length === 0) return { ok: true, list: "all", explicit: false };
  if (all.length > 1) return { ok: false, message: "Use only one list value." };
  const value = all[0];
  if (value.trim() === "") return { ok: false, message: "Choose a list: all, need or seen." };
  // Exact match only: no trimming or case folding, so a copied link is unambiguous.
  if ((GUIDE_LISTS as readonly string[]).includes(value))
    return { ok: true, list: value as GuideList, explicit: true };
  return { ok: false, message: "Choose a recognized list: all, need or seen." };
}

/** The same parameters with this scope selected and only the stale `page` removed. */
export function withGuideList(base: URLSearchParams, list: GuideList): URLSearchParams {
  const next = new URLSearchParams(base);
  next.delete("page");
  next.set("list", list);
  return next;
}

/** `/species?…#results` for a scope switch. */
export function guideListHref(base: URLSearchParams, list: GuideList): string {
  return guideResultsHref(withGuideList(base, list));
}

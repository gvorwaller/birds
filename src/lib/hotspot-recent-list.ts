/**
 * Hotspot page Recent reports lens (td-3aadc3): All, Need or Seen species
 * from the recent feed the page already loaded.
 *
 * Client-safe and pure. Like the Field Guide (and unlike Home), an absent
 * value means All, so every existing hotspot link renders exactly the list it
 * always has. The hotspot loader never reads `list`
 * (hotspot-loader-url-tracking.test.ts): switching lens is a client-side
 * navigation that reuses the loaded reports and calls no provider. Anything
 * other than one exact `all` / `need` / `seen` value is reported as invalid so
 * the page can drop it, never guessed at.
 */
import { GUIDE_LISTS, GUIDE_LIST_LABEL, type GuideList } from "$lib/guide-list";

export type HotspotRecentList = GuideList;
export const HOTSPOT_RECENT_LISTS = GUIDE_LISTS;
export const HOTSPOT_RECENT_LIST_LABEL = GUIDE_LIST_LABEL;

/** What each lens shows, for the pill's title. */
export const HOTSPOT_RECENT_LIST_MEANING: Record<HotspotRecentList, string> = {
  all: "Every species reported here in this window",
  need: "Reported species not on the life list this page displays",
  seen: "Reported species already on the life list this page displays",
};

interface ParamReader {
  getAll(name: string): string[];
}

export function parseHotspotRecentList(params: ParamReader): {
  list: HotspotRecentList;
  valid: boolean;
} {
  const all = params.getAll("list");
  if (all.length === 0) return { list: "all", valid: true };
  if (all.length === 1 && (HOTSPOT_RECENT_LISTS as readonly string[]).includes(all[0]))
    return { list: all[0] as HotspotRecentList, valid: true };
  return { list: "all", valid: false };
}

/**
 * The current URL with this lens selected. Every other parameter (window,
 * returnTo, …) is kept; All is the default, so it drops `list` and keeps one
 * canonical URL per view.
 */
export function hotspotRecentListHref(url: URL, list: HotspotRecentList): string {
  const params = new URLSearchParams(url.searchParams);
  if (list === "all") params.delete("list");
  else params.set("list", list);
  const search = params.toString();
  return `${url.pathname}${search ? `?${search}` : ""}`;
}

interface LensReport {
  need: boolean;
}
interface LensDay<R extends LensReport> {
  date: string;
  reports: R[];
}

/**
 * The days with only the lens's reports, in the same order; a day left with
 * no reports is dropped so no empty day heading renders.
 */
export function filterRecentDays<R extends LensReport, D extends LensDay<R>>(
  days: readonly D[],
  list: HotspotRecentList,
): D[] {
  if (list === "all") return [...days];
  const want = list === "need";
  const out: D[] = [];
  for (const d of days) {
    const reports = d.reports.filter((r) => r.need === want);
    if (reports.length > 0) out.push({ ...d, reports });
  }
  return out;
}

/** Species count per lens (each report row is one species). */
export function recentListCounts(
  days: readonly LensDay<LensReport>[],
): Record<HotspotRecentList, number> {
  let need = 0;
  let seen = 0;
  for (const d of days) for (const r of d.reports) r.need ? need++ : seen++;
  return { all: need + seen, need, seen };
}

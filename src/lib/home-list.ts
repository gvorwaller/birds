/**
 * Home's Needs-card lens (td-ee2b56): All, Need or Seen species from the
 * area feed the page already loaded.
 *
 * Client-safe and pure. Unlike the Field Guide's `list`, an absent value means
 * Need, so a bare Home URL renders exactly the needs card it always has. The
 * Home loader never reads `list` (home-loader-url-tracking.test.ts): switching
 * lens is a client-side navigation that reuses the loaded data and calls no
 * provider. Anything other than one exact `all` / `need` / `seen` value is
 * reported as invalid so the page can drop it, the way a stale `?loc=` is
 * dropped — never guessed at.
 */
import { GUIDE_LISTS, GUIDE_LIST_LABEL, type GuideList } from "$lib/guide-list";

export type HomeList = GuideList;
export const HOME_LISTS = GUIDE_LISTS;
export const HOME_LIST_LABEL = GUIDE_LIST_LABEL;

/** What each lens shows, for the pill's title. */
export const HOME_LIST_MEANING: Record<HomeList, string> = {
  all: "Every species reported in this area and window",
  need: "Reported species not on the life list this page displays",
  seen: "Reported species already on the life list this page displays",
};

interface ParamReader {
  getAll(name: string): string[];
}

export function parseHomeList(params: ParamReader): {
  list: HomeList;
  valid: boolean;
} {
  const all = params.getAll("list");
  if (all.length === 0) return { list: "need", valid: true };
  if (all.length === 1 && (HOME_LISTS as readonly string[]).includes(all[0]))
    return { list: all[0] as HomeList, valid: true };
  return { list: "need", valid: false };
}

/**
 * The current Home URL with this lens selected. Every other parameter —
 * including the `loc` focus — is kept; Need is the default, so it drops
 * `list` and keeps one canonical URL per view.
 */
export function homeListHref(url: URL, list: HomeList): string {
  const params = new URLSearchParams(url.searchParams);
  if (list === "need") params.delete("list");
  else params.set("list", list);
  const search = params.toString();
  return `${url.pathname}${search ? `?${search}` : ""}`;
}

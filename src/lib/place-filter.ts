/**
 * Searchable place fields for the Field Guide (td-daff98 §3b).
 *
 * Client-safe and pure: the server uses `comparePlaceChoices` to order the
 * country/state/county/hotspot lists, and the combobox uses the same folding
 * and matching, so what the page lists and what typing finds agree.
 */

export interface PlaceChoice {
  code: string;
  name: string;
}

// Letters with no Unicode decomposition that NFD + mark removal leaves alone.
const NON_DECOMPOSING: Record<string, string> = {
  ł: "l",
  đ: "d",
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  þ: "th",
  ð: "d",
  ı: "i",
};

/** Case-, accent- and whitespace-insensitive form of a label for matching. */
export function foldForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[łđøæœßþðı]/g, (ch) => NON_DECOMPOSING[ch] ?? ch)
    .replace(/\s+/g, " ")
    .trim();
}

/** Start offsets of every word in folded text. A word is a run of letters or
 * numbers, so hyphens, apostrophes, periods and spaces all start a new word. */
export function tokenStarts(folded: string): number[] {
  const starts: number[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  for (let m = re.exec(folded); m; m = re.exec(folded)) starts.push(m.index);
  return starts;
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** The one fixed order for unfiltered place lists: name (locale-independent
 * of the runtime), then code, so the server and every environment agree. */
export function comparePlaceChoices(a: PlaceChoice, b: PlaceChoice): number {
  return (
    collator.compare(a.name.replace(/\s+/g, " ").trim(), b.name.replace(/\s+/g, " ").trim()) ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  );
}

/**
 * Choices matching a typed query, best first: the whole label starts with the
 * query, then any word starts with it, then it appears anywhere. Within each
 * group the incoming (alphabetical) order is kept. A query also matches a
 * choice's code (e.g. an `L…` hotspot id). An empty query returns every choice.
 */
export function matchPlaceChoices<T extends PlaceChoice>(
  choices: readonly T[],
  query: string,
): T[] {
  const q = foldForMatch(query);
  if (!q) return [...choices];
  const whole: T[] = [];
  const word: T[] = [];
  const anywhere: T[] = [];
  for (const choice of choices) {
    const label = foldForMatch(choice.name);
    const code = choice.code.toLowerCase();
    if (label.startsWith(q) || code.startsWith(q)) whole.push(choice);
    else if (tokenStarts(label).some((i) => label.startsWith(q, i))) word.push(choice);
    else if (label.includes(q) || code.includes(q)) anywhere.push(choice);
  }
  return [...whole, ...word, ...anywhere];
}

/** Rendering page size: the popup shows this many matches, then a
 * "Show next" option. Every match stays reachable; nothing is dropped. */
export const PLACE_PAGE_SIZE = 200;

/** The visible slice for `pages` pages of `matches`, and how many remain. */
export function placePage<T>(
  matches: readonly T[],
  pages: number,
): { shown: T[]; remaining: number } {
  const count = Math.max(1, pages) * PLACE_PAGE_SIZE;
  return { shown: matches.slice(0, count), remaining: Math.max(0, matches.length - count) };
}

/**
 * Place-name normalization and matching, shared by server and client.
 *
 * `normalizePlaceName`, `tokens` and `placeNameScore` were moved here verbatim
 * from `$server/location-placeids`, which imports `$lib/db` and so can never be
 * reached from the browser. They are re-exported from that module, which
 * remains their only production consumer for Google Places matching.
 *
 * Two different normalizers exist in this codebase and they are NOT
 * interchangeable: this one is tuned for eBird *location* names (strips state
 * codes like `US-FL`, stopwords, punctuation), while `$server/species-match`
 * exports its own `normalizeName` for *species* names. That is why this one is
 * named `normalizePlaceName`.
 */

/**
 * eBird-tuned place-name normalizer.
 *
 * Behavior is pinned by golden cases in `$server/location-placeids.test.ts` —
 * it feeds `placeNameScore`, which decides real Google Places matches, so
 * changes here are behavior changes, not cleanups.
 *
 * Note this is ASCII-destructive: any non-`[a-z0-9]` character becomes a space,
 * so `"Hāna"` collapses to `"h na"`. {@link placeQueryMatches} compensates with
 * its own folding pass; do not "fix" it here.
 */
export function normalizePlaceName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(usa|us|united states|the|at|of|and)\b/g, " ")
    .replace(/\b[a-z]{2}-[a-z]{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalized words of a place name, dropping 1-character fragments. */
export function tokens(s: string): string[] {
  return normalizePlaceName(s)
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Similarity of an eBird location name to a Google Places candidate name.
 * Used to accept or reject a Google match; not used by the search box.
 */
export function placeNameScore(query: string, candidate: string): number {
  const q = tokens(query);
  const c = tokens(candidate);
  if (q.length === 0 || c.length === 0) return 0;
  const cSet = new Set(c);
  const exact =
    normalizePlaceName(query) === normalizePlaceName(candidate) ? 1 : 0;
  const overlap = q.filter(
    (t) => cSet.has(t) || c.some((ct) => ct.includes(t) || t.includes(ct)),
  ).length;
  const coverage = overlap / q.length;
  const reverse = overlap / c.length;
  return Math.max(exact, coverage * 0.75 + reverse * 0.25);
}

/**
 * Fold a string to plain ASCII letters before normalization, so that a query
 * typed without diacritics still matches a place name that has them.
 *
 * `normalizePlaceName` alone would turn `"Hāna"` into `"h na"` — the accent
 * becomes a space and splits the word. Decomposing first (NFKD) and dropping
 * the combining marks turns it into `"hana"` instead.
 */
function foldDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "");
}

/** Tokens for search matching: diacritic-folded, then normalized as usual. */
function searchTokens(s: string): string[] {
  return tokens(foldDiacritics(s));
}

/** True when `a` and `b` differ by at most one insert, delete or substitution. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;

  let i = 0;
  let j = 0;
  let edited = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (edited) return false;
    edited = true;
    // On equal lengths this is a substitution, so advance both; otherwise it is
    // an insertion in the longer string, so advance only that one.
    if (short.length === long.length) i++;
    j++;
  }
  return true;
}

/** Shortest query token length eligible for fuzzy (edit-distance) matching. */
const MIN_FUZZY_TOKEN_LENGTH = 4;

/** Shortest overall query that engages place matching at all. */
export const MIN_PLACE_QUERY_LENGTH = 3;

/**
 * Does a typed search query plausibly name this place?
 *
 * Deliberately NOT `placeNameScore`: that one compares two *place names* to
 * accept a Google match, while this compares a partial, possibly misspelled
 * query against a place name. The ticket's own example ("hugenot" should find
 * Huguenot Memorial Park) rules out plain `includes()`.
 *
 * Every query token must be satisfied by a distinct candidate token, so
 * `"park park"` cannot be satisfied twice by a single `"park"`. Fuzzy matching
 * applies only from {@link MIN_FUZZY_TOKEN_LENGTH} characters up — `tokens()`
 * keeps 2-character fragments, and an edit-distance-1 rule on those would make
 * `"ma"` match `"me"`, `"mi"` and `"md"`.
 */
export function placeQueryMatches(query: string, locName: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < MIN_PLACE_QUERY_LENGTH) return false;

  const q = searchTokens(trimmed);
  const c = searchTokens(locName);
  if (q.length === 0 || c.length === 0) return false;
  if (q.length > c.length) return false;

  const canPair = (qt: string, ct: string): boolean =>
    ct.startsWith(qt) ||
    ct.includes(qt) ||
    (qt.length >= MIN_FUZZY_TOKEN_LENGTH && withinOneEdit(qt, ct));

  // Maximum bipartite matching, not greedy first-fit. Greedily consuming the
  // first acceptable candidate is wrong when an earlier query token can take
  // the only candidate a later one needs: "park parkside" against "Parkside
  // Park" has a valid assignment (park→Park, parkside→Parkside), but greedy
  // lets "park" swallow "Parkside" and then fails. Token counts here are tiny,
  // so the augmenting-path search is far cheaper than the mistake.
  const matchedBy = new Array<number>(c.length).fill(-1);

  const assign = (qi: number, seen: boolean[]): boolean => {
    for (let ci = 0; ci < c.length; ci++) {
      if (seen[ci] || !canPair(q[qi], c[ci])) continue;
      seen[ci] = true;
      if (matchedBy[ci] === -1 || assign(matchedBy[ci], seen)) {
        matchedBy[ci] = qi;
        return true;
      }
    }
    return false;
  };

  for (let qi = 0; qi < q.length; qi++) {
    if (!assign(qi, new Array<boolean>(c.length).fill(false))) return false;
  }
  return true;
}

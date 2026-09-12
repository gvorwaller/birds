/** Family-only extraction. Species enrichment keeps its existing section policy. */
import { enrichmentUserAgent, parseRetryAfterMs } from "./wikidata";
import { WikipediaError } from "./wikipedia";

export function familyPlaintext(text: string) {
  // Retain complete natural-history prose; skip reference lists and sections that
  // encourage taxonomy/fossil padding. No length caps or silent truncation.
  const parts = text.split(/^==\s*([^=\n].*?)\s*==\s*$/m);
  let result = parts[0].trim();
  for (let i = 1; i < parts.length; i += 2) {
    if (
      /taxonom|systematic|classificat|evolution|fossil|references|bibliograph|external links|further reading|see also|footnotes|summary of extant species/i.test(
        parts[i],
      ) ||
      /^(species|genera|members)$/i.test(parts[i].trim())
    )
      continue;
    result += "\n\n" + parts[i] + "\n" + parts[i + 1].trim();
  }
  return result;
}
export async function fetchFamilyArticle(
  title: string,
  opts: { fetcher?: typeof fetch } = {},
) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "extracts|revisions|pageprops",
    explaintext: "1",
    exsectionformat: "wiki",
    redirects: "1",
    rvprop: "ids",
    titles: title,
  });
  const response = await (opts.fetcher ?? fetch)(
    "https://en.wikipedia.org/w/api.php?" + params,
    {
      headers: { "User-Agent": enrichmentUserAgent() },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new WikipediaError(
      "Family Wikipedia lookup failed",
      response.status,
      response.status === 429,
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
  const page = (await response.json()).query?.pages?.[0];
  if (
    !page ||
    page.missing ||
    !page.extract ||
    !Number.isInteger(page.revisions?.[0]?.revid) || page.revisions[0].revid <= 0
  )
    return null;
  return {
    title: String(page.title),
    revId: Number(page.revisions[0].revid),
    qid: String(page.pageprops?.wikibase_item ?? ""),
    disambiguation: page.pageprops?.disambiguation !== undefined,
    text: familyPlaintext(page.extract),
  };
}

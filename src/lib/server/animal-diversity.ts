/** Public ADW natural-history text, CC BY-NC-SA 3.0. No media ingestion.
 * https://animaldiversity.org/about/use_conditions/
 * robots.txt requests eight seconds between requests. The singleton family
 * worker is the only caller; this gate also serializes callers in this process.
 */
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { enrichmentUserAgent, parseRetryAfterMs } from "./wikidata";
import { WikipediaError } from "./wikipedia";
import type { FamilySource } from "./family-enrichment-ai";

type Node = DefaultTreeAdapterMap["node"];
const attr = (n: Node, key: string) =>
  "attrs" in n ? n.attrs.find((a) => a.name === key)?.value : undefined;
const children = (n: Node): Node[] => ("childNodes" in n ? n.childNodes : []);
const tag = (n: Node) => ("tagName" in n ? n.tagName : "");
function text(n: Node): string {
  if (["script", "style", "button"].includes(tag(n))) return "";
  return "value" in n ? n.value : children(n).map(text).join("");
}
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
function all(n: Node, predicate: (node: Node) => boolean): Node[] {
  return [
    ...(predicate(n) ? [n] : []),
    ...children(n).flatMap((c) => all(c, predicate)),
  ];
}
const TOPICS = new Set([
  "diversity",
  "geographic_range",
  "habitat",
  "physical_description",
  "reproduction",
  "lifespan_longevity",
  "behavior",
  "communication",
  "food_habits",
  "predation",
  "ecosystem_roles",
]);

export function parseAdwFamily(
  html: string,
  scientificName: string,
): FamilySource | null {
  const doc = parse(html);
  const heading = all(doc, (n) => tag(n) === "h1")[0];
  // A classification-only page is not a natural-history source. Require exact
  // family identity, Aves article, selected prose sections, and author credit.
  if (
    !heading ||
    attr(heading, "class") !== "rank--Family" ||
    clean(text(heading)) !== scientificName
  )
    return null;
  const article = all(
    doc,
    (n) =>
      tag(n) === "article" && attr(n, "data-class-scientific-name") === "Aves",
  )[0];
  if (!article) return null;
  const byline = all(article, (n) => attr(n, "class") === "byline")[0];
  if (!byline || !clean(text(byline)))
    throw Error("ADW family source is missing author attribution");
  const parts: string[] = [];
  for (const section of children(article).filter((n) => tag(n) === "section")) {
    const h = children(section).find((n) => tag(n) === "h2");
    if (!h || !TOPICS.has(attr(h, "id") ?? "")) continue;
    // Only account prose; exclude glossary popovers, navigation, media, lists,
    // and references. Preserve every paragraph in these natural-history topics.
    const paragraphs = children(section)
      .filter((n) => tag(n) === "p")
      .map((n) => clean(text(n)))
      .filter(Boolean);
    if (paragraphs.length)
      parts.push(clean(text(h)) + "\n" + paragraphs.join("\n"));
  }
  const prose = parts.join("\n\n");
  if (prose.length < 250) return null;
  return {
    provider: "adw",
    title: scientificName,
    url: `https://animaldiversity.org/accounts/${scientificName}/`,
    revision: null,
    qid: null,
    fetchedAt: new Date().toISOString(),
    attribution:
      clean(text(byline)).replace(/^By\s+/i, "") +
      ", Animal Diversity Web (University of Michigan)",
    license: "CC BY-NC-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/3.0/",
    text: scientificName + "\n\n" + prose,
  };
}

let requestTail: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;
export async function fetchAdwFamily(
  scientificName: string,
  fetcher: typeof fetch = fetch,
): Promise<FamilySource | null> {
  if (!/^[A-Z][a-z]+idae$/.test(scientificName))
    throw Error("Invalid ADW family name");
  const operation = requestTail.then(async () => {
    const delay = nextRequestAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    nextRequestAt = Date.now() + 8_000;
    const res = await fetcher(
      `https://animaldiversity.org/accounts/${scientificName}/`,
      {
        headers: { "User-Agent": enrichmentUserAgent() },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new WikipediaError(
        `ADW source request failed (${res.status})`,
        res.status,
        res.status === 429 || res.status === 503,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    // Redirects to classification are normal for taxa without written accounts.
    if (res.url && new URL(res.url).pathname.endsWith("/classification/"))
      return null;
    return parseAdwFamily(await res.text(), scientificName);
  });
  requestTail = operation.catch(() => undefined);
  return operation;
}

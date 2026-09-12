/** Exact taxon identity through the Wikidata Action API. This avoids expensive
 * SPARQL graph scans during an operator's catalog-wide source-quality review.
 * Search only discovers candidates; scientific name, rank and avian ancestry
 * are independently checked against their entity claims. */
import {
  enrichmentUserAgent,
  parseRetryAfterMs,
  WikidataError,
} from "./wikidata";
type Entity = {
  id: string;
  claims: Record<
    string,
    Array<{ rank?: string; mainsnak: { datavalue?: { value: unknown } } }>
  >;
  sitelinks?: { enwiki?: { title: string } };
  missing?: string;
};
const ranks = { family: "Q35409", genus: "Q34740", species: "Q7432" };
export function createFamilyTaxonLookup(
  fetcher: typeof fetch = fetch,
  spacingMs = 1000,
) {
  const entities = new Map<string, Entity>();
  let queue: Promise<unknown> = Promise.resolve(),
    next = 0;
  async function request(params: Record<string, string>) {
    const task = queue.then(async () => {
      const delay = Math.max(0, next - Date.now());
      if (delay) await new Promise((r) => setTimeout(r, delay));
      next = Date.now() + spacingMs;
      const response = await fetcher(
        "https://www.wikidata.org/w/api.php?" +
          new URLSearchParams({ format: "json", ...params }),
        {
          headers: { "User-Agent": enrichmentUserAgent() },
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) {
        const wait = parseRetryAfterMs(response.headers.get("retry-after"));
        if (response.status === 429)
          next = Date.now() + Math.max(wait ?? 60000, 1000);
        throw new WikidataError(
          "Wikidata entity lookup failed",
          response.status,
          response.status === 429,
          wait,
        );
      }
      const body = await response.json();
      if (body.error) throw Error("Wikidata entity API rejected the request");
      return body;
    });
    queue = task.catch(() => {});
    return task;
  }
  function values(entity: Entity, property: string) {
    let claims = (entity.claims?.[property] ?? []).filter(
      (c) => c.rank !== "deprecated",
    );
    if (claims.some((c) => c.rank === "preferred"))
      claims = claims.filter((c) => c.rank === "preferred");
    return claims.map((c) => c.mainsnak.datavalue?.value);
  }
  async function load(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => !entities.has(id));
    for (let i = 0; i < missing.length; i += 50) {
      const body = await request({
        action: "wbgetentities",
        ids: missing.slice(i, i + 50).join("|"),
        props: "claims|sitelinks",
        sitefilter: "enwiki",
      });
      for (const [id, raw] of Object.entries(body.entities ?? {})) {
        const e = raw as Entity;
        entities.set(id, {
          id,
          missing: e.missing,
          claims: Object.fromEntries(
            ["P225", "P105", "P171"].map((p) => [p, e.claims?.[p] ?? []]),
          ),
          sitelinks: e.sitelinks,
        });
      }
      if (missing.slice(i, i + 50).some((id) => !entities.has(id)))
        throw Error("Incomplete Wikidata entity response");
    }
  }
  async function bird(id: string) {
    let frontier = [id];
    const visited = new Set<string>();
    while (frontier.length) {
      if (frontier.includes("Q5113")) return true;
      await load(frontier);
      const parents: string[] = [];
      for (const qid of frontier) {
        visited.add(qid);
        for (const value of values(entities.get(qid)!, "P171")) {
          const parent = (value as { id?: string })?.id;
          if (parent && !visited.has(parent)) parents.push(parent);
        }
      }
      frontier = [...new Set(parents)].filter((p) => !visited.has(p));
    }
    return false;
  }
  return async (name: string, rank: keyof typeof ranks) => {
    if (!/^[A-Za-z][A-Za-z .-]{2,100}$/.test(name))
      throw Error("Invalid scientific name");
    const ids: string[] = [];
    let offset: string | undefined;
    const offsets = new Set<string>();
    do {
      const body = await request({
        action: "wbsearchentities",
        search: name,
        language: "en",
        type: "item",
        limit: "50",
        ...(offset ? { continue: offset } : {}),
      });
      for (const item of body.search ?? [])
        if (/^Q\d+$/.test(item.id)) ids.push(item.id);
      offset =
        body["search-continue"] === undefined
          ? undefined
          : String(body["search-continue"]);
      if (offset && offsets.has(offset))
        throw Error("Repeated Wikidata search continuation");
      if (offset) offsets.add(offset);
    } while (offset);
    await load(ids);
    const result = [];
    for (const id of [...new Set(ids)]) {
      const entity = entities.get(id)!;
      if (
        values(entity, "P225").includes(name) &&
        values(entity, "P105").some(
          (v) => (v as { id?: string })?.id === ranks[rank],
        ) &&
        (await bird(id))
      )
        result.push({
          qid: id,
          title: entity.sitelinks?.enwiki?.title ?? null,
        });
    }
    return result;
  };
}

import { it, expect, vi } from "vitest";
import { createFamilyTaxonLookup } from "./family-wikidata";
const claim = (value: unknown) => ({
  rank: "normal",
  mainsnak: { datavalue: { value } },
});
function entity(id: string, name: string, rank = "Q35409", parent = "Q5113") {
  return {
    id,
    claims: {
      P225: [claim(name)],
      P105: [claim({ id: rank })],
      P171: [claim({ id: parent })],
    },
    sitelinks: { enwiki: { title: name } },
  };
}
it("uses search only for candidates and rejects a wrong name, wrong rank, and non-bird homonym", async () => {
  const all: Record<string, unknown> = {
    Q1: entity("Q1", "Corvidae"),
    Q2: entity("Q2", "Corvidae", "Q34740"),
    Q3: entity("Q3", "Corvidae", "Q35409", "Q999"),
    Q4: entity("Q4", "Wrongidae"),
    Q999: { id: "Q999", claims: {} },
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const p = new URL(String(input)).searchParams;
    return new Response(
      JSON.stringify(
        p.get("action") === "wbsearchentities"
          ? { search: ["Q1", "Q2", "Q3", "Q4"].map((id) => ({ id })) }
          : {
              entities: Object.fromEntries(
                p
                  .get("ids")!
                  .split("|")
                  .map((id) => [id, all[id]]),
              ),
            },
      ),
    );
  });
  expect(
    await createFamilyTaxonLookup(fetcher as typeof fetch, 0)(
      "Corvidae",
      "family",
    ),
  ).toEqual([{ qid: "Q1", title: "Corvidae" }]);
});
it("follows all search pages and ancestry without accepting cycles", async () => {
  const all: Record<string, unknown> = {
    Q1: entity("Q1", "Corvidae", "Q35409", "Q2"),
    Q2: { id: "Q2", claims: { P171: [claim({ id: "Q1" })] } },
    Q3: entity("Q3", "Corvidae", "Q35409", "Q4"),
    Q4: { id: "Q4", claims: { P171: [claim({ id: "Q5113" })] } },
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const p = new URL(String(input)).searchParams;
    return new Response(
      JSON.stringify(
        p.get("action") === "wbsearchentities"
          ? p.has("continue")
            ? { search: [{ id: "Q3" }] }
            : { search: [{ id: "Q1" }], "search-continue": 1 }
          : {
              entities: Object.fromEntries(
                p
                  .get("ids")!
                  .split("|")
                  .map((id) => [id, all[id]]),
              ),
            },
      ),
    );
  });
  expect(
    await createFamilyTaxonLookup(fetcher as typeof fetch, 0)(
      "Corvidae",
      "family",
    ),
  ).toEqual([{ qid: "Q3", title: "Corvidae" }]);
});
it("preserves server rate-limit information", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "90" } }),
    );
  await expect(
    createFamilyTaxonLookup(fetcher, 0)("Corvidae", "family"),
  ).rejects.toMatchObject({
    status: 429,
    rateLimited: true,
    retryAfterMs: 90000,
  });
});

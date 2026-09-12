import { it, expect, vi } from "vitest";
import {
  discoverFamilySources,
  sourceDependencies,
} from "./family-source-discovery";
import { familyPlaintext, fetchFamilyArticle } from "./family-wikipedia";
import {
  familyPassages,
  validateFamilyDescription,
} from "./family-enrichment-ai";
const family = {
  code: "ansera1",
  name: "Magpie Goose",
  scientificName: "Anseranatidae",
  count: 1,
  order: "Anseriformes",
  taxonOrder: 1,
};
const prose =
  "These birds feed in wetlands and build nests near water. Their plumage and wings have distinctive features. ".repeat(
    4,
  );
const page = {
  title: "Magpie goose",
  qid: "Q1",
  revId: 123,
  disambiguation: false,
  text: prose,
};
function deps() {
  return {
    ...sourceDependencies,
    adw: vi.fn().mockResolvedValue(null),
    candidates: vi
      .fn()
      .mockResolvedValue([{ qid: "Q1", title: "Magpie goose" }]),
    article: vi.fn().mockResolvedValue(page),
  };
}
it("accepts a verified identity without a literal scientific name in prose", async () => {
  const source = await discoverFamilySources(
    family,
    ["Anseranas semipalmata"],
    deps(),
  );
  expect(source?.documents?.[0].scope.rank).toBe("family");
  expect(source?.resolverVersion).toBe("3");
});
it("resolves duplicate name records using the actual page identity", async () => {
  const d = deps();
  d.candidates.mockResolvedValue([
    { qid: "Q2", title: null },
    { qid: "Q1", title: "Magpie goose" },
  ]);
  expect(await discoverFamilySources(family, [], d)).not.toBeNull();
});
it("rejects disambiguation and unrelated page identities", async () => {
  for (const changed of [{ disambiguation: true }, { qid: "Q999" }]) {
    const d = deps();
    d.article.mockResolvedValue({ ...page, ...changed });
    expect(await discoverFamilySources(family, [], d)).toBeNull();
  }
});
it("never chooses arbitrarily between two usable identities", async () => {
  const d = deps();
  d.candidates.mockResolvedValue([
    { qid: "Q1", title: "First" },
    { qid: "Q2", title: "Second" },
  ]);
  d.article.mockImplementation(async (title) => ({
    ...page,
    title,
    qid: title === "Second" ? "Q2" : "Q1",
  }));
  expect(await discoverFamilySources(family, [], d)).toBeNull();
});
it("falls back to a verified sole-species source with explicit scope", async () => {
  const d = deps();
  d.candidates.mockImplementation(async (_, rank) =>
    rank === "species" ? [{ qid: "Q1", title: "Magpie goose" }] : [],
  );
  const s = await discoverFamilySources(family, ["Anseranas semipalmata"], d);
  expect(s?.documents?.[0].scope).toEqual({
    rank: "species",
    scientificName: "Anseranas semipalmata",
    members: ["Anseranas semipalmata"],
  });
});
it("keeps cassowaries and emu in separate documents and namespaces their evidence", async () => {
  const d = deps();
  d.candidates.mockImplementation(async (name, rank) =>
    rank === "family"
      ? []
      : [{ qid: name === "Casuarius" ? "Q1" : "Q2", title: name }],
  );
  d.article.mockImplementation(async (title) => ({
    ...page,
    title,
    qid: title === "Casuarius" ? "Q1" : "Q2",
  }));
  const members = [
    "Casuarius casuarius",
    "Casuarius bennetti",
    "Casuarius unappendiculatus",
    "Dromaius novaehollandiae",
  ];
  const s = (await discoverFamilySources(
    { ...family, code: "casuar1", scientificName: "Casuariidae" },
    members,
    d,
  ))!;
  expect(s.documents?.map((x) => x.scope.rank)).toEqual(["genus", "species"]);
  expect(familyPassages(s).map((p) => p.id)).toEqual(["D1P1", "D2P1"]);
  expect(() =>
    validateFamilyDescription(
      { paragraphs: [{ topic: "Traits", text: prose, evidence: ["P1"] }] },
      s,
    ),
  ).toThrow();
  expect(
    validateFamilyDescription(
      { paragraphs: [{ topic: "Traits", text: prose, evidence: ["D2P1"] }] },
      s,
    ).paragraphs,
  ).toHaveLength(1);
});
it("does not publish a multi-genus family from only one available genus", async () => {
  const d = deps();
  d.candidates.mockImplementation(async (name, rank) =>
    rank === "family" || name.startsWith("Dromaius")
      ? []
      : [{ qid: "Q1", title: name }],
  );
  expect(
    await discoverFamilySources(
      family,
      ["Casuarius casuarius", "Casuarius bennetti", "Dromaius novaehollandiae"],
      d,
    ),
  ).toBeNull();
});
it("preserves transport failures instead of turning them into a 30-day source gap", async () => {
  const d = deps();
  d.candidates.mockRejectedValue(Error("network down"));
  await expect(discoverFamilySources(family, [], d)).rejects.toThrow(
    "network down",
  );
});
it("records source quality rejection and does not use fossil-only padding", async () => {
  const d = deps();
  d.article.mockResolvedValue({
    ...page,
    text: "This fossil genus was historically assigned to another family. ".repeat(
      8,
    ),
  });
  const diagnostics: Parameters<typeof discoverFamilySources>[3] = [];
  expect(await discoverFamilySources(family, [], d, diagnostics)).toBeNull();
  expect(
    diagnostics.some((x) => x.outcome === "insufficient_natural_history"),
  ).toBe(true);
});
it("retains complete morphology and reproduction sections without changing the species splitter", () => {
  const long = "Plumage. ".repeat(1500);
  const text = familyPlaintext(
    `Intro\n== Morphology ==\n${long}\n== Reproduction ==\nNests\n== References ==\nCitation list`,
  );
  expect(text).toContain(long.trim());
  expect(text).toContain("Nests");
  expect(text).not.toContain("Citation list");
});
it("requests page identity and rejects HTTP errors", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    );
  await expect(
    fetchFamilyArticle("Corvidae", { fetcher }),
  ).rejects.toMatchObject({ status: 429, rateLimited: true });
  expect(String(fetcher.mock.calls[0][0])).toContain("pageprops");
});

it("accepts brief real habitat/range accounts, but rejects a classification-only Oilbird stub", async () => {
  const { hasNaturalHistory } = await import("./family-source-discovery");
  expect(
    hasNaturalHistory(
      "It is found in Kenya, Somalia, and Tanzania. Its natural habitats are subtropical or tropical moist lowland forest and subtropical or tropical moist shrubland.",
    ),
  ).toBe(true);
  expect(
    hasNaturalHistory(
      "Steatornithidae is a family comprising a single extant species. Prior taxonomies classified it with nocturnal strisoreans.",
    ),
  ).toBe(false);
});

it("stops between source requests when the user pauses", async () => {
  const { FamilySourceInterrupted } = await import("./family-source-discovery");
  const d = deps();
  let checks = 0;
  await expect(
    discoverFamilySources(family, [], d, [], async () => ++checks === 2),
  ).rejects.toBeInstanceOf(FamilySourceInterrupted);
  expect(d.adw).toHaveBeenCalledTimes(1);
  expect(d.candidates).not.toHaveBeenCalled();
});

it("requires a positive source revision for stable attribution", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        query: {
          pages: [
            {
              title: "Corvidae",
              extract: prose,
              revisions: [{ revid: 0 }],
              pageprops: { wikibase_item: "Q1" },
            },
          ],
        },
      }),
    ),
  );
  expect(await fetchFamilyArticle("Corvidae", { fetcher })).toBeNull();
});

it("allows explicitly labeled selected examples only when the editorial caller requests them", async () => {
  const d = deps();
  d.candidates.mockImplementation(async (name, rank) =>
    rank === "family" || name.startsWith("Dromaius")
      ? []
      : [{ qid: "Q1", title: name }],
  );
  const members = [
    "Casuarius casuarius",
    "Casuarius bennetti",
    "Dromaius novaehollandiae",
  ];
  const source = await discoverFamilySources(
    family,
    members,
    d,
    [],
    undefined,
    { allowScopedExamples: true },
  );
  expect(source?.documents).toHaveLength(1);
  expect(source?.coverage).toEqual({
    coveredMembers: members.slice(0, 2),
    uncoveredMembers: members.slice(2),
  });
});

it("records omitted members when an explicit example budget stops source collection", async () => {
  const d = deps();
  d.candidates.mockImplementation(async (name, rank) =>
    rank === "family" ? [] : [{ qid: "Q1", title: name }],
  );
  const members = ["Casuarius casuarius", "Dromaius novaehollandiae"];
  const diagnostics: Parameters<typeof discoverFamilySources>[3] = [];
  const source = await discoverFamilySources(
    family,
    members,
    d,
    diagnostics,
    undefined,
    { allowScopedExamples: true, maxExampleDocuments: 1 },
  );
  expect(source?.documents).toHaveLength(1);
  expect(source?.coverage).toEqual({
    coveredMembers: [members[0]],
    uncoveredMembers: [members[1]],
  });
  expect(
    d.candidates.mock.calls.some(([name]) => name.startsWith("Dromaius")),
  ).toBe(false);
  expect(diagnostics.some((d) => d.detail.includes("explicit limit 1"))).toBe(
    true,
  );
  await expect(
    discoverFamilySources(family, members, d, [], undefined, {
      maxExampleDocuments: 1,
    }),
  ).rejects.toThrow("requires scoped examples");
});

it("can prefer individual species when a useful genus account is still too generic for an editorial improvement", async () => {
  const d = deps();
  const members = ["Casuarius casuarius", "Casuarius bennetti"];
  const source = await discoverFamilySources(
    family,
    members,
    d,
    [],
    undefined,
    {
      allowScopedExamples: true,
      preferMemberAccounts: true,
      preferSpeciesAccounts: true,
      maxExampleDocuments: 6,
    },
  );
  expect(source?.documents?.map((d) => d.scope.scientificName)).toEqual(
    members,
  );
  expect(d.candidates.mock.calls.map(([, rank]) => rank)).toEqual([
    "species",
    "species",
  ]);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "$env/dynamic/private";

function setXcKey(value: string | undefined) {
  if (value === undefined) delete (env as Record<string, string | undefined>).XENO_CANTO_API_KEY;
  else env.XENO_CANTO_API_KEY = value;
}
import {
  buildSpeciesSparql,
  parseRetryAfterMs,
  parseSparqlBindings,
  titleFromArticleUrl,
  validSpeciesCode,
  buildSciNameSparql,
  fetchWikidataBySciName,
  validSciName,
  buildMediaSparql,
} from "./wikidata";
import * as wikidataMod from "./wikidata";
import * as commonsMod from "./wikimedia-commons";
import * as xenoCantoMod from "./xeno-canto";
import {
  splitSections,
  articleUrl,
  revisionPermalink,
  MAX_EXTRACT_CHARS,
} from "./wikipedia";
import { query } from "$lib/db";
import {
  enrichmentScope,
  factsFromWikidata,
  getEnrichment,
  iucnCode,
  markWikiError,
  markWikiNoArticle,
  wikiStaleCodes,
  aiDueCodes,
  searchEnrichment,
  guideCounts,
  upsertAiData,
  upsertResolution,
  upsertWikiOk,
  wikiFetchTitleFor,
  enrichOneNow,
  enrichOneNowCoalesced,
  enrichSpeciesMedia,
  getSpeciesMedia,
  markMediaError,
  mediaDueCodes,
  mediaFresh,
  upsertMediaOk,
} from "./species-enrichment";
import type { WikidataSpeciesRow } from "./wikidata";
import type { MediaCandidate } from "./species-enrichment";

// DB-backed cases run only when the test cluster is up (jobs-db pattern).
const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe("wikidata pure helpers", () => {
  it("validSpeciesCode accepts eBird shapes, rejects junk/injection", () => {
    for (const ok of ["grycat", "margod", "x00001", "yebsap1", "gre-egr"])
      expect(validSpeciesCode(ok), ok).toBe(true);
    for (const bad of ["", "UPPER", 'a"} UNION', "a b", "1abc", "a".repeat(20)])
      expect(validSpeciesCode(bad), bad).toBe(false);
  });

  it("buildSpeciesSparql embeds validated codes and refuses invalid ones", () => {
    const q = buildSpeciesSparql(["grycat", "margod"]);
    expect(q).toContain('VALUES ?ebird { "grycat" "margod" }');
    expect(q).toContain("wdt:P3444");
    expect(q).toContain("psn:P2067"); // normalized quantities, not raw wdt:
    expect(() => buildSpeciesSparql(['evil"} . ?x ?y ?z'])).toThrow(/invalid/);
  });

  it("buildSpeciesSparql filters quantities to BestRank statements (CODEX1 P1 #4)", () => {
    const q = buildSpeciesSparql(["grycat"]);
    expect(q).toContain("wikibase:BestRank");
  });

  it("buildMediaSparql embeds validated QIDs via P18/P51 and refuses invalid ones", () => {
    const q = buildMediaSparql(["Q123", "Q456"]);
    expect(q).toContain("VALUES ?item { wd:Q123 wd:Q456 }");
    expect(q).toContain("wdt:P18");
    expect(q).toContain("wdt:P51");
    expect(() => buildMediaSparql(['Q1"} UNION { ?x ?y ?z'])).toThrow(/invalid QIDs/);
    expect(() => buildMediaSparql(["not-a-qid"])).toThrow(/invalid QIDs/);
  });

  it("parseSparqlBindings resolves duplicate QIDs deterministically — lowest QID wins in ANY row order", () => {
    const row = (qid: string, inat: string) => ({
      ebird: { value: "grycat" },
      item: { value: `http://www.wikidata.org/entity/${qid}` },
      inat: { value: inat },
    });
    const a = parseSparqlBindings([row("Q900", "high"), row("Q83", "low")]);
    const b = parseSparqlBindings([row("Q83", "low"), row("Q900", "high")]);
    expect(a.get("grycat")?.qid).toBe("Q83");
    expect(b.get("grycat")?.qid).toBe("Q83");
    expect(a.get("grycat")?.inatTaxonId).toBe("low");
  });

  it("parseRetryAfterMs handles seconds, dates, junk, and clamps", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("999999")).toBe(2 * 60 * 60_000); // clamped
    expect(parseRetryAfterMs("garbage")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    const soon = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfterMs(soon);
    expect(parsed).toBeGreaterThan(30_000);
    expect(parsed).toBeLessThanOrEqual(61_000);
  });

  it("titleFromArticleUrl decodes enwiki URLs", () => {
    expect(titleFromArticleUrl("https://en.wikipedia.org/wiki/Marbled_godwit")).toBe(
      "Marbled godwit",
    );
    expect(titleFromArticleUrl("https://en.wikipedia.org/wiki/%CA%BB%C5%8Cma%CA%BBo")).toBe(
      "ʻŌmaʻo",
    );
    expect(titleFromArticleUrl(null)).toBeNull();
    expect(titleFromArticleUrl("https://example.com/nope")).toBeNull();
  });
});

describe("fetchWikidataMedia (P18/P51 filename resolution, td-86a2b6)", () => {
  it("decodes Special:FilePath URIs to bare filenames (spaces, not underscores)", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                item: { value: "http://www.wikidata.org/entity/Q844540" },
                image: {
                  value:
                    "http://commons.wikimedia.org/wiki/Special:FilePath/Marbled%20Godwit%20RWD.jpg",
                },
                audio: {
                  value:
                    "http://commons.wikimedia.org/wiki/Special:FilePath/Marbled%20godwit%20call.ogg",
                },
              },
            ],
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const out = await wikidataMod.fetchWikidataMedia(["Q844540"], { fetcher });
    const row = out.get("Q844540");
    expect(row?.imageFilename).toBe("Marbled Godwit RWD.jpg");
    expect(row?.audioFilename).toBe("Marbled godwit call.ogg");
  });

  it("a QID with neither claim is returned with null filenames", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          results: {
            bindings: [{ item: { value: "http://www.wikidata.org/entity/Q1" } }],
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const out = await wikidataMod.fetchWikidataMedia(["Q1"], { fetcher });
    expect(out.get("Q1")).toEqual({
      qid: "Q1",
      imageFilename: null,
      audioFilename: null,
    });
  });

  it("empty QID list never calls fetch", async () => {
    let called = 0;
    const fetcher = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect((await wikidataMod.fetchWikidataMedia([], { fetcher })).size).toBe(0);
    expect(called).toBe(0);
  });
});

describe("sci-name fallback (td-e64d93)", () => {
  it("validSciName accepts binomials, rejects injection shapes", () => {
    expect(validSciName("Gelochelidon nilotica")).toBe(true);
    expect(validSciName("Larus smithsonianus")).toBe(true);
    expect(validSciName("Anas sp.")).toBe(true);
    expect(validSciName('x" } UNION { ?s ?p ?o')).toBe(false);
    expect(validSciName("a")).toBe(false);
    expect(validSciName("has'quote")).toBe(false);
  });

  it("buildSciNameSparql embeds validated names via P225 and refuses invalid ones", () => {
    const q = buildSciNameSparql(["Gelochelidon nilotica"]);
    expect(q).toContain('VALUES ?sci { "Gelochelidon nilotica" }');
    expect(q).toContain("wdt:P225");
    expect(() => buildSciNameSparql(['bad"name'])).toThrow(/invalid sci names/);
  });

  it("fetchWikidataBySciName maps name hits back to the CALLER's eBird codes", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                sci: { value: "Gelochelidon nilotica" },
                item: { value: "http://www.wikidata.org/entity/Q18834" },
                article: { value: "https://en.wikipedia.org/wiki/Gull-billed_tern" },
              },
            ],
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const out = await fetchWikidataBySciName(
      [
        { code: "gubter2", sciName: "Gelochelidon nilotica" },
        { code: "ghost1", sciName: "Nulla species" },
        { code: "badone", sciName: 'inj"ect' }, // invalid → never sent
      ],
      { fetcher },
    );
    expect(out.size).toBe(1);
    const row = out.get("gubter2");
    expect(row?.speciesCode).toBe("gubter2"); // caller's code, not the name
    expect(row?.qid).toBe("Q18834");
    expect(row?.enwikiTitle).toBe("Gull-billed tern");
    expect(out.has("ghost1")).toBe(false);
  });

  it("no valid names → no network call at all", async () => {
    let called = 0;
    const fetcher = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const out = await fetchWikidataBySciName([{ code: "x1", sciName: 'inj"ect' }], { fetcher });
    expect(out.size).toBe(0);
    expect(called).toBe(0);
  });
});

describe("wikipedia splitSections", () => {
  const FIXTURE = [
    "The marbled godwit is a large shorebird.",
    "It breeds in the northern plains.",
    "",
    "== Taxonomy ==",
    "Named by Linnaeus.",
    "",
    "== Distribution and habitat ==",
    "Mudflats and beaches.",
    "=== Wintering ===",
    "Coastal Florida.",
    "",
    "== Behavior and ecology ==",
    "Probes with its long bill.",
    "",
    "== Gallery ==",
    "Some images.",
    "",
    "== References ==",
    "Citations here.",
  ].join("\n");

  it("splits lead + keyword-whitelisted sections; compound headings match; junk sections dropped", () => {
    const { extract, sections } = splitSections(FIXTURE);
    expect(extract).toContain("large shorebird");
    expect(extract).not.toContain("Taxonomy");
    expect(sections.map((s) => s.title)).toEqual([
      "Taxonomy",
      "Distribution and habitat",
      "Behavior and ecology",
    ]);
    // Subsections stay inside their parent's text.
    const dist = sections.find((s) => s.title === "Distribution and habitat");
    expect(dist?.text).toContain("Wintering");
    expect(dist?.text).toContain("Coastal Florida");
  });

  it("caps the extract length", () => {
    const long = "x".repeat(MAX_EXTRACT_CHARS + 500);
    expect(splitSections(long).extract.length).toBe(MAX_EXTRACT_CHARS);
  });

  it("url builders encode titles", () => {
    expect(articleUrl("Marbled godwit")).toBe("https://en.wikipedia.org/wiki/Marbled_godwit");
    expect(revisionPermalink("Marbled godwit", 123)).toBe(
      "https://en.wikipedia.org/w/index.php?title=Marbled_godwit&oldid=123",
    );
  });
});

describe("enrichment pure mapping", () => {
  it("iucnCode maps Wikidata labels; unknown labels pass through", () => {
    expect(iucnCode("least concern")).toBe("LC");
    expect(iucnCode("Vulnerable")).toBe("VU");
    expect(iucnCode("weird new label")).toBe("weird new label");
    expect(iucnCode(null)).toBeNull();
  });

  it("factsFromWikidata converts SI to display units", () => {
    const row = {
      speciesCode: "margod",
      qid: "Q1",
      enwikiTitle: "X",
      iucnStatus: null,
      massKgMin: 0.0445,
      massKgMax: 0.0445,
      wingspanMMin: 0.7,
      wingspanMMax: 0.85,
      inatTaxonId: null,
      xenoCantoId: null,
    } satisfies WikidataSpeciesRow;
    expect(factsFromWikidata(row)).toEqual({
      mass_g_min: 44.5,
      mass_g_max: 44.5,
      wingspan_cm_min: 70,
      wingspan_cm_max: 85,
    });
  });
});

describe.runIf(dbUp)("species_enrichment DB contract (test cluster)", () => {
  const CODE = "jobtst1"; // synthetic code, cleaned each test
  const wipe = () => query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);

  const WD_ROW: WikidataSpeciesRow = {
    speciesCode: CODE,
    qid: "Q999",
    enwikiTitle: "Test bird",
    iucnStatus: "least concern",
    massKgMin: 0.03,
    massKgMax: 0.04,
    wingspanMMin: null,
    wingspanMMax: null,
    inatTaxonId: "12345",
    xenoCantoId: "Testus-birdus",
  };

  it("stage separation: wiki error never clears good prose; AI write keeps tsv fresh", async () => {
    await wipe();
    await upsertResolution(CODE, WD_ROW);
    await upsertWikiOk(CODE, {
      title: "Test bird",
      revId: 42,
      extract: "A remarkable mudflat prober of quiet estuaries.",
      sections: [{ title: "Habitat", text: "Tidal mudflats and salt lagoons." }],
    });
    let row = await getEnrichment(CODE);
    expect(row?.wiki_status).toBe("ok");
    expect(row?.iucn_status).toBe("LC");
    expect(row?.cross_ids).toEqual({ inat_taxon_id: "12345", xeno_canto_id: "Testus-birdus" });

    // tsv indexed the prose (weighted B/C).
    const hit = await query<{ species_code: string }>(
      `SELECT species_code FROM species_enrichment
        WHERE search_tsv @@ websearch_to_tsquery('english', 'mudflat estuaries')`,
    );
    expect(hit.rows.map((r) => r.species_code)).toContain(CODE);

    // A later wiki failure stamps status only — prose survives (CODEX1 #3).
    await markWikiError(CODE, "HTTP 503 from wikipedia");
    row = await getEnrichment(CODE);
    expect(row?.wiki_status).toBe("error");
    expect(row?.wikipedia_extract).toContain("remarkable mudflat prober");
    expect(row?.wikipedia_rev_id).toBe("42");

    // AI write recomputes tsv atomically — tags become searchable (weight A).
    await upsertWikiOk(CODE, {
      title: "Test bird",
      revId: 43,
      extract: "A remarkable mudflat prober of quiet estuaries.",
      sections: [],
    });
    await upsertAiData(CODE, {
      fieldCraft: "Check falling tides.",
      tags: ["habitat:mudflat", "tide:falling"],
      model: "test-model",
      sourceRevId: 43,
    });
    const tagHit = await query<{ species_code: string }>(
      `SELECT species_code FROM species_enrichment
        WHERE search_tsv @@ websearch_to_tsquery('english', 'falling tide')
          AND tags @> ARRAY['tide:falling']`,
    );
    expect(tagHit.rows.map((r) => r.species_code)).toContain(CODE);
    await wipe();
  });

  it("no_article stamps the freshness clock — absent articles are not re-fetched daily", async () => {
    await wipe();
    await markWikiNoArticle(CODE);
    const row = await getEnrichment(CODE);
    expect(row?.wiki_status).toBe("no_article");
    expect(row?.wiki_fetched_at).not.toBeNull();
    await wipe();
  });

  it("ok→error keeps prose AND its original retrieval date; ok→no_article CLEARS prose (CODEX1 round 3)", async () => {
    await wipe();
    await upsertWikiOk(CODE, {
      title: "Test bird",
      revId: 50,
      extract: "A distinctive estuary sentinel.",
      sections: [{ title: "Habitat", text: "Estuaries." }],
    });
    const okAt = (await getEnrichment(CODE))?.wiki_ok_at;
    expect(okAt).not.toBeNull();

    // Failed refresh: prose survives, attribution date does NOT advance.
    await query(
      `UPDATE species_enrichment SET wiki_ok_at = NOW() - INTERVAL '30 days',
              wiki_fetched_at = NOW() - INTERVAL '30 days' WHERE species_code = $1`,
      [CODE],
    );
    const before = (await getEnrichment(CODE))?.wiki_ok_at;
    await markWikiError(CODE, "HTTP 503");
    let row = await getEnrichment(CODE);
    expect(row?.wikipedia_extract).toContain("estuary sentinel");
    expect(row?.wiki_ok_at).toBe(before); // failed attempt never re-dates prose
    expect(row?.wiki_fetched_at).not.toBe(before); // but the attempt clock moved

    // Article later disappears: terminal state clears the obsolete prose;
    // the vector keeps AI-owned lexemes only.
    await upsertAiData(CODE, {
      fieldCraft: "Scan tidal edges.",
      tags: ["habitat:mudflat"],
      model: "m",
      sourceRevId: 50,
    });
    await markWikiNoArticle(CODE);
    row = await getEnrichment(CODE);
    expect(row?.wiki_status).toBe("no_article");
    expect(row?.wikipedia_extract).toBeNull();
    expect(row?.wikipedia_rev_id).toBeNull();
    expect(row?.wiki_ok_at).toBeNull();
    expect(row?.field_craft).toBe("Scan tidal edges."); // AI-owned survives
    const proseHit = await query<{ species_code: string }>(
      `SELECT species_code FROM species_enrichment
        WHERE search_tsv @@ websearch_to_tsquery('english', 'estuary sentinel')`,
    );
    expect(proseHit.rows.map((r) => r.species_code)).not.toContain(CODE);
    const tagHit = await query<{ species_code: string }>(
      `SELECT species_code FROM species_enrichment
        WHERE search_tsv @@ websearch_to_tsquery('english', 'mudflat')`,
    );
    expect(tagHit.rows.map((r) => r.species_code)).toContain(CODE);
    await wipe();
  });

  it("TERMINAL resolution outcomes (no_mapping/no_sitelink + clock) leave scope AND stale — no scanner loop (CODEX1 P1 #1)", async () => {
    await wipe();
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Test Bird', 'Testus birdus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
      [CODE],
    );
    const uid = (
      await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)
    ).rows[0].id;
    await query(
      `INSERT INTO seen_species (user_id, species_code, source)
       VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
      [uid, CODE],
    );
    try {
      // The handler's terminal path: resolution write + no_article clock stamp.
      await upsertResolution(CODE, null);
      await markWikiNoArticle(CODE);
      const row = await getEnrichment(CODE);
      expect(row?.resolution).toBe("no_mapping");
      expect(await enrichmentScope()).not.toContain(CODE);
      expect(await wikiStaleCodes()).not.toContain(CODE);
      expect(await aiDueCodes()).not.toContain(CODE); // no prose → no AI work either
    } finally {
      await query(`DELETE FROM seen_species WHERE species_code = $1`, [CODE]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
      await wipe();
    }
  });

  it("weekly no_mapping lane: an 8-day-old row IS stale, a restamped one is NOT (GROK P2 pin)", async () => {
    await wipe();
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Test Bird', 'Testus birdus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
      [CODE],
    );
    const uid = (
      await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)
    ).rows[0].id;
    await query(
      `INSERT INTO seen_species (user_id, species_code, source)
       VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
      [uid, CODE],
    );
    try {
      await upsertResolution(CODE, null); // resolution='no_mapping'
      await markWikiNoArticle(CODE);
      // Age the clock past ERROR_RETRY_DAYS but well inside the 180d window:
      // the split-survivor lane (not the general refresh) must select it.
      await query(
        `UPDATE species_enrichment
            SET wiki_fetched_at = NOW() - INTERVAL '8 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect(await wikiStaleCodes()).toContain(CODE);
      // A fresh restamp (what BOTH the fallback hit and miss paths do)
      // removes it — the scan's 15-minute cadence has no candidate.
      await markWikiNoArticle(CODE);
      expect(await wikiStaleCodes()).not.toContain(CODE);
    } finally {
      await query(`DELETE FROM seen_species WHERE species_code = $1`, [CODE]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
      await wipe();
    }
  });

  it("scope excludes attempted rows; stale honors windows and AI gating (CODEX1 #6/#9)", async () => {
    await wipe();
    // Put the synthetic code in scope: taxonomy(species) + a seen row.
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Test Bird', 'Testus birdus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
      [CODE],
    );
    const uid = (
      await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)
    ).rows[0].id;
    await query(
      `INSERT INTO seen_species (user_id, species_code, source)
       VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
      [uid, CODE],
    );
    try {
      // Never attempted → in scope.
      expect(await enrichmentScope()).toContain(CODE);
      // Freshly fetched → out of scope, wiki not stale — but AI-due (the
      // partitioned queries replace the old staleCodes(aiEnabled) API).
      await upsertWikiOk(CODE, { title: "T", revId: 1, extract: "x", sections: [] });
      expect(await enrichmentScope()).not.toContain(CODE);
      expect(await wikiStaleCodes()).not.toContain(CODE);
      expect(await aiDueCodes()).toContain(CODE); // AI never attempted
      // Old fetch → wiki-stale, and NOT ai-due (stale prose is refetched
      // first; the annotation follows the fresh revision).
      await query(
        `UPDATE species_enrichment SET wiki_fetched_at = NOW() - INTERVAL '181 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect(await wikiStaleCodes()).toContain(CODE);
      expect(await aiDueCodes()).not.toContain(CODE);
      // Error rows retry only after their window.
      await markWikiError(CODE, "boom");
      expect(await wikiStaleCodes()).not.toContain(CODE); // fresh error
      await query(
        `UPDATE species_enrichment SET wiki_fetched_at = NOW() - INTERVAL '8 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect(await wikiStaleCodes()).toContain(CODE);
    } finally {
      await query(`DELETE FROM seen_species WHERE species_code = $1`, [CODE]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
      await wipe();
    }
  });
});

describe.runIf(dbUp)("Field guide search contract (plan Phase 3)", () => {
  const A = "gidetst1"; // "Testfinch" — name match target
  const B = "gidetst2"; // prose/tag match target
  let uid = 0;

  async function seed() {
    uid = (await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id;
    for (const [code, com, sci] of [
      [A, "Golden Testfinch", "Testus aureus"],
      [B, "Plain Prosebird", "Testus prosus"],
    ]) {
      await query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
         VALUES ($1, $2, $3, 'species', 'Testidae')
         ON CONFLICT (species_code) DO UPDATE SET com_name = $2, sci_name = $3, category = 'species'`,
        [code, com, sci],
      );
    }
    await upsertWikiOk(A, { title: "A", revId: 1, extract: "A quiet upland bird.", sections: [] });
    await upsertWikiOk(B, {
      title: "B",
      revId: 1,
      extract: "A testfinch-like skulker of dense reedbeds.",
      sections: [],
    });
    await upsertAiData(B, {
      fieldCraft: "Listen at dawn in reedbeds.",
      tags: ["habitat:freshwater-marsh", "find:heard-more-than-seen"],
      model: "m",
      sourceRevId: 1,
    });
    await query(
      `INSERT INTO seen_species (user_id, species_code, source) VALUES ($1, $2, 'manual')
       ON CONFLICT DO NOTHING`,
      [uid, A],
    );
  }
  async function unseed() {
    await query(`DELETE FROM seen_species WHERE species_code IN ($1, $2)`, [A, B]);
    await query(`DELETE FROM species_enrichment WHERE species_code IN ($1, $2)`, [A, B]);
    await query(`DELETE FROM taxonomy_cache WHERE species_code IN ($1, $2)`, [A, B]);
  }

  it("name matches UNION prose matches, name tier ranks first; tags AND-filter; seen badge scoped", async () => {
    await seed();
    try {
      // "testfinch" hits A by NAME and B by PROSE — union, name first.
      const both = await searchEnrichment("testfinch", [], uid);
      const codes = both.map((r) => r.species_code);
      expect(codes).toContain(A);
      expect(codes).toContain(B);
      expect(codes.indexOf(A)).toBeLessThan(codes.indexOf(B)); // name tier wins
      expect(both.find((r) => r.species_code === A)?.seen).toBe(true);
      expect(both.find((r) => r.species_code === B)?.seen).toBe(false);

      // Tag AND semantics: both tags → B only; adding a non-matching tag → none.
      const tagged = await searchEnrichment(
        "",
        ["habitat:freshwater-marsh", "find:heard-more-than-seen"],
        uid,
      );
      // CONTAINS, not equals: real AI annotations on the shared test
      // cluster legitimately match too (American Bittern carries exactly
      // these two tags — the vocabulary working as designed).
      expect(tagged.map((r) => r.species_code)).toContain(B);
      expect(tagged.map((r) => r.species_code)).not.toContain(A);
      const none = await searchEnrichment(
        "",
        ["habitat:freshwater-marsh", "tide:low"],
        uid,
      );
      expect(none.map((r) => r.species_code)).not.toContain(B);

      // Tag search finds the AI lexemes through FTS too.
      const fts = await searchEnrichment("reedbeds dawn", [], uid);
      expect(fts.map((r) => r.species_code)).toContain(B);
    } finally {
      await unseed();
    }
  });
});

describe.runIf(dbUp)("td-0753d0: taxonomy-first search, unenriched rows, tier ordering, guideCounts", () => {
  const E = "enrtst01"; // enriched species
  const U = "unrtst01"; // unenriched species (taxonomy only)
  const S = "sphtst01"; // spuh (non-species category)
  let uid = 0;

  async function seed() {
    uid = (await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id;
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Enriched Sparrowtest', 'Testus enrichus', 'species', 'Testidae'),
              ($2, 'Unenriched Sparrowtest', 'Testus unenrichus', 'species', 'Testidae'),
              ($3, 'Sparrowtest sp.', 'Testus sp.', 'spuh', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE
         SET com_name = EXCLUDED.com_name, sci_name = EXCLUDED.sci_name,
             category = EXCLUDED.category`,
      [E, U, S],
    );
    await upsertWikiOk(E, {
      title: "Enriched Sparrowtest",
      revId: 1,
      extract: "A sparrowtest that haunts alpine meadows.",
      sections: [],
    });
    await upsertAiData(E, {
      fieldCraft: "Check high meadows.",
      tags: ["habitat:alpine-meadow"],
      model: "m",
      sourceRevId: 1,
    });
  }
  async function unseed() {
    await query(`DELETE FROM seen_species WHERE species_code IN ($1, $2, $3)`, [E, U, S]);
    await query(`DELETE FROM species_enrichment WHERE species_code IN ($1, $2, $3)`, [E, U, S]);
    await query(`DELETE FROM taxonomy_cache WHERE species_code IN ($1, $2, $3)`, [E, U, S]);
  }

  it("unenriched species appear in name search results", async () => {
    await seed();
    try {
      const results = await searchEnrichment("Unenriched Sparrowtest", [], uid);
      const codes = results.map((r) => r.species_code);
      expect(codes).toContain(U);
      const row = results.find((r) => r.species_code === U)!;
      expect(row.has_prose).toBe(false);
      expect(row.wiki_fetched_at).toBeNull();
      expect(row.tags).toEqual([]);
    } finally {
      await unseed();
    }
  });

  it("5-tier ordering: exact code > exact name > prefix > substring, all in one result set", async () => {
    // Seed 4 species that all match query "sparxtest" at different tiers.
    const T0 = "sparxtest"; // code IS the query → tier 0
    const T1 = "tiertst01"; // com_name exactly equals query → tier 1
    const T2 = "tiertst02"; // com_name starts with query → tier 2
    const T3 = "tiertst03"; // com_name contains query mid-word → tier 3
    const tierCodes = [T0, T1, T2, T3];
    await seed();
    for (const [code, com] of [
      [T0, "Sparxtest Ignored Name"],
      [T1, "Sparxtest"],
      [T2, "Sparxtest Warbler"],
      [T3, "Great Sparxtest"],
    ] as const) {
      await query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
         VALUES ($1, $2, 'Testus tierus', 'species', 'Testidae')
         ON CONFLICT (species_code) DO UPDATE SET com_name = $2, category = 'species'`,
        [code, com],
      );
    }
    try {
      const results = await searchEnrichment("sparxtest", [], uid);
      const codes = results.map((r) => r.species_code);
      for (const c of tierCodes) expect(codes).toContain(c);
      // Strict ordering: tier 0 before tier 1 before tier 2 before tier 3.
      expect(codes.indexOf(T0)).toBeLessThan(codes.indexOf(T1));
      expect(codes.indexOf(T1)).toBeLessThan(codes.indexOf(T2));
      expect(codes.indexOf(T2)).toBeLessThan(codes.indexOf(T3));
    } finally {
      for (const c of tierCodes)
        await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [c]);
      await unseed();
    }
  });

  it("dedup: both legs match the same species — only one row returned", async () => {
    await seed();
    try {
      const results = await searchEnrichment("sparrowtest", [], uid);
      const eCodes = results.filter((r) => r.species_code === E);
      expect(eCodes).toHaveLength(1);
    } finally {
      await unseed();
    }
  });

  it("tags exclude unenriched rows", async () => {
    await seed();
    try {
      const tagged = await searchEnrichment("Sparrowtest", ["habitat:alpine-meadow"], uid);
      const codes = tagged.map((r) => r.species_code);
      expect(codes).toContain(E);
      expect(codes).not.toContain(U);
    } finally {
      await unseed();
    }
  });

  it("non-species categories are excluded from search", async () => {
    await seed();
    try {
      const results = await searchEnrichment("Sparrowtest sp.", [], uid);
      const codes = results.map((r) => r.species_code);
      expect(codes).not.toContain(S);
    } finally {
      await unseed();
    }
  });

  it("guideCounts includes taxonomy total and excludes retired enrichment", async () => {
    await seed();
    try {
      const before = await guideCounts();
      expect(before.taxonomy).toBeGreaterThan(0);
      expect(before.withWikipedia).toBeGreaterThan(0);
      expect(before.taxonomy).toBeGreaterThanOrEqual(before.withWikipedia);

      await query(
        `INSERT INTO species_enrichment (species_code, wikipedia_extract, wiki_status, wiki_fetched_at)
         VALUES ('retired9', 'ghost', 'ok', NOW())
         ON CONFLICT (species_code) DO NOTHING`,
      );
      try {
        const after = await guideCounts();
        expect(after.withWikipedia).toBe(before.withWikipedia);
        expect(after.taxonomy).toBe(before.taxonomy);
      } finally {
        await query(`DELETE FROM species_enrichment WHERE species_code = 'retired9'`);
      }
    } finally {
      await unseed();
    }
  });

  it("resolution-only partial row (wiki_fetched_at NULL) appears loadable in search", async () => {
    await seed();
    const P = "parttst01";
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Partial Loadbird', 'Testus partialus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET com_name = 'Partial Loadbird', category = 'species'`,
      [P],
    );
    // Simulate worker crash: resolution committed, wiki never fetched.
    await query(
      `INSERT INTO species_enrichment (species_code, resolution, wiki_status)
       VALUES ($1, 'mapped', NULL)
       ON CONFLICT (species_code) DO UPDATE SET wiki_status = NULL, wiki_fetched_at = NULL, wikipedia_extract = NULL`,
      [P],
    );
    try {
      const results = await searchEnrichment("Partial Loadbird", [], uid);
      const row = results.find((r) => r.species_code === P);
      expect(row).toBeDefined();
      expect(row!.has_prose).toBe(false);
      expect(row!.wiki_fetched_at).toBeNull();
    } finally {
      await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [P]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [P]);
      await unseed();
    }
  });

  it("enrichOneNowCoalesced shares promises and cleans up after settlement", { timeout: 25_000 }, async () => {
    const fakeCode = "zzztst99";
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Coalesce Test', 'Testus coalescus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
      [fakeCode],
    );
    try {
      // Concurrent calls share one promise.
      const p1 = enrichOneNowCoalesced(fakeCode);
      const p2 = enrichOneNowCoalesced(fakeCode);
      expect(p1).toBe(p2);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.outcome).toBe(r2.outcome);

      // After settlement, .finally() cleans the Map — next call creates fresh.
      const p3 = enrichOneNowCoalesced(fakeCode);
      expect(p3).not.toBe(p1);
      await p3;
    } finally {
      await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [fakeCode]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [fakeCode]);
    }
  });
});

describe("wikiFetchTitleFor (td-b7d021 — shared action/worker decision)", () => {
  const base: WikidataSpeciesRow = {
    speciesCode: "x1",
    qid: "Q1",
    enwikiTitle: null,
    iucnStatus: null,
    massKgMin: null,
    massKgMax: null,
    wingspanMMin: null,
    wingspanMMax: null,
    inatTaxonId: null,
    xenoCantoId: null,
  };
  it("sitelink wins; sci name is never consulted", () => {
    expect(wikiFetchTitleFor({ ...base, enwikiTitle: "Whimbrel" }, "Numenius phaeopus")).toEqual({
      title: "Whimbrel",
      viaFallback: false,
    });
  });
  it("no sitelink + valid binomial → fallback title", () => {
    expect(wikiFetchTitleFor(base, "Numenius hudsonicus")).toEqual({
      title: "Numenius hudsonicus",
      viaFallback: true,
    });
  });
  it("no sitelink + missing/invalid sci name → null (terminal)", () => {
    expect(wikiFetchTitleFor(base, null)).toBeNull();
    expect(wikiFetchTitleFor(base, 'inj"ect')).toBeNull();
  });
});

describe.runIf(dbUp)("no_sitelink weekly lane — MISSES only (td-b7d021)", () => {
  const CODE = "jobtst3";
  const NS_ROW: WikidataSpeciesRow = {
    speciesCode: CODE,
    qid: "Q27608723",
    enwikiTitle: null,
    iucnStatus: null,
    massKgMin: null,
    massKgMax: null,
    wingspanMMin: null,
    wingspanMMax: null,
    inatTaxonId: null,
    xenoCantoId: null,
  };
  it("miss retries weekly; a fallback HIT rides the normal 180d clock", async () => {
    await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Lane Bird', 'Lanus birdus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
      [CODE],
    );
    const uid = (
      await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)
    ).rows[0].id;
    await query(
      `INSERT INTO seen_species (user_id, species_code, source)
       VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
      [uid, CODE],
    );
    try {
      // Fallback MISS: no_sitelink + no_article clock just stamped → fresh.
      await upsertResolution(CODE, NS_ROW);
      await markWikiNoArticle(CODE);
      expect(await wikiStaleCodes()).not.toContain(CODE);
      // Past the weekly window → due (this is the new lane).
      await query(
        `UPDATE species_enrichment SET wiki_fetched_at = NOW() - INTERVAL '8 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect(await wikiStaleCodes()).toContain(CODE);
      // Fallback HIT (binomial redirect found the article): wiki_status='ok'
      // excludes the row from the weekly lane even when aged (MISS-only,
      // GROK pin d) — resolution stays no_sitelink for the UI note.
      await upsertWikiOk(CODE, { title: "Lanus birdus", revId: 5, extract: "x", sections: [] });
      await query(
        `UPDATE species_enrichment SET wiki_fetched_at = NOW() - INTERVAL '8 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect((await getEnrichment(CODE))?.resolution).toBe("no_sitelink");
      expect(await wikiStaleCodes()).not.toContain(CODE);
      // …but the normal 180d refresh still applies to the hit.
      await query(
        `UPDATE species_enrichment SET wiki_fetched_at = NOW() - INTERVAL '181 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect(await wikiStaleCodes()).toContain(CODE);
    } finally {
      await query(`DELETE FROM seen_species WHERE species_code = $1`, [CODE]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
      await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);
    }
  });
});

describe.runIf(dbUp)("enrichOneNow — instant wiki-only refresh (td-b7d021)", () => {
  const CODE = "jobtst4";
  const SCI = "Instantus birdus";

  /** Fetcher speaking both WDQS and the Wikipedia API from canned bodies. */
  function fakeNet(opts: {
    batchBindings?: object[];
    sciBindings?: object[];
    article?: { title: string; revid: number; extract: string } | "missing" | "http503";
  }) {
    let sparqlCalls = 0;
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("query.wikidata.org")) {
        sparqlCalls++;
        const bindings = sparqlCalls === 1 ? (opts.batchBindings ?? []) : (opts.sciBindings ?? []);
        return new Response(JSON.stringify({ results: { bindings } }), { status: 200 });
      }
      if (url.includes("wikipedia.org")) {
        if (opts.article === "http503") return new Response("busy", { status: 503 });
        if (opts.article === "missing" || opts.article == null) {
          return new Response(
            JSON.stringify({ query: { pages: [{ title: "x", missing: true }] } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  title: opts.article.title,
                  extract: opts.article.extract,
                  revisions: [{ revid: opts.article.revid }],
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return { fetcher, sparql: () => sparqlCalls };
  }

  const seed = async () => {
    await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Instant Bird', $2, 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET sci_name = $2, category = 'species'`,
      [CODE, SCI],
    );
  };
  const cleanup = async () => {
    await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
    await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);
  };

  it("no sitelink → binomial fallback HIT: stores the RESOLVED title, keeps no_sitelink", async () => {
    await seed();
    try {
      const net = fakeNet({
        batchBindings: [
          { ebird: { value: CODE }, item: { value: "http://www.wikidata.org/entity/Q77" } },
        ],
        article: { title: "Instant bird article", revid: 9, extract: "Prose." },
      });
      const out = await enrichOneNow(CODE, { fetcher: net.fetcher });
      expect(out).toEqual({
        outcome: "ok",
        title: "Instant bird article",
        viaFallback: true,
        aiDue: true,
      });
      const row = await getEnrichment(CODE);
      expect(row?.resolution).toBe("no_sitelink"); // WD truth survives the hit
      expect(row?.wiki_status).toBe("ok");
      expect(row?.wikipedia_title).toBe("Instant bird article"); // never the com name
      expect(net.sparql()).toBe(1); // P3444 hit → sci SPARQL not needed
    } finally {
      await cleanup();
    }
  });

  it("fallback MISS → no_article with the clock stamped (weekly lane feed)", async () => {
    await seed();
    try {
      const net = fakeNet({
        batchBindings: [
          { ebird: { value: CODE }, item: { value: "http://www.wikidata.org/entity/Q77" } },
        ],
        article: "missing",
      });
      expect(await enrichOneNow(CODE, { fetcher: net.fetcher })).toEqual({
        outcome: "no_article",
      });
      const row = await getEnrichment(CODE);
      expect(row?.resolution).toBe("no_sitelink");
      expect(row?.wiki_status).toBe("no_article");
      expect(row?.wiki_fetched_at).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("unmapped everywhere → no_mapping (sci SPARQL was tried)", async () => {
    await seed();
    try {
      const net = fakeNet({ batchBindings: [], sciBindings: [] });
      expect(await enrichOneNow(CODE, { fetcher: net.fetcher })).toEqual({
        outcome: "no_mapping",
      });
      expect(net.sparql()).toBe(2);
      expect((await getEnrichment(CODE))?.resolution).toBe("no_mapping");
    } finally {
      await cleanup();
    }
  });

  it("transient failure → NO error marks written (user's click must not burn the retry window)", async () => {
    await seed();
    try {
      const net = fakeNet({
        batchBindings: [
          {
            ebird: { value: CODE },
            item: { value: "http://www.wikidata.org/entity/Q77" },
            article: { value: "https://en.wikipedia.org/wiki/Instant_bird" },
          },
        ],
        article: "http503",
      });
      expect(await enrichOneNow(CODE, { fetcher: net.fetcher })).toEqual({
        outcome: "transient",
      });
      // ZERO writes: no row exists at all (CODEX1 blocker — network phase
      // must complete before any persistence begins).
      expect(await getEnrichment(CODE)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("transient failure leaves a PRE-EXISTING row byte-identical", async () => {
    await seed();
    try {
      await upsertResolution(CODE, {
        speciesCode: CODE,
        qid: "Q77",
        enwikiTitle: null,
        iucnStatus: "least concern",
        massKgMin: null,
        massKgMax: null,
        wingspanMMin: null,
        wingspanMMax: null,
        inatTaxonId: "42",
        xenoCantoId: null,
      });
      await markWikiNoArticle(CODE);
      const before = await getEnrichment(CODE);
      const net = fakeNet({
        batchBindings: [
          { ebird: { value: CODE }, item: { value: "http://www.wikidata.org/entity/Q77" } },
        ],
        article: "http503",
      });
      expect(await enrichOneNow(CODE, { fetcher: net.fetcher })).toEqual({
        outcome: "transient",
      });
      expect(await getEnrichment(CODE)).toEqual(before);
    } finally {
      await cleanup();
    }
  });

  it("persistence is ATOMIC: a failing wiki write rolls back the resolution write (CODEX1)", async () => {
    await seed();
    try {
      // Pre-existing state the resolution write would CHANGE (no_mapping →
      // mapped), so a committed first write is detectable.
      await upsertResolution(CODE, null);
      await markWikiNoArticle(CODE);
      const before = await getEnrichment(CODE);
      expect(before?.resolution).toBe("no_mapping");
      // Fault injection through real SQL: revid 1e19 overflows BIGINT, so
      // upsertWikiOk fails AFTER upsertResolution succeeded in-transaction.
      const net = fakeNet({
        batchBindings: [
          {
            ebird: { value: CODE },
            item: { value: "http://www.wikidata.org/entity/Q77" },
            article: { value: "https://en.wikipedia.org/wiki/Instant_bird" },
          },
        ],
        article: { title: "Instant bird", revid: 1e19, extract: "Prose." },
      });
      await expect(enrichOneNow(CODE, { fetcher: net.fetcher })).rejects.toThrow();
      // The whole persistence phase rolled back — resolution untouched.
      expect(await getEnrichment(CODE)).toEqual(before);
    } finally {
      await cleanup();
    }
  });
  it("enrichOneNow NEVER touches a media gateway (unchanged 20s wiki-only budget, td-86a2b6)", async () => {
    await seed();
    const spyMedia = vi.spyOn(wikidataMod, "fetchWikidataMedia");
    const spyCommons = vi.spyOn(commonsMod, "fetchCommonsFileInfo");
    const spyXc = vi.spyOn(xenoCantoMod, "fetchXenoCantoRecordings");
    try {
      const net = fakeNet({
        batchBindings: [
          {
            ebird: { value: CODE },
            item: { value: "http://www.wikidata.org/entity/Q77" },
          },
        ],
        article: {
          title: "Instant bird article",
          revid: 9,
          extract: "Prose.",
        },
      });
      await enrichOneNow(CODE, { fetcher: net.fetcher });
      expect(spyMedia).not.toHaveBeenCalled();
      expect(spyCommons).not.toHaveBeenCalled();
      expect(spyXc).not.toHaveBeenCalled();
    } finally {
      spyMedia.mockRestore();
      spyCommons.mockRestore();
      spyXc.mockRestore();
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Field-guide sample media (td-86a2b6)
// ---------------------------------------------------------------------------

describe.runIf(dbUp)("species_media DB contract (test cluster)", () => {
  const CODE = "medtst01";
  const wipe = async () => {
    await query(`DELETE FROM species_media WHERE species_code = $1`, [CODE]);
    await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);
  };

  const PHOTO: MediaCandidate = {
    kind: "photo",
    vocalization_type: null,
    rank: 1,
    provider: "wikimedia_commons",
    provider_id: "Test bird.jpg",
    media_url: "https://upload.wikimedia.org/test.jpg",
    thumbnail_url: "https://upload.wikimedia.org/640px-test.jpg",
    source_url: "https://commons.wikimedia.org/wiki/File:Test_bird.jpg",
    title: null,
    creator: "Photographer",
    license_code: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0",
    location: null,
    duration_seconds: null,
    width: 800,
    height: 600,
  };
  const SONG: MediaCandidate = {
    kind: "sound",
    vocalization_type: "song",
    rank: 1,
    provider: "xeno_canto",
    provider_id: "XC1",
    media_url: "https://xeno-canto.org/1/download",
    thumbnail_url: null,
    source_url: "https://xeno-canto.org/1",
    title: null,
    creator: "Recordist",
    license_code: "CC BY-NC-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-nc-sa/4.0",
    location: "Some Marsh",
    duration_seconds: 12,
    width: null,
    height: null,
  };

  it("transactional replace: DELETE + INSERT swap rows atomically, status/clocks stamped", async () => {
    await wipe();
    try {
      await upsertMediaOk(CODE, [PHOTO, SONG], "ok");
      let media = await getSpeciesMedia(CODE);
      expect(media.photo?.provider_id).toBe("Test bird.jpg");
      expect(media.sounds).toHaveLength(1);
      expect(media.sounds[0].vocalization_type).toBe("song");
      expect(media.status).toBe("ok");
      expect(media.mediaError).toBeNull();

      const enr = await getEnrichment(CODE);
      expect(enr?.media_status).toBe("ok");
      expect(enr?.media_fetched_at).not.toBeNull();
      expect(enr?.media_ok_at).not.toBeNull();

      // A second write REPLACES — the old song row is gone, only the new
      // candidate set survives (no leftover rank/kind rows).
      await upsertMediaOk(CODE, [PHOTO], "ok");
      media = await getSpeciesMedia(CODE);
      expect(media.sounds).toHaveLength(0);
      expect(media.photo).not.toBeNull();
    } finally {
      await wipe();
    }
  });

  it("transactional replace rolls back the delete when a replacement row is invalid", async () => {
    await wipe();
    try {
      await upsertMediaOk(CODE, [PHOTO], "ok");
      const invalid = {
        ...PHOTO,
        provider: "not_a_provider" as MediaCandidate["provider"],
      };
      await expect(upsertMediaOk(CODE, [invalid], "ok")).rejects.toThrow();
      const media = await getSpeciesMedia(CODE);
      expect(media.photo?.provider_id).toBe("Test bird.jpg");
      expect(media.status).toBe("ok");
    } finally {
      await wipe();
    }
  });

  it("kind+rank uniqueness: two sounds at different ranks coexist; same rank cannot duplicate", async () => {
    await wipe();
    try {
      const call: MediaCandidate = {
        ...SONG,
        vocalization_type: "call",
        rank: 2,
        provider_id: "XC2",
      };
      await upsertMediaOk(CODE, [SONG, call], "ok");
      const media = await getSpeciesMedia(CODE);
      expect(media.sounds.map((s) => s.rank).sort()).toEqual([1, 2]);

      // Constraint enforcement: inserting a duplicate (code, kind, rank) fails.
      await expect(
        query(
          `INSERT INTO species_media
             (species_code, kind, rank, provider, provider_id, media_url, source_url, license_code)
           VALUES ($1, 'sound', 1, 'xeno_canto', 'XC99', 'u', 's', 'CC0 1.0')`,
          [CODE],
        ),
      ).rejects.toThrow(/species_media_uq/);
    } finally {
      await wipe();
    }
  });

  it("no_media: empty candidate array writes zero rows, status recorded", async () => {
    await wipe();
    try {
      await upsertMediaOk(CODE, [], "no_media");
      const media = await getSpeciesMedia(CODE);
      expect(media.photo).toBeNull();
      expect(media.sounds).toEqual([]);
      expect(media.status).toBe("no_media");
    } finally {
      await wipe();
    }
  });

  it("markMediaError preserves existing species_media rows (last-good) and never advances media_ok_at", async () => {
    await wipe();
    try {
      await upsertMediaOk(CODE, [PHOTO], "ok");
      const okAt = (await getEnrichment(CODE))?.media_ok_at;
      expect(okAt).not.toBeNull();

      await markMediaError(CODE, "Commons unreachable: fetch failed");
      const media = await getSpeciesMedia(CODE);
      expect(media.photo?.provider_id).toBe("Test bird.jpg"); // last-good preserved
      expect(media.status).toBe("error");
      expect(media.mediaError).toContain("Commons unreachable");

      const enr = await getEnrichment(CODE);
      expect(enr?.media_ok_at).toBe(okAt); // error never re-dates the ok clock
      expect(enr?.media_status).toBe("error");
    } finally {
      await wipe();
    }
  });

  it("markMediaError works even when no enrichment row exists yet (belt-and-braces upsert)", async () => {
    await wipe();
    try {
      await markMediaError(CODE, "boom");
      const enr = await getEnrichment(CODE);
      expect(enr?.media_status).toBe("error");
      expect(enr?.media_error).toBe("boom");
    } finally {
      await wipe();
    }
  });

  it("markMediaError redacts credential-shaped text before storage", async () => {
    await wipe();
    try {
      await markMediaError(CODE, "upstream said api_key=SECRET123 while fetching");
      const enr = await getEnrichment(CODE);
      expect(enr?.media_error).not.toContain("SECRET123");
      expect(enr?.media_error).toContain("[redacted]");
    } finally {
      await wipe();
    }
  });

  it(
    "mediaDueCodes / mediaFresh: unresolved (no QID) never due; resolved+never-attempted is due; freshly ok is not",
    // mediaDueCodes() scans the full taxonomy/enrichment universe on the
    // shared test cluster; this test calls it 6x sequentially, each ~1s
    // against real data volume where nearly everything is media-due (a
    // brand-new stage) — well past vitest's default 5s (CODEX1 evidence:
    // EXPLAIN timing on this cluster showed ~1.1s/call vs. wikiStaleCodes'
    // ~3ms because almost every row is a TRUE match here, not a FALSE
    // short-circuit).
    { timeout: 30_000 },
    async () => {
      await wipe();
      await query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Media Test Bird', 'Testus mediaus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
        [CODE],
      );
      const uid = (await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0]
        .id;
      await query(
        `INSERT INTO seen_species (user_id, species_code, source)
       VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
        [uid, CODE],
      );
      try {
        // No wikidata_qid at all → never a media candidate.
        expect(await mediaDueCodes()).not.toContain(CODE);
        expect(await mediaFresh(CODE)).toBe(false);

        // Resolved (has a QID), media never attempted → due.
        await upsertResolution(CODE, {
          speciesCode: CODE,
          qid: "Q999999",
          enwikiTitle: "Media Test Bird",
          iucnStatus: null,
          massKgMin: null,
          massKgMax: null,
          wingspanMMin: null,
          wingspanMMax: null,
          inatTaxonId: null,
          xenoCantoId: null,
        });
        expect(await mediaDueCodes()).toContain(CODE);

        // Freshly ok → not due, and mediaFresh reports true.
        await upsertMediaOk(CODE, [PHOTO], "ok");
        expect(await mediaDueCodes()).not.toContain(CODE);
        expect(await mediaFresh(CODE)).toBe(true);

        // Aged past the refresh window → due again.
        await query(
          `UPDATE species_enrichment SET media_fetched_at = NOW() - INTERVAL '181 days'
          WHERE species_code = $1`,
          [CODE],
        );
        expect(await mediaDueCodes()).toContain(CODE);
        expect(await mediaFresh(CODE)).toBe(false);

        // Error retries after ERROR_RETRY_DAYS, not immediately.
        await markMediaError(CODE, "boom");
        expect(await mediaDueCodes()).not.toContain(CODE);
        await query(
          `UPDATE species_enrichment SET media_fetched_at = NOW() - INTERVAL '8 days'
          WHERE species_code = $1`,
          [CODE],
        );
        expect(await mediaDueCodes()).toContain(CODE);

        // 'partial' is transient (xc outage / missing key) — it retries on
        // the short ERROR window, NOT the 180-day ok window, so configuring
        // XENO_CANTO_API_KEY late backfills sounds within days, not months.
        await upsertMediaOk(CODE, [PHOTO], "partial");
        expect(await mediaDueCodes()).not.toContain(CODE);
        expect(await mediaFresh(CODE)).toBe(true);
        await query(
          `UPDATE species_enrichment SET media_fetched_at = NOW() - INTERVAL '8 days'
          WHERE species_code = $1`,
          [CODE],
        );
        expect(await mediaDueCodes()).toContain(CODE);
        expect(await mediaFresh(CODE)).toBe(false);
      } finally {
        await query(`DELETE FROM seen_species WHERE species_code = $1`, [CODE]);
        await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
        await wipe();
      }
    },
  );
});

describe.runIf(dbUp)("enrichSpeciesMedia orchestrator (injected fetchers, td-86a2b6)", () => {
  const CODE = "medtst02";
  const QID = "Q555555";
  const SCI = "Testus orchestrus";
  const LAST_GOOD: MediaCandidate = {
    kind: "photo",
    vocalization_type: null,
    rank: 1,
    provider: "wikimedia_commons",
    provider_id: "Last good.jpg",
    media_url: "https://upload.wikimedia.org/last-good.jpg",
    thumbnail_url: "https://upload.wikimedia.org/640px-last-good.jpg",
    source_url: "https://commons.wikimedia.org/wiki/File:Last_good.jpg",
    title: null,
    creator: "Photographer",
    license_code: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0",
    location: null,
    duration_seconds: null,
    width: 800,
    height: 600,
  };

  const wipe = async () => {
    await query(`DELETE FROM species_media WHERE species_code = $1`, [CODE]);
    await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);
  };

  const origKey = env.XENO_CANTO_API_KEY;
  afterEach(() => {
    setXcKey(origKey);
  });

  /** Fetcher speaking WDQS, Commons, and xeno-canto from canned bodies. */
  function fakeMediaNet(opts: {
    imageFilename?: string | null;
    audioFilename?: string | null;
    commonsPages?: object[];
    xc?: "ok" | "empty" | "error" | "rate_limited";
  }) {
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("query.wikidata.org")) {
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  item: { value: `http://www.wikidata.org/entity/${QID}` },
                  ...(opts.imageFilename
                    ? {
                        image: {
                          value: `http://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(opts.imageFilename)}`,
                        },
                      }
                    : {}),
                  ...(opts.audioFilename
                    ? {
                        audio: {
                          value: `http://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(opts.audioFilename)}`,
                        },
                      }
                    : {}),
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("commons.wikimedia.org")) {
        return new Response(JSON.stringify({ query: { pages: opts.commonsPages ?? [] } }), {
          status: 200,
        });
      }
      if (url.includes("xeno-canto.org")) {
        if (opts.xc === "error") return new Response("busy", { status: 503 });
        if (opts.xc === "rate_limited") return new Response("slow down", { status: 429 });
        if (opts.xc === "empty" || opts.xc == null)
          return new Response(JSON.stringify({ recordings: [] }), {
            status: 200,
          });
        return new Response(
          JSON.stringify({
            recordings: [
              {
                id: "10",
                file: "u10",
                type: "song",
                q: "A",
                len: "0:12",
                rec: "R",
                lic: "//creativecommons.org/licenses/by-nc-sa/4.0/",
              },
              {
                id: "11",
                file: "u11",
                type: "call",
                q: "A",
                len: "0:08",
                rec: "R",
                lic: "//creativecommons.org/licenses/by-nc-sa/4.0/",
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return fetcher;
  }

  const commonsPhotoPage = (filename: string) => ({
    title: `File:${filename}`,
    imageinfo: [
      {
        url: `https://upload.wikimedia.org/${encodeURIComponent(filename)}`,
        thumburl: `https://upload.wikimedia.org/640px-${encodeURIComponent(filename)}`,
        width: 800,
        height: 600,
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: "A Photographer" },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: {
            value: "https://creativecommons.org/licenses/by-sa/4.0",
          },
        },
      },
    ],
  });

  const commonsAudioPage = (filename: string) => ({
    title: `File:${filename}`,
    imageinfo: [
      {
        url: `https://upload.wikimedia.org/${encodeURIComponent(filename)}`,
        mime: "audio/ogg",
        duration: 6.5,
        extmetadata: {
          Artist: { value: "A Recordist" },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: {
            value: "https://creativecommons.org/licenses/by-sa/4.0",
          },
        },
      },
    ],
  });

  it("Commons photo ok + xeno-canto ok → status ok, photo + song(rank1) + call(rank2) persisted", async () => {
    await wipe();
    setXcKey("test-key");
    try {
      const fetcher = fakeMediaNet({
        imageFilename: "Test bird.jpg",
        commonsPages: [commonsPhotoPage("Test bird.jpg")],
        xc: "ok",
      });
      const status = await enrichSpeciesMedia(CODE, QID, SCI, { fetcher });
      expect(status).toBe("ok");
      const media = await getSpeciesMedia(CODE);
      expect(media.photo?.provider).toBe("wikimedia_commons");
      expect(media.sounds.map((s) => [s.rank, s.vocalization_type, s.provider])).toEqual([
        [1, "song", "xeno_canto"],
        [2, "call", "xeno_canto"],
      ]);
      expect(media.status).toBe("ok");
    } finally {
      await wipe();
    }
  });

  it("Commons audio present: it takes sound rank=1, xeno-canto SONG is skipped, only the call fills rank=2", async () => {
    await wipe();
    setXcKey("test-key");
    try {
      const fetcher = fakeMediaNet({
        audioFilename: "Test call.ogg",
        commonsPages: [commonsAudioPage("Test call.ogg")],
        xc: "ok",
      });
      const status = await enrichSpeciesMedia(CODE, QID, SCI, { fetcher });
      expect(status).toBe("ok");
      const media = await getSpeciesMedia(CODE);
      expect(media.photo).toBeNull();
      expect(media.sounds.map((s) => [s.rank, s.vocalization_type, s.provider])).toEqual([
        [1, null, "wikimedia_commons"],
        [2, "call", "xeno_canto"],
      ]);
    } finally {
      await wipe();
    }
  });

  it("missing xeno-canto key → partial; Commons photo still written", async () => {
    await wipe();
    setXcKey(undefined);
    try {
      const fetcher = fakeMediaNet({
        imageFilename: "Test bird.jpg",
        commonsPages: [commonsPhotoPage("Test bird.jpg")],
      });
      const status = await enrichSpeciesMedia(CODE, QID, SCI, { fetcher });
      expect(status).toBe("partial");
      const media = await getSpeciesMedia(CODE);
      expect(media.photo).not.toBeNull();
      expect(media.sounds).toEqual([]);
      expect(media.status).toBe("partial");
    } finally {
      await wipe();
    }
  });

  it("xeno-canto transient error (not missing key) is ALSO soft → partial, never fatal", async () => {
    await wipe();
    setXcKey("test-key");
    try {
      const fetcher = fakeMediaNet({
        imageFilename: "Test bird.jpg",
        commonsPages: [commonsPhotoPage("Test bird.jpg")],
        xc: "error",
      });
      const status = await enrichSpeciesMedia(CODE, QID, SCI, { fetcher });
      expect(status).toBe("partial");
    } finally {
      await wipe();
    }
  });

  it("soft xeno-canto failure PRESERVES last-good xeno-canto sounds (the replace must not blank them)", async () => {
    await wipe();
    setXcKey("test-key");
    const PRIOR_SONG: MediaCandidate = {
      kind: "sound",
      vocalization_type: "song",
      rank: 1,
      provider: "xeno_canto",
      provider_id: "XC100",
      media_url: "https://xeno-canto.org/100/file",
      thumbnail_url: null,
      source_url: "https://xeno-canto.org/100",
      title: null,
      creator: "R",
      license_code: "CC BY-NC-SA 4.0",
      license_url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
      location: null,
      duration_seconds: 12,
      width: null,
      height: null,
    };
    const PRIOR_CALL: MediaCandidate = {
      ...PRIOR_SONG,
      vocalization_type: "call",
      rank: 2,
      provider_id: "XC101",
      source_url: "https://xeno-canto.org/101",
    };
    try {
      await upsertMediaOk(CODE, [LAST_GOOD, PRIOR_SONG, PRIOR_CALL], "ok");
      const fetcher = fakeMediaNet({
        imageFilename: "Replacement.jpg",
        commonsPages: [commonsPhotoPage("Replacement.jpg")],
        xc: "error",
      });
      const status = await enrichSpeciesMedia(CODE, QID, SCI, { fetcher });
      expect(status).toBe("partial");
      const media = await getSpeciesMedia(CODE);
      // The Commons photo still refreshes…
      expect(media.photo?.provider_id).toBe("Replacement.jpg");
      // …but the last-good xeno-canto sounds survive the transient outage.
      expect(media.sounds.map((s) => [s.rank, s.provider_id])).toEqual([
        [1, "XC100"],
        [2, "XC101"],
      ]);
    } finally {
      await wipe();
    }
  });

  it("xeno-canto rate limit is retryable and preserves last-good media", async () => {
    await wipe();
    setXcKey("test-key");
    try {
      await upsertMediaOk(CODE, [LAST_GOOD], "ok");
      const fetcher = fakeMediaNet({
        imageFilename: "Replacement.jpg",
        commonsPages: [commonsPhotoPage("Replacement.jpg")],
        xc: "rate_limited",
      });
      await expect(enrichSpeciesMedia(CODE, QID, SCI, { fetcher })).rejects.toMatchObject({
        name: "XenoCantoError",
        rateLimited: true,
      });
      const media = await getSpeciesMedia(CODE);
      expect(media.photo?.provider_id).toBe("Last good.jpg");
      expect(media.status).toBe("ok");
    } finally {
      await wipe();
    }
  });

  it("both sources answer empty → no_media", async () => {
    await wipe();
    setXcKey("test-key");
    try {
      const fetcher = fakeMediaNet({ xc: "empty" });
      const status = await enrichSpeciesMedia(CODE, QID, SCI, { fetcher });
      expect(status).toBe("no_media");
      const media = await getSpeciesMedia(CODE);
      expect(media.photo).toBeNull();
      expect(media.sounds).toEqual([]);
    } finally {
      await wipe();
    }
  });

  it("Wikidata/WDQS failure is FATAL — throws, does not write anything", async () => {
    await wipe();
    const fetcher = (async (input: URL | RequestInfo) => {
      if (String(input).includes("query.wikidata.org"))
        return new Response("busy", { status: 503 });
      throw new Error("unexpected fetch");
    }) as typeof fetch;
    try {
      await expect(enrichSpeciesMedia(CODE, QID, SCI, { fetcher })).rejects.toThrow();
      expect((await getSpeciesMedia(CODE)).status).toBeNull();
    } finally {
      await wipe();
    }
  });

  it("Commons imageinfo failure is FATAL — throws even when Wikidata succeeded", async () => {
    await wipe();
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("query.wikidata.org")) {
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  item: { value: `http://www.wikidata.org/entity/${QID}` },
                  image: {
                    value: "http://commons.wikimedia.org/wiki/Special:FilePath/Test%20bird.jpg",
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("commons.wikimedia.org")) return new Response("busy", { status: 503 });
      throw new Error("unexpected fetch");
    }) as typeof fetch;
    try {
      await expect(enrichSpeciesMedia(CODE, QID, SCI, { fetcher })).rejects.toThrow();
    } finally {
      await wipe();
    }
  });
});

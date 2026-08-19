import { describe, expect, it } from "vitest";
import {
  buildSpeciesSparql,
  parseRetryAfterMs,
  parseSparqlBindings,
  titleFromArticleUrl,
  validSpeciesCode,
  buildSciNameSparql,
  fetchWikidataBySciName,
  validSciName,
} from "./wikidata";
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
  upsertAiData,
  upsertResolution,
  upsertWikiOk,
  wikiFetchTitleFor,
  enrichOneNow,
} from "./species-enrichment";
import type { WikidataSpeciesRow } from "./wikidata";

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
      const row = await getEnrichment(CODE);
      expect(row?.wiki_status).toBeNull(); // resolution recorded, wiki stage untouched
      expect(row?.wiki_fetched_at).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

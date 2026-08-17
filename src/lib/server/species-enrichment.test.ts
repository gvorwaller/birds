import { describe, expect, it } from "vitest";
import {
  buildSpeciesSparql,
  parseRetryAfterMs,
  parseSparqlBindings,
  titleFromArticleUrl,
  validSpeciesCode,
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
  staleCodes,
  upsertAiData,
  upsertResolution,
  upsertWikiOk,
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
      expect(await staleCodes(false)).not.toContain(CODE);
      expect(await staleCodes(true)).not.toContain(CODE); // no prose → no AI work either
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
      // Freshly fetched → out of scope, not stale.
      await upsertWikiOk(CODE, { title: "T", revId: 1, extract: "x", sections: [] });
      expect(await enrichmentScope()).not.toContain(CODE);
      expect(await staleCodes(false)).not.toContain(CODE);
      // AI-missing counts as stale ONLY when the AI stage is enabled.
      expect(await staleCodes(true)).toContain(CODE);
      // Old fetch → stale regardless.
      await query(
        `UPDATE species_enrichment SET wiki_fetched_at = NOW() - INTERVAL '181 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect(await staleCodes(false)).toContain(CODE);
      // Error rows retry only after their window.
      await markWikiError(CODE, "boom");
      expect(await staleCodes(false)).not.toContain(CODE); // fresh error
      await query(
        `UPDATE species_enrichment SET wiki_fetched_at = NOW() - INTERVAL '8 days'
          WHERE species_code = $1`,
        [CODE],
      );
      expect(await staleCodes(false)).toContain(CODE);
    } finally {
      await query(`DELETE FROM seen_species WHERE species_code = $1`, [CODE]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
      await wipe();
    }
  });
});

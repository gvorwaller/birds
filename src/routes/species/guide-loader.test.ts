import { describe, expect, it } from "vitest";
import { load } from "./+page.server";
import { isFieldGuideActive } from "$lib/field-guide-nav";
import { query } from "$lib/db";
import { upsertAiData, upsertWikiOk } from "$server/species-enrichment";

// Route-level verification for the Field guide loader (CODEX1 Phase-3 #1).
// Runs against the real test cluster like the other DB-gated suites.
const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

/** The loader takes a SvelteKit event; only locals + url are read. */
function event(scopeId: number, path: string) {
  return {
    locals: { scopeId },
    url: new URL(`http://localhost${path}`),
  } as unknown as Parameters<typeof load>[0];
}

interface GuideLoad {
  q: string;
  tags: string[];
  active: boolean;
  results: { species_code: string; seen: boolean }[];
  counts: { taxonomy: number; withWikipedia: number; annotated: number };
}

async function run(scopeId: number, path: string): Promise<GuideLoad> {
  return (await load(event(scopeId, path))) as unknown as GuideLoad;
}

describe("Field guide nav-active invariant", () => {
  it("exact /species only — detail pages never light the drawer item", () => {
    expect(isFieldGuideActive("/species")).toBe(true);
    expect(isFieldGuideActive("/species/")).toBe(true);
    expect(isFieldGuideActive("/species/margod")).toBe(false);
    expect(isFieldGuideActive("/species/margod/")).toBe(false);
    expect(isFieldGuideActive("/")).toBe(false);
  });
});

describe.runIf(dbUp)("Field guide loader (route contract, test cluster)", () => {
  const CODE = "gldrtst1";

  async function seed(): Promise<number> {
    const uid = (
      await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)
    ).rows[0].id;
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Loader Testbird', 'Testus loaderus', 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
      [CODE],
    );
    await upsertWikiOk(CODE, {
      title: "L",
      revId: 1,
      extract: "A loaderus bird of quiet marshes.",
      sections: [],
    });
    await upsertAiData(CODE, {
      fieldCraft: "Look low.",
      tags: ["habitat:freshwater-marsh"],
      model: "m",
      sourceRevId: 1,
    });
    return uid;
  }
  async function unseed() {
    await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [CODE]);
    await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [CODE]);
  }

  it("GET ?tags= AND-filters; unknown tags degrade to dropped, not errors", async () => {
    const uid = await seed();
    try {
      const good = await run(uid, "/species?tags=habitat%3Afreshwater-marsh");
      expect(good.active).toBe(true);
      expect(good.tags).toEqual(["habitat:freshwater-marsh"]);
      expect(good.results.map((r) => r.species_code)).toContain(CODE);

      // Unknown tag alongside a real one: dropped, filter still applies.
      const mixed = await run(uid, "/species?tags=habitat%3Afreshwater-marsh&tags=bogus%3Atag");
      expect(mixed.tags).toEqual(["habitat:freshwater-marsh"]);
      expect(mixed.results.map((r) => r.species_code)).toContain(CODE);

      // ONLY unknown tags: degrades to the inactive intro state (no query).
      const junkOnly = await run(uid, "/species?tags=bogus%3Atag");
      expect(junkOnly.active).toBe(false);
      expect(junkOnly.results).toEqual([]);
    } finally {
      await unseed();
    }
  });

  it("q is clamped to 200 chars; intro state runs no search; counts reflect the SEARCHABLE corpus", async () => {
    const uid = await seed();
    try {
      const long = await run(uid, `/species?q=${"x".repeat(300)}`);
      expect(long.q).toHaveLength(200);

      const intro = await run(uid, "/species");
      expect(intro.active).toBe(false);
      expect(intro.results).toEqual([]);
      expect(intro.counts.withWikipedia).toBeGreaterThan(0);
      expect(intro.counts.taxonomy).toBeGreaterThan(0);

      // A retired code (enrichment row without current taxonomy) must not
      // inflate the advertised counts (CODEX1 Phase-3 #2).
      await query(
        `INSERT INTO species_enrichment (species_code, wikipedia_extract, wiki_status, wiki_fetched_at)
         VALUES ('retired0', 'ghost prose', 'ok', NOW())
         ON CONFLICT (species_code) DO NOTHING`,
      );
      try {
        const after = await run(uid, "/species");
        expect(after.counts.withWikipedia).toBe(intro.counts.withWikipedia);
      } finally {
        await query(`DELETE FROM species_enrichment WHERE species_code = 'retired0'`);
      }
    } finally {
      await unseed();
    }
  });

  it("seen badge follows the SCOPE user id (the viewer path: scopeId = owner)", async () => {
    const uid = await seed();
    try {
      await query(
        `INSERT INTO seen_species (user_id, species_code, source) VALUES ($1, $2, 'manual')
         ON CONFLICT DO NOTHING`,
        [uid, CODE],
      );
      const asOwnerScope = await run(uid, "/species?tags=habitat%3Afreshwater-marsh");
      expect(
        asOwnerScope.results.find((r) => r.species_code === CODE)?.seen,
      ).toBe(true);
      // A different scope id (no seen rows) → Need.
      const other = await run(uid + 999_999, "/species?tags=habitat%3Afreshwater-marsh");
      expect(other.results.find((r) => r.species_code === CODE)?.seen).toBe(false);
    } finally {
      await query(`DELETE FROM seen_species WHERE species_code = $1`, [CODE]);
      await unseed();
    }
  });
});

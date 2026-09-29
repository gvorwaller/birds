/**
 * td-894144 Release A — the database side of "AI never changes a tag".
 *
 * Runs against the shared birds_test cluster as the RUNTIME role (birds_app,
 * the app pool's login). Owned fixture codes only (zzts…), deleted exactly.
 * Plan: docs/2026-09-26-ai-tag-accuracy-plan-CC.md, Release A tests.
 *
 * Writers that need heavy fixtures (upsertInatSimilar, similarCandidatesFor,
 * markSimilarDeclined) are exercised as birds_app by their own suites in
 * species-enrichment.test.ts / job-handlers.test.ts, which run on the same
 * role and would fail with "permission denied" if they named a denied column.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { query } from "$lib/db";
import {
  getEnrichment,
  markAiError,
  markInatError,
  markInatNoMapping,
  markMediaError,
  markWikiError,
  markWikiNoArticle,
  reconcileSimilarState,
  searchGuide,
  upsertAiProseData,
  upsertMediaOk,
  upsertResolution,
  upsertWikiOk,
} from "./species-enrichment";
import { setFixtureTags, withOwnerClient } from "./tag-fixtures.test-helper";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT 1 FROM information_schema.columns
			  WHERE table_name = 'species_enrichment' AND column_name = 'legacy_tags'`,
    ).then((r) => r.rows.length === 1)
  : false;

const RUN = String(process.pid % 100000).padStart(5, "0");
const A = `zzts${RUN}a`; // insert-branch code
const B = `zzts${RUN}b`; // conflict-branch code
const T = `zzts${RUN}t`; // taxonomy fixture for the availability tests
const ALL = [A, B, T];
const MIGRATION_SQL = readFileSync(
  new URL(
    "../../../backend/db/migrations/0065_tag_safety.sql",
    import.meta.url,
  ),
  "utf8",
);

const article = (revId: number, extract: string) => ({
  title: `Fixture ${RUN}`,
  revId,
  extract,
  sections: [{ title: "Habitat", text: "Coastal mudflats in winter." }],
});

async function cleanup() {
  await query("DELETE FROM species_enrichment WHERE species_code = ANY($1)", [
    ALL,
  ]);
  await withOwnerClient((c) =>
    c.query("DELETE FROM taxonomy_cache WHERE species_code = $1", [T]),
  );
}

async function vectorMatches(code: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT search_tsv IS NOT DISTINCT FROM public.species_search_vector(
		          tags, wikipedia_extract, field_craft, wikipedia_sections) AS ok
		   FROM species_enrichment WHERE species_code = $1`,
    [code],
  );
  return r.rows[0]?.ok === true;
}

describe.runIf(dbUp && migrated)("td-894144 Release A: grants", () => {
  it("birds_app has no table-level INSERT/UPDATE and no write on tags, legacy_tags, search_tsv", async () => {
    const t = await query<{
      ins: boolean;
      upd: boolean;
      sel: boolean;
      del: boolean;
    }>(
      `SELECT has_table_privilege('birds_app', 'public.species_enrichment', 'INSERT') AS ins,
			        has_table_privilege('birds_app', 'public.species_enrichment', 'UPDATE') AS upd,
			        has_table_privilege('birds_app', 'public.species_enrichment', 'SELECT') AS sel,
			        has_table_privilege('birds_app', 'public.species_enrichment', 'DELETE') AS del`,
    );
    // has_table_privilege is true if ANY column is granted; check the
    // table-level ACL directly instead.
    const acl = await query<{ table_level: string | null }>(
      `SELECT (SELECT string_agg(privilege_type, ',' ORDER BY privilege_type)
			           FROM information_schema.role_table_grants
			          WHERE table_name = 'species_enrichment' AND grantee = 'birds_app') AS table_level`,
    );
    expect(acl.rows[0].table_level).toBe("DELETE,SELECT");
    expect(t.rows[0].sel).toBe(true);
    expect(t.rows[0].del).toBe(true);
    for (const col of ["tags", "legacy_tags", "search_tsv"]) {
      const c = await query<{ ins: boolean; upd: boolean }>(
        `SELECT has_column_privilege('birds_app', 'public.species_enrichment', $1, 'INSERT') AS ins,
				        has_column_privilege('birds_app', 'public.species_enrichment', $1, 'UPDATE') AS upd`,
        [col],
      );
      expect(c.rows[0], col).toEqual({ ins: false, upd: false });
    }
  });

  it("every other current column is writable (a new column is denied until a migration grants it)", async () => {
    const r = await query<{ column_name: string; ins: boolean; upd: boolean }>(
      `SELECT column_name,
			        has_column_privilege('birds_app', 'public.species_enrichment', column_name, 'INSERT') AS ins,
			        has_column_privilege('birds_app', 'public.species_enrichment', column_name, 'UPDATE') AS upd
			   FROM information_schema.columns
			  WHERE table_schema = 'public' AND table_name = 'species_enrichment'
			    AND column_name NOT IN ('tags', 'legacy_tags', 'search_tsv')`,
    );
    expect(r.rows.length).toBeGreaterThan(20);
    const denied = r.rows
      .filter((x) => !x.ins || !x.upd)
      .map((x) => x.column_name);
    expect(denied).toEqual([]);
  });

  it("the search trigger fires only on its input columns", async () => {
    const r = await query<{ cols: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
			   FROM pg_trigger t
			   JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr)
			  WHERE t.tgname = 'species_enrichment_b_search_tsv'`,
    );
    expect(r.rows[0].cols).toEqual([
      "field_craft",
      "search_tsv",
      "tags",
      "wikipedia_extract",
      "wikipedia_sections",
    ]);
  });

  it("the migration hard-limits its owner fixture escape to birds_test", () => {
    // This assertion reads the pending migration source because a developer's
    // long-lived birds_test may already have an earlier uncommitted draft of
    // 0065 applied; production has never received it.
    expect(MIGRATION_SQL).toContain("current_database() = 'birds_test'");
  });
});

describe.runIf(dbUp && migrated)(
  "td-894144 Release A: denied direct writes (as birds_app)",
  () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    it("UPDATE of tags, search_tsv or legacy_tags is refused; INSERT with tags is refused", async () => {
      await upsertWikiOk(A, article(1, "A seabird."));
      for (const sql of [
        `UPDATE species_enrichment SET tags = ARRAY['habitat:open-ocean'] WHERE species_code = $1`,
        `UPDATE species_enrichment SET search_tsv = to_tsvector('x') WHERE species_code = $1`,
        `UPDATE species_enrichment SET legacy_tags = ARRAY['habitat:open-ocean'] WHERE species_code = $1`,
      ]) {
        await expect(query(sql, [A]), sql).rejects.toThrow(/permission denied/);
      }
      await expect(
        query(
          `INSERT INTO species_enrichment (species_code, tags) VALUES ($1, ARRAY['x'])`,
          [B],
        ),
      ).rejects.toThrow(/permission denied/);
    });
  },
);

describe.runIf(dbUp && migrated)(
  "td-894144 Release A: normal writers still work (as birds_app)",
  () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    it("INSERT and ON CONFLICT branches of every simple writer succeed, vector stays derived", async () => {
      // Insert branches on fresh codes, then the same writers again (conflict).
      for (const code of [A, B]) {
        await upsertResolution(code, null);
        await upsertResolution(code, null);
      }
      await query(
        "DELETE FROM species_enrichment WHERE species_code = ANY($1)",
        [[A, B]],
      );

      await markWikiError(A, "boom"); // insert
      await markWikiError(A, "boom again"); // conflict
      await upsertWikiOk(A, article(2, "A pelagic seabird.")); // conflict
      expect(await vectorMatches(A)).toBe(true);

      await upsertWikiOk(B, article(3, "Fresh insert.")); // insert
      expect(await vectorMatches(B)).toBe(true);
      await markWikiNoArticle(B); // conflict — clears prose; vector re-derived
      expect(await vectorMatches(B)).toBe(true);
      await query("DELETE FROM species_enrichment WHERE species_code = $1", [
        B,
      ]);
      await markWikiNoArticle(B); // insert
      expect(await vectorMatches(B)).toBe(true);

      await upsertAiProseData(A, {
        fieldCraft: "Scan offshore.",
        model: "m",
        sourceRevId: 2,
      });
      expect(await vectorMatches(A)).toBe(true);
      const afterProse = await getEnrichment(A);
      expect(afterProse?.field_craft).toBe("Scan offshore.");
      expect(afterProse?.tags).toEqual([]); // AI wrote no tags

      await markAiError(A, "ai boom");
      await markMediaError(A, "media boom"); // conflict
      await upsertMediaOk(A, [], "no_media"); // conflict
      await query("DELETE FROM species_enrichment WHERE species_code = $1", [
        B,
      ]);
      await markMediaError(B, "media boom"); // insert
      await query("DELETE FROM species_enrichment WHERE species_code = $1", [
        B,
      ]);
      await upsertMediaOk(B, [], "no_media"); // insert

      await markInatError(A, "inat boom"); // conflict
      await markInatNoMapping(A); // conflict
      await query("DELETE FROM species_enrichment WHERE species_code = $1", [
        B,
      ]);
      await markInatError(B, "inat boom"); // insert
      await query("DELETE FROM species_enrichment WHERE species_code = $1", [
        B,
      ]);
      await markInatNoMapping(B); // insert

      await reconcileSimilarState(A, [], "hash-zz", "none", null);
      // The direct similar reset issued by job-handlers (newly exposed codes).
      await query(
        `UPDATE species_enrichment
			    SET similar_status = NULL, similar_error = NULL, updated_at = NOW()
			  WHERE species_code = $1`,
        [A],
      );
      expect(await vectorMatches(A)).toBe(true);
    });
  },
);

describe.runIf(dbUp && migrated)("td-894144 Release A: legacy guard", () => {
  beforeAll(async () => {
    await cleanup();
    await upsertWikiOk(A, article(1, "A seabird."));
  });
  afterAll(cleanup);

  it("the owner cannot change legacy_tags without the fixture flag; insert with it is refused too", async () => {
    await expect(
      withOwnerClient((c) =>
        c.query(
          `UPDATE species_enrichment SET legacy_tags = ARRAY['x'] WHERE species_code = $1`,
          [A],
        ),
      ),
    ).rejects.toThrow(/legacy_tags is immutable/);
    await expect(
      withOwnerClient((c) =>
        c.query(
          `INSERT INTO species_enrichment (species_code, legacy_tags) VALUES ($1, ARRAY['x'])`,
          [B],
        ),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("an ON CONFLICT write preserves a legacy baseline; tags stay byte-identical", async () => {
    await setFixtureTags(A, ["habitat:open-ocean", "habitat:beach"]);
    await upsertWikiOk(A, article(9, "Rewritten article text."));
    const r = await query<{ tags: string[]; legacy_tags: string[] }>(
      "SELECT tags, legacy_tags FROM species_enrichment WHERE species_code = $1",
      [A],
    );
    expect(r.rows[0].tags).toEqual(["habitat:open-ocean", "habitat:beach"]);
    expect(r.rows[0].legacy_tags).toEqual([
      "habitat:open-ocean",
      "habitat:beach",
    ]);
    expect(await vectorMatches(A)).toBe(true);
  });

  it("cutover snapshot: no row has a legacy baseline that differs from its tags", async () => {
    // Nothing but the owner fixture helper (which sets both equally) can
    // write either column, so this holds on the live snapshot.
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM species_enrichment
			  WHERE legacy_tags IS NOT NULL AND legacy_tags IS DISTINCT FROM tags`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});

describe.runIf(dbUp && migrated)(
  'td-894144 Release A: availability (unknown is not "none")',
  () => {
    beforeAll(async () => {
      await cleanup();
      await withOwnerClient((c) =>
        c.query(
          `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family, fetched_at)
				 VALUES ($1, $2, $3, 'species', 'Fixture family', NOW())`,
          [T, `Zzts Fixture Petrel ${RUN}`, `Zztsia fixtura${RUN}`],
        ),
      );
      await upsertWikiOk(T, article(1, "A fixture petrel of the open ocean."));
      // AI annotated it AFTER the cutover: prose, but no legacy baseline.
      await upsertAiProseData(T, {
        fieldCraft: "Look offshore.",
        model: "m",
        sourceRevId: 1,
      });
    });
    afterAll(cleanup);

    it("a post-cutover species reads tags_available = false on the detail read", async () => {
      const e = await getEnrichment(T);
      expect(e?.ai_generated_at).not.toBeNull();
      expect(e?.tags_available).toBe(false);
    });

    it("a tag filter counts it as not yet evaluated — before the tag predicate, even with no matches", async () => {
      const found = await searchGuide(
        `Zzts Fixture Petrel ${RUN}`,
        ["habitat:open-ocean"],
        0,
      );
      expect(found.rows).toEqual([]); // it can't match a tag filter
      expect(found.unknownCount).toBe(1); // …and the page says so
      const noTags = await searchGuide(`Zzts Fixture Petrel ${RUN}`, [], 0);
      expect(
        noTags.rows.map((r) => [r.species_code, r.tags_available]),
      ).toEqual([[T, false]]);
      expect(noTags.unknownCount).toBe(0); // only computed with a tag filter
    });

    it("an unavailable row cannot match even if its protected tags array is non-empty", async () => {
      // A corrupt/anomalous pre-cutover row must still obey the availability
      // contract: legacy_tags NULL means every tag is unknown. The owner helper
      // creates that state only on this owned birds_test fixture.
      await setFixtureTags(T, ["habitat:open-ocean"], { legacy: false });
      const found = await searchGuide(
        `Zzts Fixture Petrel ${RUN}`,
        ["habitat:open-ocean"],
        0,
      );
      expect(found.rows).toEqual([]);
      expect(found.unknownCount).toBe(1);
    });

    it("once it has an (owner-fixture) baseline it is available and matches", async () => {
      await setFixtureTags(T, ["habitat:open-ocean"]);
      const found = await searchGuide(
        `Zzts Fixture Petrel ${RUN}`,
        ["habitat:open-ocean"],
        0,
      );
      expect(found.rows.map((r) => [r.species_code, r.tags_available])).toEqual(
        [[T, true]],
      );
      expect(found.unknownCount).toBe(0);
    });
  },
);

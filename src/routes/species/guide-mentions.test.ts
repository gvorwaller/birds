import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { upsertWikiOk } from "$server/species-enrichment";
import { loadTestEnv, requireTestDb } from "$server/testing/test-env";
import { load } from "./+page.server";

/**
 * td-bdde97: the loader's opt-in for species that only mention a bird-name
 * query. Own fixture species (made-up words) and a disposable user; the codes
 * differ from species-enrichment.test.ts's so parallel files never collide.
 */
loadTestEnv();
await requireTestDb(query);

const N = "bdnamt02"; // "Plain Bdloadfinch" — named for the word
const P = "bdprot02"; // "Zz Bdloadprose" — only mentions it; on the life list
const CODES = [N, P];
let uid = 0;

function event(path: string) {
  return {
    locals: { scopeId: uid, user: { id: uid, role: "user", views_user_id: null } },
    depends: () => {},
    url: new URL(`http://localhost${path}`),
  } as unknown as Parameters<typeof load>[0];
}
const run = async (path: string) => (await load(event(path))) as any;
const codes = (d: any): string[] => d.results.map((r: { species_code: string }) => r.species_code);

beforeAll(async () => {
  try {
    uid = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'bdde97 loader fixture', '!unset', 'user') RETURNING id`,
        [`bdde97-${randomUUID()}`],
      )
    ).rows[0].id;
    for (const [code, com] of [
      [N, "Plain Bdloadfinch"],
      [P, "Zz Bdloadprose"],
    ] as const) {
      await query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
         VALUES ($1, $2, 'Testus bdloadus', 'species', 'Bdloadidae')
         ON CONFLICT (species_code) DO UPDATE
           SET com_name = EXCLUDED.com_name, family = EXCLUDED.family, category = 'species'`,
        [code, com],
      );
    }
    await upsertWikiOk(P, { title: "P", revId: 1, extract: "It follows flocks of bdloadfinches.", sections: [] });
    await query(`INSERT INTO seen_species (user_id, species_code, source) VALUES ($1, $2, 'manual')`, [uid, P]);
  } catch (e) {
    await cleanup();
    throw e;
  }
});

async function cleanup() {
  if (uid) {
    await query(`DELETE FROM seen_species WHERE user_id = $1`, [uid]);
    await query(`DELETE FROM users WHERE id = $1 AND username LIKE 'bdde97-%'`, [uid]);
  }
  await query(`DELETE FROM species_enrichment WHERE species_code = ANY($1)`, [CODES]);
  await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1)`, [CODES]);
}
afterAll(cleanup);

describe("td-bdde97: Field guide loader, opt-in prose matches", () => {
  it("hides prose-only matches by default and offers them with a page-one link", async () => {
    const d = await run("/species?q=bdloadfinch&page=1");
    expect(codes(d)).toEqual([N]);
    expect(d.includeMentions).toBe(false);
    expect(d.mentions).toEqual({ count: 1, shown: false, href: "/species?q=bdloadfinch&mentions=1#results" });
  });

  it("shows them on request, with a link that hides them again", async () => {
    const d = await run("/species?q=bdloadfinch&mentions=1");
    expect(codes(d)).toEqual([N, P]);
    expect(d.mentions).toEqual({ count: 1, shown: true, href: "/species?q=bdloadfinch#results" });
  });

  it("keeps the opt-in through a scope with nothing to show, and it applies again after", async () => {
    // Need: P is on the life list, so this scope has no prose-only match and no note…
    const need = await run("/species?q=bdloadfinch&list=need&mentions=1");
    expect(codes(need)).toEqual([N]);
    expect(need.mentions).toBeNull();
    // …but the loader still reports the opt-in, which the filter form carries.
    expect(need.includeMentions).toBe(true);
    const all = await run("/species?q=bdloadfinch&list=all&mentions=1");
    expect(codes(all)).toEqual([N, P]);
  });

  it("only mentions=1 opts in", async () => {
    for (const v of ["0", "true", "yes", ""]) {
      expect((await run(`/species?q=bdloadfinch&mentions=${v}`)).includeMentions).toBe(false);
    }
  });
});

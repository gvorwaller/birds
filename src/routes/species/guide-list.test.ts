import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { ALL_TAGS } from "$lib/species-tags";
import { GUIDE_LISTS, type GuideList } from "$lib/guide-list";
import { scopeOwnerId } from "$server/access";
import { setSpecialInterest } from "$server/special-interest";
import { recordSpeciesView } from "$server/species-views";
import { loadTestEnv, requireTestDb } from "$server/testing/test-env";
import { load } from "./+page.server";

/**
 * Phase 9A (td-f02bf7): All / Need / Seen list scope. Deterministic fixtures in
 * the isolated database: a controlled geography (a county, a hotspot and a
 * map circle across the antimeridian) with 250 EXISTING taxonomy species, an
 * owner with a controlled life list, and a linked viewer with a deliberately
 * different list of their own. Nothing here depends on production-copy totals.
 */
loadTestEnv();
await requireTestDb(query);

const COUNTY = "US-FL-961";
const H_MAIN = "L99761001"; // carries all 250 species
const H_WEST = "L99762001"; // (12, -179.9): ~13.6 mi across the antimeridian
const H_EAST = "L99762002"; // (12, 179.0): ~61 mi
const H_BARE = "L99763001"; // loaded, but no species rows at all
const COUNTY_BARE = "US-FL-962"; // loaded county whose hotspot has nothing
const RETIRED = "g9retired1"; // in a seen list, never in the taxonomy
const CENTER = { lat: 12, lng: 179.9 };

interface Account {
  id: number;
  role: "user" | "viewer";
  views_user_id: number | null;
}
let owner: Account;
let viewer: Account;
let species: string[] = []; // the 250 geography species, in Postgres name order
let ownerSeen = new Set<string>();
let viewerSeen = new Set<string>();
let emptyState: string | null = null;
let commonFamily = "";
let narrowTag = "";
let commonTag = "";
const users: number[] = [];

function event(path: string, who: Account) {
  return {
    locals: { scopeId: scopeOwnerId(who as never), user: { id: who.id, role: who.role, views_user_id: who.views_user_id } },
    depends: () => {},
    url: new URL(`http://localhost${path}`),
  } as unknown as Parameters<typeof load>[0];
}
const run = async (path: string, who: Account = owner) => (await load(event(path, who))) as any;
const rejection = (p: Promise<unknown>) => p.then(() => null, (e) => e);
const codes = (d: any): string[] => d.results.map((r: { species_code: string }) => r.species_code);

/** Every page of a result set, in order (the loader itself never returns more than 100). */
async function collect(path: string, who: Account = owner) {
  const sep = path.includes("?") ? "&" : "?";
  const first = await run(path, who);
  const rows: any[] = [...first.results];
  const total: number = first.total;
  for (let page = 2; rows.length < total; page += 1) rows.push(...(await run(`${path}${sep}page=${page}`, who)).results);
  return { rows, total, first };
}
const withList = (base: string, list: GuideList) => `${base}${base.includes("?") ? "&" : "?"}list=${list}`;

async function makeUser(role: "user" | "viewer", viewsUserId: number | null): Promise<Account> {
  const id = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role,views_user_id) VALUES($1,$2,'!unset',$3,$4) RETURNING id",
      [`list-${randomUUID()}`, `List QA ${role}`, role, viewsUserId],
    )
  ).rows[0].id;
  users.push(id);
  return { id, role, views_user_id: viewsUserId };
}

describe("Field Guide All / Need / Seen list scope", () => {
  beforeAll(async () => {
    owner = await makeUser("user", null);
    viewer = await makeUser("viewer", owner.id);

    // 250 durable snapshot species, in the database's own name order. Requiring
    // an enrichment row excludes other suites' temporary taxonomy-only rows;
    // those rows may appear and disappear while Vitest files run in parallel.
    species = (
      await query<{ species_code: string }>(
        `SELECT tc.species_code
           FROM taxonomy_cache tc
           JOIN species_enrichment se USING (species_code)
          WHERE tc.category='species'
          ORDER BY tc.com_name, tc.species_code
          OFFSET 1500 LIMIT 250`,
      )
    ).rows.map((r) => r.species_code);
    if (species.length !== 250) throw Error("Requires 250 real taxonomy species");

    // Geography: a county with one hotspot carrying all 250, a map pair, and an empty county.
    const row = async (code: string, kind: "region" | "hotspot", name: string, region: string | null) =>
      query(
        `INSERT INTO frequency_fetch (loc_code,loc_kind,loc_name,begin_year,end_year,sample_sizes,n_species,region_code)
         VALUES ($1,$2,$3,2016,2025,$4,9,$5)`,
        [code, kind, name, Array(48).fill(10), region],
      );
    await row(COUNTY, "region", "Zqlist County", "US-FL");
    await row(H_MAIN, "hotspot", "Zqlist Marsh", COUNTY);
    await row(H_WEST, "hotspot", "Zqlist West", null);
    await row(H_EAST, "hotspot", "Zqlist East", null);
    await row(COUNTY_BARE, "region", "Zqlist Bare County", "US-FL");
    await row(H_BARE, "hotspot", "Zqlist Bare Marsh", COUNTY_BARE);
    for (const [id, lat, lng] of [[H_WEST, 12, -179.9], [H_EAST, 12, 179.0]] as const)
      await query(`INSERT INTO ebird_locations (loc_id,loc_name,lat,lng) VALUES ($1,'Zqlist map',$2,$3)`, [id, lat, lng]);
    const freq = (loc: string, list: string[]) =>
      query(
        `INSERT INTO species_month_freq (loc_code,species_code,month,num)
         SELECT $1, unnest($2::text[]), 6, 3`,
        [loc, list],
      );
    await freq(H_MAIN, species);
    await freq(H_WEST, species.slice(0, 40));
    await freq(H_EAST, species.slice(40, 80));

    // Owner's life list: the alphabetically FIRST 60 (so an in-memory slice of All page 1 would be wrong),
    // a retired code, and a real species OUTSIDE the geography. Viewer: a different, LAST 60 plus more.
    const outside = (
      await query<{ species_code: string }>(
        `SELECT tc.species_code
           FROM taxonomy_cache tc
           JOIN species_enrichment se USING (species_code)
          WHERE tc.category='species' AND tc.species_code <> ALL($1::text[])
          ORDER BY tc.com_name, tc.species_code OFFSET 5000 LIMIT 3`,
        [species],
      )
    ).rows.map((r) => r.species_code);
    ownerSeen = new Set(species.slice(0, 60));
    for (const c of [...ownerSeen, RETIRED, ...outside])
      await query("INSERT INTO seen_species(user_id,species_code) VALUES($1,$2)", [owner.id, c]);
    viewerSeen = new Set(species.slice(190));
    for (const c of viewerSeen) await query("INSERT INTO seen_species(user_id,species_code) VALUES($1,$2)", [viewer.id, c]);

    // Personal browsing state: each account's own. Owner: interest in one seen and one unseen species.
    await setSpecialInterest(owner.id, species[3], true);
    await setSpecialInterest(owner.id, species[100], true);
    await setSpecialInterest(viewer.id, species[200], true);
    await recordSpeciesView(viewer.id, species[5], randomUUID());

    // Dynamic but deterministic-in-this-fixture: the most common family and tag among the 250.
    commonFamily = (
      await query<{ family_code: string }>(
        `SELECT family_code FROM taxonomy_cache WHERE species_code = ANY($1) AND family_code IS NOT NULL
          GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
        [species],
      )
    ).rows[0].family_code;
    const tags = (
      await query<{ t: string }>(
        `SELECT t FROM (SELECT unnest(tags) t FROM species_enrichment WHERE species_code = ANY($1)) x
          GROUP BY t ORDER BY count(*) DESC, t`,
        [species],
      )
    ).rows.map((r) => r.t).filter((t) => ALL_TAGS.has(t));
    commonTag = tags[0];
    if (!commonTag) throw Error("Requires enriched species with tags");
    // The rarest tag (globally) that still occurs among the fixture species, capped so the test stays small.
    narrowTag =
      (
        await query<{ t: string }>(
          `SELECT t FROM (SELECT unnest(tags) t FROM species_enrichment) x WHERE t = ANY($1)
            GROUP BY t HAVING count(*) BETWEEN 5 AND 200 ORDER BY count(*), t LIMIT 1`,
          [tags],
        )
      ).rows[0]?.t ?? commonTag;

    emptyState =
      (
        await query<{ code: string }>(
          `SELECT code FROM regions r WHERE level='subnational1'
             AND NOT EXISTS (SELECT 1 FROM frequency_fetch f
               WHERE f.loc_code = r.code OR f.loc_code LIKE r.code||'-%' OR f.region_code = r.code OR f.region_code LIKE r.code||'-%')
           ORDER BY code LIMIT 1`,
        )
      ).rows[0]?.code ?? null;
  });

  afterAll(async () => {
    await query("DELETE FROM species_view_history WHERE user_id = ANY($1)", [users]);
    await query("DELETE FROM species_special_interest WHERE user_id = ANY($1)", [users]);
    await query("DELETE FROM seen_species WHERE user_id = ANY($1)", [users]);
    await query("DELETE FROM users WHERE id = ANY($1)", [users]);
    await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [[COUNTY, COUNTY_BARE, H_MAIN, H_WEST, H_EAST, H_BARE]]);
    await query("DELETE FROM ebird_locations WHERE loc_id = ANY($1)", [[H_WEST, H_EAST]]);
  });

  describe("the three scopes are a disjoint complement over the identical candidate set", () => {
    // Every filter family the spec names, each combined with each scope. Name
    // order is sufficient here; a separate bounded case below checks all sorts.
    const FILTERS: [string, () => string][] = [
      ["explicit browse only", () => ""],
      // Bounded on purpose: `collect` walks every page of three sorts x three scopes, so a very broad text or tag
      // (q=a is thousands of species) is a minutes-long test that proves nothing more than a narrow one.
      ["text", () => "q=sparrow"],
      ["tag", () => `tags=${encodeURIComponent(narrowTag)}`],
      ["family", () => `family=${commonFamily}`],
      ["special interest", () => "interest=1"],
      ["county", () => `country=US&region=US-FL&county=${COUNTY}`],
      ["hotspot", () => `country=US&region=US-FL&county=${COUNTY}&hotspot=${H_MAIN}`],
      ["region + family", () => `country=US&region=US-FL&family=${commonFamily}`],
      ["antimeridian map circle", () => `place=Fixture+Point&lat=${CENTER.lat}&lng=${CENTER.lng}&dist=25`],
      ["county + text + tag + family", () => `county=${COUNTY}&q=a&tags=${encodeURIComponent(commonTag)}&family=${commonFamily}`],
    ];

    for (const [label, build] of FILTERS) {
      it(`${label}: Need ∪ Seen = All, Need ∩ Seen = ∅, counts add up and order is preserved`, async () => {
        // The bare "explicit browse" case is bounded to one family so it cannot race other suites' taxonomy fixtures.
        const base = label === "explicit browse only" ? `family=${commonFamily}` : build();
        const prefix = base ? `/species?${base}` : "/species";
        const withSort = `${prefix}${prefix.includes("?") ? "&" : "?"}sort=name`;
        const all = await collect(withList(withSort, "all"));
        const need = await collect(withList(withSort, "need"));
        const seen = await collect(withList(withSort, "seen"));
          const [a, n, s] = [all.rows, need.rows, seen.rows].map((r) => r.map((x: any) => x.species_code));
          expect(all.total, `${label} All total`).toBe(a.length);
          expect(need.total + seen.total, `${label} counts`).toBe(all.total);
          expect(new Set(a).size, "All has no duplicates").toBe(a.length);
          expect(n.filter((c) => s.includes(c)), "disjoint").toEqual([]);
          expect([...n, ...s].sort(), `${label} union`).toEqual([...a].sort());
          // Every row's badge agrees with the scope it is in.
          expect(need.rows.every((r: any) => r.seen === false), "Need rows are unseen").toBe(true);
          expect(seen.rows.every((r: any) => r.seen === true), "Seen rows are seen").toBe(true);
          // The existing order is unchanged within each scope: it is All's order, filtered.
          const seenRows = new Set(all.rows.filter((r: any) => r.seen).map((r: any) => r.species_code));
          expect(n, `${label} Need order`).toEqual(a.filter((c) => !seenRows.has(c)));
          expect(s, `${label} Seen order`).toEqual(a.filter((c) => seenRows.has(c)));
      }, 30_000);
    }

    it("preserves the existing order within each scope for every supported sort", async () => {
      for (const sort of ["name", "relevance", "taxonomic"]) {
        const base = `/species?county=${COUNTY}&sort=${sort}`;
        const all = await collect(withList(base, "all"));
        const need = await collect(withList(base, "need"));
        const seen = await collect(withList(base, "seen"));
        const allCodes = codes({ results: all.rows });
        const seenCodes = new Set(seen.rows.map((row: any) => row.species_code));
        expect(codes({ results: need.rows }), `${sort} Need order`).toEqual(allCodes.filter((code) => !seenCodes.has(code)));
        expect(codes({ results: seen.rows }), `${sort} Seen order`).toEqual(allCodes.filter((code) => seenCodes.has(code)));
      }
    }, 30_000);
  });

  describe("scope is applied in the database before the 100-row limit, the exact count and pagination", () => {
    const geo = `/species?county=${COUNTY}&sort=name`;

    it("All 250 = 3 pages (100/100/50); Need 190 = 100/90; Seen 60 = one page; the first page of Need is 100 Need rows", async () => {
      const all = await run(withList(geo, "all"));
      expect(all).toMatchObject({ total: 250, list: "all", listExplicit: true });
      expect(all.results).toHaveLength(100);
      // The 60 alphabetically-first species are Seen, so an in-memory filter of All's page 1 would give 40.
      expect(all.results.slice(0, 60).every((r: any) => r.seen)).toBe(true);
      const need = await run(withList(geo, "need"));
      expect(need).toMatchObject({ total: 190, list: "need" });
      expect(need.results).toHaveLength(100);
      expect(need.results.every((r: any) => !r.seen)).toBe(true);
      expect(codes(await run(withList(`${geo}&page=2`, "need")))).toHaveLength(90);
      const seen = await run(withList(geo, "seen"));
      expect(seen).toMatchObject({ total: 60, list: "seen" });
      expect(codes(seen)).toEqual(species.slice(0, 60));
      expect(seen.next).toBeNull();
      expect(need.next).toContain("list=need");
      expect(need.next).toContain("page=2");
      expect(codes(await run(withList(`${geo}&page=3`, "all")))).toHaveLength(50);
    });

    it("a past-end page is a 404 in every scope, never a fallback to page one", async () => {
      for (const [list, page] of [["all", 4], ["need", 3], ["seen", 2]] as const) {
        const err = await rejection(run(withList(`${geo}&page=${page}`, list)));
        expect(err?.status, `${list} page ${page}`).toBe(404);
      }
    });

    it("next/previous links keep the list and every other parameter, including repeated unknown ones", async () => {
      const d = await run(`${withList(geo, "need")}&future=kept&future=twice`);
      const next = new URL(d.next, "http://localhost");
      expect(next.searchParams.get("list")).toBe("need");
      expect(next.searchParams.get("page")).toBe("2");
      expect(next.searchParams.getAll("future")).toEqual(["kept", "twice"]);
      expect(next.searchParams.get("county")).toBe(COUNTY);
      expect(next.hash).toBe("#results");
      const back = await run(`${withList(geo, "need")}&future=kept&page=2`);
      expect(new URL(back.previous, "http://localhost").searchParams.get("list")).toBe("need");
      expect(new URL(back.previous, "http://localhost").searchParams.get("page")).toBe("1");
    });
  });

  describe("geography and coverage", () => {
    it("the map circle's scopes partition its species across the antimeridian, and exclude the outside hotspot", async () => {
      const base = `/species?place=Fixture+Point&lat=${CENTER.lat}&lng=${CENTER.lng}&dist=25&sort=name`;
      const all = await run(withList(base, "all"));
      expect(all.total).toBe(40);
      expect(new Set(codes(all))).toEqual(new Set(species.slice(0, 40)));
      // All 40 are among the owner's first 60: Seen is everything, Need is empty and says so honestly.
      expect(await run(withList(base, "seen"))).toMatchObject({ total: 40 });
      const need = await run(withList(base, "need"));
      expect(need).toMatchObject({ total: 0, results: [] });
      expect(need.location).toMatchObject({ kind: "map", sourceCount: 1 }); // covered: an empty Need is NOT an unavailable place
      // The wider circle adds the east hotspot's 40 (unseen) species.
      const wide = `/species?place=Fixture+Point&lat=${CENTER.lat}&lng=${CENTER.lng}&dist=100&sort=name`;
      expect((await run(withList(wide, "need"))).total).toBe(20); // species 60..79 of the 80 are unseen
      expect((await run(withList(wide, "seen"))).total).toBe(60);
    });

    it("no historical coverage stays unavailable in every scope, never a zero-species or zero-Need claim", async () => {
      if (!emptyState) return;
      for (const list of GUIDE_LISTS) {
        const d = await run(withList(`/species?region=${emptyState}`, list));
        expect(d.location, list).toMatchObject({ sourceCount: 0, wholeArea: false, beginYear: null, endYear: null });
        expect(d.results, list).toEqual([]);
        expect(d.active, list).toBe(true);
      }
      // A loaded place whose sources hold no species is covered, and its scopes are simply empty.
      const bare = await run(withList(`/species?county=${COUNTY_BARE}`, "need"));
      expect(bare.location).toMatchObject({ sourceCount: 2 });
      expect(bare.total).toBe(0);
    });

    it("the hotspot and county scopes agree with their single source", async () => {
      const hotspot = `/species?county=${COUNTY}&hotspot=${H_MAIN}&sort=name`;
      const counts = await Promise.all(GUIDE_LISTS.map(async (l) => (await run(withList(hotspot, l))).total));
      expect(counts).toEqual([250, 190, 60]);
    });
  });

  describe("owner, linked viewer, and the personal-state boundary", () => {
    const geo = `/species?county=${COUNTY}&sort=name`;

    it("the linked viewer receives the owner's displayed-list membership, unchanged by the viewer's own list", async () => {
      expect(scopeOwnerId(viewer as never)).toBe(owner.id);
      for (const list of GUIDE_LISTS) {
        const [o, v] = [await collect(withList(geo, list)), await collect(withList(geo, list), viewer)];
        expect(codes({ results: v.rows }), list).toEqual(codes({ results: o.rows }));
        expect(v.total, list).toBe(o.total);
        expect(v.rows.map((r: any) => r.seen), `${list} badges`).toEqual(o.rows.map((r: any) => r.seen));
      }
      // The viewer's own seen rows (the last 60) do not leak in: they read as Need, as for the owner.
      const need = await collect(withList(geo, "need"), viewer);
      for (const c of viewerSeen) expect(need.rows.some((r: any) => r.species_code === c), c).toBe(true);
      expect((await run(withList(geo, "seen"), viewer)).total).toBe(60);
    });

    it("Viewed and Special-interest state stays the signed-in account's own", async () => {
      // Badges are looked up for the rows on the page, so read each account's own on the page that holds them.
      const o = await run(withList(`${geo}&interest=1`, "all"));
      const v = await run(withList(`${geo}&interest=1`, "all"), viewer);
      expect(new Set(o.interests)).toEqual(new Set([species[3], species[100]]));
      expect(v.interests).toEqual([species[200]]);
      const firstPage = await run(withList(geo, "all"));
      const viewerFirstPage = await run(withList(geo, "all"), viewer);
      expect(Object.keys(firstPage.viewed)).toEqual([]);
      expect(Object.keys(viewerFirstPage.viewed)).toEqual([species[5]]);
      // The interest-only filter is the signed-in account's own, composed with the display-scope list.
      const ownerInterestNeed = await run(withList(`${geo}&interest=1`, "need"));
      expect(codes(ownerInterestNeed)).toEqual([species[100]]);
      const viewerInterestAll = await run(withList(`${geo}&interest=1`, "all"), viewer);
      expect(codes(viewerInterestAll)).toEqual([species[200]]);
      expect((await run(withList(`${geo}&interest=1`, "seen"), viewer)).total).toBe(0); // species[200] is Need for the display list
    });

    it("no other account's life list is visible: a retired or out-of-candidate seen code never enters Seen", async () => {
      const seen = await collect(withList(geo, "seen"));
      expect(seen.rows.map((r: any) => r.species_code)).toEqual(species.slice(0, 60));
      expect(seen.rows.some((r: any) => r.species_code === RETIRED)).toBe(false);
      // The owner's seen species OUTSIDE the county are not injected into its Seen list either.
      const outside = (await query<{ species_code: string }>("SELECT species_code FROM seen_species WHERE user_id=$1", [owner.id])).rows
        .map((r) => r.species_code).filter((c) => !species.includes(c));
      expect(outside.length).toBeGreaterThanOrEqual(3);
      for (const c of outside) expect(seen.rows.map((r: any) => r.species_code)).not.toContain(c);
    });
  });

  describe("strict parameters and the browse landing", () => {
    it("rejects blank, unknown, differently-cased and repeated list values with 400", async () => {
      for (const qs of ["list=", "list=bogus", "list=ALL", "list=Need", "list=%20need", "list=all&list=need", "list=need&list=need"]) {
        const err = await rejection(run(`/species?${qs}`));
        expect(err?.status, qs).toBe(400);
        expect(typeof err.body.message, qs).toBe("string");
      }
      // ...alongside valid geography and search state, too.
      expect((await rejection(run(`/species?county=${COUNTY}&q=a&list=`)))?.status).toBe(400);
    });

    it("an absent list is All and keeps the blank landing prompt; an explicit scope alone browses the taxonomy", async () => {
      const blank = await run("/species");
      expect(blank).toMatchObject({ list: "all", listExplicit: false, active: false, results: [] });
      const familyOnly = await run(`/species?family=${commonFamily}`);
      const familyAll = await run(`/species?family=${commonFamily}&list=all`);
      expect(familyOnly).toMatchObject({ list: "all", listExplicit: false, total: familyAll.total });
      expect(codes(familyOnly)).toEqual(codes(familyAll)); // an existing link with no list is still All
      for (const list of GUIDE_LISTS) {
        const d = await run(`/species?list=${list}`);
        expect(d, list).toMatchObject({ list, listExplicit: true, active: true });
        expect(d.total, list).toBeGreaterThan(0);
        // All and Need browse the whole taxonomy with normal 100-row pages.
        if (list !== "seen") expect(d.results, list).toHaveLength(100);
      }
      // Seen alone is the owner's life list restricted to the CURRENT taxonomy: 60 in the county plus the 3
      // outside it, and NOT the retired code that is also on the list.
      const seen = await run("/species?list=seen");
      expect(seen.total).toBe(63);
      expect(seen.results).toHaveLength(63);
      expect(codes(seen)).not.toContain(RETIRED);
    });
  });
});

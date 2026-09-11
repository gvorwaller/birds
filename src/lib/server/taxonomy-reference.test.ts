import { beforeAll, afterAll, expect, it } from "vitest";
import { env } from "$env/dynamic/private";
import { randomUUID } from "node:crypto";
import { query, withTransaction } from "$lib/db";
import { parseTaxonomy, replaceTaxonomy, writeTaxonomy } from "./taxonomy-sync";
import { searchGuide } from "./species-enrichment";
import { studySpecies } from "./species-study";
import { recordSpeciesView } from "./species-views";
import { load } from "../../routes/taxonomy/+page.server";
import fixture from "./fixtures/taxonomy-reference.json";
import { familyGroups } from "$lib/species-study";
import { isFieldGuideActive } from "$lib/field-guide-nav";
import { safeReturnTo } from "$lib/return-link";
let owner: number, viewer: number;
beforeAll(async () => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires isolated birds_test");
  owner = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Taxonomy QA','!unset','user') RETURNING id",
      ["tax-" + randomUUID()],
    )
  ).rows[0].id;
  viewer = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role,views_user_id) VALUES($1,'Taxonomy QA viewer','!unset','viewer',$2) RETURNING id",
      ["tax-" + randomUUID(), owner],
    )
  ).rows[0].id;
});
afterAll(async () => {
  await query("DELETE FROM users WHERE id=ANY($1::int[])", [
    [owner, viewer].filter(Boolean),
  ]);
});
it("parses real source fields and leaves absent optional metadata unknown", () => {
  const rows = parseTaxonomy(fixture);
  expect(rows.find((r) => r.speciesCode === "osprey")).toMatchObject({
    order: "Accipitriformes",
    familyCode: "pandio1",
    bandingCodes: ["OSPR"],
    taxonOrder: 7832,
  });
  const { speciesCode, comName, sciName, category } = fixture[0];
  expect(
    parseTaxonomy([{ speciesCode, comName, sciName, category }])[0],
  ).toMatchObject({ familyCode: null, taxonOrder: null, extinct: null });
  expect(rows.some((r) => r.extinct === true)).toBe(true);
});
it("rejects malformed payloads before replacing existing rows", async () => {
  const before = (await query("SELECT count(*)::int AS n FROM taxonomy_cache WHERE species_code IN ('osprey','redhea','grbher3')"))
    .rows[0].n;
  for (const payload of [
    [],
    {},
    [fixture[0], fixture[0]],
    [{ ...fixture[0], taxonOrder: "7832" }],
    [{ ...fixture[0], bandingCodes: "OSPR" }],
    [{ ...fixture[0], extinct: "false" }],
    [{ ...fixture[0], speciesCode: "../x" }],
    [
      fixture[0],
      { ...fixture[0], speciesCode: "another", order: "ConflictingOrder" },
    ],
  ]) {
    await expect(replaceTaxonomy(payload)).rejects.toThrow();
  }
  expect(
    (await query("SELECT count(*)::int AS n FROM taxonomy_cache WHERE species_code IN ('osprey','redhea','grbher3')")).rows[0].n,
  ).toBe(before);
});
it("writes complete metadata transactionally; failed deferred override constraint preserves old taxonomy", async () => {
  const before = (await query("SELECT count(*)::int AS n FROM taxonomy_cache WHERE species_code IN ('osprey','redhea','grbher3')"))
    .rows[0].n;
  await withTransaction(async (c) => {
    await c.query(
      "CREATE TEMP TABLE taxonomy_cache (LIKE public.taxonomy_cache INCLUDING ALL) ON COMMIT DROP",
    );
    await c.query("SET LOCAL search_path TO pg_temp, public");
    await writeTaxonomy(c, parseTaxonomy(fixture));
    const osp = (
      await c.query(
        "SELECT taxon_order::float8,banding_codes FROM taxonomy_cache WHERE species_code='osprey'",
      )
    ).rows[0];
    expect(osp).toEqual({ taxon_order: 7832, banding_codes: ["OSPR"] });
    await c.query(
      "CREATE TEMP TABLE override_check(code text REFERENCES taxonomy_cache(species_code) DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP",
    );
    await c.query("INSERT INTO override_check VALUES('osprey')");
    await c.query("SAVEPOINT before_bad_sync");
    await writeTaxonomy(
      c,
      parseTaxonomy(fixture.filter((r) => r.speciesCode !== "osprey")),
    );
    await expect(
      c.query("SET CONSTRAINTS ALL IMMEDIATE"),
    ).rejects.toMatchObject({ code: "23503" });
    await c.query("ROLLBACK TO SAVEPOINT before_bad_sync");
    expect(
      (
        await c.query(
          "SELECT species_code FROM taxonomy_cache WHERE species_code='osprey'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  expect(
    (await query("SELECT count(*)::int AS n FROM taxonomy_cache WHERE species_code IN ('osprey','redhea','grbher3')")).rows[0].n,
  ).toBe(before);
});
it("paginates an entire real family with exact totals and no missing or duplicate species", async () => {
  const family = (
    await query<{ family_code: string; n: number }>(
      "SELECT family_code,count(*)::int n FROM taxonomy_cache WHERE category='species' AND family_code IS NOT NULL GROUP BY family_code HAVING count(*)>100 ORDER BY count(*) LIMIT 1",
    )
  ).rows[0];
  expect(family).toBeTruthy();
  const codes: string[] = [];
  for (let page = 1; codes.length < family.n; page++) {
    const result = await searchGuide("", [], owner, null, {
      family: family.family_code,
      sort: "taxonomic",
      page,
    });
    expect(result.total).toBe(family.n);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThanOrEqual(100);
    codes.push(...result.rows.map((r) => r.species_code));
  }
  const expected = (
    await query<{ species_code: string }>(
      "SELECT species_code FROM taxonomy_cache WHERE family_code=$1 AND category='species' ORDER BY taxon_order NULLS LAST,com_name,species_code",
      [family.family_code],
    )
  ).rows.map((r) => r.species_code);
  expect(codes).toEqual(expected);
  expect(new Set(codes).size).toBe(family.n);
});
it("matches exact banding codes, keeps family and geography intersections, and exposes the matched code", async () => {
  const result = await searchGuide("ospr", [], owner, null, { page: 1 });
  expect(result.rows[0]).toMatchObject({
    species_code: "osprey",
    matched_banding_code: "OSPR",
  });
  expect(
    (await searchGuide("OSPR", [], owner, null, { family: "anatid1", page: 1 }))
      .rows,
  ).toHaveLength(0);
  expect(
    (await searchGuide("OSPR", [], owner, [], { page: 1 })).rows,
  ).toHaveLength(0);
  expect(
    (await searchGuide("%", [], owner, null, { page: 1 })).rows,
  ).toHaveLength(0);
});
it("keeps taxonomic study lists and family order personal, including shared viewers", async () => {
  await recordSpeciesView(owner, "osprey", randomUUID());
  await recordSpeciesView(owner, "redhea", randomUUID());
  const a = await studySpecies(owner, "", "viewed", "taxonomic");
  expect(a.rows.map((r) => r.code)).toEqual(["redhea", "osprey"]);
  expect(familyGroups(a.rows, true).map((g) => g.rows[0].code)).toEqual([
    "redhea",
    "osprey",
  ]);
  expect(
    (await studySpecies(viewer, "OSPR", "viewed", "taxonomic")).rows,
  ).toHaveLength(0);
  expect(
    (await studySpecies(viewer, "OSPR", "unviewed", "taxonomic")).rows.map(
      (r) => r.code,
    ),
  ).toEqual(["osprey"]);
  expect(
    (await studySpecies(owner, "OSPR", "viewed", "taxonomic")).rows[0]
      .matchedBandingCode,
  ).toBe("OSPR");
});
it("loads focused families without recording views, searches taxonomy, and handles retired family links", async () => {
  const event = (path: string, id: number) =>
    ({
      locals: { user: { id }, scopeId: owner },
      url: new URL(path, "https://birds.test"),
      depends: () => {},
    }) as Parameters<typeof load>[0];
  const before = (
    await query(
      "SELECT count(*)::int n FROM species_view_history WHERE user_id=$1",
      [viewer],
    )
  ).rows[0].n;
  const data = await load(
    event("/taxonomy?family=pandio1&focus=osprey", viewer),
  );
  expect(data!.rows.map((r) => r.code)).toEqual(["osprey"]);
  expect(data!.viewed).toEqual({});
  expect(data!.order).toBe("Accipitriformes");
  expect(
    (
      await query(
        "SELECT count(*)::int n FROM species_view_history WHERE user_id=$1",
        [viewer],
      )
    ).rows[0].n,
  ).toBe(before);
  expect(
    (await load(event("/taxonomy?q=OSPR", viewer)))!.groups.flatMap((g) =>
      g.families.map((f) => f.code),
    ),
  ).toEqual(["pandio1"]);
  expect(
    (await load(event("/taxonomy?family=retired", viewer)))!.unavailableFamily,
  ).toBe(true);
  expect((await load(event("/taxonomy?order=RetiredOrder", viewer))).unavailableOrder).toBe(true);
  expect(isFieldGuideActive("/taxonomy")).toBe(true);
  expect(safeReturnTo("/taxonomy?family=pandio1").label).toBe("Taxonomy");
});

it("returns every real species sharing an ambiguous banding code", async () => {
  const result = await searchGuide("WHIM", [], owner, null, { page: 1 });
  expect(
    result.rows
      .filter((r) => r.matched_banding_code === "WHIM")
      .map((r) => r.species_code)
      .sort(),
  ).toEqual(["whimbr3", "whimbr5"]);
});

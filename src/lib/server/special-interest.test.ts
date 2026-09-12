import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import {
  setSpecialInterest,
  specialInterestFor,
  specialInterestSpecies,
} from "./special-interest";
import { searchGuide } from "./species-enrichment";
import { load as guideLoad } from "../../routes/species/+page.server";
import { load as collectionLoad } from "../../routes/special-interest/+page.server";

let owner: number, viewer: number;
let codes: string[];
beforeAll(async () => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires dedicated birds_test");
  codes = (
    await query<{ species_code: string }>(
      "SELECT species_code FROM taxonomy_cache WHERE category='species' ORDER BY species_code LIMIT 120",
    )
  ).rows.map((r) => r.species_code);
  if (codes.length !== 120) throw Error("Requires 120 real taxonomy species");
  owner = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Interest QA','!unset','user') RETURNING id",
      ["interest-" + randomUUID()],
    )
  ).rows[0].id;
  viewer = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role,views_user_id) VALUES($1,'Interest viewer QA','!unset','viewer',$2) RETURNING id",
      ["interest-" + randomUUID(), owner],
    )
  ).rows[0].id;
});
beforeEach(async () => {
  await query(
    "DELETE FROM species_special_interest WHERE user_id=ANY($1::int[])",
    [[owner, viewer]],
  );
});
afterAll(async () => {
  await query("DELETE FROM users WHERE id=ANY($1::int[])", [
    [owner, viewer].filter(Boolean),
  ]);
});

it("keeps viewer interest independent of owner, Seen/Need and viewing history", async () => {
  await setSpecialInterest(viewer, codes[0], true);
  expect(await specialInterestFor(owner, codes)).toEqual([]);
  expect(await specialInterestFor(viewer, codes)).toEqual([codes[0]]);
  expect(await specialInterestSpecies(owner, "", "name")).toEqual([]);
  for (const table of ["seen_species", "species_view_history"]) {
    expect(
      (
        await query(`SELECT 1 FROM ${table} WHERE user_id=ANY($1::int[])`, [
          [owner, viewer],
        ])
      ).rowCount,
    ).toBe(0);
  }
});
it("concurrent and repeated saves are idempotent and preserve saved date; removes are idempotent", async () => {
  await Promise.all([
    setSpecialInterest(viewer, codes[0], true),
    setSpecialInterest(viewer, codes[0], true),
  ]);
  const original = await specialInterestSpecies(viewer, "", "recent");
  expect(original).toHaveLength(1);
  await setSpecialInterest(viewer, codes[0], true);
  expect(await specialInterestSpecies(viewer, "", "recent")).toEqual(original);
  await setSpecialInterest(owner, codes[0], true);
  await setSpecialInterest(viewer, codes[0], false);
  await setSpecialInterest(viewer, codes[0], false);
  expect(await specialInterestSpecies(viewer, "", "recent")).toEqual([]);
  expect(await specialInterestFor(owner, codes)).toEqual([codes[0]]);
});
it("retains and removes retired codes, but rejects adding unavailable codes", async () => {
  const retired = "interestgone";
  expect(
    (
      await query("SELECT 1 FROM taxonomy_cache WHERE species_code=$1", [
        retired,
      ])
    ).rowCount,
  ).toBe(0);
  // Represents an existing personal row after taxonomy replacement.
  await query(
    "INSERT INTO species_special_interest(user_id,species_code) VALUES($1,$2)",
    [viewer, retired],
  );
  expect(await specialInterestSpecies(viewer, "", "name")).toMatchObject([
    { code: retired, current: false, name: null },
  ]);
  await expect(setSpecialInterest(viewer, retired, true)).rejects.toMatchObject(
    { status: 404 },
  );
  await setSpecialInterest(viewer, retired, false);
  expect(await specialInterestSpecies(viewer, "", "name")).toEqual([]);
});
it("returns the whole collection and intersects before guide pagination, including unenriched species", async () => {
  await query(
    "INSERT INTO species_special_interest(user_id,species_code) SELECT $1,unnest($2::text[])",
    [viewer, codes],
  );
  expect(await specialInterestSpecies(viewer, "", "name")).toHaveLength(120);
  expect(await specialInterestSpecies(viewer, "%", "name")).toEqual([]);
  const one = await searchGuide("", [], owner, null, {
    interestUserId: viewer,
    page: 1,
    sort: "name",
  });
  const two = await searchGuide("", [], owner, null, {
    interestUserId: viewer,
    page: 2,
    sort: "name",
  });
  expect(one.total).toBe(120);
  expect(one.rows).toHaveLength(100);
  expect(two.rows).toHaveLength(20);
  expect(
    new Set([...one.rows, ...two.rows].map((r) => r.species_code)),
  ).toEqual(new Set(codes));
  expect(
    (await searchGuide("", [], owner, [], { interestUserId: viewer, page: 1 }))
      .rows,
  ).toEqual([]);
  expect(
    (
      await searchGuide(codes[0], [], owner, null, {
        interestUserId: viewer,
        page: 1,
      })
    ).rows.map((r) => r.species_code),
  ).toContain(codes[0]);
  expect(
    (await searchGuide("", [], owner, null, { interestUserId: owner, page: 1 }))
      .rows,
  ).toEqual([]);
});
it("routes preserve the personal filter through paging while Seen follows the shared owner", async () => {
  await query(
    "INSERT INTO species_special_interest(user_id,species_code) SELECT $1,unnest($2::text[])",
    [viewer, codes],
  );
  await query(
    "INSERT INTO seen_species(user_id,species_code,source) VALUES($1,$2,'manual')",
    [owner, codes[0]],
  );
  try {
    const deps: string[] = [];
    const event = {
      locals: { user: { id: viewer, role: "viewer" }, scopeId: owner },
      url: new URL("http://localhost/species?interest=1&sort=name"),
      depends: (x: string) => deps.push(x),
    };
    const data = (await guideLoad(event as never)) as any;
    expect(data.interestOnly).toBe(true);
    expect(data.total).toBe(120);
    expect(data.next).toContain("interest=1");
    expect(data.next).toContain("page=2");
    expect(deps).toContain("app:special-interest");
    const seen = await searchGuide(codes[0], [], owner, null, {
      interestUserId: viewer,
      page: 1,
    });
    expect(seen.rows.find((r) => r.species_code === codes[0])?.seen).toBe(true);
    const collection = (await collectionLoad({
      ...event,
      url: new URL("http://localhost/special-interest"),
    } as never)) as any;
    expect(collection.accountId).toBe(viewer);
    expect(collection.rows).toHaveLength(120);
  } finally {
    await query("DELETE FROM seen_species WHERE user_id=$1", [owner]);
  }
});
it("account deletion cascades personal selections", async () => {
  const uid = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Delete QA','!unset','user') RETURNING id",
      ["interest-delete-" + randomUUID()],
    )
  ).rows[0].id;
  try {
    await setSpecialInterest(uid, codes[0], true);
  } finally {
    await query("DELETE FROM users WHERE id=$1", [uid]);
  }
  expect(await specialInterestFor(uid, codes)).toEqual([]);
});
it("combines personal interest with actual family, tag and loaded-region data", async () => {
  const sample = (
    await query<{
      species_code: string;
      family_code: string;
      tags: string[];
      loc_code: string;
    }>(
      `SELECT t.species_code,t.family_code,e.tags,m.loc_code FROM taxonomy_cache t
     JOIN species_enrichment e USING(species_code)
     JOIN species_month_freq m USING(species_code)
     WHERE t.species_code='osprey' AND t.category='species' AND t.family_code IS NOT NULL
       AND cardinality(e.tags)>0 AND m.num>0 LIMIT 1`,
    )
  ).rows[0];
  expect(sample).toBeTruthy();
  await setSpecialInterest(viewer, sample.species_code, true);
  const options = {
    interestUserId: viewer,
    page: 1,
    family: sample.family_code,
  };
  const found = await searchGuide(
    "OSPR",
    [sample.tags[0]],
    owner,
    [sample.loc_code],
    options,
  );
  expect(found.rows.map((r) => r.species_code)).toEqual(["osprey"]);
  expect(
    (
      await searchGuide("OSPR", [sample.tags[0]], owner, [sample.loc_code], {
        ...options,
        family: "anatid1",
      })
    ).rows,
  ).toEqual([]);
  expect(
    (
      await searchGuide(
        "OSPR",
        ["habitat:interest-test-no-match"],
        owner,
        [sample.loc_code],
        options,
      )
    ).rows,
  ).toEqual([]);
});

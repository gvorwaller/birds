import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import {
  clearSpeciesViews,
  recordSpeciesView,
  setSpeciesViewTracking,
  speciesViewsFor,
  viewedSpecies,
} from "./species-views";

let owner: number, viewer: number;
let codes: string[];
const retiredCode = "vwh" + randomUUID().replaceAll("-", "").slice(0, 8);
beforeAll(async () => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires dedicated birds_test");
  const r = await query<{ species_code: string }>(
    "SELECT species_code FROM taxonomy_cache WHERE category='species' ORDER BY species_code LIMIT 60",
  );
  codes = r.rows.map((r) => r.species_code);
  if (codes.length !== 60)
    throw Error("Requires 60 real test taxonomy species");
  owner = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'History test','!unset','user') RETURNING id",
      ["view-test-" + randomUUID()],
    )
  ).rows[0].id;
  viewer = (
    await query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role,views_user_id) VALUES($1,'History viewer test','!unset','viewer',$2) RETURNING id",
      ["view-test-" + randomUUID(), owner],
    )
  ).rows[0].id;
});
beforeEach(async () => {
  await clearSpeciesViews(owner);
  await clearSpeciesViews(viewer);
  await setSpeciesViewTracking(owner, true);
  await setSpeciesViewTracking(viewer, true);
});
afterAll(async () => {
  await query("DELETE FROM users WHERE id=ANY($1::int[])", [
    [owner, viewer].filter(Boolean),
  ]);
  await query("DELETE FROM taxonomy_cache WHERE species_code=$1", [
    retiredCode,
  ]);
});
describe("personal history on real PostgreSQL", () => {
  it("isolates a family viewer from the shared owner and never adds life-list sightings", async () => {
    const saved = await recordSpeciesView(viewer, codes[0], randomUUID());
    expect(saved.view).not.toBeNull();
    expect((await viewedSpecies(owner, "", false)).rows).toHaveLength(0);
    expect((await viewedSpecies(viewer, "", false)).rows).toHaveLength(1);
    expect(await speciesViewsFor(owner, [codes[0]])).toEqual({});
    expect(Object.keys(await speciesViewsFor(viewer, [codes[0]]))).toEqual([
      codes[0],
    ]);
    expect(
      (
        await query("SELECT 1 FROM seen_species WHERE user_id=ANY($1::int[])", [
          [owner, viewer],
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("preserves first viewed, updates new visits, and ignores old retries after intervening visits", async () => {
    const id = randomUUID();
    const a = await recordSpeciesView(owner, codes[0], id);
    const b = await recordSpeciesView(owner, codes[0], randomUUID());
    const retry = await recordSpeciesView(owner, codes[0], id);
    expect(b.view!.firstViewedAt).toBe(a.view!.firstViewedAt);
    expect(Date.parse(b.view!.lastViewedAt)).toBeGreaterThanOrEqual(
      Date.parse(a.view!.lastViewedAt),
    );
    expect(retry).toEqual(b);
    expect(
      (
        await query("SELECT 1 FROM species_view_receipts WHERE user_id=$1", [
          owner,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("deduplicates simultaneous retries and rejects reusing a visit for another species", async () => {
    const id = randomUUID();
    const results = await Promise.all([
      recordSpeciesView(owner, codes[0], id),
      recordSpeciesView(owner, codes[0], id),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expect(recordSpeciesView(owner, codes[1], id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await viewedSpecies(owner, "", false)).rows).toHaveLength(1);
  });
  it("pauses without losing history, resumes future visits, and clears only the requesting account", async () => {
    await recordSpeciesView(owner, codes[0], randomUUID());
    await recordSpeciesView(viewer, codes[0], randomUUID());
    await setSpeciesViewTracking(viewer, false);
    expect(await recordSpeciesView(viewer, codes[1], randomUUID())).toEqual({
      enabled: false,
      view: null,
    });
    expect((await viewedSpecies(viewer, "", false)).rows).toHaveLength(1);
    await clearSpeciesViews(viewer);
    expect(await viewedSpecies(viewer, "", false)).toMatchObject({
      enabled: false,
      rows: [],
    });
    expect(
      (
        await query("SELECT 1 FROM species_view_receipts WHERE user_id=$1", [
          viewer,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await viewedSpecies(owner, "", false)).rows).toHaveLength(1);
    await setSpeciesViewTracking(viewer, true);
    await recordSpeciesView(viewer, codes[1], randomUUID());
    expect((await viewedSpecies(viewer, "", false)).rows[0].code).toBe(
      codes[1],
    );
  });
  it("retains history after a taxonomy code retires and rejects new invalid visits", async () => {
    await query(
      "INSERT INTO taxonomy_cache(species_code,com_name,sci_name,category) VALUES($1,'History test taxon','History test','species')",
      [retiredCode],
    );
    await recordSpeciesView(owner, retiredCode, randomUUID());
    await query("DELETE FROM taxonomy_cache WHERE species_code=$1", [
      retiredCode,
    ]);
    expect((await viewedSpecies(owner, "", false)).rows[0]).toMatchObject({
      code: retiredCode,
      current: false,
      name: null,
    });
    await expect(
      recordSpeciesView(owner, retiredCode, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("returns the whole collection, searches literal wildcards, and sorts by recent/name", async () => {
    await query(
      `INSERT INTO species_view_history(user_id,species_code,first_viewed_at,last_viewed_at)
   SELECT $1,code,clock_timestamp(),clock_timestamp() FROM unnest($2::text[]) code`,
      [owner, codes],
    );
    const all = await viewedSpecies(owner, "", true);
    expect(all.rows).toHaveLength(60);
    expect(
      (await viewedSpecies(owner, codes[0], false)).rows.map((r) => r.code),
    ).toContain(codes[0]);
    expect((await viewedSpecies(owner, "%", false)).rows).toHaveLength(0);
    await recordSpeciesView(owner, codes[0], randomUUID());
    expect((await viewedSpecies(owner, "", false)).rows[0].code).toBe(codes[0]);
    const names = all.rows.map((r) => r.name!);
    expect(names).toEqual(
      [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
});

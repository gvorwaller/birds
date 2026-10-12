/**
 * td-c2f2b2: durable official coordinates for downloaded hotspots.
 *
 * Real birds_test. Owns every row: L99… location ids (12 digits — far beyond
 * eBird's id space), a per-run ZZ-H… region, a fixture admin, its own cache
 * keys and CLAIMTEST-style job rows; everything is deleted by those exact
 * keys. Repairs are scoped to the fixture hotspots (onlyLocCodes) and use
 * fake eBird requests — no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { query } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import { requeueInterrupted, runWithClaim, StaleClaimError } from "./jobs";
import {
  COORDINATE_CHUNK,
  coordinateGaps,
  coordinatesFromCache,
  recordCoordinateMiss,
  rememberOfficialHotspots,
  upsertLocationCoordinates,
} from "./hotspot-coordinates";
import {
  catalogDue,
  catalogUnitsDue,
  ensureLoadedHotspotCoordinates,
  hotspotCoordinateStatus,
  lookupOfficialCoordinates,
  repairHotspotCoordinates,
} from "./hotspot-coordinate-repair";
import { EbirdError, hotspotsInRegion } from "./ebird";
import { recentHotspotCoordinateRepair } from "./job-handlers";
import { resolveGuideLocation } from "./guide-location";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const tag = randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase();
const REGION = `ZZ-H${tag}-001`;
const OTHER_REGION = `ZZ-H${tag}-002`;
const LABEL = `COORDTEST ${tag}`;
const base = 990_000_000_000 + randomInt(0, 9_000_000) * 1_000;
const ids: string[] = [];
const newId = () => {
  const id = `L${base + ids.length}`;
  ids.push(id);
  return id;
};
const cacheKeys: string[] = [];
let userId = 0;

/** A downloaded hotspot (metadata row only — coordinates are what's under test). */
async function downloaded(loc: string, region = REGION) {
  await query(
    `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
     VALUES ($1, 'hotspot', $2, 2016, 2025, $3, 0, $4)`,
    [loc, `Coordinate fixture ${loc}`, Array(48).fill(10), region],
  );
}

async function row(loc: string) {
  return (
    await query<{
      loc_name: string;
      lat: number;
      lng: number;
      coord_source: string;
      coord_fetched_at: Date | null;
      updated_at: Date;
      last_seen_at: Date;
      google_place_id: string | null;
    }>(
      `SELECT loc_name, lat, lng, coord_source, coord_fetched_at, updated_at, last_seen_at, google_place_id
         FROM ebird_locations WHERE loc_id = $1`,
      [loc],
    )
  ).rows[0];
}

async function miss(loc: string) {
  return (
    await query<{ reason: string }>("SELECT reason FROM hotspot_coord_misses WHERE loc_code = $1", [loc])
  ).rows[0]?.reason ?? null;
}

const t = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s));
const official = (loc: string, lat: number, name = "Official", at = t(10)) =>
  upsertLocationCoordinates([{ locId: loc, locName: name, lat, lng: 10 }], "official", at);
const observed = (loc: string, lat: number, name = "Observed") =>
  upsertLocationCoordinates([{ locId: loc, locName: name, lat, lng: 10 }], "observation", null);

async function claim(id: number): Promise<JobRow> {
  const r = await query<JobRow>(
    `UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1,
                     heartbeat_at = NOW(), claim_seq = claim_seq + 1
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id],
  );
  expect(r.rows[0], `job ${id} claimable`).toBeDefined();
  return r.rows[0];
}

/** A drained-and-reclaimed job: A is the stale claim, B the live one. */
async function staleAndLive(): Promise<{ a: JobRow; b: JobRow }> {
  const id = (
    await query<{ id: number }>(
      `INSERT INTO jobs (type, payload, requested_by, label, max_attempts)
       VALUES ('tag_preview', '{}', $1, $2, 3) RETURNING id`,
      [userId, LABEL],
    )
  ).rows[0].id;
  const a = await claim(id);
  await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
  return { a, b: await claim(id) };
}

/** Gap-stage tests skip the world catalog (it would read the real regions table). */
const noCatalog = async () => [];
const listResult = (data: Array<{ locId: string; locName: string; lat: number; lng: number }>) => ({
  data,
  fetchedAt: new Date(),
  stale: false,
  live: { startedAt: new Date() },
});
const staleList = (refreshErrorStatus: number) => ({
  data: [] as Array<{ locId: string; locName: string; lat: number; lng: number }>,
  fetchedAt: t(1),
  stale: true,
  refreshErrorStatus,
});

const info = (loc: string, lat: number, extra: Record<string, unknown> = {}) => ({
  locId: loc,
  name: `Info ${loc}`,
  latitude: lat,
  longitude: 20,
  isHotspot: true,
  ...extra,
});

describe.skipIf(!dbUp)("durable hotspot coordinates (td-c2f2b2)", () => {
  beforeAll(async () => {
    userId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Coordinate fixture', '!unset', 'admin') RETURNING id`,
        [`coordtest-${tag}`],
      )
    ).rows[0].id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [ids]);
    await query("DELETE FROM ebird_locations WHERE loc_id = ANY($1)", [ids]);
    await query("DELETE FROM ebird_cache WHERE cache_key = ANY($1)", [cacheKeys]);
    await query("DELETE FROM hotspot_catalog WHERE region_code LIKE $1", [`ZZC${tag}%`]);
    await query("DELETE FROM jobs WHERE label = $1", [LABEL]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    const left = await query<{ n: number }>(
      `SELECT (SELECT count(*) FROM ebird_locations WHERE loc_id = ANY($1))
            + (SELECT count(*) FROM hotspot_coord_misses WHERE loc_code = ANY($1))
            + (SELECT count(*) FROM frequency_fetch WHERE loc_code = ANY($1))
            + (SELECT count(*) FROM ebird_cache WHERE cache_key = ANY($2)) AS n`,
      [ids, cacheKeys],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });

  describe("precedence (C0)", () => {
    it("an observation creates a row; official replaces it and records when its request started", async () => {
      const loc = newId();
      await observed(loc, 1);
      expect(await row(loc)).toMatchObject({ lat: 1, coord_source: "observation", coord_fetched_at: null });
      expect(await official(loc, 2, "Official", t(10))).toBe(1);
      const r = await row(loc);
      expect(r).toMatchObject({ lat: 2, loc_name: "Official", coord_source: "official" });
      expect(r.coord_fetched_at?.toISOString()).toBe(t(10).toISOString());
    });

    it("an observation never replaces official coordinates or name, but still marks the row seen", async () => {
      const loc = newId();
      await official(loc, 2);
      const before = await row(loc);
      await new Promise((r) => setTimeout(r, 20));
      await observed(loc, 9, "Observed name");
      const after = await row(loc);
      expect(after).toMatchObject({ lat: 2, loc_name: "Official", coord_source: "official" });
      expect(after.last_seen_at.getTime()).toBeGreaterThan(before.last_seen_at.getTime());
    });

    it("official orders by request start: older never overwrites newer; newer and different does", async () => {
      const loc = newId();
      await official(loc, 2, "Official", t(20));
      expect(await official(loc, 3, "Older", t(10))).toBe(0);
      expect(await row(loc)).toMatchObject({ lat: 2, loc_name: "Official" });
      expect(await official(loc, 4, "Moved", t(30))).toBe(1);
      expect(await row(loc)).toMatchObject({ lat: 4, loc_name: "Moved" });
    });

    it("an unchanged newer answer only records its request time (updated_at stays)", async () => {
      const loc = newId();
      await official(loc, 2, "Official", t(10));
      const before = await row(loc);
      expect(await official(loc, 2, "Official", t(50))).toBe(0);
      const after = await row(loc);
      expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
      // last_seen_at is in the google-place partial index: an unchanged refresh must not move it.
      expect(after.last_seen_at.toISOString()).toBe(before.last_seen_at.toISOString());
      expect(after.coord_fetched_at?.toISOString()).toBe(t(50).toISOString());
    });

    it("a delayed older answer never replaces a newer identical one (T10, T30 same, then T20 different)", async () => {
      const loc = newId();
      await official(loc, 2, "Official", t(10));
      await official(loc, 2, "Official", t(30));
      expect(await official(loc, 7, "Stale move", t(20))).toBe(0);
      expect(await row(loc)).toMatchObject({ lat: 2, loc_name: "Official" });
    });

    it("a Google result written mid-fetch does not block the official write; Google columns are preserved", async () => {
      const loc = newId();
      await observed(loc, 1);
      await query(
        `UPDATE ebird_locations SET google_place_id = 'zzplace', updated_at = $2 WHERE loc_id = $1`,
        [loc, t(99)],
      );
      expect(await official(loc, 5, "Official", t(10))).toBe(1);
      expect(await row(loc)).toMatchObject({ lat: 5, google_place_id: "zzplace" });
    });

    it("skips unusable rows: non-hotspot ids for official, out-of-range or non-finite coordinates, empty names", async () => {
      const good = newId();
      const n = await upsertLocationCoordinates(
        [
          { locId: "zzpersonal", locName: "Not an L id", lat: 1, lng: 1 },
          { locId: newId(), locName: "Too far north", lat: 91, lng: 1 },
          { locId: newId(), locName: "NaN", lat: Number.NaN, lng: 1 },
          { locId: newId(), locName: "  ", lat: 1, lng: 1 },
          { locId: newId(), locName: null, lat: 1, lng: 1 },
          { locId: good, locName: "Good", lat: 1, lng: 1 },
        ],
        "official",
        t(10),
      );
      expect(n).toBe(1);
      expect(await row(good)).toMatchObject({ loc_name: "Good" });
      expect((await query("SELECT 1 FROM ebird_locations WHERE loc_id = 'zzpersonal'")).rowCount).toBe(0);
    });

    it("writes more than one statement's worth of rows", async () => {
      const rows = Array.from({ length: COORDINATE_CHUNK + 1 }, (_, i) => ({
        locId: newId(),
        locName: `Bulk ${i}`,
        lat: -10,
        lng: i / 100,
      }));
      expect(await upsertLocationCoordinates(rows, "official", t(10))).toBe(COORDINATE_CHUNK + 1);
    });

    it("official coordinates clear a recorded miss", async () => {
      const loc = newId();
      await downloaded(loc);
      await recordCoordinateMiss(loc, "gone");
      expect(await miss(loc)).toBe("gone");
      await official(loc, 2);
      expect(await miss(loc)).toBeNull();
    });
  });

  describe("claims (CODEX1 P1-2)", () => {
    it("a stale claim's coordinate and miss writes are refused; the live claim and no claim write", async () => {
      const loc = newId();
      await downloaded(loc);
      const { a, b } = await staleAndLive();
      await expect(runWithClaim(a, () => official(loc, 2))).rejects.toBeInstanceOf(StaleClaimError);
      await expect(
        runWithClaim(a, () => rememberOfficialHotspots([{ locId: loc, locName: "A", lat: 2, lng: 1 }], t(10))),
      ).rejects.toBeInstanceOf(StaleClaimError);
      await expect(runWithClaim(a, () => recordCoordinateMiss(loc, "gone"))).rejects.toBeInstanceOf(
        StaleClaimError,
      );
      expect(await row(loc)).toBeUndefined();
      expect(await miss(loc)).toBeNull();
      await runWithClaim(b, () => official(loc, 2));
      expect(await row(loc)).toMatchObject({ lat: 2 });
      await observed(loc, 3);
      expect((await row(loc)).lat).toBe(2);
    });

    it("rememberOfficialHotspots logs an ordinary database failure instead of failing its caller", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const loc = newId();
      // Postgres text cannot hold NUL: the statement fails.
      await expect(
        rememberOfficialHotspots([{ locId: loc, locName: "bad\u0000name", lat: 1, lng: 1 }], t(10)),
      ).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
      await expect(
        upsertLocationCoordinates([{ locId: loc, locName: "bad\u0000name", lat: 1, lng: 1 }], "official", t(10)),
      ).rejects.toThrow();
      expect(await row(loc)).toBeUndefined();
    });

    it("a lost claim during a hotspot-info lookup propagates and writes nothing", async () => {
      const loc = newId();
      await downloaded(loc);
      const { a } = await staleAndLive();
      await expect(
        runWithClaim(a, () => lookupOfficialCoordinates(loc, "zz-key", async () => info(loc, 7))),
      ).rejects.toBeInstanceOf(StaleClaimError);
      await expect(
        runWithClaim(a, () => lookupOfficialCoordinates(loc, "zz-key", async () => null)),
      ).rejects.toBeInstanceOf(StaleClaimError);
      expect(await row(loc)).toBeUndefined();
      expect(await miss(loc)).toBeNull();
    });
  });

  describe("live eBird hotspot lists (C1)", () => {
    const listRegion = `ZZ-H${tag}-LST`;
    const key = `hotspotsRegion:${listRegion}`;
    cacheKeys.push(key);

    it("a live list response is stored; a cache hit and a stale fallback store nothing", async () => {
      const [l1, l2] = [newId(), newId()];
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { locId: l1, locName: "Listed one", lat: 11, lng: 12 },
              { locId: l2, locName: "Listed two", lat: 13, lng: 14 },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchSpy);
      const before = new Date();
      const live = await hotspotsInRegion("zz-key", listRegion);
      expect(live.live).toBeDefined();
      const r1 = await row(l1);
      expect(r1).toMatchObject({ lat: 11, loc_name: "Listed one", coord_source: "official" });
      expect(r1.coord_fetched_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
      expect(await row(l2)).toMatchObject({ lat: 13 });

      await query("DELETE FROM ebird_locations WHERE loc_id = ANY($1)", [[l1, l2]]);
      const hit = await hotspotsInRegion("zz-key", listRegion);
      expect(hit.live).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await row(l1)).toBeUndefined();

      await query(`UPDATE ebird_cache SET fetched_at = NOW() - interval '2 days' WHERE cache_key = $1`, [key]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const stale = await hotspotsInRegion("zz-key", listRegion);
      expect(stale.stale).toBe(true);
      expect(stale.live).toBeUndefined();
      expect(await row(l1)).toBeUndefined();
    });
  });

  describe("world catalog (td-79261e)", () => {
    const C = (n: string) => `ZZC${tag}${n}`;
    const catalogRow = async (code: string) =>
      (
        await query<{ status: string; hotspots: number; error: string | null }>(
          "SELECT status, hotspots, error FROM hotspot_catalog WHERE region_code = $1",
          [code],
        )
      ).rows[0];

    it("the real unit list is every country in the regions table (a split one by its states), all due when never fetched", async () => {
      const units = await catalogUnitsDue();
      const countries = await query<{ n: number }>("SELECT count(*)::int AS n FROM regions WHERE level = 'country'");
      expect(units.length).toBeGreaterThanOrEqual(countries.rows[0].n - 5);
      const known = await query<{ n: number }>("SELECT count(*)::int AS n FROM regions WHERE code = ANY($1)", [
        units.map((u) => u.code),
      ]);
      expect(known.rows[0].n).toBe(units.length);
      expect(await catalogDue()).toBe(true);
    });

    it("stores every unit's full list and records it; splits a country eBird can't serve whole into its states", async () => {
      const [h1, h2, h3] = [newId(), newId(), newId()];
      let pass = 0;
      const fetched: string[] = [];
      const result = await repairHotspotCoordinates("zz-key", {
        onlyLocCodes: [],
        catalogUnits: async () =>
          pass++ === 0
            ? [
                { code: C("A"), level: "country" },
                { code: C("BIG"), level: "country" },
                { code: C("NONE"), level: "country" },
              ]
            : [{ code: C("BIG-01"), level: "subnational1" }],
        hasSubregions: async (code) => code === C("BIG"),
        fetchCatalog: async (_key, code) => {
          fetched.push(code);
          if (code === C("BIG")) throw new EbirdError("eBird did not respond within 120s.", 504);
          if (code === C("NONE")) throw new EbirdError("eBird API error 404", 404);
          return {
            data:
              code === C("A")
                ? [
                    { locId: h1, locName: "Catalog one", lat: 31, lng: 32 },
                    { locId: h2, locName: "Catalog two", lat: 33, lng: 34 },
                  ]
                : [{ locId: h3, locName: "Catalog state", lat: 35, lng: 36 }],
            startedAt: new Date(),
          };
        },
      });
      expect(fetched).toEqual([C("A"), C("BIG"), C("NONE"), C("BIG-01")]);
      expect(result).toMatchObject({ outcome: "complete", catalogUnits: 2, catalogHotspots: 3, catalogSplit: 1 });
      expect(await row(h1)).toMatchObject({ lat: 31, coord_source: "official" });
      expect(await row(h3)).toMatchObject({ lat: 35, coord_source: "official" });
      expect(await catalogRow(C("A"))).toMatchObject({ status: "ok", hotspots: 2 });
      expect(await catalogRow(C("BIG"))).toMatchObject({ status: "split" });
      expect(await catalogRow(C("BIG-01"))).toMatchObject({ status: "ok", hotspots: 1 });
      expect(await catalogRow(C("NONE"))).toMatchObject({ status: "ok", hotspots: 0 });
    });

    it("a failure is recorded and retried later; three in a row end the run; 401 throws; 429 defers; a failed write fails the run", async () => {
      const units = ["E1", "E2", "E3", "E4"].map((n) => ({ code: C(n), level: "subnational1" as const }));
      const down = await repairHotspotCoordinates("zz-key", {
        onlyLocCodes: [],
        catalogUnits: async () => units,
        fetchCatalog: async () => {
          throw new EbirdError("eBird API error 503", 503);
        },
      });
      expect(down).toMatchObject({ outcome: "upstream", catalogErrors: 3 });
      expect(await catalogRow(C("E1"))).toMatchObject({ status: "error", error: "eBird API error 503" });
      expect(await catalogRow(C("E4"))).toBeUndefined();

      const once = (status: number) =>
        repairHotspotCoordinates("zz-key", {
          onlyLocCodes: [],
          catalogUnits: async () => [units[3]],
          fetchCatalog: async () => {
            throw new EbirdError(`eBird API error ${status}`, status);
          },
        });
      await expect(once(401)).rejects.toMatchObject({ status: 401 });
      expect(await once(429)).toMatchObject({ outcome: "deferred", catalogUnits: 0 });

      await expect(
        repairHotspotCoordinates("zz-key", {
          onlyLocCodes: [],
          catalogUnits: async () => [units[3]],
          fetchCatalog: async () => ({
            data: [{ locId: newId(), locName: "bad\u0000name", lat: 1, lng: 1 }],
            startedAt: new Date(),
          }),
        }),
      ).rejects.toThrow();
      expect(await catalogRow(C("E4"))).toBeUndefined();
    });

    it("a plain 5xx on a country is an outage (retried in a day), never a split", async () => {
      const result = await repairHotspotCoordinates("zz-key", {
        onlyLocCodes: [],
        catalogUnits: async () => [{ code: C("T503"), level: "country" }],
        hasSubregions: async () => true,
        fetchCatalog: async () => {
          throw new EbirdError("eBird API error 503", 503);
        },
      });
      expect(result).toMatchObject({ outcome: "complete", catalogSplit: 0, catalogErrors: 1 });
      expect(await catalogRow(C("T503"))).toMatchObject({ status: "error", error: "eBird API error 503" });
    });

    it("rows eBird lists that cannot be stored are counted, and the unit is retried instead of 'ok'", async () => {
      const good = newId();
      const result = await repairHotspotCoordinates("zz-key", {
        onlyLocCodes: [],
        catalogUnits: async () => [{ code: C("BAD"), level: "subnational1" }],
        fetchCatalog: async () => ({
          data: [
            { locId: good, locName: "Good", lat: 1, lng: 1 },
            { locId: good, locName: "Good, listed twice", lat: 1, lng: 1 },
            { locId: "zznotahotspot", locName: "Bad id", lat: 1, lng: 1 },
            { locId: newId(), locName: "Bad latitude", lat: 95, lng: 1 },
          ],
          startedAt: new Date(),
        }),
      });
      expect(result).toMatchObject({ catalogUnits: 1, catalogHotspots: 1, catalogErrors: 1 });
      expect(await row(good)).toMatchObject({ coord_source: "official" });
      expect(await catalogRow(C("BAD"))).toMatchObject({
        status: "error",
        hotspots: 1,
        error: "2 of 4 listed hotspots had an unusable id, name or coordinates.",
      });
    });

    it("a deferred catalog never holds back the gap repair: gaps are filled first", async () => {
      const gap = newId();
      await downloaded(gap);
      const result = await repairHotspotCoordinates("zz-key", {
        onlyLocCodes: [gap],
        fetchRegion: async () => listResult([{ locId: gap, locName: "Gap first", lat: 41, lng: 42 }]),
        catalogUnits: async () => [{ code: C("DEF"), level: "country" }],
        fetchCatalog: async () => {
          throw new EbirdError("eBird API rate limit hit", 429);
        },
      });
      expect(result).toMatchObject({ outcome: "deferred", regionsFetched: 1, gapsAfter: 0 });
      expect(await row(gap)).toMatchObject({ lat: 41, coord_source: "official" });
    });

    it("a recent split stands in for its country by its states; a split older than 30 days is tried whole again", async () => {
      const country = (
        await query<{ code: string }>(
          `SELECT c.code FROM regions c
            WHERE c.level = 'country'
              AND EXISTS (SELECT 1 FROM regions s WHERE s.parent_code = c.code AND s.level = 'subnational1')
              AND NOT EXISTS (SELECT 1 FROM hotspot_catalog h WHERE h.region_code = c.code)
            ORDER BY c.code LIMIT 1`,
        )
      ).rows[0].code;
      try {
        await query(
          `INSERT INTO hotspot_catalog (region_code, status, hotspots, fetched_at) VALUES ($1, 'split', 0, NOW())`,
          [country],
        );
        let codes = (await catalogUnitsDue()).map((u) => u.code);
        expect(codes).not.toContain(country);
        expect(codes.some((c) => c.startsWith(`${country}-`))).toBe(true);
        await query(`UPDATE hotspot_catalog SET fetched_at = NOW() - interval '31 days' WHERE region_code = $1`, [
          country,
        ]);
        codes = (await catalogUnitsDue()).map((u) => u.code);
        expect(codes).toContain(country);
        expect(codes.some((c) => c.startsWith(`${country}-`))).toBe(false);
      } finally {
        await query("DELETE FROM hotspot_catalog WHERE region_code = $1 AND status = 'split'", [country]);
      }
    });

    it("a lost claim stops the catalog and records nothing", async () => {
      const { a } = await staleAndLive();
      const h = newId();
      await expect(
        runWithClaim(a, () =>
          repairHotspotCoordinates("zz-key", {
            onlyLocCodes: [],
            catalogUnits: async () => [{ code: C("CL"), level: "country" }],
            fetchCatalog: async () => ({ data: [{ locId: h, locName: "Claimed", lat: 1, lng: 1 }], startedAt: new Date() }),
          }),
        ),
      ).rejects.toBeInstanceOf(StaleClaimError);
      expect(await row(h)).toBeUndefined();
      expect(await catalogRow(C("CL"))).toBeUndefined();
    });
  });

  describe("repair (C2/C3)", () => {
    it("fills gaps from the cache, then region lists, then hotspot info; records misses; a second run is a no-op", async () => {
      const [cached, cachedInfo, listed, viaInfo, gone, notHotspot] = [
        newId(),
        newId(),
        newId(),
        newId(),
        newId(),
        newId(),
      ];
      for (const loc of [cached, cachedInfo, listed, viaInfo, gone, notHotspot]) await downloaded(loc);
      await downloaded(newId(), OTHER_REGION); // the other region eBird no longer lists
      const otherGone = ids[ids.length - 1];
      // An observation coordinate is a gap too: it is upgraded to official.
      await observed(cached, 1);
      const listKey = `hotspots:zz${tag}:0:50`;
      const infoKey = `hotspotInfo:${cachedInfo}`;
      cacheKeys.push(listKey, infoKey);
      await query(
        `INSERT INTO ebird_cache (cache_key, payload, fetched_at) VALUES
           ($1, $2, NOW() - interval '1 hour'), ($3, $4, NOW() - interval '1 hour')`,
        [
          listKey,
          JSON.stringify([{ locId: cached, locName: "From cached list", lat: 21, lng: 22 }]),
          infoKey,
          JSON.stringify({ locId: cachedInfo, locName: "From cached info", lat: 23, lng: 24, isHotspot: true }),
        ],
      );
      const regionCalls: string[] = [];
      const infoCalls: string[] = [];
      const mine = [cached, cachedInfo, listed, viaInfo, gone, notHotspot, otherGone];
      const result = await repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
        onlyLocCodes: mine,
        fetchRegion: async (_key, region) => {
          regionCalls.push(region);
          if (region === OTHER_REGION) throw new EbirdError("eBird API error 404", 404);
          return listResult([{ locId: listed, locName: "From region list", lat: 25, lng: 26 }]);
        },
        fetchInfo: async (loc) => {
          infoCalls.push(loc);
          if (loc === viaInfo) return info(loc, 27);
          if (loc === notHotspot) return info(loc, 28, { isHotspot: false });
          return null;
        },
      });
      expect(regionCalls).toEqual([REGION, OTHER_REGION]);
      expect(infoCalls.sort()).toEqual([gone, notHotspot, otherGone, viaInfo].sort());
      expect(result).toMatchObject({
        outcome: "complete",
        gapsBefore: 7,
        fromCache: 2,
        regionsFetched: 1,
        infoLookups: 4,
        misses: 3,
        gapsAfter: 0,
      });
      expect(await row(cached)).toMatchObject({ lat: 21, coord_source: "official" });
      expect(await row(cachedInfo)).toMatchObject({ lat: 23, coord_source: "official" });
      expect(await row(listed)).toMatchObject({ lat: 25 });
      expect(await row(viaInfo)).toMatchObject({ lat: 27, loc_name: `Info ${viaInfo}` });
      expect(await miss(gone)).toBe("gone");
      expect(await miss(notHotspot)).toBe("not_hotspot");
      expect(await row(notHotspot)).toBeUndefined();

      const again = await repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
        onlyLocCodes: mine,
        fetchRegion: async () => {
          throw new Error("must not be called");
        },
        fetchInfo: async () => {
          throw new Error("must not be called");
        },
      });
      expect(again).toMatchObject({ outcome: "complete", gapsBefore: 0, gapsAfter: 0 });
    });

    it("a failed write fails the run instead of counting coordinates it did not store (CODEX1 review P1)", async () => {
      const [viaList, viaInfo] = [newId(), newId()];
      await downloaded(viaList);
      await downloaded(viaInfo, OTHER_REGION);
      await expect(
        repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
          onlyLocCodes: [viaList],
          fetchRegion: async () => listResult([{ locId: viaList, locName: "bad\u0000name", lat: 1, lng: 1 }]),
        }),
      ).rejects.toThrow();
      await expect(
        repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
          onlyLocCodes: [viaInfo],
          fetchRegion: async () => {
            throw new EbirdError("eBird API error 404", 404);
          },
          fetchInfo: async (loc) => info(loc, 1, { name: "bad\u0000name" }),
        }),
      ).rejects.toThrow();
      expect(await row(viaList)).toBeUndefined();
      expect(await row(viaInfo)).toBeUndefined();
      expect(await miss(viaInfo)).toBeNull();
    });

    it("a stale region list decides the run: 401/403 throws, 429 defers, other failures end it as upstream", async () => {
      const loc = newId();
      await downloaded(loc);
      const run = (status: number) =>
        repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
          onlyLocCodes: [loc],
          fetchRegion: async () => staleList(status),
          fetchInfo: async () => {
            throw new Error("must not be called");
          },
        });
      await expect(run(401)).rejects.toMatchObject({ status: 401 });
      await expect(run(403)).rejects.toMatchObject({ status: 403 });
      expect(await run(429)).toMatchObject({ outcome: "deferred", regionsFetched: 0, gapsAfter: 1 });
      expect(await run(503)).toMatchObject({ outcome: "upstream", regionsFetched: 0, gapsAfter: 1 });
      await official(loc, 3);
    });

    it("a capped, deferred or eBird-failed run is due again after an hour; others after a day", async () => {
      const label = `${LABEL} recent`;
      const finished = async (outcome: string, status: string, ago: string) => {
        await query("DELETE FROM jobs WHERE label = $1", [label]);
        await query(
          `INSERT INTO jobs (type, payload, requested_by, label, max_attempts, status, result, finished_at)
           VALUES ('repair_hotspot_coords', '{}', $1, $2, 1, $3, $4, NOW() - $5::interval)`,
          [userId, label, status, JSON.stringify({ outcome }), ago],
        );
        return recentHotspotCoordinateRepair({ labelForTests: label });
      };
      expect(await finished("capped", "succeeded", "30 minutes")).toBe(true);
      expect(await finished("capped", "succeeded", "2 hours")).toBe(false);
      expect(await finished("deferred", "succeeded", "2 hours")).toBe(false);
      expect(await finished("upstream", "succeeded", "2 hours")).toBe(false);
      expect(await finished("complete", "succeeded", "2 hours")).toBe(true);
      expect(await finished("stopped", "cancelled", "2 hours")).toBe(true);
      expect(await finished("complete", "succeeded", "25 hours")).toBe(false);
      // Only the LATEST run decides: an older complete run (3 h ago) must not
      // hold back a newer capped one (2 h ago), and vice versa.
      await finished("complete", "succeeded", "3 hours");
      await query(
        `INSERT INTO jobs (type, payload, requested_by, label, max_attempts, status, result, finished_at)
         VALUES ('repair_hotspot_coords', '{}', $1, $2, 1, 'succeeded', '{"outcome":"capped"}', NOW() - interval '2 hours')`,
        [userId, label],
      );
      expect(await recentHotspotCoordinateRepair({ labelForTests: label })).toBe(false);
      await query(
        `INSERT INTO jobs (type, payload, requested_by, label, max_attempts, status, result, finished_at)
         VALUES ('repair_hotspot_coords', '{}', $1, $2, 1, 'succeeded', '{"outcome":"complete"}', NOW() - interval '1 hour')`,
        [userId, label],
      );
      expect(await recentHotspotCoordinateRepair({ labelForTests: label })).toBe(true);
      await query("DELETE FROM jobs WHERE label = $1", [label]);
    });

    it("a due world catalog waits an hour after a complete run, not a day; a cancel or failure still waits the day", async () => {
      const label = `${LABEL} catalog-due`;
      const finished = async (outcome: string, status: string, ago: string) => {
        await query("DELETE FROM jobs WHERE label = $1", [label]);
        await query(
          `INSERT INTO jobs (type, payload, requested_by, label, max_attempts, status, result, finished_at)
           VALUES ('repair_hotspot_coords', '{}', $1, $2, 1, $3, $4, NOW() - $5::interval)`,
          [userId, label, status, JSON.stringify({ outcome }), ago],
        );
        return recentHotspotCoordinateRepair({ catalogIsDue: true, labelForTests: label });
      };
      // td-79261e deploy: the gap repair finished complete 2 h before the
      // catalog shipped; the due catalog must not wait out the rest of the day.
      expect(await finished("complete", "succeeded", "2 hours")).toBe(false);
      expect(await finished("complete", "succeeded", "30 minutes")).toBe(true);
      expect(await finished("stopped", "cancelled", "2 hours")).toBe(true);
      expect(await finished("boom", "failed", "2 hours")).toBe(true);
      expect(await finished("capped", "succeeded", "2 hours")).toBe(false);
      await query("DELETE FROM jobs WHERE label = $1", [label]);
    });

    it("a recent miss is not retried; an old one is", async () => {
      const loc = newId();
      await downloaded(loc);
      await recordCoordinateMiss(loc, "gone");
      expect((await coordinateGaps(ids)).map((g) => g.locCode)).not.toContain(loc);
      await query(`UPDATE hotspot_coord_misses SET checked_at = NOW() - interval '31 days' WHERE loc_code = $1`, [loc]);
      expect((await coordinateGaps(ids)).map((g) => g.locCode)).toContain(loc);
      await official(loc, 3);
    });

    it("stops between units on cancel, caps info lookups, and throws on a rejected key", async () => {
      const locs = [newId(), newId(), newId()];
      for (const loc of locs) await downloaded(loc, OTHER_REGION);
      const noRegion = async () => {
        throw new EbirdError("eBird API error 404", 404);
      };
      const stopped = await repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
        onlyLocCodes: locs,
        fetchRegion: noRegion,
        onProgress: async (p) => p.stage === "info",
      });
      expect(stopped).toMatchObject({ outcome: "stopped", infoLookups: 0, gapsAfter: 3 });

      const capped = await repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
        onlyLocCodes: locs,
        fetchRegion: noRegion,
        infoCap: 1,
        fetchInfo: async (loc) => info(loc, 30),
      });
      expect(capped).toMatchObject({ outcome: "capped", infoLookups: 1, gapsAfter: 2 });

      await expect(
        repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
          onlyLocCodes: locs,
          fetchRegion: async () => {
            throw new EbirdError("eBird API key is missing or invalid — check Settings.", 403);
          },
        }),
      ).rejects.toMatchObject({ status: 403 });

      const upstream = await repairHotspotCoordinates("zz-key", {
        catalogUnits: noCatalog,
        onlyLocCodes: locs,
        fetchRegion: noRegion,
        fetchInfo: async () => {
          throw new EbirdError("eBird API error 503", 503);
        },
      });
      expect(upstream).toMatchObject({ outcome: "upstream", error: "eBird API error 503", gapsAfter: 2 });
    });

    it("after a load: present coordinates need no request; no key skips; never throws on eBird trouble", async () => {
      const loc = newId();
      await downloaded(loc);
      await official(loc, 3);
      expect(await ensureLoadedHotspotCoordinates(userId, loc)).toBe("present");
      const bare = newId();
      await downloaded(bare);
      // The fixture admin has no stored key.
      expect(await ensureLoadedHotspotCoordinates(userId, bare)).toBe("skipped");
      expect(await coordinatesFromCache([])).toBe(0);
    });

    it("Admin status lists a miss with an ISO time and counts it as missing", async () => {
      const loc = newId();
      await downloaded(loc);
      await recordCoordinateMiss(loc, "not_hotspot");
      const status = await hotspotCoordinateStatus();
      expect(status.missing).toBeGreaterThanOrEqual(1);
      expect(status.downloaded).toBeGreaterThanOrEqual(status.missing);
      expect(status.missing).toBeGreaterThanOrEqual(status.noCoordinates);
      expect(status.missesTotal).toBeGreaterThanOrEqual(status.misses.length);
      expect(status.catalog.units).toBeGreaterThan(200);
      expect(status.catalog.loaded).toBeLessThanOrEqual(status.catalog.units);
      expect(status.officialStored).toBeGreaterThanOrEqual(1);
      const m = status.misses.find((x) => x.locCode === loc);
      expect(m).toMatchObject({ reason: "not_hotspot", locName: `Coordinate fixture ${loc}` });
      expect(m!.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      // The scheduler's recent-run query is valid SQL with the interval it is given.
      await query(
        `SELECT 1 FROM jobs WHERE type = 'repair_hotspot_coords'
           AND finished_at > NOW() - make_interval(secs => $1) LIMIT 1`,
        [86_400],
      );
    });

    it("the Field Guide map finds a downloaded hotspot once its coordinates are stored, with no list cached", async () => {
      const loc = newId();
      await downloaded(loc);
      const sel = { kind: "map" as const, place: "Coordinate fixture", lat: -62.4321, lng: -151.2345, dist: 3 };
      const before = (await resolveGuideLocation(sel))!;
      expect(before.locCodes).not.toContain(loc);
      await upsertLocationCoordinates(
        [{ locId: loc, locName: "Southern ocean fixture", lat: -62.4321, lng: -151.2345 }],
        "official",
        new Date(),
      );
      const after = (await resolveGuideLocation(sel))!;
      expect(after.locCodes).toEqual([loc]);
    });
  });
});

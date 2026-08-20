import { describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { encryptSecret } from "$server/crypto";
import { importLifeList } from "./ebird-account";
import { resolveLiferLocations } from "./lifer-locations";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

/** Fetcher speaking the two eBird endpoints from canned outcomes. */
function fakeEbird(spec: {
  hotspot?: Record<string, { name: string; latitude: number; longitude: number } | 404 | 403>;
  checklist?: Record<
    string,
    { locId: string; name: string; latitude: number; longitude: number } | 404 | 403
  >;
  rateLimit?: boolean;
}) {
  const calls: string[] = [];
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    if (spec.rateLimit) return new Response("slow down", { status: 429 });
    const hs = /\/ref\/hotspot\/info\/([^/?]+)/.exec(url);
    if (hs) {
      const v = spec.hotspot?.[decodeURIComponent(hs[1])];
      if (v === 403) return new Response("forbidden", { status: 403 });
      if (v == null || v === 404) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ locId: hs[1], ...v }), { status: 200 });
    }
    const cl = /\/product\/checklist\/view\/([^/?]+)/.exec(url);
    if (cl) {
      const v = spec.checklist?.[decodeURIComponent(cl[1])];
      if (v === 403) return new Response("forbidden", { status: 403 });
      if (v == null || v === 404) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ subId: cl[1], loc: v }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe.runIf(dbUp)("resolveLiferLocations (td-b5986c B, GROK pin 2)", () => {
  const LOCS = ["Ltest01", "Ltest02", "Ltest03"];
  let uid: number;

  const seed = async (rows: { code: string; locId: string; subId: string | null }[]) => {
    uid = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ('zz_lifer_test', 'Lifer Test', 'x', 'user')
         ON CONFLICT (username) DO UPDATE SET role = 'user'
         RETURNING id`,
      )
    ).rows[0].id;
    await query(
      `INSERT INTO user_ebird (user_id, api_key_enc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc`,
      [uid, encryptSecret("test-key")],
    );
    await wipe();
    for (const r of rows) {
      await query(
        `INSERT INTO seen_species (user_id, species_code, source, loc_id, sub_id)
         VALUES ($1, $2, 'csv_import', $3, $4)
         ON CONFLICT (user_id, species_code) DO UPDATE
           SET loc_id = EXCLUDED.loc_id, sub_id = EXCLUDED.sub_id`,
        [uid, r.code, r.locId, r.subId],
      );
    }
  };
  const wipe = async () => {
    await query(`DELETE FROM seen_species WHERE user_id = $1`, [uid]);
    await query(`DELETE FROM ebird_locations WHERE loc_id = ANY($1)`, [LOCS]);
    await query(`DELETE FROM lifer_loc_attempts WHERE user_id = $1`, [uid]);
  };

  it("hotspot hit + checklist fallback + both-miss negative, all in one pass", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
      { code: "zztstb1", locId: "Ltest02", subId: "Stest02" },
      { code: "zztstc1", locId: "Ltest03", subId: "Stest03" },
    ]);
    try {
      const net = fakeEbird({
        hotspot: { Ltest01: { name: "Hotspot One", latitude: 30.1, longitude: -81.4 } },
        checklist: { Stest02: { locId: "Ltest02", name: "My Yard", latitude: 44.2, longitude: -68.5 } },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(res).toMatchObject({ candidates: 3, resolved: 2, negative: 1, stopped: false });
      const locs = await query<{ loc_id: string; loc_name: string }>(
        `SELECT loc_id, loc_name FROM ebird_locations WHERE loc_id = ANY($1) ORDER BY loc_id`,
        [LOCS],
      );
      expect(locs.rows.map((r) => r.loc_id)).toEqual(["Ltest01", "Ltest02"]);
      expect(locs.rows[1].loc_name).toBe("My Yard");

      // Negative persisted in lifer_loc_attempts.
      const neg = await query(
        `SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest03'`,
        [uid],
      );
      expect(neg.rows.length).toBe(1);

      // Second pass has NO candidates (pin 2 — 404s remembered, not retried).
      const again = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(again.candidates).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("negative survives importLifeList DELETE+reINSERT (the original blocker)", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
    ]);
    try {
      // Resolve: Ltest01 is a both-miss → negative persisted.
      const net = fakeEbird({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(res).toMatchObject({ candidates: 1, negative: 1 });

      // Re-import the same loc_id (simulates a credentialed sync).
      await importLifeList(uid, {
        rows: [{
          comName: "zztsta1", sciName: null, firstSeen: "2025-01-01",
          csvRowNum: 1, taxonOrder: null, category: "species",
          obsCount: 1, locationName: "Somewhere", locId: "Ltest01",
          regionCode: "US-FL", subId: "Stest01", exotic: null, countable: true,
        }],
      }, "csv_import");

      // The negative must survive: candidates === 0 after re-import.
      const again = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(again.candidates).toBe(0);

      // lifer_loc_attempts row still present.
      const row = await query(
        `SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest01'`,
        [uid],
      );
      expect(row.rows.length).toBe(1);
    } finally {
      await wipe();
    }
  });

  it("transient 429 stops the pass WITHOUT recording a negative", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({ rateLimit: true });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 0, stopped: true });
      // No lifer_loc_attempts row — retries next sync.
      const row = await query(
        `SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest01'`,
        [uid],
      );
      expect(row.rows.length).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("hotspot 403 (invalid API key) stops the pass without persisting a negative", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
      { code: "zztstb1", locId: "Ltest02", subId: "Stest02" },
    ]);
    try {
      const net = fakeEbird({
        hotspot: { Ltest01: 403 },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(res.stopped).toBe(true);
      expect(res.negative).toBe(0);
      // No lifer_loc_attempts row — a bad key must not poison loc_ids.
      const row = await query(
        `SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1`,
        [uid],
      );
      expect(row.rows.length).toBe(0);
      // Second loc_id was never attempted (pass stopped at first).
      expect(net.calls.length).toBe(1);
    } finally {
      await wipe();
    }
  });

  it("checklist 403 is a data state (negative), not a stop", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({
        checklist: { Stest01: 403 },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(res).toMatchObject({ candidates: 1, negative: 1, stopped: false });
      // Persisted as a negative.
      const row = await query(
        `SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest01'`,
        [uid],
      );
      expect(row.rows.length).toBe(1);
    } finally {
      await wipe();
    }
  });

  it("NULLS LAST: prefers sibling row with sub_id for checklist fallback", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: null },
      { code: "zztstb1", locId: "Ltest01", subId: "Stest01" },
    ]);
    try {
      const net = fakeEbird({
        checklist: { Stest01: { locId: "Ltest01", name: "Personal Spot", latitude: 35.0, longitude: -80.0 } },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 1 });
      // The checklist fallback was used (hotspot 404 + sub_id from sibling).
      expect(net.calls.some((c) => c.includes("checklist/view/Stest01"))).toBe(true);
      const loc = await query<{ loc_name: string }>(
        `SELECT loc_name FROM ebird_locations WHERE loc_id = 'Ltest01'`,
      );
      expect(loc.rows[0].loc_name).toBe("Personal Spot");
    } finally {
      await wipe();
    }
  });

  it("cap limits live lookups; capped flag disclosed; join-first skips known locs", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: null },
      { code: "zztstb1", locId: "Ltest02", subId: null },
      { code: "zztstc1", locId: "Ltest03", subId: null },
    ]);
    try {
      await query(
        `INSERT INTO ebird_locations (loc_id, loc_name, lat, lng)
         VALUES ('Ltest03', 'Known Spot', 1, 2) ON CONFLICT (loc_id) DO NOTHING`,
      );
      const net = fakeEbird({
        hotspot: {
          Ltest01: { name: "A", latitude: 1, longitude: 2 },
          Ltest02: { name: "B", latitude: 3, longitude: 4 },
        },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, cap: 1 });
      expect(res.candidates).toBe(2);
      expect(res.capped).toBe(true);
      expect(res.resolved).toBe(1);
      const known = await query<{ loc_name: string }>(
        `SELECT loc_name FROM ebird_locations WHERE loc_id = 'Ltest03'`,
      );
      expect(known.rows[0].loc_name).toBe("Known Spot");
    } finally {
      await wipe();
    }
  });
});

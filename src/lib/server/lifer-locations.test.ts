import { describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { encryptSecret } from "$server/crypto";
import { resolveLiferLocations } from "./lifer-locations";

// DB-backed (jobs-db pattern) — everything here needs the test cluster.
const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

/** Fetcher speaking the two eBird endpoints from canned outcomes. */
function fakeEbird(spec: {
  hotspot?: Record<string, { name: string; latitude: number; longitude: number } | 404>;
  checklist?: Record<
    string,
    { locId: string; name: string; latitude: number; longitude: number } | 404
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
      if (v == null || v === 404) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ locId: hs[1], ...v }), { status: 200 });
    }
    const cl = /\/product\/checklist\/view\/([^/?]+)/.exec(url);
    if (cl) {
      const v = spec.checklist?.[decodeURIComponent(cl[1])];
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

  // DEDICATED user: other test files seed seen_species rows for the shared
  // admin user in parallel, and the resolver's candidate query is per-user
  // over ALL rows — a shared user makes candidate counts racy.
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
           SET loc_id = EXCLUDED.loc_id, sub_id = EXCLUDED.sub_id, loc_checked_at = NULL`,
        [uid, r.code, r.locId, r.subId],
      );
    }
  };
  const wipe = async () => {
    await query(`DELETE FROM seen_species WHERE user_id = $1`, [uid]);
    await query(`DELETE FROM ebird_locations WHERE loc_id = ANY($1)`, [LOCS]);
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
      // Negative persisted: second pass has NO candidates (pin 2 — 404s are
      // remembered, not retried every sync).
      const again = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(again.candidates).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("transient 429 stops the pass WITHOUT stamping (retries next sync)", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({ rateLimit: true });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 0, stopped: true });
      const row = await query<{ loc_checked_at: string | null }>(
        `SELECT loc_checked_at::text FROM seen_species WHERE user_id = $1 AND species_code = 'zztsta1'`,
        [uid],
      );
      expect(row.rows[0].loc_checked_at).toBeNull();
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
      // Ltest03 already known → join-first excludes it from candidates.
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
      expect(res.candidates).toBe(2); // Ltest03 never a candidate
      expect(res.capped).toBe(true);
      expect(res.resolved).toBe(1); // only one live lookup ran
      // INSERT-only: the pre-existing row keeps its feed-sourced values.
      const known = await query<{ loc_name: string }>(
        `SELECT loc_name FROM ebird_locations WHERE loc_id = 'Ltest03'`,
      );
      expect(known.rows[0].loc_name).toBe("Known Spot");
    } finally {
      await wipe();
    }
  });
});

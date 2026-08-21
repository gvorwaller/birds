import { describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { encryptSecret } from "$server/crypto";
import { importLifeList } from "./ebird-account";
import { resolveLiferLocations, extractLatLng, hasChecklistMarker } from "./lifer-locations";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

/** Canned hotspot-info fetcher (API key path). */
function fakeEbird(spec: {
  hotspot?: Record<string, { name: string; latitude: number; longitude: number } | 404 | 403 | "empty">;
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
      if (v === "empty") return new Response("", { status: 200 });
      if (v == null || v === 404) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ locId: hs[1], ...v }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

function ownerHtml(lat: number, lng: number): string {
  return `<html>some page content "lat":${lat},"lng":${lng} more content</html>`;
}

/** Canned owner HTML fetcher (CAS session path). */
function fakeOwnerFetcher(spec: {
  checklists?: Record<string, string | 403 | 404 | "login">;
}) {
  const calls: string[] = [];
  const fetcher = async (_userId: number, url: string) => {
    calls.push(url);
    const subMatch = /\/checklist\/([^/?]+)/.exec(url);
    if (!subMatch) throw new Error(`unexpected owner fetch: ${url}`);
    const subId = subMatch[1];
    const v = spec.checklists?.[subId];
    if (v === 403 || v === 404) {
      const { EbirdUpstreamError } = await import("./ebird-account");
      throw new EbirdUpstreamError(`HTTP ${v}`, v);
    }
    if (v === "login") {
      const { EbirdLoginError } = await import("./ebird-account");
      throw new EbirdLoginError("session expired");
    }
    if (v == null) return `<html>"checklistId":"CLtest" no coordinates</html>`;
    return v;
  };
  return { fetcher, calls };
}

describe.runIf(dbUp)("resolveLiferLocations (td-2fbfc1 Commit B)", () => {
  const LOCS = ["Ltest01", "Ltest02", "Ltest03"];
  const TEST_TAXA = ["zztsta1", "zztstb1", "zztstc1"];
  let uid: number;

  const seed = async (rows: { code: string; locId: string; subId: string | null; firstSeen?: string }[]) => {
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
    for (const code of TEST_TAXA) {
      await query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category)
         VALUES ($1, $1, $1, 'species')
         ON CONFLICT (species_code) DO NOTHING`,
        [code],
      );
    }
    for (const r of rows) {
      await query(
        `INSERT INTO seen_species (user_id, species_code, source, loc_id, sub_id, first_seen)
         VALUES ($1, $2, 'csv_import', $3, $4, $5)
         ON CONFLICT (user_id, species_code) DO UPDATE
           SET loc_id = EXCLUDED.loc_id, sub_id = EXCLUDED.sub_id, first_seen = EXCLUDED.first_seen`,
        [uid, r.code, r.locId, r.subId, r.firstSeen ?? null],
      );
    }
  };
  const wipe = async () => {
    await query(`DELETE FROM seen_species WHERE user_id = $1`, [uid]);
    await query(`DELETE FROM ebird_locations WHERE loc_id = ANY($1)`, [LOCS]);
    await query(`DELETE FROM lifer_loc_attempts WHERE user_id = $1`, [uid]);
    await query(`DELETE FROM lifer_loc_coords WHERE user_id = $1`, [uid]);
    await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1)`, [TEST_TAXA]);
  };

  it("hotspot hit writes ebird_locations, not lifer_loc_coords", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
    ]);
    try {
      const net = fakeEbird({
        hotspot: { Ltest01: { name: "Hotspot One", latitude: 30.1, longitude: -81.4 } },
      });
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 1, negative: 0, stopped: false });
      const locs = await query(`SELECT loc_id FROM ebird_locations WHERE loc_id = 'Ltest01'`);
      expect(locs.rows.length).toBe(1);
      const llc = await query(`SELECT 1 FROM lifer_loc_coords WHERE user_id = $1`, [uid]);
      expect(llc.rows.length).toBe(0);
      expect(owner.calls.length).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("owner HTML hit writes lifer_loc_coords, not ebird_locations", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
    ]);
    try {
      const net = fakeEbird({ hotspot: {} });
      const owner = fakeOwnerFetcher({
        checklists: { Stest01: ownerHtml(30.263, -81.637) },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 1, negative: 0, stopped: false });
      const locs = await query(`SELECT loc_id FROM ebird_locations WHERE loc_id = 'Ltest01'`);
      expect(locs.rows.length).toBe(0);
      const llc = await query<{ source_loc_id: string; lat: number; provenance: string }>(
        `SELECT source_loc_id, lat, provenance FROM lifer_loc_coords WHERE user_id = $1`, [uid],
      );
      expect(llc.rows.length).toBe(1);
      expect(llc.rows[0].source_loc_id).toBe("Ltest01");
      expect(llc.rows[0].provenance).toBe("checklist_owner");
    } finally {
      await wipe();
    }
  });

  it("production-shaped owner HTML with quoted coordinates resolves instead of stopping as auth", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
    ]);
    try {
      const net = fakeEbird({ hotspot: { Ltest01: "empty" } });
      const owner = fakeOwnerFetcher({
        checklists: {
          Stest01:
            `<html><div data-sub-id="Stest01"></div>` +
            `<script>var subId = "Stest01"; var p = {"lat":"30.263016","lng":"-81.637047"};</script></html>`,
        },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 1, negative: 0, stopped: false });
      const row = await query<{ lat: number; lng: number }>(
        `SELECT lat, lng FROM lifer_loc_coords WHERE user_id = $1 AND source_loc_id = 'Ltest01'`,
        [uid],
      );
      expect(row.rows[0]).toEqual({ lat: 30.263016, lng: -81.637047 });
    } finally {
      await wipe();
    }
  });

  it("owner-JSON hit excluded from next candidate set (CC1 pin A)", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
    ]);
    try {
      const net = fakeEbird({ hotspot: {} });
      const owner = fakeOwnerFetcher({
        checklists: { Stest01: ownerHtml(30.0, -81.0) },
      });
      await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      const owner2 = fakeOwnerFetcher({ checklists: {} });
      const again = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner2.fetcher });
      expect(again.candidates).toBe(0);
      expect(owner2.calls.length).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("empty-200 hotspot-info → miss, falls through to owner HTML", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
      { code: "zztstb1", locId: "Ltest02", subId: "Stest02" },
    ]);
    try {
      const net = fakeEbird({
        hotspot: {
          Ltest01: "empty",
          Ltest02: { name: "Real Hotspot", latitude: 29.5, longitude: -81.2 },
        },
      });
      const owner = fakeOwnerFetcher({
        checklists: { Stest01: ownerHtml(30.263, -81.637) },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 2, resolved: 2, negative: 0, stopped: false });
      const el = await query(`SELECT loc_id FROM ebird_locations WHERE loc_id = 'Ltest02'`);
      expect(el.rows.length).toBe(1);
      const llc = await query(`SELECT source_loc_id FROM lifer_loc_coords WHERE user_id = $1`, [uid]);
      expect(llc.rows.length).toBe(1);
    } finally {
      await wipe();
    }
  });

  it("negative persists with reason and survives importLifeList reINSERT", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
    ]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, negative: 1 });
      const attempt = await query<{ reason: string }>(
        `SELECT reason FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest01'`, [uid],
      );
      expect(attempt.rows[0].reason).toBe("no_coords");

      await importLifeList(uid, {
        rows: [{
          comName: "zztsta1", sciName: null, firstSeen: "2025-01-01",
          csvRowNum: 1, taxonOrder: null, category: "species",
          obsCount: 1, locationName: "Somewhere", locId: "Ltest01",
          regionCode: "US-FL", subId: "Stest01", exotic: null, countable: true,
        }],
      }, "csv_import");

      const again = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(again.candidates).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("transient 429 stops the pass WITHOUT recording a negative", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({ rateLimit: true });
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 0, stopped: true });
      const row = await query(
        `SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest01'`, [uid],
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
      const net = fakeEbird({ hotspot: { Ltest01: 403 } });
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res.stopped).toBe(true);
      expect(res.negative).toBe(0);
      const row = await query(`SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1`, [uid]);
      expect(row.rows.length).toBe(0);
      expect(net.calls.length).toBe(1);
    } finally {
      await wipe();
    }
  });

  it("owner HTML login bounce stops the pass, no negative", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({ checklists: { Stest01: "login" } });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 0, stopped: true });
    } finally {
      await wipe();
    }
  });

  it("owner HTML without valid lat/lng but with checklist marker → negative no_coords", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({});
      // Real checklist page with no coords (e.g., old submission)
      const owner = fakeOwnerFetcher({
        checklists: { Stest01: `<html>"checklistId":"CL123" no coordinates here</html>` },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 1 });
      const attempt = await query<{ reason: string }>(
        `SELECT reason FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest01'`, [uid],
      );
      expect(attempt.rows[0].reason).toBe("no_coords");
    } finally {
      await wipe();
    }
  });

  it("login/interstitial HTML (no checklist marker) → stopped with stopReason:'auth', no negative", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({
        checklists: { Stest01: "<html>Please sign in to continue</html>" },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 0, stopped: true, stopReason: 'auth' });
      const row = await query(
        `SELECT 1 FROM lifer_loc_attempts WHERE user_id = $1 AND loc_id = 'Ltest01'`, [uid],
      );
      expect(row.rows.length).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("multi-SubID: first 404, second hits → resolved, no negative", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01", firstSeen: "2025-01-01" },
      { code: "zztstb1", locId: "Ltest01", subId: "Stest02", firstSeen: "2025-06-01" },
    ]);
    try {
      const net = fakeEbird({});
      // Newest SubID (Stest02) 404s; older SubID (Stest01) has coords.
      const owner = fakeOwnerFetcher({
        checklists: {
          Stest02: 404,
          Stest01: ownerHtml(35.0, -80.0),
        },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 1, negative: 0 });
      const llc = await query<{ source_sub_id: string }>(
        `SELECT source_sub_id FROM lifer_loc_coords WHERE user_id = $1 AND source_loc_id = 'Ltest01'`, [uid],
      );
      expect(llc.rows.length).toBe(1);
      expect(llc.rows[0].source_sub_id).toBe("Stest01");
      // Both SubIDs were attempted (404 did NOT stop the pass)
      expect(owner.calls.length).toBe(2);
    } finally {
      await wipe();
    }
  });

  it("cross-user isolation: user B cannot see user A's lifer_loc_coords", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({
        checklists: { Stest01: ownerHtml(30.0, -81.0) },
      });
      await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });

      const userB = (
        await query<{ id: number }>(
          `INSERT INTO users (username, display_name, password_hash, role)
           VALUES ('zz_lifer_test_b', 'Lifer B', 'x', 'user')
           ON CONFLICT (username) DO UPDATE SET role = 'user'
           RETURNING id`,
        )
      ).rows[0].id;
      const bCoords = await query(
        `SELECT 1 FROM lifer_loc_coords WHERE user_id = $1 AND source_loc_id = 'Ltest01'`,
        [userB],
      );
      expect(bCoords.rows.length).toBe(0);
      await query(`DELETE FROM users WHERE id = $1`, [userB]);
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
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher, cap: 1 });
      expect(res.candidates).toBe(2);
      expect(res.capped).toBe(true);
      expect(res.resolved).toBe(1);
    } finally {
      await wipe();
    }
  });

  it("loc with no sub_id and hotspot miss → negative no_coords", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: null }]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 1 });
    } finally {
      await wipe();
    }
  });

  it("deadlineAt in the past → stopped immediately, no negatives", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, {
        fetcher: net.fetcher,
        ownerFetcher: owner.fetcher,
        deadlineAt: Date.now() - 1000,
      });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 0, stopped: true });
      expect(net.calls.length).toBe(0);
      expect(owner.calls.length).toBe(0);
    } finally {
      await wipe();
    }
  });

  it("heartbeat cancel stops the pass", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, {
        fetcher: net.fetcher,
        ownerFetcher: owner.fetcher,
        heartbeat: async () => ({ cancel: true }),
      });
      expect(res).toMatchObject({ candidates: 1, resolved: 0, negative: 0, stopped: true, stopReason: 'cancel' });
    } finally {
      await wipe();
    }
  });

  it("hotspot success counts HTTP budget but not CAS budget", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01" },
      { code: "zztstb1", locId: "Ltest02", subId: "Stest02" },
    ]);
    try {
      const net = fakeEbird({
        hotspot: { Ltest01: { name: "Public", latitude: 1, longitude: 2 } },
      });
      const owner = fakeOwnerFetcher({
        checklists: { Stest02: ownerHtml(30.0, -81.0) },
      });
      // cap=3, casCap=1: hotspot hit (1 HTTP) + hotspot miss (1 HTTP) + owner hit (1 HTTP + 1 CAS) = 3 HTTP, 1 CAS
      const res = await resolveLiferLocations(uid, {
        fetcher: net.fetcher,
        ownerFetcher: owner.fetcher,
        cap: 3,
        casCap: 1,
      });
      expect(res).toMatchObject({ candidates: 2, resolved: 2, negative: 0, capped: false });
    } finally {
      await wipe();
    }
  });

  it("owner 403 stops but owner 404 tries next SubID", async () => {
    await seed([
      { code: "zztsta1", locId: "Ltest01", subId: "Stest01", firstSeen: "2025-01-01" },
      { code: "zztstb1", locId: "Ltest01", subId: "Stest02", firstSeen: "2025-06-01" },
    ]);
    try {
      const net = fakeEbird({});
      const owner = fakeOwnerFetcher({
        checklists: { Stest02: 403 },
      });
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res).toMatchObject({ stopped: true, negative: 0, stopReason: 'upstream' });
      // Only tried Stest02 (newest), stopped on 403 — didn't try Stest01
      expect(owner.calls.length).toBe(1);
    } finally {
      await wipe();
    }
  });

  it("owner timeout (504) maps to stopReason:'timeout', not 'upstream'", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      const net = fakeEbird({});
      const { EbirdUpstreamError: EUE } = await import("./ebird-account");
      const owner = {
        fetcher: async () => { throw new EUE("timed out", 504); },
        calls: [] as string[],
      };
      const res = await resolveLiferLocations(uid, {
        fetcher: net.fetcher,
        ownerFetcher: owner.fetcher,
      });
      expect(res).toMatchObject({ stopped: true, stopReason: 'timeout', negative: 0 });
    } finally {
      await wipe();
    }
  });

  it("legacy_untrusted attempts are retried", async () => {
    await seed([{ code: "zztsta1", locId: "Ltest01", subId: "Stest01" }]);
    try {
      await query(
        `INSERT INTO lifer_loc_attempts (user_id, loc_id, reason) VALUES ($1, 'Ltest01', 'legacy_untrusted')`,
        [uid],
      );
      const net = fakeEbird({
        hotspot: { Ltest01: { name: "Now Found", latitude: 30.0, longitude: -81.0 } },
      });
      const owner = fakeOwnerFetcher({});
      const res = await resolveLiferLocations(uid, { fetcher: net.fetcher, ownerFetcher: owner.fetcher });
      expect(res.candidates).toBe(1);
      expect(res.resolved).toBe(1);
    } finally {
      await wipe();
    }
  });
});

describe("extractLatLng", () => {
  it("extracts valid lat/lng from HTML", () => {
    const html = `some content "lat":30.263016,"lng":-81.637047 more content`;
    expect(extractLatLng(html)).toEqual({ lat: 30.263016, lng: -81.637047 });
  });

  it("extracts quoted numeric coordinates from the live checklist JSP shape", () => {
    const html = `"lat":"30.263016","lng":"-81.637047"`;
    expect(extractLatLng(html)).toEqual({ lat: 30.263016, lng: -81.637047 });
  });

  it("returns null for out-of-range coordinates", () => {
    expect(extractLatLng(`"lat":91,"lng":0`)).toBeNull();
    expect(extractLatLng(`"lat":0,"lng":181`)).toBeNull();
  });

  it("returns null when no lat/lng keys", () => {
    expect(extractLatLng("<html>nothing here</html>")).toBeNull();
  });

  it("handles negative coordinates", () => {
    const r = extractLatLng(`"lat":-33.86,"lng":151.2`);
    expect(r).toEqual({ lat: -33.86, lng: 151.2 });
  });

  it("returns null for non-adjacent lat/lng (must be a pair)", () => {
    expect(extractLatLng(`"lat":30.0 some junk "lng":-81.0`)).toBeNull();
    expect(extractLatLng(`"lat":30.0,"other":1,"lng":-81.0`)).toBeNull();
  });

  it("falls back to latitude/longitude keys (eBird API format)", () => {
    const html = `"latitude":42.3601,"longitude":-71.0589`;
    expect(extractLatLng(html)).toEqual({ lat: 42.3601, lng: -71.0589 });
  });

  it("prefers lat/lng over latitude/longitude when both present", () => {
    const html = `"lat":1.0,"lng":2.0 "latitude":3.0,"longitude":4.0`;
    expect(extractLatLng(html)).toEqual({ lat: 1.0, lng: 2.0 });
  });
});

describe("hasChecklistMarker", () => {
  it("accepts live JSP markers for the expected SubID", () => {
    expect(hasChecklistMarker(`var subId = "S95614428";`, "S95614428")).toBe(true);
    expect(hasChecklistMarker(`<div data-sub-id="S95614428"></div>`, "S95614428")).toBe(true);
  });

  it("rejects another SubID and login/interstitial HTML", () => {
    expect(hasChecklistMarker(`var subId = "S999";`, "S95614428")).toBe(false);
    expect(hasChecklistMarker(`<html>Please sign in to continue</html>`, "S95614428")).toBe(false);
  });
});

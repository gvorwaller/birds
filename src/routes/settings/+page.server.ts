import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { decryptSecret, encryptSecret } from "$server/crypto";
import { getEbirdApiKey } from "$server/ebird";
import {
  importLifeList,
  parseLifeListCsv,
  testEbirdLogin,
  invalidateEbirdSession,
} from "$server/ebird-account";
import { syncGallery } from "$server/gallery";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import {
  sendWebPush,
  validPushEndpoint,
  validPushKeys,
  vapidPublicKey,
  PushError,
  type PushSubscriptionRow,
} from "$server/push";
import { ownerGalleryUrl } from "$server/access";
import { hashPassword } from "$server/auth";
import {
  normalizeNearMeRadiusKm,
  radiusSelectOptionsKm,
  validateNearMeRadiusKm,
} from "$lib/near-me-radius";

export const load: PageServerLoad = async ({ locals }) => {
  const userId = locals.user!.id;
  const isAdmin = locals.user!.role === "admin";
  const hasGallery = (await ownerGalleryUrl(userId)) != null;

  // Admin-only user management (provisioning family accounts).
  const users = isAdmin
    ? (
        await query<{
          id: number;
          username: string;
          display_name: string;
          role: string;
          views_user_id: number | null;
          gallery_url: string | null;
          last_login_at: string | null;
        }>(
          `SELECT id, username, display_name, role, views_user_id, gallery_url, last_login_at
					   FROM users ORDER BY id`,
        )
      ).rows
    : [];

  const [
    ebird,
    user,
    taxCount,
    seenBySource,
    photoStats,
    cacheStats,
    tripStats,
    alertPrefs,
    pushDevices,
  ] = await Promise.all([
    query<{
      api_key_set: boolean;
      login_set: boolean;
      login_username_enc: string | null;
      life_list_synced_at: string | null;
      life_list_status: string | null;
      life_list_error: string | null;
    }>(
      `SELECT api_key_enc IS NOT NULL AS api_key_set,
			        (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set,
			        login_username_enc,
			        life_list_synced_at, life_list_status, life_list_error
			   FROM user_ebird WHERE user_id = $1`,
      [userId],
    ),
    query<{
      home_lat: number | null;
      home_lon: number | null;
      home_label: string | null;
      home_google_place_id: string | null;
      near_me_radius_km: number | null;
    }>(
      `SELECT home_lat, home_lon, home_label, home_google_place_id, near_me_radius_km
			   FROM users WHERE id = $1`,
      [userId],
    ),
    query<{ n: string; newest: string | null }>(
      "SELECT COUNT(*) AS n, MAX(fetched_at)::text AS newest FROM taxonomy_cache",
    ),
    query<{ source: string; n: string }>(
      "SELECT source, COUNT(*) AS n FROM seen_species WHERE user_id = $1 GROUP BY source",
      [userId],
    ),
    query<{ total: string; matched: string; newest: string | null }>(
      `SELECT COUNT(*) AS total, COUNT(species_code) AS matched, MAX(fetched_at)::text AS newest FROM photo_links`,
    ),
    query<{ cache_rows: string; cache_newest: string | null }>(
      `SELECT COUNT(*) AS cache_rows, MAX(fetched_at)::text AS cache_newest FROM ebird_cache`,
    ),
    query<{ trips: string; stops: string }>(
      `SELECT COUNT(DISTINCT t.id) AS trips, COUNT(s.id) AS stops
			   FROM trips t
			   LEFT JOIN trip_stops s ON s.trip_id = t.id
			  WHERE t.user_id = $1`,
      [userId],
    ),
    query<{
      enabled: boolean;
      radius_km: number;
      realert_days: number;
    }>(
      `SELECT enabled, radius_km, realert_days
         FROM user_alert_prefs WHERE user_id = $1`,
      [userId],
    ),
    query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $1`,
      [userId],
    ),
  ]);

  const row = ebird.rows[0];
  // The eBird username is an identifier (low-sensitivity) — show it so the
  // user can confirm which account is saved. The password is never returned.
  let loginUsername: string | null = null;
  if (row?.login_username_enc) {
    try {
      loginUsername = decryptSecret(row.login_username_enc);
    } catch {
      loginUsername = null;
    }
  }

  return {
    ebird: {
      api_key_set: row?.api_key_set ?? false,
      login_set: row?.login_set ?? false,
      login_username: loginUsername,
      life_list_synced_at: row?.life_list_synced_at ?? null,
      life_list_status: row?.life_list_status ?? null,
      life_list_error: row?.life_list_error ?? null,
    },
    home: user.rows[0] ?? {
      home_lat: null,
      home_lon: null,
      home_label: null,
      home_google_place_id: null,
      near_me_radius_km: null,
    },
    alerts: alertPrefs.rows[0] ?? {
      enabled: false,
      radius_km: 40,
      realert_days: 7,
    },
    pushDeviceCount: Number(pushDevices.rows[0]?.n ?? 0),
    // The PUBLIC half of the VAPID pair — safe to expose; the browser needs
    // it as applicationServerKey to subscribe.
    vapidPublicKey: vapidPublicKey(),
    // Settings is the single explicit persistence surface for the saved search
    // radius now that Home's implicit save-on-change action is gone.
    radiusKm: normalizeNearMeRadiusKm(user.rows[0]?.near_me_radius_km),
    radiusOptionsKm: radiusSelectOptionsKm(
      normalizeNearMeRadiusKm(user.rows[0]?.near_me_radius_km),
    ),
    taxonomyCount: Number(taxCount.rows[0]?.n ?? 0),
    taxonomyNewest: taxCount.rows[0]?.newest ?? null,
    seenBySource: seenBySource.rows.map((r) => ({
      source: r.source,
      n: Number(r.n),
    })),
    photoTotal: hasGallery ? Number(photoStats.rows[0]?.total ?? 0) : 0,
    photoMatched: hasGallery ? Number(photoStats.rows[0]?.matched ?? 0) : 0,
    photoNewest: hasGallery ? (photoStats.rows[0]?.newest ?? null) : null,
    cacheRows: Number(cacheStats.rows[0]?.cache_rows ?? 0),
    cacheNewest: cacheStats.rows[0]?.cache_newest ?? null,
    tripCount: Number(tripStats.rows[0]?.trips ?? 0),
    tripStopCount: Number(tripStats.rows[0]?.stops ?? 0),
    hasGallery,
    isAdmin,
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      role: u.role,
      views_user_id: u.views_user_id,
      has_gallery: !!u.gallery_url,
      last_login_at: u.last_login_at,
    })),
  };
};

async function ensureEbirdRow(userId: number): Promise<void> {
  await query(
    `INSERT INTO user_ebird (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

export const actions: Actions = {
  save_api_key: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    const key = (form.get("api_key") ?? "").toString().trim();
    if (!key)
      return fail(400, {
        error: "Enter an eBird API key (ebird.org/api/keygen).",
      });
    await ensureEbirdRow(userId);
    await query(
      `UPDATE user_ebird SET api_key_enc = $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, encryptSecret(key)],
    );
    return { ok: true as const, message: "eBird API key saved (encrypted)." };
  },

  save_login: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    const username = (form.get("ebird_username") ?? "").toString().trim();
    const password = (form.get("ebird_password") ?? "").toString();
    if (!username || !password) {
      return fail(400, {
        error: "Enter both the eBird username and password.",
      });
    }
    await ensureEbirdRow(userId);
    await query(
      `UPDATE user_ebird SET login_username_enc = $2, login_password_enc = $3, updated_at = NOW()
			  WHERE user_id = $1`,
      [userId, encryptSecret(username), encryptSecret(password)],
    );
    invalidateEbirdSession(userId);
    return {
      ok: true as const,
      message: "eBird account credentials saved (encrypted).",
    };
  },

  reveal_api_key: async ({ locals }) => {
    const userId = locals.user!.id;
    const key = await getEbirdApiKey(userId);
    if (!key) return fail(404, { error: "No API key saved." });
    return { ok: true as const, apiKey: key };
  },

  clear_api_key: async ({ locals }) => {
    const userId = locals.user!.id;
    await query(
      "UPDATE user_ebird SET api_key_enc = NULL, updated_at = NOW() WHERE user_id = $1",
      [userId],
    );
    return { ok: true as const, message: "eBird API key removed." };
  },

  clear_login: async ({ locals }) => {
    const userId = locals.user!.id;
    await query(
      `UPDATE user_ebird SET login_username_enc = NULL, login_password_enc = NULL,
			        life_list_status = NULL, life_list_error = NULL, updated_at = NOW()
			  WHERE user_id = $1`,
      [userId],
    );
    invalidateEbirdSession(userId);
    return { ok: true as const, message: "eBird account credentials removed." };
  },

  test_login: async ({ locals }) => {
    const userId = locals.user!.id;
    try {
      await testEbirdLogin(userId);
      return {
        ok: true as const,
        message: "eBird login works — credentials accepted.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(502, { error: `eBird login test failed: ${msg}` });
    }
  },

  save_home: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    const lat = Number(form.get("home_lat"));
    const lon = Number(form.get("home_lon"));
    const label = (form.get("home_label") ?? "").toString().trim() || null;
    const googlePlaceId =
      (form.get("home_google_place_id") ?? "").toString().trim() || null;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      return fail(400, { error: "Pick a location on the map first." });
    }
    await query(
      "UPDATE users SET home_lat = $2, home_lon = $3, home_label = $4, home_google_place_id = $5 WHERE id = $1",
      [userId, lat, lon, label, googlePlaceId],
    );
    return {
      ok: true as const,
      message: `Home location saved${label ? `: ${label}` : ""}.`,
    };
  },

  save_radius: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    const radius = validateNearMeRadiusKm(form.get("near_me_radius_km"));
    if (!radius.ok) return fail(400, { error: radius.error });

    await query("UPDATE users SET near_me_radius_km = $2 WHERE id = $1", [
      userId,
      radius.value,
    ]);
    return {
      ok: true as const,
      message: `Search radius saved: ${radius.value} km.`,
    };
  },

  /**
   * Both syncs are background JOBS (Phase 3, td-eb9e1d): validate the
   * prerequisites here, enqueue, return immediately. The worker runs them
   * with the retry schedule; results land in the job history (/admin and
   * the Forecast data hub).
   */
  sync_taxonomy: async ({ locals }) => {
    const userId = locals.user!.id;
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) return fail(400, { error: "Save your eBird API key first." });
    const { jobId, deduped } = await enqueueJob({
      type: "sync_taxonomy",
      payload: {},
      dedupKey: dedupKeys.syncTaxonomy(),
      requestedBy: userId,
      label: "eBird taxonomy + photo re-match",
    });
    return {
      ok: true as const,
      message: deduped
        ? "A taxonomy sync is already queued — it runs in the background."
        : "Taxonomy sync queued — it runs in the background; the result appears in the job history.",
      queued: { jobId, deduped },
    };
  },

  sync_lifelist: async ({ locals }) => {
    const userId = locals.user!.id;
    const creds = await query<{ login_set: boolean }>(
      `SELECT (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set
         FROM user_ebird WHERE user_id = $1`,
      [userId],
    );
    if (creds.rows[0]?.login_set !== true) {
      return fail(400, { error: "Save your eBird sign-in first." });
    }
    const { jobId, deduped } = await enqueueJob({
      type: "sync_lifelist",
      payload: {},
      dedupKey: dedupKeys.syncLifelist(userId),
      requestedBy: userId,
      label: "Life list from eBird",
    });
    return {
      ok: true as const,
      message: deduped
        ? "A life-list sync is already queued — it runs in the background."
        : "Life-list sync queued — it runs in the background; your last synced list stays until it succeeds.",
      queued: { jobId, deduped },
    };
  },

  /**
   * Need-alert preferences (Web Push channel). Enabling requires at least
   * one enrolled device — checked here; the scan also skips users whose
   * devices have all been pruned.
   */
  save_alerts: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    const enabled = form.get("enabled") === "1";
    const radius = Number(form.get("radius_km"));
    const realert = Number(form.get("realert_days"));
    if (!Number.isInteger(radius) || radius < 1 || radius > 50) {
      return fail(400, { error: "Alert radius must be between 1 and 50 km." });
    }
    if (!Number.isInteger(realert) || realert < 1 || realert > 30) {
      return fail(400, { error: "Re-alert window must be between 1 and 30 days." });
    }
    if (enabled) {
      const devices = await query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $1`,
        [userId],
      );
      if (Number(devices.rows[0]?.n ?? 0) === 0) {
        return fail(400, {
          error: "Enable notifications on this device first (the button above).",
        });
      }
    }
    await query(
      `INSERT INTO user_alert_prefs (user_id, enabled, radius_km, realert_days, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         enabled = $2, radius_km = $3, realert_days = $4, updated_at = NOW()`,
      [userId, enabled, radius, realert],
    );
    return {
      ok: true as const,
      message: enabled
        ? "Need alerts saved and enabled — the next background scan (within ~30 min) starts watching."
        : "Need-alert settings saved (alerts off).",
    };
  },

  /**
   * Store this browser/device's push subscription (from
   * pushManager.subscribe().toJSON()). The endpoint is a capability — never
   * echoed back, never logged.
   */
  save_push_sub: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    let sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    try {
      sub = JSON.parse((form.get("subscription") ?? "").toString());
    } catch {
      return fail(400, { error: "Malformed push subscription." });
    }
    const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
    const p256dh = typeof sub.keys?.p256dh === "string" ? sub.keys.p256dh : "";
    const auth = typeof sub.keys?.auth === "string" ? sub.keys.auth : "";
    // Strict boundary (CODEX1): only real push-service origins, structural
    // URL checks, and key-shape bounds — an arbitrary https URL here would be
    // authenticated blind SSRF via the worker's sends.
    if (!validPushEndpoint(endpoint) || !validPushKeys(p256dh, auth)) {
      return fail(400, { error: "Malformed push subscription." });
    }
    // Re-homing an EXISTING endpoint to the current login is deliberate: the
    // subscription tuple is capability material the browser just proved it
    // holds; same browser switching accounts moves the device's alerts to
    // the account now using it.
    await query(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $3, auth = $4`,
      [endpoint, userId, p256dh, auth],
    );
    return { ok: true as const, message: "This device is enrolled for notifications." };
  },

  /**
   * Synchronous test push to EVERY enrolled device — misconfiguration must
   * surface at setup time. Dead endpoints (404/410) are pruned on the spot.
   */
  test_push: async ({ locals }) => {
    const userId = locals.user!.id;
    const subs = await query<PushSubscriptionRow>(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [userId],
    );
    if (subs.rows.length === 0) {
      return fail(400, { error: "Enable notifications on this device first." });
    }
    let delivered = 0;
    let lastError: string | null = null;
    for (const sub of subs.rows) {
      try {
        await sendWebPush(sub, {
          title: "Need-alerts test",
          body: "Notifications are working. Rare birds you need will show up like this.",
          tag: "need-alerts-test",
        });
        delivered++;
      } catch (err) {
        if (err instanceof PushError && err.gone) {
          await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
        } else {
          lastError = err instanceof PushError ? err.message : "push failed";
        }
      }
    }
    if (delivered === 0) {
      return fail(502, {
        error: `Test failed on every enrolled device${lastError ? ` (${lastError})` : ""} — try re-enabling notifications on this device.`,
      });
    }
    return {
      ok: true as const,
      message: `Test sent to ${delivered} device${delivered === 1 ? "" : "s"}. If nothing appeared: notifications must be allowed for the birds app, and Focus can silence them.`,
    };
  },


  import_csv: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    const file = form.get("csv");
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, { error: "Choose a CSV file exported from eBird." });
    }
    try {
      const parsed = parseLifeListCsv(await file.text());
      const result = await importLifeList(userId, parsed, "csv_import");
      return {
        ok: true as const,
        message: `CSV imported: ${result.matched} species (${result.unmatched.length} unmatched names).`,
      };
    } catch (err) {
      return fail(400, {
        error: `CSV import failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },

  flush_cache: async () => {
    const r = await query<{ n: string }>(
      "WITH d AS (DELETE FROM ebird_cache RETURNING 1) SELECT COUNT(*) AS n FROM d",
    );
    return {
      ok: true as const,
      message: `Cleared ${Number(r.rows[0]?.n ?? 0)} cached eBird responses — next load fetches fresh.`,
    };
  },

  sync_gallery: async ({ locals }) => {
    if (!(await ownerGalleryUrl(locals.user!.id))) {
      return fail(403, {
        error: "No photo source is configured for your account.",
      });
    }
    try {
      const result = await syncGallery();
      return {
        ok: true as const,
        message: `Gallery synced: ${result.total} photos, ${result.matched} matched, ${result.unmatched} unmatched.`,
      };
    } catch (err) {
      return fail(502, {
        error: `Gallery sync failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },

  // --- Admin-only user management (provision family accounts) ---
  create_user: async ({ locals, request }) => {
    if (locals.user!.role !== "admin")
      return fail(403, { error: "Admins only." });
    const form = await request.formData();
    const username = (form.get("new_username") ?? "")
      .toString()
      .trim()
      .toLowerCase();
    const displayName = (form.get("new_display_name") ?? "").toString().trim();
    const role = (form.get("new_role") ?? "user").toString();
    const password = (form.get("new_password") ?? "").toString();
    if (!username || !displayName || !password) {
      return fail(400, {
        error: "Username, display name, and password are required.",
      });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return fail(400, {
        error:
          "Username may use only lowercase letters, numbers, and underscores.",
      });
    }
    if (!["admin", "user", "viewer"].includes(role)) {
      return fail(400, { error: "Invalid role." });
    }
    if (password.length < 8) {
      return fail(400, { error: "Password must be at least 8 characters." });
    }
    // A viewer reads a chosen owner's data; default to the creating admin.
    let viewsUserId: number | null = null;
    if (role === "viewer") {
      const v = Number(form.get("views_user_id"));
      viewsUserId = Number.isInteger(v) && v > 0 ? v : locals.user!.id;
    }
    const exists = await query("SELECT 1 FROM users WHERE username = $1", [
      username,
    ]);
    if (exists.rowCount)
      return fail(409, { error: `Username "${username}" is already taken.` });
    const hash = await hashPassword(password);
    await query(
      `INSERT INTO users (username, display_name, password_hash, role, views_user_id)
			 VALUES ($1, $2, $3, $4, $5)`,
      [username, displayName, hash, role, viewsUserId],
    );
    return {
      ok: true as const,
      message: `Created ${role} account "${username}".`,
    };
  },

  set_user_password: async ({ locals, request }) => {
    if (locals.user!.role !== "admin")
      return fail(403, { error: "Admins only." });
    const form = await request.formData();
    const targetId = Number(form.get("user_id"));
    const password = (form.get("password") ?? "").toString();
    if (!Number.isInteger(targetId) || password.length < 8) {
      return fail(400, { error: "Pick a user and an 8+ character password." });
    }
    const hash = await hashPassword(password);
    const r = await query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      targetId,
      hash,
    ]);
    if (!r.rowCount) return fail(404, { error: "User not found." });
    return { ok: true as const, message: "Password updated." };
  },
};

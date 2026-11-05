import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { DEFAULT_SCAN_INTERVAL_MIN } from "$lib/need-alerts-policy";

// In-app history of need alerts (Gaylon: a push vanishes once dismissed —
// this page is the durable record). Rows come from need_alert_log, which
// stores the title/body verbatim as pushed, so this list can never disagree
// with what the notification said.
export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user!;
  // Alerts are personal (tied to the account's own needs + devices); a
  // read-only viewer has neither, same as /settings.
  if (user.role === "viewer") throw redirect(303, "/");

  const [prefs, devices, history] = await Promise.all([
    query<{
      enabled: boolean;
      radius_km: number;
      realert_days: number;
      scan_interval_min: number;
      last_scanned_at: string | null;
    }>(
      `SELECT enabled, radius_km, realert_days, scan_interval_min, last_scanned_at::text
         FROM user_alert_prefs WHERE user_id = $1`,
      [user.id],
    ),
    query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $1`,
      [user.id],
    ),
    query<{
      id: string;
      species_code: string;
      com_name: string | null;
      title: string;
      body: string;
      url: string;
      reports: { subId: string | null; locName: string; obsDt: string; distanceMi: number }[];
      sent_at: string;
    }>(
      `SELECT l.id::text, l.species_code, t.com_name, l.title, l.body, l.url, l.reports, l.sent_at::text
         FROM need_alert_log l
         LEFT JOIN taxonomy_cache t ON t.species_code = l.species_code
        WHERE l.user_id = $1
        ORDER BY l.sent_at DESC, l.id DESC
        LIMIT 200`,
      [user.id],
    ),
  ]);

  return {
    accountId: user.id,
    alerts: prefs.rows[0] ?? {
      enabled: false,
      radius_km: 40,
      realert_days: 7,
      scan_interval_min: DEFAULT_SCAN_INTERVAL_MIN,
      last_scanned_at: null,
    },
    pushDeviceCount: Number(devices.rows[0]?.n ?? 0),
    history: history.rows,
    // This account's own last completed check (per-account intervals since
    // 0102). The global scan job ticks every 15 min whether or not this
    // account was due, so its finish time would overstate how often a
    // slower account is checked.
    lastScanAt: prefs.rows[0]?.last_scanned_at ?? null,
  };
};

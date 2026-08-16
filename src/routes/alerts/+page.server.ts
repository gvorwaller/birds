import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";

// In-app history of need alerts (Gaylon: a push vanishes once dismissed —
// this page is the durable record). Rows come from need_alert_log, which
// stores the title/body verbatim as pushed, so this list can never disagree
// with what the notification said.
export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user!;
  // Alerts are personal (tied to the account's own needs + devices); a
  // read-only viewer has neither, same as /settings.
  if (user.role === "viewer") throw redirect(303, "/");

  const [prefs, devices, history, lastScan] = await Promise.all([
    query<{ enabled: boolean; radius_km: number; realert_days: number }>(
      `SELECT enabled, radius_km, realert_days
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
      title: string;
      body: string;
      url: string;
      sent_at: string;
    }>(
      `SELECT id::text, species_code, title, body, url, sent_at::text
         FROM need_alert_log
        WHERE user_id = $1
        ORDER BY sent_at DESC, id DESC
        LIMIT 200`,
      [user.id],
    ),
    query<{ finished_at: string | null }>(
      `SELECT finished_at::text
         FROM jobs
        WHERE type = 'scan_need_alerts' AND status = 'succeeded'
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1`,
    ),
  ]);

  return {
    alerts: prefs.rows[0] ?? { enabled: false, radius_km: 40, realert_days: 7 },
    pushDeviceCount: Number(devices.rows[0]?.n ?? 0),
    history: history.rows,
    lastScanAt: lastScan.rows[0]?.finished_at ?? null,
  };
};

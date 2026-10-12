/**
 * Per-account usage (td-c8e6a3). The hook records that an account opened a
 * page in an app section on a UTC day; Admin → Users summarizes it. Only the
 * section and the day are kept — never what was searched or viewed.
 */
import { query } from "$lib/db";
import type { UsageFeature } from "$lib/usage-features";

/** UTC calendar day, "2026-10-12". */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Each web process writes a given (account, day, section) once: every later
// page load that day is a set lookup, not a query. A restart forgets the set
// and costs one more insert that the primary key turns into a no-op.
let recordedDay = "";
const recorded = new Set<string>();

/**
 * Record a page load. Fire-and-forget: the request never waits for it, and a
 * failed write is logged, never surfaced (usage is a report, not data the
 * page depends on).
 */
export function recordActivity(userId: number, feature: UsageFeature, now = new Date()): void {
  const day = utcDay(now);
  if (day !== recordedDay) {
    recorded.clear();
    recordedDay = day;
  }
  const key = `${userId}|${feature}`;
  if (recorded.has(key)) return;
  recorded.add(key);
  query(
    `INSERT INTO user_activity_day (user_id, day, feature) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userId, day, feature],
  ).catch((err) => {
    recorded.delete(key); // let a later page load try again
    console.warn("[user-activity] record failed:", err instanceof Error ? err.message : err);
  });
}

/** Test hook: forget what this process has recorded. */
export function resetRecordedActivity(): void {
  recorded.clear();
  recordedDay = "";
}

export interface AccountUsage {
  id: number;
  username: string;
  displayName: string;
  role: string;
  /** For a viewer: whose data it reads. */
  viewsName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  /** Latest UTC day with a recorded page load, or null. */
  lastActiveDay: string | null;
  /** Distinct days with a page load in the last 30 days (today included). */
  activeDays30: number;
  /** Used the app on a later day than the one the account was created:
   * a recorded page load or a login after that day. */
  returned: boolean;
  /** Section → distinct days used in the last 30 days. */
  features30: Partial<Record<UsageFeature, number>>;
}

export interface UsageReport {
  accounts: AccountUsage[];
  /** First recorded day across all accounts (when tracking began), or null. */
  trackingSince: string | null;
}

export async function usageReport(): Promise<UsageReport> {
  const today = utcDay();
  const r = await query<{
    id: number;
    username: string;
    display_name: string;
    role: string;
    views_name: string | null;
    created_at: string;
    last_login_at: string | null;
    last_active_day: string | null;
    active_days_30: number;
    returned: boolean;
    features_30: Record<string, number> | null;
  }>(
    `WITH a AS (
       SELECT user_id, day, feature FROM user_activity_day
     ), per_user AS (
       SELECT user_id,
              max(day) AS last_active_day,
              count(DISTINCT day) FILTER (WHERE day > $1::date - 30)::int AS active_days_30
         FROM a GROUP BY user_id
     ), feats AS (
       SELECT user_id, jsonb_object_agg(feature, n) AS features_30
         FROM (SELECT user_id, feature, count(*)::int AS n FROM a
                WHERE day > $1::date - 30 GROUP BY 1, 2) f
        GROUP BY user_id
     )
     SELECT u.id, u.username, u.display_name, u.role, o.display_name AS views_name,
            u.created_at, u.last_login_at,
            to_char(p.last_active_day, 'YYYY-MM-DD') AS last_active_day,
            COALESCE(p.active_days_30, 0) AS active_days_30,
            (COALESCE(p.last_active_day > (u.created_at AT TIME ZONE 'UTC')::date, false)
             OR COALESCE((u.last_login_at AT TIME ZONE 'UTC')::date > (u.created_at AT TIME ZONE 'UTC')::date, false))
              AS returned,
            f.features_30
       FROM users u
       LEFT JOIN users o ON o.id = u.views_user_id
       LEFT JOIN per_user p ON p.user_id = u.id
       LEFT JOIN feats f ON f.user_id = u.id
      ORDER BY p.last_active_day DESC NULLS LAST, u.last_login_at DESC NULLS LAST, u.id`,
    [today],
  );
  const since = await query<{ d: string | null }>(
    "SELECT to_char(min(day), 'YYYY-MM-DD') AS d FROM user_activity_day",
  );
  return {
    trackingSince: since.rows[0]?.d ?? null,
    accounts: r.rows.map((x) => ({
      id: x.id,
      username: x.username,
      displayName: x.display_name,
      role: x.role,
      viewsName: x.views_name,
      createdAt: new Date(x.created_at).toISOString(),
      lastLoginAt: x.last_login_at ? new Date(x.last_login_at).toISOString() : null,
      lastActiveDay: x.last_active_day,
      activeDays30: x.active_days_30,
      returned: x.returned,
      features30: (x.features_30 ?? {}) as Partial<Record<UsageFeature, number>>,
    })),
  };
}

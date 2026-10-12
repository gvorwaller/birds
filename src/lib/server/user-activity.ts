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

// Each web process writes a given (day, account, section) once: a repeat
// report that day is a set lookup, not a query. A restart forgets the set and
// costs one more insert that the primary key turns into a no-op.
let recordedDay = "";
const recorded = new Set<string>();

/**
 * Record that an account used a section today (td-c8e6a3). Never rejects: a
 * failed write is logged and forgotten, so a later report retries (usage is a
 * report, not data a page depends on).
 */
export async function recordActivity(userId: number, feature: UsageFeature, now = new Date()): Promise<void> {
  const day = utcDay(now);
  if (day !== recordedDay) {
    recorded.clear();
    recordedDay = day;
  }
  // Day-qualified, so a failed write from before midnight can never clear
  // the next day's entry.
  const key = `${day}|${userId}|${feature}`;
  if (recorded.has(key)) return;
  recorded.add(key);
  try {
    await query(
      `INSERT INTO user_activity_day (user_id, day, feature) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [userId, day, feature],
    );
  } catch (err) {
    recorded.delete(key);
    console.warn("[user-activity] record failed:", err instanceof Error ? err.message : err);
  }
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
  /** Whether the account came back on a later day than its first known use:
   * "yes" — evidence of use on two or more days; "not_yet" — recorded use on
   * one day only; "unknown" — no recorded page loads and at most one day of
   * older evidence, so an earlier visit can't be ruled out; "never" — no
   * evidence of use at all. */
  returned: Returned;
  /** Section → distinct days used in the last 30 days. */
  features30: Partial<Record<UsageFeature, number>>;
}

export type Returned = "yes" | "not_yet" | "unknown" | "never";

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
    use_days: number;
    tracked: boolean;
    features_30: Record<string, number> | null;
  }>(
    `WITH a AS (
       SELECT user_id, day, feature FROM user_activity_day
     ), per_user AS (
       SELECT user_id,
              max(day) AS last_active_day,
              count(DISTINCT day) FILTER (WHERE day > $1::date - 30)::int AS active_days_30
         FROM a GROUP BY user_id
     ), use_days AS (
       -- Every UTC day with evidence the account used the app: recorded page
       -- loads, logins (the latest login stamp and live sessions' sign-ins),
       -- and species pages opened. Older days than tracking come only from
       -- the last three.
       SELECT user_id, count(DISTINCT d)::int AS n FROM (
         SELECT user_id, day AS d FROM a
         UNION ALL SELECT id, (last_login_at AT TIME ZONE 'UTC')::date FROM users WHERE last_login_at IS NOT NULL
         UNION ALL SELECT user_id, (created_at AT TIME ZONE 'UTC')::date FROM sessions
         UNION ALL SELECT user_id, (first_viewed_at AT TIME ZONE 'UTC')::date FROM species_view_history
         UNION ALL SELECT user_id, (last_viewed_at AT TIME ZONE 'UTC')::date FROM species_view_history
       ) e GROUP BY user_id
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
            COALESCE(d.n, 0) AS use_days,
            (p.user_id IS NOT NULL) AS tracked,
            f.features_30
       FROM users u
       LEFT JOIN users o ON o.id = u.views_user_id
       LEFT JOIN per_user p ON p.user_id = u.id
       LEFT JOIN use_days d ON d.user_id = u.id
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
      returned: x.use_days >= 2 ? "yes" : x.tracked ? "not_yet" : x.use_days === 1 ? "unknown" : "never",
      features30: (x.features_30 ?? {}) as Partial<Record<UsageFeature, number>>,
    })),
  };
}

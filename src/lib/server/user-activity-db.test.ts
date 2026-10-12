/**
 * td-c8e6a3: usage recording and the Admin → Users report on real PostgreSQL.
 * Shared birds_test: own per-run accounts only, exact cleanup (rows cascade
 * with the accounts), no seed/reset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { recordActivity, resetRecordedActivity, usageReport, utcDay } from "./user-activity";

const tag = randomUUID().replaceAll("-", "").slice(0, 8);
const ids: number[] = [];
const account = async (suffix: string, createdDaysAgo: number, lastLoginDaysAgo: number | null, viewsUserId: number | null = null) => {
  const r = await query<{ id: number }>(
    `INSERT INTO users (username, display_name, password_hash, role, views_user_id, created_at, last_login_at)
     VALUES ($1, $2, '!unset', $3, $4, now() - make_interval(days => $5::int),
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END)
     RETURNING id`,
    [`zzusage-${suffix}-${tag}`, `Usage ${suffix}`, viewsUserId ? "viewer" : "user", viewsUserId, createdDaysAgo, lastLoginDaysAgo],
  );
  ids.push(r.rows[0].id);
  return r.rows[0].id;
};
const day = (daysAgo: number) => utcDay(new Date(Date.now() - daysAgo * 86_400_000));
const rows = async (id: number) =>
  (await query<{ day: string; feature: string }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, feature FROM user_activity_day WHERE user_id = $1 ORDER BY 1, 2",
    [id],
  )).rows;

beforeAll(() => {
  if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "15436" || env.PGDATABASE !== "birds_test")
    throw Error("Requires dedicated birds_test");
});

afterAll(async () => {
  await query("DELETE FROM users WHERE id = ANY($1) AND username LIKE 'zzusage-%'", [ids]);
  const left = await query<{ n: number }>(
    "SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM user_activity_day WHERE user_id = ANY($1)) AS n",
    [ids],
  );
  expect(Number(left.rows[0].n)).toBe(0);
});

describe("usage recording (td-c8e6a3)", () => {
  it("writes one row per account, day and section, however many reports", async () => {
    resetRecordedActivity();
    const id = await account("rec", 3, 0);
    for (let i = 0; i < 5; i++) await recordActivity(id, "home");
    await recordActivity(id, "field_guide");
    await recordActivity(id, "home", new Date(Date.now() - 86_400_000)); // yesterday: a new day
    expect(await rows(id)).toEqual(
      [
        { day: day(1), feature: "home" },
        { day: day(0), feature: "field_guide" },
        { day: day(0), feature: "home" },
      ].sort((a, b) => (a.day + a.feature).localeCompare(b.day + b.feature)),
    );
    // A restarted process (empty memory) re-inserts as a no-op.
    resetRecordedActivity();
    await recordActivity(id, "home");
    expect((await rows(id)).length).toBe(3);
  });

  it("a failed write resolves false, shares that outcome with a concurrent report, and is retried", async () => {
    resetRecordedActivity();
    // An account id that does not exist yet: the FK rejects the insert.
    const id = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
    const [first, concurrent] = await Promise.all([recordActivity(id, "home"), recordActivity(id, "home")]);
    expect([first, concurrent]).toEqual([false, false]);
    // The same key is not remembered: once the account exists, the next report writes.
    await query(
      "INSERT INTO users (id, username, display_name, password_hash, role) VALUES ($1, $2, 'Usage retry', '!unset', 'user')",
      [id, `zzusage-retry-${tag}`],
    );
    ids.push(id);
    expect(await recordActivity(id, "home")).toBe(true);
    expect(await rows(id)).toEqual([{ day: day(0), feature: "home" }]);
    // A report while a good write is pending shares it: one row, both true.
    const [a, b] = await Promise.all([recordActivity(id, "trips"), recordActivity(id, "trips")]);
    expect([a, b]).toEqual([true, true]);
    expect((await rows(id)).length).toBe(2);
  });

  it("reports last active, days active in 30, sections, and whether the account came back", async () => {
    const owner = await account("own", 60, 0);
    const active = await account("act", 40, 40);
    const once = await account("one", 10, 10);
    const delayed = await account("late", 11, 0); // provisioned 11 days ago, first used today
    const loginOnly = await account("log", 20, 2, owner); // one pre-tracking day of evidence
    const viewsAndLogin = await account("views", 20, 2); // login + a species page on another day
    const never = await account("nev", 5, null);
    await query(
      `INSERT INTO user_activity_day (user_id, day, feature) VALUES
         ($1, $2, 'home'), ($1, $3, 'home'), ($1, $3, 'forecast'), ($1, $4, 'trips'), ($1, $8, 'photos'),
         ($5, $6, 'home'), ($7, $2, 'home')`,
      [active, day(0), day(5), day(45), once, day(10), delayed, day(29)],
    );
    await query(
      `INSERT INTO species_view_history (user_id, species_code, first_viewed_at, last_viewed_at)
       VALUES ($1, 'amerob', now() - interval '9 days', now() - interval '9 days')`,
      [viewsAndLogin],
    );
    const report = await usageReport();
    const by = new Map(report.accounts.map((a) => [a.id, a]));
    expect(by.get(active)).toMatchObject({
      lastActiveDay: day(0),
      activeDays30: 3, // today, 5 and 29 days ago; 45 days ago is outside the window
      returned: "yes",
      features30: { home: 2, forecast: 1, photos: 1 },
    });
    // Signed up, signed in and used the app all on one day.
    expect(by.get(once)).toMatchObject({ lastActiveDay: day(10), activeDays30: 1, returned: "not_yet" });
    // Provisioned long before, used only today: not back yet.
    expect(by.get(delayed)).toMatchObject({ lastActiveDay: day(0), activeDays30: 1, returned: "not_yet" });
    // No recorded page loads and one day of older evidence: an earlier visit can't be ruled out.
    expect(by.get(loginOnly)).toMatchObject({ lastActiveDay: null, activeDays30: 0, returned: "unknown", viewsName: "Usage own", role: "viewer" });
    expect(by.get(viewsAndLogin)).toMatchObject({ lastActiveDay: null, returned: "yes" });
    expect(by.get(never)).toMatchObject({ lastActiveDay: null, activeDays30: 0, returned: "never", features30: {} });
    expect(report.trackingSince! <= day(45)).toBe(true);
  });
});

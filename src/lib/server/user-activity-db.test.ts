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
const settle = () => new Promise((r) => setTimeout(r, 150));

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
  it("writes one row per account, day and section, however many page loads", async () => {
    resetRecordedActivity();
    const id = await account("rec", 3, 0);
    for (let i = 0; i < 5; i++) recordActivity(id, "home");
    recordActivity(id, "field_guide");
    recordActivity(id, "home", new Date(Date.now() - 86_400_000)); // yesterday: a new day
    await settle();
    expect(await rows(id)).toEqual(
      [
        { day: day(1), feature: "home" },
        { day: day(0), feature: "field_guide" },
        { day: day(0), feature: "home" },
      ].sort((a, b) => (a.day + a.feature).localeCompare(b.day + b.feature)),
    );
    // A restarted process (empty memory) re-inserts as a no-op.
    resetRecordedActivity();
    recordActivity(id, "home");
    await settle();
    expect((await rows(id)).length).toBe(3);
  });

  it("reports last active, days active in 30, sections, and whether the account returned", async () => {
    const owner = await account("own", 60, 0);
    const active = await account("act", 40, 40);
    const once = await account("one", 10, 10);
    const loginOnly = await account("log", 20, 2, owner);
    await query(
      `INSERT INTO user_activity_day (user_id, day, feature) VALUES
         ($1, $2, 'home'), ($1, $3, 'home'), ($1, $3, 'forecast'), ($1, $4, 'trips'),
         ($5, $6, 'home')`,
      [active, day(0), day(5), day(45), once, day(10)],
    );
    const report = await usageReport();
    const by = new Map(report.accounts.map((a) => [a.id, a]));
    expect(by.get(active)).toMatchObject({
      lastActiveDay: day(0),
      activeDays30: 2, // the 45-day-old row is outside the window
      returned: true,
      features30: { home: 2, forecast: 1 },
    });
    // Used the app only on the day the account was created.
    expect(by.get(once)).toMatchObject({ lastActiveDay: day(10), activeDays30: 1, returned: false, features30: { home: 1 } });
    // No recorded page loads, but a login on a later day than signup counts as returning.
    expect(by.get(loginOnly)).toMatchObject({ lastActiveDay: null, activeDays30: 0, returned: true, viewsName: "Usage own", role: "viewer" });
    expect(report.trackingSince! <= day(45)).toBe(true);
  });
});

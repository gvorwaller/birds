/**
 * td-12bd33: Settings → User admin → Delete account on real PostgreSQL.
 * Shared birds_test: own per-run accounts and jobs only, exact cleanup, no
 * seed/reset. Live job fixtures are parked a day in the future so a worker on
 * this cluster never claims them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query, withTransaction } from "$lib/db";
import { deleteAccount } from "./account-delete";
import { listJobs } from "./jobs";

const tag = randomUUID().replaceAll("-", "").slice(0, 8);
const userIds: number[] = [];
const jobIds: string[] = [];

const account = async (suffix: string, role = "user", viewsUserId: number | null = null) => {
  const username = `zzdel_${suffix}_${tag}`;
  const r = await query<{ id: number }>(
    `INSERT INTO users (username, display_name, password_hash, role, views_user_id)
     VALUES ($1, $2, '!unset', $3, $4) RETURNING id`,
    [username, `Delete ${suffix}`, role, viewsUserId],
  );
  userIds.push(r.rows[0].id);
  return { id: r.rows[0].id, username };
};

const job = async (userId: number, type: string, status: "pending" | "running" | "succeeded") => {
  const r = await query<{ id: string }>(
    `INSERT INTO jobs (type, status, requested_by, label, next_retry_at, started_at, heartbeat_at, finished_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $2 = 'pending' THEN now() + interval '1 day' END,
             CASE WHEN $2 <> 'pending' THEN now() END,
             CASE WHEN $2 = 'running' THEN now() END,
             CASE WHEN $2 = 'succeeded' THEN now() END)
     RETURNING id`,
    [type, status, userId, `zzdel ${tag}`],
  );
  jobIds.push(r.rows[0].id);
  return r.rows[0].id;
};

const jobRow = async (id: string) =>
  (await query<{ status: string; requested_by: number | null }>(
    "SELECT status, requested_by FROM jobs WHERE id = $1",
    [id],
  )).rows[0];
const exists = async (id: number) =>
  ((await query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount ?? 0) > 0;

beforeAll(() => {
  if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "15436" || env.PGDATABASE !== "birds_test")
    throw Error("Requires dedicated birds_test");
});

afterAll(async () => {
  await query("DELETE FROM jobs WHERE id = ANY($1::bigint[]) AND label = $2", [jobIds, `zzdel ${tag}`]);
  await query("DELETE FROM users WHERE views_user_id = ANY($1) AND username LIKE 'zzdel\\_%'", [userIds]);
  await query("DELETE FROM users WHERE id = ANY($1) AND username LIKE 'zzdel\\_%'", [userIds]);
  const left = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM users WHERE id = ANY($1))
          + (SELECT count(*) FROM jobs WHERE id = ANY($2::bigint[]))
          + (SELECT count(*) FROM species_view_receipts WHERE user_id = ANY($1)) AS n`,
    [userIds, jobIds],
  );
  expect(Number(left.rows[0].n)).toBe(0);
});

/** Hold row locks in another transaction until the returned release() runs. */
const holdLock = async (sql: string, params: unknown[]) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockedNow = new Promise<void>((resolve) => (locked = resolve));
  const tx = withTransaction(async (c) => {
    await c.query(sql, params);
    locked();
    await gate;
  });
  await lockedNow;
  return async () => {
    release();
    await tx;
  };
};

describe("deleteAccount (td-12bd33)", () => {
  it("deletes the account and what it owns, cancels its queued jobs and keeps finished ones as history", async () => {
    const admin = await account("admin", "admin");
    const target = await account("target");
    await query("INSERT INTO user_activity_day (user_id, day, feature) VALUES ($1, current_date, 'home')", [target.id]);
    await query(
      `INSERT INTO species_view_history (user_id, species_code, first_viewed_at, last_viewed_at)
       VALUES ($1, 'zzdelbird', now(), now())`,
      [target.id],
    );
    await query(
      "INSERT INTO species_view_receipts (user_id, visit_id, species_code) VALUES ($1, $2, 'zzdelbird')",
      [target.id, randomUUID()],
    );
    const done = await job(target.id, "load_hotspots", "succeeded");
    const queued = await job(target.id, "sync_lifelist", "pending");

    // Typed with stray case and spaces: still the same username.
    const r = await deleteAccount(admin.id, target.id, `  ${target.username.toUpperCase()} `);
    expect(r).toEqual({ ok: true, username: target.username, displayName: "Delete target", cancelledJobs: 1 });

    expect(await exists(target.id)).toBe(false);
    const owned = await query<{ n: number }>(
      `SELECT (SELECT count(*) FROM user_activity_day WHERE user_id = $1)
            + (SELECT count(*) FROM species_view_history WHERE user_id = $1)
            + (SELECT count(*) FROM species_view_receipts WHERE user_id = $1) AS n`,
      [target.id],
    );
    expect(Number(owned.rows[0].n)).toBe(0);
    expect(await jobRow(done)).toEqual({ status: "succeeded", requested_by: null });
    expect(await jobRow(queued)).toEqual({ status: "cancelled", requested_by: null });
    const ev = await query<{ details: Record<string, unknown> }>(
      "SELECT details FROM job_events WHERE job_id = $1 AND action = 'cancelled'",
      [queued],
    );
    expect(ev.rows[0].details).toMatchObject({ reason: "account_deleted", requestedBy: admin.id });

    // The job list still shows the history, credited to a deleted account.
    const listed = (await listJobs(500)).find((j) => String(j.id) === done);
    expect(listed).toMatchObject({ requested_by: null, requested_by_name: "a deleted account" });
  });

  it("never deletes the acting admin's own account", async () => {
    const admin = await account("self", "admin");
    expect(await deleteAccount(admin.id, admin.id, admin.username)).toEqual({ ok: false, reason: "self" });
    expect(await exists(admin.id)).toBe(true);
  });

  it("needs the exact username typed, and says when the account is already gone", async () => {
    const admin = await account("admin2", "admin");
    const target = await account("typo");
    expect(await deleteAccount(admin.id, target.id, `${target.username}x`)).toEqual({ ok: false, reason: "confirm" });
    expect(await deleteAccount(admin.id, target.id, "")).toEqual({ ok: false, reason: "confirm" });
    expect(await exists(target.id)).toBe(true);
    expect(await deleteAccount(admin.id, 2_000_000_000, "nobody")).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an account a viewer displays, naming the viewers", async () => {
    const admin = await account("admin3", "admin");
    const owner = await account("owner");
    await account("viewb", "viewer", owner.id);
    await account("viewa", "viewer", owner.id);
    expect(await deleteAccount(admin.id, owner.id, owner.username)).toEqual({
      ok: false,
      reason: "viewers",
      viewers: ["Delete viewa", "Delete viewb"],
    });
    expect(await exists(owner.id)).toBe(true);
  });

  it("refuses while one of the account's jobs is running, and touches none of them", async () => {
    const admin = await account("admin4", "admin");
    const target = await account("busy");
    const running = await job(target.id, "sync_lifelist", "running");
    const queued = await job(target.id, "load_hotspots", "pending");
    expect(await deleteAccount(admin.id, target.id, target.username)).toEqual({ ok: false, reason: "running" });
    expect(await exists(target.id)).toBe(true);
    expect(await jobRow(running)).toEqual({ status: "running", requested_by: target.id });
    expect(await jobRow(queued)).toEqual({ status: "pending", requested_by: target.id });
  });

  it("refuses the account that owns the scheduled background jobs", async () => {
    const admin = await account("admin5", "admin");
    const target = await account("sched", "admin");
    const recurring = await job(target.id, "tag_consistency", "pending");
    expect(await deleteAccount(admin.id, target.id, target.username)).toEqual({ ok: false, reason: "system_jobs" });
    expect(await exists(target.id)).toBe(true);
    expect(await jobRow(recurring)).toEqual({ status: "pending", requested_by: target.id });
  });

  it.each([
    ["a row its delete cascades to", "SELECT 1 FROM user_activity_day WHERE user_id = $1 FOR UPDATE"],
    ["a finished job it keeps as history", "SELECT 1 FROM jobs WHERE requested_by = $1 AND status = 'succeeded' FOR UPDATE"],
  ])("gives up quickly as busy, changing nothing, when %s is locked elsewhere", async (_what, lockSql) => {
    const admin = await account(`admin6${_what.length}`, "admin");
    const target = await account(`locked${_what.length}`);
    await query("INSERT INTO user_activity_day (user_id, day, feature) VALUES ($1, current_date, 'home')", [target.id]);
    await job(target.id, "load_hotspots", "succeeded");
    const queued = await job(target.id, "sync_lifelist", "pending");
    const release = await holdLock(lockSql, [target.id]);
    try {
      const t0 = Date.now();
      const r = await deleteAccount(admin.id, target.id, target.username, { lockTimeoutMs: 300, txTimeoutMs: 5_000 });
      expect(r).toEqual({ ok: false, reason: "busy" });
      expect(Date.now() - t0).toBeLessThan(4_000);
    } finally {
      await release();
    }
    expect(await exists(target.id)).toBe(true);
    expect(await jobRow(queued)).toEqual({ status: "pending", requested_by: target.id });
  });

  it("the database itself refuses to leave a live job without its requester (0087)", async () => {
    const target = await account("net");
    const queued = await job(target.id, "sync_lifelist", "pending");
    await expect(query("DELETE FROM users WHERE id = $1", [target.id])).rejects.toMatchObject({ code: "23514" });
    expect(await exists(target.id)).toBe(true);
    expect(await jobRow(queued)).toEqual({ status: "pending", requested_by: target.id });
  });
});

/**
 * Stuck pages (td-1cb094) against birds_test. Every row belongs to a fixture
 * user this file creates (unique username) and deletes; its rows go with it
 * (ON DELETE CASCADE), and the test checks none are left.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { MAX_EVENTS_PER_USER_DAY, type StallEvent } from "$lib/client-stalls";
import { pruneHistory } from "$server/jobs";
import { clientStallsReport, recordClientStalls } from "$server/client-stalls";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
const USERNAME = `zz_stalls_${tag}`;
const ROUTE = `/zzstalls_${tag}/[code]`;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/27.0.1 Mobile/15E148 Safari/604.1";
let userId = 0;

const ev = (over: Partial<StallEvent> = {}): StallEvent => ({
  id: randomUUID(),
  kind: "unfinished",
  occurredAt: Date.now() - 60_000,
  fromRoute: "/species/[code]",
  toRoute: ROUTE,
  toPath: `/zzstalls_${tag}/blugrb1`,
  navType: "link",
  stage: "data",
  waitedMs: 25_300,
  dataMs: 300,
  aliveMs: 25_000,
  hiddenMs: 25_000,
  errors: ["TypeError: x"],
  standalone: true,
  online: true,
  version: "testver",
  ...over,
});

describe.skipIf(!dbUp)("client_stalls on birds_test", () => {
  beforeAll(async () => {
    const r = await query<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $1, 'x', 'viewer') RETURNING id`,
      [USERNAME],
    );
    userId = r.rows[0].id;
  });

  afterAll(async () => {
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
    const left = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM client_stalls WHERE user_id = $1`, [userId]);
    expect(left.rows[0].n).toBe(0);
  });

  it("stores each report once, with the device from the request", async () => {
    const e = ev();
    expect(await recordClientStalls(userId, UA, [e, ev({ kind: "freeze", stage: null, navType: null, dataMs: null, aliveMs: null, hiddenMs: null, errors: [] })])).toBe(2);
    expect(await recordClientStalls(userId, UA, [e])).toBe(0);
    const r = await query(
      `SELECT kind, to_route, to_path, nav_type, stage, waited_ms, data_ms, alive_ms, hidden_ms, errors, standalone, device, version
         FROM client_stalls WHERE event_id = $1`,
      [e.id],
    );
    expect(r.rows[0]).toEqual({
      kind: "unfinished",
      to_route: ROUTE,
      to_path: `/zzstalls_${tag}/blugrb1`,
      nav_type: "link",
      stage: "data",
      waited_ms: 25_300,
      data_ms: 300,
      alive_ms: 25_000,
      hidden_ms: 25_000,
      errors: ["TypeError: x"],
      standalone: true,
      device: UA,
      version: "testver",
    });
  });

  it("shows the reports with the account name, and counts them per page over 7 days", async () => {
    const report = await clientStallsReport();
    const mine = report.recent.filter((r) => r.toRoute === ROUTE);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ user: USERNAME, device: UA });
    expect(report.routes.find((r) => r.route === ROUTE)).toMatchObject({
      total: 2,
      byKind: { slow: 0, superseded: 0, unfinished: 1, lost: 0, freeze: 1 },
      worstWaitedMs: 25_300,
    });
    expect(report.retentionDays).toBe(30);
  });

  it("drops reports past the daily cap for one account", async () => {
    await query(
      `INSERT INTO client_stalls (event_id, occurred_at, user_id, kind, waited_ms, standalone, online, device, version)
       SELECT gen_random_uuid(), NOW(), $1, 'freeze', 2000, false, true, 'x', 'testver' FROM generate_series(1, $2)`,
      [userId, MAX_EVENTS_PER_USER_DAY - 3],
    );
    expect(await recordClientStalls(userId, UA, [ev(), ev()])).toBe(1);
    expect(await recordClientStalls(userId, UA, [ev()])).toBe(0);
  });

  it("holds the cap when posts arrive at the same time", async () => {
    await query(`DELETE FROM client_stalls WHERE user_id = $1`, [userId]);
    await query(
      `INSERT INTO client_stalls (event_id, occurred_at, user_id, kind, waited_ms, standalone, online, device, version)
       SELECT gen_random_uuid(), NOW(), $1, 'freeze', 2000, false, true, 'x', 'testver' FROM generate_series(1, $2)`,
      [userId, MAX_EVENTS_PER_USER_DAY - 1],
    );
    const written = await Promise.all([1, 2, 3, 4].map(() => recordClientStalls(userId, UA, [ev(), ev()])));
    expect(written.reduce((a, n) => a + n, 0)).toBe(1);
    const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM client_stalls WHERE user_id = $1`, [userId]);
    expect(r.rows[0].n).toBe(MAX_EVENTS_PER_USER_DAY);
  });

  it("prunes reports older than 30 days", async () => {
    const old = ev();
    await query(
      `INSERT INTO client_stalls (event_id, occurred_at, user_id, kind, waited_ms, standalone, online, device, version)
       VALUES ($1, NOW() - interval '31 days', $2, 'lost', 0, false, true, 'x', 'testver')`,
      [old.id, userId],
    );
    await pruneHistory({ clientStallUserIds: [userId] });
    const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM client_stalls WHERE event_id = $1`, [old.id]);
    expect(r.rows[0].n).toBe(0);
    const kept = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM client_stalls WHERE user_id = $1`, [userId]);
    expect(kept.rows[0].n).toBeGreaterThan(0);
  });
});

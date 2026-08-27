/**
 * trip-shares (td-8b959f follow-up). Load-bearing pins: ownership before any
 * write (this module decides who can see a trip), transactional regenerate,
 * and revoked tokens being dead at the SQL level.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbCalls: { text: string; params: unknown[] }[] = [];
let queryHandler: (text: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number } =
  () => ({ rows: [] });
let txDepth = 0;

async function record(text: string, params?: unknown[]) {
  dbCalls.push({ text, params: params ?? [] });
  return queryHandler(text, params);
}

vi.mock("$lib/db", () => ({
  query: (text: string, params?: unknown[]) => record(text, params),
  withTransaction: async (fn: (client: { query: typeof record }) => Promise<unknown>) => {
    txDepth++;
    try {
      return await fn({
        query: async (text: string, params?: unknown[]) => {
          dbCalls.push({ text: `[tx]${text}`, params: params ?? [] });
          return queryHandler(text, params);
        },
      });
    } finally {
      txDepth--;
    }
  },
}));

import { createShare, getActiveShare, revokeShare, tripForToken } from "./trip-shares";

beforeEach(() => {
  dbCalls.length = 0;
  txDepth = 0;
  queryHandler = () => ({ rows: [] });
});

describe("createShare", () => {
  it("PINNED (ownership): a trip that isn't the caller's → null with ZERO writes", async () => {
    queryHandler = (text) =>
      text.includes("FROM trips WHERE") ? { rows: [] } : { rows: [{}] };
    const token = await createShare(2, 7);
    expect(token).toBeNull();
    expect(dbCalls.filter((c) => /INSERT|UPDATE/i.test(c.text))).toHaveLength(0);
  });

  it("regenerate = revoke old + insert new, INSIDE a transaction, 43-char base64url token", async () => {
    queryHandler = () => ({ rows: [{ 1: 1 }] });
    const token = await createShare(1, 7);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    const revoke = dbCalls.find((c) => c.text.includes("SET revoked_at"));
    const insert = dbCalls.find((c) => c.text.includes("INSERT INTO trip_shares"));
    expect(revoke?.text.startsWith("[tx]")).toBe(true);
    expect(insert?.text.startsWith("[tx]")).toBe(true);
    expect(insert?.params).toEqual([token, 7]);
    // and revoke came before insert (the partial unique index demands it)
    expect(dbCalls.indexOf(revoke!)).toBeLessThan(dbCalls.indexOf(insert!));
  });

  it("two creates yield different tokens", async () => {
    queryHandler = () => ({ rows: [{ 1: 1 }] });
    const a = await createShare(1, 7);
    const b = await createShare(1, 7);
    expect(a).not.toBe(b);
  });
});

describe("reads and revocation", () => {
  it("getActiveShare joins trips on user_id and filters revoked", async () => {
    queryHandler = () => ({ rows: [{ token: "t", created_at: "2026-08-27" }] });
    await getActiveShare(1, 7);
    const sql = dbCalls[0].text;
    expect(sql).toContain("t.user_id = $2");
    expect(sql).toContain("revoked_at IS NULL");
  });

  it("revokeShare joins on user_id; false when nothing was active", async () => {
    queryHandler = () => ({ rows: [], rowCount: 0 });
    expect(await revokeShare(1, 7)).toBe(false);
    expect(dbCalls[0].text).toContain("t.user_id = $2");
    queryHandler = () => ({ rows: [], rowCount: 1 });
    expect(await revokeShare(1, 7)).toBe(true);
  });

  it("PINNED: tripForToken only resolves ACTIVE tokens (revoked filtered in SQL)", async () => {
    queryHandler = () => ({ rows: [] });
    expect(await tripForToken("dead")).toBeNull();
    expect(dbCalls[0].text).toContain("s.revoked_at IS NULL");
    expect(dbCalls[0].params).toEqual(["dead"]);
  });
});

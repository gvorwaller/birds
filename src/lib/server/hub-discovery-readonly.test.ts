import { describe, expect, it, vi } from "vitest";
import { loadTestEnv, requireTestDb } from "$server/testing/test-env";

/**
 * Phase 8B: discovery causes zero database writes and zero jobs. Proven at the
 * statement level, so it cannot race with other suites' fixtures: every SQL
 * statement the service sends is recorded and must be a read.
 */
const sent = vi.hoisted(() => ({ sql: [] as string[], transactions: 0 }));
vi.mock("$lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/db")>();
  return {
    ...actual,
    query: (text: string, params?: unknown[]) => {
      sent.sql.push(text);
      return (actual.query as (t: string, p?: unknown[]) => Promise<unknown>)(text, params);
    },
    withTransaction: (...args: unknown[]) => {
      sent.transactions += 1;
      return (actual.withTransaction as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

import { query } from "$lib/db";
import { hubDiscover } from "$server/hub-discovery";

loadTestEnv();
await requireTestDb(query as unknown as (sql: string) => Promise<unknown>);

const WRITE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|NOTIFY|LISTEN|VACUUM|LOCK|MERGE|CALL)\b/i;

describe("Hotspots & data discovery is read-only", () => {
  it("sends only SELECT statements, opens no transaction and touches no job across typed, map and paged searches", async () => {
    sent.sql.length = 0;
    sent.transactions = 0;
    await hubDiscover({ mode: "typed", find: "Sarasota", page: 1 });
    await hubDiscover({ mode: "typed", find: "Florida", page: 2 });
    await hubDiscover({ mode: "typed", find: "US-FL", page: 1 });
    await hubDiscover({ mode: "typed", find: "z", page: 1 });
    await hubDiscover({ mode: "map", place: "Myakka River SP", lat: 27.240503, lng: -82.314817, dist: 25, page: 1 });
    await hubDiscover({ mode: "map", place: "Nemo", lat: -48.87, lng: -123.39, dist: 200, page: 1 });
    expect(sent.sql.length).toBeGreaterThan(10); // the recorder really saw the service's queries
    for (const statement of sent.sql) {
      expect(statement.trim(), statement.slice(0, 80)).toMatch(/^(WITH|SELECT)\b/i);
      // Column/alias names may contain a keyword as a word inside a string literal; strip literals first.
      expect(statement.replace(/'[^']*'/g, "''"), statement.slice(0, 80)).not.toMatch(WRITE);
      expect(statement).not.toMatch(/\bjobs\b/i);
    }
    expect(sent.transactions).toBe(0);
  });
});

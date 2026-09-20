import { describe, expect, it, vi } from "vitest";
import { guardEbird } from "$server/testing/ebird-guard";
import { loadTestEnv, requireTestDb } from "$server/testing/test-env";

/**
 * Phase 9A: choosing All / Need / Seen is a read scope. Across every scope and
 * filter combination the Field Guide loader sends only reads (recorded at the
 * statement level, so it cannot race other suites), opens no transaction, queues
 * no job, and makes no eBird request, even for an account with an API key.
 */
const sent = vi.hoisted(() => ({ sql: [] as string[], transactions: 0, ebird: [] as string[] }));
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
vi.mock("$server/ebird", async (importOriginal) =>
  guardEbird(await importOriginal<Record<string, unknown>>(), sent.ebird, "placeholder-key"),
);

import { query } from "$lib/db";
import { load } from "./+page.server";

loadTestEnv();
await requireTestDb(query as unknown as (sql: string) => Promise<unknown>);

const WRITE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|NOTIFY|LISTEN|VACUUM|LOCK|MERGE|CALL)\b/i;

describe("All / Need / Seen list scope is read-only", () => {
  it("sends only reads, opens no transaction, queues no job and calls no eBird across scopes and filters", async () => {
    const admin = (await query<{ id: number }>("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id;
    const event = (path: string) =>
      ({
        locals: { scopeId: admin, user: { id: admin, role: "admin", views_user_id: null } },
        depends: () => {},
        url: new URL(`http://localhost${path}`),
      }) as unknown as Parameters<typeof load>[0];
    sent.sql.length = 0;
    sent.transactions = 0;
    sent.ebird.length = 0;
    for (const list of ["all", "need", "seen"]) {
      for (const filters of [
        "",
        "&q=warbler",
        "&country=US&region=US-FL",
        "&country=US&region=US-FL&county=US-FL-115",
        "&place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25",
        "&interest=1&sort=name&page=1",
      ])
        await load(event(`/species?list=${list}${filters}`));
    }
    expect(sent.sql.length).toBeGreaterThan(30); // the recorder saw the loader's real queries
    for (const statement of sent.sql) {
      expect(statement.trim(), statement.slice(0, 80)).toMatch(/^(WITH|SELECT)\b/i);
      expect(statement.replace(/'[^']*'/g, "''"), statement.slice(0, 80)).not.toMatch(WRITE);
      expect(statement).not.toMatch(/\bjobs\b/i);
    }
    expect(sent.transactions).toBe(0);
    expect(sent.ebird).toEqual([]);
  }, 120_000);
});

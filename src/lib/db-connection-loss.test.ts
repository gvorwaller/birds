/**
 * td-894144 (prod job 6985): pg-pool removes its own 'error' listener while a
 * client is checked out, so a server-side end of the session mid-transaction
 * (there: the tag engine's SET LOCAL transaction_timeout) emitted 'error' with
 * no listener and crashed the whole worker process. The call must reject
 * instead, and the pool must keep working. Reproduced the prod way: a short
 * transaction_timeout, then a statement that outlives it.
 */
import { describe, expect, it } from "vitest";
import { query, withReadSnapshot, withTransaction } from "$lib/db";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const outliveTimeout = async (c: { query: (sql: string) => Promise<unknown> }) => {
  await c.query("SET LOCAL transaction_timeout = '300ms'");
  await c.query("SELECT pg_sleep(2)");
};

describe.runIf(dbUp)("a session the server ends mid-transaction", () => {
  it("withTransaction rejects instead of crashing the process; the pool still works", async () => {
    await expect(withTransaction(outliveTimeout)).rejects.toThrow();
    expect((await query<{ one: number }>("SELECT 1 AS one")).rows[0].one).toBe(1);
  });

  it("withReadSnapshot rejects instead of crashing the process; the pool still works", async () => {
    await expect(withReadSnapshot(outliveTimeout)).rejects.toThrow();
    expect((await query<{ one: number }>("SELECT 1 AS one")).rows[0].one).toBe(1);
  });
});

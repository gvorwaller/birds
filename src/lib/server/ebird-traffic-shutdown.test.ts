/**
 * td-009031: a clean shutdown waits for a flush already writing. The
 * database write is held open by a mock, so the order is forced, not raced.
 */
import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const writes: unknown[][] = [];
  return {
    release: () => release(),
    writes,
    queryTimed: vi.fn(async (_sql: string, params: unknown[]) => {
      writes.push(params);
      if (writes.length === 1) await gate;
      return { rows: [], rowCount: 0 };
    }),
  };
});
vi.mock("$lib/db", () => ({ queryTimed: db.queryTimed, query: vi.fn() }));

import {
  flushEbirdTraffic,
  flushEbirdTrafficOnShutdown,
  pendingTrafficForTests,
  recordEbirdTraffic,
} from "$server/ebird-traffic";

describe("shutdown flush", () => {
  it("waits for the write already running, then writes what is left", async () => {
    recordEbirdTraffic("taxonomy", "ok", 1, 1);
    const periodic = flushEbirdTraffic(); // takes the tally, then blocks on the gate
    expect(pendingTrafficForTests()).toHaveLength(0);
    recordEbirdTraffic("region/list", "ok", 1, 1);

    let done = false;
    const shutdown = flushEbirdTrafficOnShutdown().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false); // still waiting on the first write

    db.release();
    await Promise.all([periodic, shutdown]);
    expect(done).toBe(true);
    expect(db.writes).toHaveLength(2);
    expect((db.writes[1][1] as string[])).toEqual(["region/list"]);
    expect(pendingTrafficForTests()).toHaveLength(0);
  });
});

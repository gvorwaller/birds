/**
 * queryTimed's acquisition-bounding mechanism (CODEX1: pg query_timeout only
 * arms inside Client.query — pool CHECKOUT can wait forever). Exercised with
 * a mocked pg Pool so the stall shapes are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => {
  const state = {
    connectImpl: null as null | (() => Promise<unknown>),
    released: [] as unknown[],
  };
  class FakePool {
    connect() {
      return state.connectImpl!();
    }
    query() {
      throw new Error("plain pool.query not under test");
    }
  }
  return { state, FakePool };
});

vi.mock("pg", () => ({
  default: { Pool: pgMock.FakePool },
}));

const { queryTimed } = await import("./db");

function makeClient() {
  return {
    query: vi.fn<(cfg: unknown) => Promise<{ rows: unknown[] }>>(async () => ({
      rows: [{ ok: 1 }],
    })),
    release: vi.fn<(err?: unknown) => void>((err?: unknown) =>
      pgMock.state.released.push(err ?? "clean"),
    ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  pgMock.state.released.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("queryTimed", () => {
  it("REJECTS within the deadline when pool acquisition never settles", async () => {
    pgMock.state.connectImpl = () => new Promise(() => {}); // checkout stall
    const p = queryTimed("SELECT 1", [], 5_000).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(5_100);
    const err = (await p) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/pool acquisition exceeded 5000ms/);
  });

  it("a LATE-arriving client after the deadline is released clean, never queried", async () => {
    const client = makeClient();
    let arrive!: () => void;
    pgMock.state.connectImpl = () =>
      new Promise((resolve) => {
        arrive = () => resolve(client);
      });
    const p = queryTimed("SELECT 1", [], 2_000).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await p).toBeInstanceOf(Error);
    // The checkout completes AFTER the caller gave up…
    arrive();
    await vi.advanceTimersByTimeAsync(1);
    // …and the client goes straight back: released with NO error (reusable),
    // and its query() was never invoked.
    expect(client.release).toHaveBeenCalledWith();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("happy path: query gets the REMAINING interval as query_timeout; clean release", async () => {
    const client = makeClient();
    pgMock.state.connectImpl = async () => client;
    const r = await queryTimed("SELECT 1", ["a"], 8_000);
    expect(r.rows).toEqual([{ ok: 1 }]);
    const cfg = client.query.mock.calls[0][0] as { query_timeout: number };
    expect(cfg.query_timeout).toBeGreaterThan(0);
    expect(cfg.query_timeout).toBeLessThanOrEqual(8_000);
    expect(client.release.mock.calls[0][0]).toBeUndefined(); // clean release
  });

  it("query error/timeout DESTROYS the client (release with error), never reuses it", async () => {
    const client = makeClient();
    client.query.mockRejectedValueOnce(new Error("Query read timeout"));
    pgMock.state.connectImpl = async () => client;
    await expect(queryTimed("SELECT 1", [], 3_000)).rejects.toThrow(/read timeout/);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

import { describe, expect, it } from "vitest";
import { RegionDetailLoader, type RegionDetailState } from "./region-detail-loader";

type Pending = { code: string; resolve: (v: string) => void; reject: (e: Error) => void; signal: AbortSignal };

function setup(version = "v1", timeoutMs = 30_000) {
  const pending: Pending[] = [];
  let state: RegionDetailState<string> = { details: {}, failed: [] };
  const loader = new RegionDetailLoader<string>(
    version,
    () => state,
    (patch) => (state = { ...state, ...patch }),
    (code, _name, signal) => new Promise((resolve, reject) => pending.push({ code, resolve, reject, signal })),
    timeoutMs,
  );
  return { loader, pending, get state() { return state; } };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RegionDetailLoader (td-fb6948)", () => {
  it("keeps every group when many answers arrive out of order", async () => {
    const t = setup();
    const codes = ["NO", "NO-18", "NO-03", "IL", "US-FL"];
    const loads = codes.map((c) => t.loader.load(c, c));
    // Answer in reverse order, interleaved with the event loop like real bodies.
    for (const p of [...t.pending].reverse()) { p.resolve(`rows:${p.code}`); await flush(); }
    await Promise.all(loads);
    expect(Object.keys(t.state.details).sort()).toEqual([...codes].sort());
    expect(t.state.details["NO-18"]).toBe("rows:NO-18");
  });

  it("asks once per group while it is loading or loaded", async () => {
    const t = setup();
    const a = t.loader.load("NO-18", "Nordland");
    void t.loader.load("NO-18", "Nordland");
    expect(t.pending).toHaveLength(1);
    t.pending[0].resolve("rows");
    await a;
    await t.loader.load("NO-18", "Nordland");
    expect(t.pending).toHaveLength(1);
  });

  it("records a failure (HTTP, network or timeout) and lets Retry ask again", async () => {
    const t = setup();
    const first = t.loader.load("NO-18", "Nordland");
    t.pending[0].reject(new Error("503"));
    await first;
    expect(t.state.failed).toEqual(["NO-18"]);
    expect(t.state.details).toEqual({});
    const retry = t.loader.load("NO-18", "Nordland");
    expect(t.state.failed).toEqual([]); // the failure clears while retrying
    t.pending[1].resolve("rows");
    await retry;
    expect(t.state).toEqual({ details: { "NO-18": "rows" }, failed: [] });
  });

  it("gives each request a timeout signal", async () => {
    const t = setup("v1", 20);
    void t.loader.load("NO-18", "Nordland");
    await new Promise((r) => setTimeout(r, 60));
    expect(t.pending[0].signal.aborted).toBe(true);
  });

  it("drops an answer to a request made before the loaded data changed, and loads afresh", async () => {
    const t = setup("v1");
    const old = t.loader.load("NO-18", "Nordland");
    t.loader.setVersion("v2"); // a load finished: rows may differ now
    const fresh = t.loader.load("NO-18", "Nordland");
    expect(t.pending).toHaveLength(2); // the reset let the new data be asked for
    t.pending[1].resolve("new rows");
    await fresh;
    t.pending[0].resolve("old rows"); // the old answer lands last
    await old;
    expect(t.state.details["NO-18"]).toBe("new rows");
  });

  it("an old failure after the change neither shows nor unblocks a duplicate request", async () => {
    const t = setup("v1");
    const old = t.loader.load("NO-18", "Nordland");
    t.loader.setVersion("v2");
    const fresh = t.loader.load("NO-18", "Nordland");
    t.pending[0].reject(new Error("aborted"));
    await old;
    expect(t.state.failed).toEqual([]);
    void t.loader.load("NO-18", "Nordland"); // still loading under v2: no third request
    expect(t.pending).toHaveLength(2);
    t.pending[1].resolve("new rows");
    await fresh;
    expect(t.state.details["NO-18"]).toBe("new rows");
  });

  it("setVersion with the same version keeps everything", async () => {
    const t = setup("v1");
    const a = t.loader.load("NO-18", "Nordland");
    t.pending[0].resolve("rows");
    await a;
    t.loader.setVersion("v1");
    expect(t.state.details["NO-18"]).toBe("rows");
    t.loader.setVersion("v2");
    expect(t.state).toEqual({ details: {}, failed: [] });
  });
});

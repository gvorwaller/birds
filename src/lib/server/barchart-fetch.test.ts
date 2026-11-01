/**
 * td-534b33: the default bar-chart download asks eBird with the longer
 * BARCHART_FETCH_TIMEOUT_MS and a short-lived signal linked to the caller's,
 * so a drain cuts it off. fetchAuthenticatedEbird is stubbed: no network.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/db", () => ({
  query: async () => ({ rows: [] }),
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: async () => ({ rows: [] }) }),
}));

const calls: { url: string; opts?: { timeout?: number; signal?: AbortSignal } }[] = [];
let respond: (signal?: AbortSignal) => Promise<string> = async () => {
  throw new Error("eBird returned HTTP 400 for this request.");
};
vi.mock("$server/ebird-account", async (importActual) => ({
  ...(await importActual<typeof import("./ebird-account")>()),
  fetchAuthenticatedEbird: vi.fn(
    async (_userId: number, url: string, opts?: { timeout?: number; signal?: AbortSignal }) => {
      calls.push({ url, opts });
      return respond(opts?.signal);
    },
  ),
}));

const { BARCHART_FETCH_TIMEOUT_MS, ensureFrequencies } = await import("./barchart");

const loc = { code: "L3499263", kind: "hotspot" as const, name: "Everglades NP" };

describe("default bar-chart download (td-534b33)", () => {
  it("allows 120 seconds instead of the usual 30", async () => {
    calls.length = 0;
    await ensureFrequencies(1, [loc], { sleep: async () => {}, force: true });
    expect(BARCHART_FETCH_TIMEOUT_MS).toBe(120_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("L3499263");
    expect(calls[0].opts?.timeout).toBe(BARCHART_FETCH_TIMEOUT_MS);
  });

  it("aborts the download in flight when the caller's signal aborts", async () => {
    calls.length = 0;
    const drain = new AbortController();
    let downloadSignal: AbortSignal | undefined;
    respond = (signal) =>
      new Promise((_resolve, reject) => {
        downloadSignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
        drain.abort();
      });
    const result = await ensureFrequencies(1, [loc], {
      sleep: async () => {},
      force: true,
      abortSignal: drain.signal,
    });
    // Its own signal, not the drain signal itself, and it was aborted.
    expect(downloadSignal).toBeDefined();
    expect(downloadSignal).not.toBe(drain.signal);
    expect(downloadSignal?.aborted).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.notAttempted).toEqual(["L3499263"]);
  });
});

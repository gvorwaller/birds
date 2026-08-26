/**
 * app-config semantics (td-015838). The load-bearing case is GROK P0-1:
 * "DB error → compiled default" would silently re-price a drain at Opus rates
 * after the admin selected Haiku. These tests pin last-known-good instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbCalls: { fn: "query" | "queryTimed"; text: string; params: unknown[] }[] = [];
let queryHandler: (text: string) => { rows: unknown[] } | undefined = () => undefined;
let queryTimedHandler: (text: string) => { rows: unknown[] } | undefined = () => undefined;

vi.mock("$lib/db", () => ({
  query: async (text: string, params?: unknown[]) => {
    dbCalls.push({ fn: "query", text, params: params ?? [] });
    const r = queryHandler(text);
    if (r === undefined) throw new Error("query: unexpected in this test");
    return r;
  },
  queryTimed: async (text: string, params: unknown[] | undefined, timeoutMs: number) => {
    dbCalls.push({ fn: "queryTimed", text, params: params ?? [] });
    if (!(timeoutMs > 0)) throw new Error("queryTimed called without a positive timeout");
    const r = queryTimedHandler(text);
    if (r === undefined) throw new Error("simulated db failure");
    return r;
  },
}));

import { CONFIG_KEYS, _resetConfigCacheForTests, getConfig, setConfig } from "./app-config";

const KEY = CONFIG_KEYS.enrichmentModel;
const OPUS = { provider: "anthropic", model: "claude-opus-5" };
const HAIKU = { provider: "anthropic", model: "claude-haiku-4-5" };

beforeEach(() => {
  _resetConfigCacheForTests();
  dbCalls.length = 0;
  queryHandler = () => undefined;
  queryTimedHandler = () => undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getConfig", () => {
  it("returns the stored value, reading through queryTimed (a hung pool.query would wedge the worker with no throw)", async () => {
    queryTimedHandler = () => ({ rows: [{ value: HAIKU }] });
    const v = await getConfig(KEY, OPUS);
    expect(v).toEqual(HAIKU);
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].fn).toBe("queryTimed"); // never plain query on the read path
    expect(dbCalls[0].params).toEqual([KEY]);
  });

  it("absent row → compiled default (no seed rows: absence MEANS default)", async () => {
    queryTimedHandler = () => ({ rows: [] });
    expect(await getConfig(KEY, OPUS)).toEqual(OPUS);
  });

  it("PINNED (GROK P0-1): after a successful Haiku read, a DB blip returns HAIKU, not the compiled Opus default", async () => {
    queryTimedHandler = () => ({ rows: [{ value: HAIKU }] });
    await getConfig(KEY, OPUS);
    queryTimedHandler = () => undefined; // every read now fails
    // The inversion this guards: compiled default is Opus 5 at 5x the price —
    // falling back to it would re-price the rest of a drain while the
    // dropdown still shows Haiku.
    expect(await getConfig(KEY, OPUS)).toEqual(HAIKU);
    expect(await getConfig(KEY, OPUS)).toEqual(HAIKU); // stays sticky, not one-shot
  });

  it("compiled default applies ONLY when no read has ever succeeded in this process", async () => {
    queryTimedHandler = () => undefined;
    expect(await getConfig(KEY, OPUS)).toEqual(OPUS);
  });

  it("an absent-row read is a SUCCESSFUL read: it seeds last-known-good with the default", async () => {
    queryTimedHandler = () => ({ rows: [] });
    await getConfig(KEY, HAIKU);
    queryTimedHandler = () => undefined;
    expect(await getConfig(KEY, HAIKU)).toEqual(HAIKU);
  });

  it("never throws on read failure", async () => {
    queryTimedHandler = () => undefined;
    await expect(getConfig(KEY, OPUS)).resolves.toEqual(OPUS);
  });
});

describe("setConfig", () => {
  it("rejects unknown keys (a typo'd key would persist silently forever)", async () => {
    await expect(setConfig("ai.model.enrichmnet", OPUS)).rejects.toThrow(/unknown key/);
    expect(dbCalls).toHaveLength(0);
  });

  it("rejects unknown and non-selectable model ids, and malformed values", async () => {
    for (const bad of [
      { provider: "anthropic", model: "claude-nonexistent-9" },
      { provider: "anthropic", model: "claude-opus-4-8" }, // pricing-only, never selectable
      { provider: "openai", model: "claude-opus-5" },
      { provider: "anthropic" },
      "claude-opus-5",
      null,
    ]) {
      await expect(setConfig(KEY, bad)).rejects.toThrow(/app-config/);
    }
    expect(dbCalls).toHaveLength(0); // validation happens before any write
  });

  it("upserts a valid value and updates last-known-good (a later blip cannot resurrect the pre-write value)", async () => {
    queryHandler = () => ({ rows: [] });
    await setConfig(KEY, HAIKU);
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].text).toContain("ON CONFLICT (key) DO UPDATE");
    expect(dbCalls[0].params).toEqual([KEY, JSON.stringify(HAIKU)]);
    queryTimedHandler = () => undefined; // reads fail from here on
    expect(await getConfig(KEY, OPUS)).toEqual(HAIKU);
  });

  it("THROWS on DB write failure — admin actions want the error, unlike hot-path reads", async () => {
    queryHandler = () => undefined;
    await expect(setConfig(KEY, HAIKU)).rejects.toThrow();
  });

  it("guidance key validates the same way", async () => {
    queryHandler = () => ({ rows: [] });
    await setConfig(CONFIG_KEYS.guidanceModel, { provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(dbCalls).toHaveLength(1);
  });
});

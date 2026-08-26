/**
 * Guidance rewire tests (plan step 6): registry-built requests, envelope on
 * every post-response throw, and — the integration contract — exactly ONE
 * ledger call per API call through fieldTipsForTrip, on every outcome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbCalls: { fn: string; text: string; params: unknown[] }[] = [];
let queryHandler: (text: string) => { rows: unknown[] } | undefined = () => ({ rows: [] });
let queryTimedHandler: (text: string) => { rows: unknown[] } | undefined = () => ({ rows: [] });

vi.mock("$lib/db", () => ({
  query: async (text: string, params?: unknown[]) => {
    dbCalls.push({ fn: "query", text, params: params ?? [] });
    return queryHandler(text) ?? { rows: [] };
  },
  queryTimed: async (text: string, params?: unknown[]) => {
    dbCalls.push({ fn: "queryTimed", text, params: params ?? [] });
    return queryTimedHandler(text) ?? { rows: [] };
  },
}));

import { fieldTipsForTrip, generateFieldTips, GuidanceError } from "./ai-guidance";
import { SELECTABLE_MODELS } from "./ai-models";

// House pattern (xeno-canto.test.ts): the $env snapshot is a mutable POJO,
// and ~/.claude/settings.json blanks ANTHROPIC_API_KEY to "" in Claude Code
// subprocesses — write onto the snapshot directly.
const { env: dynamicEnv } = await import("$env/dynamic/private");
if (!dynamicEnv.ANTHROPIC_API_KEY) dynamicEnv.ANTHROPIC_API_KEY = "test-key";

const SONNET = SELECTABLE_MODELS.find((m) => m.id === "claude-sonnet-4-6")!;

const INPUT = {
  tripName: "Coastal loop",
  stops: [{ id: 7, name: "North Jetty", notes: "Marbled Godwit" }],
  weather: null,
  now: new Date("2026-08-26T12:00:00Z"),
};

const okBody = (over: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-4-6",
  stop_reason: "end_turn",
  usage: { input_tokens: 800, output_tokens: 120 },
  content: [{ type: "text", text: '[{"n": 1, "tip": "Try the outer flats on the early ebb."}]' }],
  ...over,
});
const resp = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "request-id": "req_guid_1", ...headers },
  });
const fetcherReturning = (r: Response) => {
  const calls: { init: RequestInit }[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    calls.push({ init: init ?? {} });
    return r;
  }) as typeof fetch;
  return { fetcher, calls };
};

beforeEach(() => {
  dbCalls.length = 0;
  queryHandler = () => ({ rows: [] });
  queryTimedHandler = () => ({ rows: [] });
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("generateFieldTips (unit, injected fetcher)", () => {
  it("Sonnet 4.6 request shape: no thinking key, answer budget IS max_tokens, no schema (free text is deliberate)", async () => {
    const { fetcher, calls } = fetcherReturning(resp(okBody()));
    const out = await generateFieldTips(INPUT, SONNET, { fetcher });
    expect(out.tips).toEqual({ 7: "Try the outer flats on the early ebb." });
    expect(out.envelope.requestId).toBe("req_guid_1");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.max_tokens).toBe(1500);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config"); // no structured outputs in v1
  });

  it("a refusal throws WITH an unbilled event envelope (the throw used to discard it)", async () => {
    const { fetcher } = fetcherReturning(
      resp(okBody({ stop_reason: "refusal", content: [], usage: { input_tokens: 700, output_tokens: 0 } })),
    );
    const err = await generateFieldTips(INPUT, SONNET, { fetcher }).catch((e) => e);
    expect(err).toBeInstanceOf(GuidanceError);
    expect(err.envelope.attempts[0].billed).toBe(false);
    expect(err.envelope.requestId).toBe("req_guid_1");
  });

  it("a malformed 200 (no JSON array) throws WITH the envelope carrying its real spend", async () => {
    const { fetcher } = fetcherReturning(
      resp(okBody({ content: [{ type: "text", text: "Sorry, here are your tips as prose…" }] })),
    );
    const err = await generateFieldTips(INPUT, SONNET, { fetcher }).catch((e) => e);
    expect(err).toBeInstanceOf(GuidanceError);
    expect(err.envelope.attempts[0].inputTokens).toBe(800); // billed even though unusable
  });

  it("a non-2xx throws WITH http_status + provider error.type + request-id", async () => {
    const { fetcher } = fetcherReturning(
      resp({ error: { type: "overloaded_error", message: "busy" } }, 529),
    );
    const err = await generateFieldTips(INPUT, SONNET, { fetcher }).catch((e) => e);
    expect(err).toBeInstanceOf(GuidanceError);
    expect(err.envelope.httpStatus).toBe(529);
    expect(err.envelope.providerErrorType).toBe("overloaded_error");
    expect(err.envelope.requestId).toBe("req_guid_1");
  });
});

describe("fieldTipsForTrip (integration: config → registry → call → ledger)", () => {
  const ledgerInserts = () => dbCalls.filter((c) => c.text.includes("INSERT INTO ai_usage"));

  it("success → tips returned, ONE ledger call with purpose 'guidance'", async () => {
    vi.stubGlobal("fetch", fetcherReturning(resp(okBody())).fetcher);
    const tips = await fieldTipsForTrip(INPUT);
    expect(tips).toEqual({ 7: "Try the outer flats on the early ebb." });
    const inserts = ledgerInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[2]).toBe("guidance"); // purpose
    expect(inserts[0].params[9]).toBe(true); // ok
  });

  it("malformed 200 → throws, ONE ledger call with ok=false and the billed tokens", async () => {
    vi.stubGlobal(
      "fetch",
      fetcherReturning(resp(okBody({ content: [{ type: "text", text: "prose only" }] }))).fetcher,
    );
    await expect(fieldTipsForTrip(INPUT)).rejects.toBeInstanceOf(GuidanceError);
    const inserts = ledgerInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[9]).toBe(false); // ok
    expect(inserts[0].params[15]).toEqual([800]); // input_tokens — real spend recorded
  });

  it("refusal → ONE ledger call whose attempt row is billed=false", async () => {
    vi.stubGlobal(
      "fetch",
      fetcherReturning(
        resp(okBody({ stop_reason: "refusal", content: [], usage: { input_tokens: 700, output_tokens: 0 } })),
      ).fetcher,
    );
    await expect(fieldTipsForTrip(INPUT)).rejects.toBeInstanceOf(GuidanceError);
    const inserts = ledgerInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[22]).toEqual([false]); // billed
  });

  it("non-2xx → ONE ledger call with http_status + provider_error_type, tokens NULL (unknown spend)", async () => {
    vi.stubGlobal(
      "fetch",
      fetcherReturning(resp({ error: { type: "overloaded_error" } }, 529)).fetcher,
    );
    await expect(fieldTipsForTrip(INPUT)).rejects.toBeInstanceOf(GuidanceError);
    const inserts = ledgerInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[6]).toBe(529); // http_status
    expect(inserts[0].params[7]).toBe("overloaded_error");
    expect(inserts[0].params[15]).toEqual([null]); // unknown spend, not $0
  });

  it("empty stop list → no API call, no ledger row (metering is per CALL, and no call happens)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tips = await fieldTipsForTrip({ ...INPUT, stops: [] });
    expect(tips).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledgerInserts()).toHaveLength(0);
  });

  it("the config dropdown drives the guidance model per call", async () => {
    queryTimedHandler = (text) =>
      text.includes("FROM app_config")
        ? { rows: [{ value: { provider: "anthropic", model: "claude-haiku-4-5" } }] }
        : { rows: [] };
    const { fetcher, calls } = fetcherReturning(resp(okBody({ model: "claude-haiku-4-5" })));
    vi.stubGlobal("fetch", fetcher);
    await fieldTipsForTrip(INPUT);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("claude-haiku-4-5");
    expect(ledgerInserts()[0].params[1]).toBe("claude-haiku-4-5"); // requested_model
  });
});

/**
 * Ledger recording + aggregation (td-09be7a). The load-bearing pins:
 * atomic single-statement chain insert (GROK P1-5), recordUsage never throws,
 * and the aggregate reader not reintroducing reported-vs-charged as a SELECT
 * (GROK P1-6 / P0-2).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallEnvelope } from "./ai-models";

const dbCalls: { fn: "query" | "queryTimed"; text: string; params: unknown[] }[] = [];
let queryHandler: (text: string, params?: unknown[]) => { rows: unknown[] } | undefined = () =>
  undefined;

vi.mock("$lib/db", () => ({
  query: async (text: string, params?: unknown[]) => {
    dbCalls.push({ fn: "query", text, params: params ?? [] });
    const r = queryHandler(text, params);
    if (r === undefined) throw new Error("simulated db failure");
    return r;
  },
  queryTimed: async (text: string, params?: unknown[]) => {
    dbCalls.push({ fn: "queryTimed", text, params: params ?? [] });
    const r = queryHandler(text, params);
    if (r === undefined) throw new Error("simulated db failure");
    return r;
  },
}));

import { recordUsage, usageAggregates, type UsageCall } from "./ai-usage";

const envelope = (over: Partial<CallEnvelope> = {}): CallEnvelope => ({
  attemptIndex: 0,
  attemptType: null,
  isFinal: true,
  servedModel: "claude-opus-5",
  stopReason: "end_turn",
  billed: true,
  inputTokens: 1000,
  outputTokens: 200,
  thinkingTokens: 50,
  cacheReadTokens: null,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  ...over,
});

const baseCall = (over: Partial<UsageCall> = {}): UsageCall => ({
  requestedModel: "claude-opus-5",
  purpose: "enrichment",
  speciesCode: "dowwoo",
  jobId: 42,
  ok: true,
  attempts: [envelope()],
  ...over,
});

beforeEach(() => {
  dbCalls.length = 0;
  queryHandler = () => ({ rows: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordUsage", () => {
  it("writes one INSERT with call_id minted inside the statement", async () => {
    await recordUsage(baseCall());
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].text).toContain("INSERT INTO ai_usage");
    expect(dbCalls[0].text).toContain("gen_random_uuid()");
    // arrays of length 1 for the single attempt
    expect(dbCalls[0].params[11]).toEqual([0]); // attempt_index
    expect(dbCalls[0].params[15]).toEqual([1000]); // input_tokens
  });

  it("uses a hard-deadline query so a stuck pool cannot wedge the metered call", async () => {
    await recordUsage(baseCall());
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].fn).toBe("queryTimed");
    expect(dbCalls[0].text).toContain("INSERT INTO ai_usage");
  });

  it("PINNED (GROK P1-5): a fallback chain is ONE statement — a partial chain can never exist (DELETE is revoked; repair is impossible)", async () => {
    await recordUsage(
      baseCall({
        attempts: [
          envelope({
            attemptIndex: 0,
            attemptType: "message",
            isFinal: false,
            billed: false,
            outputTokens: 0,
            inputTokens: 535,
          }),
          envelope({
            attemptIndex: 1,
            attemptType: "fallback_message",
            isFinal: true,
            servedModel: "claude-opus-4-8",
            inputTokens: 412,
            outputTokens: 264,
          }),
        ],
      }),
    );
    expect(dbCalls).toHaveLength(1); // not one insert per attempt
    expect(dbCalls[0].params[11]).toEqual([0, 1]);
    expect(dbCalls[0].params[14]).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    expect(dbCalls[0].params[22]).toEqual([false, true]); // billed per attempt
  });

  it("NEVER throws on DB failure — the metered call matters more than its receipt", async () => {
    queryHandler = () => undefined;
    await expect(recordUsage(baseCall())).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("does not retry on failure (a retry after a unique violation is how partial chains would sneak in)", async () => {
    queryHandler = () => undefined;
    await recordUsage(baseCall());
    expect(dbCalls).toHaveLength(1);
  });

  it("sanitizes error text before storage", async () => {
    await recordUsage(baseCall({ ok: false, error: "boom api_key=sk-ant-secret123 dead" }));
    const stored = dbCalls[0].params[10] as string;
    expect(stored).not.toContain("sk-ant-secret123");
    expect(stored).toContain("[redacted]");
  });

  it("empty attempts (network error / abort) → one event row with NULL tokens and billed=TRUE, so it prices to null and renders '—', never $0.00", async () => {
    await recordUsage(baseCall({ ok: false, error: "fetch failed", attempts: [] }));
    expect(dbCalls[0].params[11]).toEqual([0]);
    expect(dbCalls[0].params[15]).toEqual([null]); // input_tokens unknown
    expect(dbCalls[0].params[16]).toEqual([null]); // output_tokens unknown
    expect(dbCalls[0].params[22]).toEqual([true]); // spend UNKNOWN, not "free"
  });
});

describe("usageAggregates", () => {
  // Frozen clock: 2026-09-10T12:00Z → todayStart 09-10T00Z, d7Start 09-03T12Z,
  // d30Start 08-11T12Z. Chosen so a post-intro Sonnet 5 bucket (09-02) lands
  // inside d30 but outside d7 and today.
  const NOW = new Date("2026-09-10T12:00:00Z");
  const bucket = (iso: string) => new Date(iso);

  const group = (over: Record<string, unknown>) => ({
    bucket: bucket("2026-09-10T10:00:00Z"),
    served_model: "claude-opus-5",
    purpose: "enrichment",
    billed: true,
    priceable: true,
    attempts: 1,
    calls: 1,
    input_tokens: "0",
    output_tokens: "0",
    cache_read_tokens: "0",
    cache_write_5m_tokens: "0",
    cache_write_1h_tokens: "0",
    ...over,
  });

  const groups = [
    // (a) plain opus spend today: 1000 in + 200 out → $0.005 + $0.005 = $0.01
    group({ attempts: 2, calls: 2, input_tokens: "1000", output_tokens: "200" }),
    // (b) refusal event row: billed=false → $0, NOT unpriced
    group({ billed: false, input_tokens: "900", output_tokens: "0" }),
    // (c) abort: billed but NULL tokens → unpriced, excluded from dollars
    group({ priceable: false, purpose: "guidance" }),
    // (d) unknown served model → rate unavailable → unpriced, never NaN
    group({ served_model: "claude-mystery-9", input_tokens: "100", output_tokens: "10" }),
    // (e) Sonnet 5 INTRO window (bucket 08-20, in d30): 1M in → $2
    group({
      bucket: bucket("2026-08-20T00:00:00Z"),
      served_model: "claude-sonnet-5",
      input_tokens: "1000000",
    }),
    // (f) Sonnet 5 POST-intro window (bucket 09-02, in d30 not d7): 1M in → $3
    group({
      bucket: bucket("2026-09-02T00:00:00Z"),
      served_model: "claude-sonnet-5",
      input_tokens: "1000000",
    }),
  ];

  const chainAt = new Date("2026-09-10T09:00:00Z");
  const attemptRow = (over: Record<string, unknown>) => ({
    call_id: "c1",
    at: chainAt,
    attempt_index: 0,
    is_final: true,
    purpose: "enrichment",
    species_code: "dowwoo",
    requested_model: "claude-opus-5",
    served_model: "claude-opus-5",
    stop_reason: "end_turn",
    http_status: 200,
    duration_ms: 8000,
    input_tokens: 1000,
    output_tokens: 200,
    thinking_tokens: 50,
    cache_read_tokens: null,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    ok: true,
    billed: true,
    error: null,
    ...over,
  });

  function routeAggregates() {
    queryHandler = (text) => {
      if (text.includes("date_trunc('hour', at)")) return { rows: groups };
      if (text.includes("calls_today"))
        return { rows: [{ calls_today: 3, calls_7d: 5, calls_30d: 6, calls_all: 7 }] };
      if (text.includes("GROUP BY call_id ORDER BY MAX(at)"))
        return { rows: [{ call_id: "c1" }, { call_id: "c2" }] };
      if (text.includes("ANY($1::uuid[])"))
        return {
          rows: [
            // c1: fallback chain — unbilled declined primary + billed opus-4-8 final
            attemptRow({
              call_id: "c1",
              is_final: false,
              attempt_index: 0,
              billed: false,
              input_tokens: 535,
              output_tokens: 0,
              thinking_tokens: null,
            }),
            attemptRow({
              call_id: "c1",
              attempt_index: 1,
              served_model: "claude-opus-4-8",
              input_tokens: 412,
              output_tokens: 264,
              thinking_tokens: null,
            }),
            // c2: abort — NULL tokens, billed=true
            attemptRow({
              call_id: "c2",
              at: new Date("2026-09-10T08:00:00Z"),
              ok: false,
              input_tokens: null,
              output_tokens: null,
              thinking_tokens: null,
              stop_reason: null,
              http_status: null,
              error: "aborted",
            }),
          ],
        };
      if (text.includes("stop_reason AS key"))
        return { rows: [{ key: "end_turn", n: 40 }, { key: "refusal", n: 2 }] };
      if (text.includes("provider_error_type AS key"))
        return { rows: [{ key: "overloaded_error", n: 1 }] };
      return undefined;
    };
  }

  it("PINNED (GROK P1-6/P0-2): the pricing query has NO WHERE clause — no ok / is_final / distinct-call filter can drop billed spend", async () => {
    routeAggregates();
    await usageAggregates(NOW);
    const pricingSql = dbCalls.find((c) => c.text.includes("date_trunc('hour', at)"))!.text;
    expect(pricingSql).not.toMatch(/WHERE/i);
    expect(pricingSql).not.toMatch(/is_final/);
    expect(pricingSql).not.toMatch(/DISTINCT call_id\)(?!::int AS calls)/);
  });

  it("windows: dollars from billed priced groups only; unpriced counted, never $0'd or NaN'd", async () => {
    routeAggregates();
    const agg = await usageAggregates(NOW);
    // today = groups a–d: $0.01 + $0 (refusal) + excluded (abort, unknown model)
    expect(agg.windows.today.dollars).toBeCloseTo(0.01, 9);
    expect(agg.windows.today.unpricedAttempts).toBe(2);
    expect(agg.windows.d7.dollars).toBeCloseTo(0.01, 9);
    // d30 adds both Sonnet 5 buckets, priced per their OWN windows: $2 + $3
    expect(agg.windows.d30.dollars).toBeCloseTo(5.01, 9);
    expect(agg.windows.all.dollars).toBeCloseTo(5.01, 9);
    expect(Number.isNaN(agg.windows.all.dollars)).toBe(false);
    // calls come from the DISTINCT query, not from summing group counts
    expect(agg.windows.today.calls).toBe(3);
    expect(agg.windows.all.calls).toBe(7);
  });

  it("PINNED: Sonnet 5 intro-vs-standard pricing is decided per bucket, so one cell can span the boundary correctly", async () => {
    routeAggregates();
    const agg = await usageAggregates(NOW);
    const sonnet = agg.byModelPurpose.find((c) => c.servedModel === "claude-sonnet-5")!;
    expect(sonnet.dollars).toBeCloseTo(5, 9); // $2 (intro) + $3 (standard), never 2×either
  });

  it("byModelPurpose: unknown model carries its attempts as unpriced with $0 accumulated", async () => {
    routeAggregates();
    const agg = await usageAggregates(NOW);
    const mystery = agg.byModelPurpose.find((c) => c.servedModel === "claude-mystery-9")!;
    expect(mystery.dollars).toBe(0);
    expect(mystery.unpricedAttempts).toBe(1);
  });

  it("recent: a fallback chain folds to ONE call priced across BOTH attempts, served model = final attempt's", async () => {
    routeAggregates();
    const agg = await usageAggregates(NOW);
    const c1 = agg.recent.find((r) => r.callId === "c1")!;
    expect(c1.attempts).toBe(2);
    expect(c1.servedModel).toBe("claude-opus-4-8");
    // $0 (unbilled primary) + 412×$5/M + 264×$25/M
    expect(c1.dollars).toBeCloseTo(412 * 5e-6 + 264 * 25e-6, 9);
    expect(c1.inputTokens).toBe(947); // both attempts' reported tokens
  });

  it("recent: an abort renders dollars=null and null tokens — '—', never $0.00", async () => {
    routeAggregates();
    const agg = await usageAggregates(NOW);
    const c2 = agg.recent.find((r) => r.callId === "c2")!;
    expect(c2.dollars).toBeNull();
    expect(c2.inputTokens).toBeNull();
    expect(c2.ok).toBe(false);
  });

  it("stop_reason and error breakdowns pass through", async () => {
    routeAggregates();
    const agg = await usageAggregates(NOW);
    expect(agg.stopReasons).toEqual([
      { key: "end_turn", n: 40 },
      { key: "refusal", n: 2 },
    ]);
    expect(agg.errors).toEqual([{ key: "overloaded_error", n: 1 }]);
  });
});

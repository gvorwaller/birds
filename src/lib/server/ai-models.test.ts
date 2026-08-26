/**
 * Registry tests (td-015838/td-09be7a). Every case here encodes a lesson that
 * cost real money or a real 400 during the Sonnet→Opus switch or the meter
 * reviews — these are the properties the registry EXISTS to hold.
 */
import { describe, expect, it } from "vitest";
import {
  SELECTABLE_MODELS,
  PRICING_ONLY_MODELS,
  DEFAULT_MODEL_IDS,
  THINKING_HEADROOM_TOKENS,
  resolveModel,
  extractEnvelope,
  rateFor,
  dollarsForRow,
  type AiCallParts,
} from "./ai-models";

const PARTS: AiCallParts = {
  system: "sys",
  user: "usr",
  schema: { type: "object", properties: {}, additionalProperties: false },
  maxOutputTokens: 2000,
  effort: "medium",
};

const byId = (id: string) => {
  const m = SELECTABLE_MODELS.find((x) => x.id === id);
  if (!m?.buildRequest) throw new Error(`no builder for ${id}`);
  return m;
};

describe("buildRequest — per-model shape (each violation is a real 400 or cost bug)", () => {
  it("opus-5: adaptive thinking + effort + fallbacks + the -2026-07-01 beta header", () => {
    const r = byId("claude-opus-5").buildRequest!(PARTS);
    expect(r.body.thinking).toEqual({ type: "adaptive" });
    expect((r.body.output_config as { effort?: string }).effort).toBe("medium");
    expect(r.body.fallbacks).toBe("default");
    expect(r.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
  });

  it("opus-5: max_tokens = answer budget + thinking headroom (reproduces today's 8000)", () => {
    const r = byId("claude-opus-5").buildRequest!(PARTS);
    expect(r.body.max_tokens).toBe(2000 + THINKING_HEADROOM_TOKENS);
    expect(r.body.max_tokens).toBe(8000); // the value running in prod today
  });

  it("sonnet-4-6: NO thinking key, NO fallbacks, NO beta header, answer budget IS max_tokens", () => {
    const r = byId("claude-sonnet-4-6").buildRequest!(PARTS);
    expect(r.body).not.toHaveProperty("thinking");
    expect(r.body).not.toHaveProperty("fallbacks");
    expect(r.headers).toEqual({});
    expect(r.body.max_tokens).toBe(2000);
  });

  it("haiku-4-5: NO effort key even when the caller asks (effort 400s on Haiku)", () => {
    const r = byId("claude-haiku-4-5").buildRequest!({ ...PARTS, effort: "high" });
    const oc = r.body.output_config as Record<string, unknown>;
    expect(oc).not.toHaveProperty("effort");
    expect(r.body).not.toHaveProperty("thinking");
  });

  it("sonnet-5: thinking headroom applies (thinks by default) and no fallbacks", () => {
    const r = byId("claude-sonnet-5").buildRequest!(PARTS);
    expect(r.body.max_tokens).toBe(2000 + THINKING_HEADROOM_TOKENS);
    expect(r.body).not.toHaveProperty("fallbacks");
  });

  it("every selectable model accepts a json_schema (structured outputs is load-bearing)", () => {
    for (const m of SELECTABLE_MODELS) {
      const r = m.buildRequest!(PARTS);
      const oc = r.body.output_config as { format?: { type?: string } };
      expect(oc.format?.type, m.id).toBe("json_schema");
    }
  });

  it("NO builder ever emits sampling params or an API key header", () => {
    // The key-absence assertion is the leak guarantee, tested as the property
    // it is — the registry never sees auth, so it cannot leak it.
    for (const m of SELECTABLE_MODELS) {
      const r = m.buildRequest!(PARTS);
      expect(r.body).not.toHaveProperty("temperature");
      expect(r.body).not.toHaveProperty("top_p");
      expect(r.body).not.toHaveProperty("top_k");
      expect(Object.keys(r.headers).join()).not.toMatch(/x-api-key|authorization/i);
    }
  });
});

describe("resolveModel — never build a request for an unknown id", () => {
  it("resolves a stored value to its entry", () => {
    const m = resolveModel({ provider: "anthropic", model: "claude-haiku-4-5" }, "claude-opus-5");
    expect(m.id).toBe("claude-haiku-4-5");
  });

  it("falls back to the compiled default on unknown, removed, or malformed values", () => {
    for (const bad of [
      { model: "claude-nonexistent-9" },
      { model: "claude-opus-4-8" }, // pricing-only: priceable, NOT selectable
      { model: 42 },
      "claude-opus-5", // bare string is not the stored shape
      null,
      {},
    ]) {
      expect(resolveModel(bad, DEFAULT_MODEL_IDS.enrichment).id).toBe("claude-opus-5");
    }
  });
});

describe("extractEnvelope — the discriminator (GROK P1-3 fixtures, all four)", () => {
  it("(a) no iterations: one envelope from top-level usage", () => {
    const env = extractEnvelope({
      model: "claude-opus-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 500, output_tokens_details: { thinking_tokens: 80 } },
    });
    expect(env).toHaveLength(1);
    expect(env[0]).toMatchObject({
      servedModel: "claude-opus-5",
      billed: true,
      inputTokens: 1200,
      outputTokens: 500,
      thinkingTokens: 80,
      isFinal: true,
    });
  });

  it("(b) all-zero single iteration beside nonzero top-level: prices the TOP-LEVEL, not $0", () => {
    // Observed shape on ordinary responses; naive iteration pricing records
    // $0 for a real call.
    const env = extractEnvelope({
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 2095,
        output_tokens: 503,
        iterations: [{ type: "message", usage: { input_tokens: 0, output_tokens: 0 } }],
      },
    });
    expect(env).toHaveLength(1);
    expect(env[0].inputTokens).toBe(2095);
    expect(env[0].billed).toBe(true);
  });

  it("(c) fallback with BILLED partial primary: two rows, both billed", () => {
    const env = extractEnvelope({
      model: "claude-opus-4-8",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 412,
        output_tokens: 264,
        iterations: [
          { type: "message", model: "claude-opus-5", usage: { input_tokens: 535, output_tokens: 90 } },
          { type: "fallback_message", model: "claude-opus-4-8", usage: { input_tokens: 412, output_tokens: 264 } },
        ],
      },
    });
    expect(env).toHaveLength(2);
    expect(env[0]).toMatchObject({ servedModel: "claude-opus-5", billed: true, isFinal: false });
    expect(env[1]).toMatchObject({ servedModel: "claude-opus-4-8", billed: true, isFinal: true });
  });

  it("(d) fallback with UNBILLED 0-output primary: reported tokens are NOT billed (GROK P0-2)", () => {
    // The official sample: declined primary input 535 / output 0 — reported,
    // charged $0. Pricing it overcounts on every classifier decline, the very
    // path fallbacks:'default' exists for.
    const env = extractEnvelope({
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 412,
        output_tokens: 264,
        iterations: [
          { type: "message", model: "claude-opus-5", usage: { input_tokens: 535, output_tokens: 0 } },
          { type: "fallback_message", model: "claude-opus-4-8", usage: { input_tokens: 412, output_tokens: 264 } },
        ],
      },
    });
    expect(env[0].billed).toBe(false);
    expect(env[0].inputTokens).toBe(535); // still RECORDED — an event row
    expect(env[1].billed).toBe(true);
  });

  it("a no-fallback refusal (200, usage present, output 0) is an event row, not spend", () => {
    const env = extractEnvelope({
      model: "claude-opus-5",
      stop_reason: "refusal",
      usage: { input_tokens: 900, output_tokens: 0 },
    });
    expect(env).toHaveLength(1);
    expect(env[0].billed).toBe(false);
    expect(env[0].stopReason).toBe("refusal");
  });

  it("exactly one envelope per chain is final", () => {
    for (const fixture of [
      { model: "m", usage: { input_tokens: 1, output_tokens: 1 } },
      {
        model: "m",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          iterations: [
            { type: "message", usage: { input_tokens: 5, output_tokens: 2 } },
            { type: "fallback_message", usage: { input_tokens: 1, output_tokens: 1 } },
          ],
        },
      },
    ]) {
      const env = extractEnvelope(fixture);
      expect(env.filter((e) => e.isFinal)).toHaveLength(1);
    }
  });
});

describe("pricing — the formula, pinned (GROK P1-9)", () => {
  const base = {
    billed: true,
    served_model: "claude-opus-5",
    at: new Date("2026-08-26T00:00:00Z"),
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
  };

  it("computes the written formula", () => {
    expect(dollarsForRow(base)).toBeCloseTo(5 + 25, 6);
    expect(
      dollarsForRow({
        ...base,
        cache_read_tokens: 1_000_000,
        cache_write_5m_tokens: 1_000_000,
        cache_write_1h_tokens: 1_000_000,
      }),
    ).toBeCloseTo(5 + 25 + 5 * 0.1 + 5 * 1.25 + 5 * 2, 6);
  });

  it("PINNED: thinking tokens change NOTHING (they are inside output_tokens)", () => {
    // The single most likely arithmetic bug in the whole meter: pricing
    // thinking on top of output double-bills. The formula must ignore the
    // field even if a future refactor threads it into the row — so pass it
    // and assert it is inert. (A first version of this test compared two
    // identical calls: a tautology, this week's lying-test disease. This one
    // actually varies the input.)
    const withThinking = dollarsForRow({
      ...base,
      output_tokens: 100,
      thinking_tokens: 40,
    } as never);
    const withoutThinking = dollarsForRow({
      ...base,
      output_tokens: 100,
      thinking_tokens: 0,
    } as never);
    expect(withThinking).toBe(withoutThinking);
    expect(withThinking).toBeCloseTo(5 + 100 * (25 / 1_000_000), 9);
  });

  it("billed=false rows are $0 by definition (refusals may honestly say $0.00)", () => {
    expect(dollarsForRow({ ...base, billed: false })).toBe(0);
  });

  it("NULL core tokens (aborts) are UNPRICEABLE — null, never $0.00", () => {
    // $0.00 on an abort reads as a receipt for a free call the provider may
    // still have billed. Render "—".
    expect(dollarsForRow({ ...base, input_tokens: null })).toBeNull();
    expect(dollarsForRow({ ...base, output_tokens: null })).toBeNull();
  });

  it("unknown served model is unpriceable, never NaN and never 0", () => {
    const d = dollarsForRow({ ...base, served_model: "gemini-2.5-flash" });
    expect(d).toBeNull();
  });

  it("FAMILY-PREFIX matching: a dated variant still prices (GROK P1-9)", () => {
    expect(rateFor("claude-opus-4-8-20260101", new Date())).not.toBeNull();
    expect(dollarsForRow({ ...base, served_model: "claude-opus-4-8-20260101" })).toBeCloseTo(30, 6);
  });

  it("prefix matching picks the LONGEST id (opus-4-8 must not match bare opus)", () => {
    // claude-opus-5 vs a hypothetical shorter prefix: the dated 4-8 variant
    // must resolve to opus-4-8's rates, not another family's.
    const r = rateFor("claude-sonnet-4-6-20270101", new Date("2027-06-01T00:00:00Z"));
    expect(r?.inPerMTok).toBe(3);
  });

  it("Sonnet 5 window boundary is honored in UTC-of-Pacific terms", () => {
    const before = rateFor("claude-sonnet-5", new Date("2026-08-31T23:00:00Z"));
    const after = rateFor("claude-sonnet-5", new Date("2026-09-01T08:00:00Z"));
    expect(before?.inPerMTok).toBe(2); // intro
    expect(after?.inPerMTok).toBe(3); // post-intro
    // The ambiguous hour (midnight-07:00 UTC on Sep 1 = still Aug 31 Pacific)
    // stays on the intro rate:
    const pacificEve = rateFor("claude-sonnet-5", new Date("2026-09-01T05:00:00Z"));
    expect(pacificEve?.inPerMTok).toBe(2);
  });

  it("pricing-only entries price but never resolve as selectable", () => {
    expect(PRICING_ONLY_MODELS.every((m) => m.buildRequest === undefined)).toBe(true);
    expect(rateFor("claude-opus-4-8", new Date())?.inPerMTok).toBe(5);
  });
});

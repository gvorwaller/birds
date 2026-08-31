/**
 * Chokepoint contract (plan step 4): exactly one recorded call per API call —
 * success, enveloped failure, and bare failure — with provenance in the
 * returned attempt object and the timeout signal owned here (GROK P1-8).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCallEnvelope, CallEnvelope } from "./ai-models";
import { DEFAULT_MODEL_IDS } from "./ai-models";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("./app-config", () => ({ getConfig: mocks.getConfig }));
vi.mock("./ai-usage", () => ({ recordUsage: mocks.recordUsage }));

import { meteredAiCall } from "./ai-call";
import { newTimingBag, runWithTiming } from "./request-timing";

const attempt = (over: Partial<CallEnvelope> = {}): CallEnvelope => ({
  attemptIndex: 0,
  attemptType: null,
  isFinal: true,
  servedModel: "claude-opus-5",
  stopReason: "end_turn",
  billed: true,
  inputTokens: 1200,
  outputTokens: 500,
  thinkingTokens: 80,
  cacheReadTokens: null,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  ...over,
});

const okEnvelope = (attempts: CallEnvelope[] = [attempt()]): AiCallEnvelope => ({
  requestId: "req_abc",
  httpStatus: 200,
  providerErrorType: null,
  attempts,
});

const baseOpts = {
  purpose: "enrichment" as const,
  configKey: "ai.model.enrichment",
  defaultModelId: DEFAULT_MODEL_IDS.enrichment,
  speciesCode: "dowwoo",
  jobId: 42,
  timeoutMs: 120_000,
};

beforeEach(() => {
  vi.restoreAllMocks(); // console spy
  mocks.getConfig.mockReset();
  mocks.recordUsage.mockReset();
  mocks.getConfig.mockResolvedValue({ provider: "anthropic", model: "claude-opus-5" });
  mocks.recordUsage.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("meteredAiCall — success", () => {
  it("records exactly one call and returns the attempt object with final-attempt provenance", async () => {
    const env = okEnvelope([
      attempt({ attemptIndex: 0, isFinal: false, billed: false, outputTokens: 0 }),
      attempt({ attemptIndex: 1, isFinal: true, servedModel: "claude-opus-4-8" }),
    ]);
    const out = await meteredAiCall({
      ...baseOpts,
      run: async () => ({ result: { note: "hi" }, envelope: env }),
    });
    expect(out.result).toEqual({ note: "hi" });
    expect(out.requestedModel).toBe("claude-opus-5");
    expect(out.servedModel).toBe("claude-opus-4-8"); // the FINAL attempt's, not the requested
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        purpose: "enrichment",
        speciesCode: "dowwoo",
        jobId: 42,
        requestId: "req_abc",
        attempts: env.attempts, // BOTH rows reach the ledger
      }),
    );
    const rec = mocks.recordUsage.mock.calls[0][0];
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("resolves the model from config per call; config value drives which model run() receives", async () => {
    mocks.getConfig.mockResolvedValue({ provider: "anthropic", model: "claude-haiku-4-5" });
    const seen: string[] = [];
    await meteredAiCall({
      ...baseOpts,
      run: async (model) => {
        seen.push(model.id);
        return { result: 1, envelope: okEnvelope() };
      },
    });
    expect(seen).toEqual(["claude-haiku-4-5"]);
    expect(mocks.getConfig).toHaveBeenCalledWith("ai.model.enrichment", {
      provider: "anthropic",
      model: "claude-opus-5",
    });
  });

  it("modelOverride bypasses config entirely (compare must never read or disturb the dropdowns)", async () => {
    const sonnet = (await import("./ai-models")).SELECTABLE_MODELS.find(
      (m) => m.id === "claude-sonnet-4-6",
    )!;
    const out = await meteredAiCall({
      ...baseOpts,
      purpose: "compare",
      modelOverride: sonnet,
      run: async (model) => ({
        result: model.id,
        envelope: okEnvelope([attempt({ servedModel: "claude-sonnet-4-6" })]),
      }),
    });
    expect(out.result).toBe("claude-sonnet-4-6");
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it("a config-layer rejection still proceeds on the compiled default (belt-and-braces over getConfig's own contract)", async () => {
    mocks.getConfig.mockRejectedValue(new Error("contract regression"));
    const seen: string[] = [];
    await meteredAiCall({
      ...baseOpts,
      run: async (model) => {
        seen.push(model.id);
        return { result: 1, envelope: okEnvelope() };
      },
    });
    expect(seen).toEqual(["claude-opus-5"]);
  });
});

describe("meteredAiCall — failure", () => {
  it("includes a failed provider call in request timing exactly once", async () => {
    const bag = newTimingBag();
    await runWithTiming(bag, () =>
      meteredAiCall({
        ...baseOpts,
        run: async () => {
          throw new Error("provider down");
        },
      }),
    ).catch(() => {});
    expect(bag.buckets.ai.n).toBe(1);
    expect(bag.buckets.ai.ms).toBeGreaterThanOrEqual(0);
  });

  it("PINNED (kitmur): a post-200 throw with an envelope records the failure WITH its tokens and stop_reason, then rethrows", async () => {
    const err = Object.assign(new Error("annotation JSON truncated"), {
      envelope: okEnvelope([attempt({ stopReason: "max_tokens" })]),
    });
    await expect(
      meteredAiCall({
        ...baseOpts,
        run: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err); // the ORIGINAL error, not a wrapper
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    const rec = mocks.recordUsage.mock.calls[0][0];
    expect(rec.ok).toBe(false);
    expect(rec.attempts[0].stopReason).toBe("max_tokens");
    expect(rec.attempts[0].inputTokens).toBe(1200); // real spend on a failed call
    expect(rec.error).toContain("truncated");
  });

  it("a bare throw (network error, no envelope) records an empty-attempts call — unknown spend, not zero", async () => {
    await expect(
      meteredAiCall({
        ...baseOpts,
        run: async () => {
          throw new Error("fetch failed");
        },
      }),
    ).rejects.toThrow("fetch failed");
    const rec = mocks.recordUsage.mock.calls[0][0];
    expect(rec.ok).toBe(false);
    expect(rec.attempts).toEqual([]); // recordUsage synthesizes the NULL-token row
    expect(rec.requestId).toBeNull();
  });

  it("recordUsage REJECTING fails neither the success path nor the rethrow path", async () => {
    mocks.recordUsage.mockRejectedValue(new Error("ledger down"));
    const out = await meteredAiCall({
      ...baseOpts,
      run: async () => ({ result: "fine", envelope: okEnvelope() }),
    });
    expect(out.result).toBe("fine");
    await expect(
      meteredAiCall({
        ...baseOpts,
        run: async () => {
          throw new Error("api down");
        },
      }),
    ).rejects.toThrow("api down"); // the API error, not "ledger down"
  });
});

describe("meteredAiCall — timeout ownership (GROK P1-8)", () => {
  it("hands run() a signal that aborts after timeoutMs", async () => {
    let got: AbortSignal | undefined;
    await meteredAiCall({
      ...baseOpts,
      timeoutMs: 20,
      run: async (_model, signal) => {
        got = signal;
        expect(signal.aborted).toBe(false);
        return { result: 1, envelope: okEnvelope() };
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(got?.aborted).toBe(true); // the chokepoint's clock, not a consumer-internal one
  });
});

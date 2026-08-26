/**
 * Admin AI actions (plan step 7): every action carries the `kind`
 * discriminant (one ActionData slot — without it a compare result renders
 * under the nudge button), registry validation on set_ai_model, and the
 * compare runner's guards (server-side species check, single-flight, abort
 * pricing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbCalls: { text: string; params: unknown[] }[] = [];
let queryHandler: (text: string, params?: unknown[]) => { rows: unknown[] } | undefined = () => ({
  rows: [],
});

vi.mock("$lib/db", () => ({
  query: async (text: string, params?: unknown[]) => {
    dbCalls.push({ text, params: params ?? [] });
    return queryHandler(text, params) ?? { rows: [] };
  },
  queryTimed: async (text: string, params?: unknown[]) => {
    dbCalls.push({ text, params: params ?? [] });
    return queryHandler(text, params) ?? { rows: [] };
  },
}));

const mocks = vi.hoisted(() => ({
  nudgeEnrichmentScan: vi.fn(),
  generateSpeciesAnnotation: vi.fn(),
  aiStageInputFor: vi.fn(),
  similarCandidatesFor: vi.fn(),
}));
vi.mock("$server/job-handlers", () => ({ nudgeEnrichmentScan: mocks.nudgeEnrichmentScan }));
vi.mock("$server/admin-status", () => ({ adminLiveStatus: vi.fn() }));
vi.mock("$server/gallery", () => ({ galleryHealth: vi.fn() }));
vi.mock("$server/ai-enrichment", () => ({
  generateSpeciesAnnotation: mocks.generateSpeciesAnnotation,
}));
vi.mock("$server/species-enrichment", () => ({
  aiStageInputFor: mocks.aiStageInputFor,
  similarCandidatesFor: mocks.similarCandidatesFor,
}));

import { actions, load } from "./+page.server";

const ADMIN = { locals: { user: { id: 1, role: "admin" } } };
const VIEWER = { locals: { user: { id: 2, role: "viewer" } } };

const req = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  }
  return new Request("http://localhost/admin", { method: "POST", body: fd });
};

const STAGE = {
  extract: "prose",
  sections: [],
  revId: 55,
  aiStatus: null,
  aiSourceRevId: null,
  aiAttemptedAt: null,
  similarStatus: null,
  similarCandidatesHash: null,
  similarSourceRevId: null,
  similarAttemptedAt: null,
};
const CANDIDATES = [
  {
    code: "haiwoo",
    comName: "Hairy Woodpecker",
    sciName: "Leuconotopicus villosus",
    basis: "ebird_slash" as const,
    reciprocal: false,
  },
];
const annotationResult = (modelId: string) => ({
  annotation: {
    tags: [],
    fieldCraft: "Work the trunks low.",
    droppedTags: [],
    similar: [{ code: "haiwoo", note: "Hairy shows a much longer bill." }],
    droppedSimilar: [],
  },
  envelope: {
    requestId: "req_cmp",
    httpStatus: 200,
    providerErrorType: null,
    attempts: [
      {
        attemptIndex: 0,
        attemptType: null,
        isFinal: true,
        servedModel: modelId,
        stopReason: "end_turn",
        billed: true,
        inputTokens: 1000,
        outputTokens: 200,
        thinkingTokens: null,
        cacheReadTokens: null,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
      },
    ],
  },
});

function routeCompareDb() {
  queryHandler = (text) => {
    if (text.includes("FROM taxonomy_cache WHERE species_code"))
      return {
        rows: [{ com_name: "Downy Woodpecker", sci_name: "Dryobates pubescens", family: "Picidae" }],
      };
    return { rows: [] };
  };
}

beforeEach(() => {
  dbCalls.length = 0;
  queryHandler = () => ({ rows: [] });
  mocks.nudgeEnrichmentScan.mockReset();
  mocks.generateSpeciesAnnotation.mockReset();
  mocks.aiStageInputFor.mockReset();
  mocks.similarCandidatesFor.mockReset();
  mocks.aiStageInputFor.mockResolvedValue(STAGE);
  mocks.similarCandidatesFor.mockResolvedValue(CANDIDATES);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loader", () => {
  it("404s non-admins before touching anything", async () => {
    await expect(load(VIEWER as never)).rejects.toMatchObject({ status: 404 });
    expect(dbCalls).toHaveLength(0);
  });
});

describe("kind discriminant — the one-ActionData-slot fix", () => {
  it("nudge_enrichment carries kind on success AND on 403", async () => {
    const denied = (await actions.nudge_enrichment(VIEWER as never)) as {
      status: number;
      data: { kind: string };
    };
    expect(denied.status).toBe(403);
    expect(denied.data.kind).toBe("nudge");
    mocks.nudgeEnrichmentScan.mockResolvedValue({
      candidates: 0,
      chunksEnqueued: 0,
      wikiCandidates: 0,
      aiCandidates: 0,
      mediaCandidates: 0,
      deduped: 0,
      remaining: 0,
    });
    const ok = (await actions.nudge_enrichment(ADMIN as never)) as { kind: string; ok: boolean };
    expect(ok.kind).toBe("nudge");
    expect(ok.ok).toBe(true);
  });
});

describe("set_ai_model", () => {
  it("403s non-admins with kind", async () => {
    const r = (await actions.set_ai_model({
      ...VIEWER,
      request: req({ surface: "enrichment", model: "claude-haiku-4-5" }),
    } as never)) as { status: number; data: { kind: string } };
    expect(r.status).toBe(403);
    expect(r.data.kind).toBe("set_model");
  });

  it("rejects unknown surfaces and unknown/non-selectable models WITHOUT writing", async () => {
    for (const fields of [
      { surface: "enrichmnet", model: "claude-haiku-4-5" },
      { surface: "enrichment", model: "claude-nonexistent-9" },
      { surface: "enrichment", model: "claude-opus-4-8" }, // pricing-only
    ]) {
      const r = (await actions.set_ai_model({ ...ADMIN, request: req(fields) } as never)) as {
        status: number;
        data: { kind: string };
      };
      expect(r.status).toBe(400);
      expect(r.data.kind).toBe("set_model");
    }
    expect(dbCalls.filter((c) => c.text.includes("app_config"))).toHaveLength(0);
  });

  it("persists a valid choice and says future-calls-only", async () => {
    const r = (await actions.set_ai_model({
      ...ADMIN,
      request: req({ surface: "guidance", model: "claude-haiku-4-5" }),
    } as never)) as { kind: string; ok: boolean; message: string };
    expect(r.kind).toBe("set_model");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("future calls only");
    const write = dbCalls.find((c) => c.text.includes("ON CONFLICT (key) DO UPDATE"));
    expect(write?.params[0]).toBe("ai.model.guidance");
  });
});

describe("run_compare", () => {
  it("403s non-admins with kind", async () => {
    const r = (await actions.run_compare({
      ...VIEWER,
      request: req({ species: "dowwoo", models: ["claude-haiku-4-5"] }),
    } as never)) as { status: number; data: { kind: string } };
    expect(r.status).toBe(403);
    expect(r.data.kind).toBe("compare");
  });

  it("rejects empty model sets, unknown models, unknown species, and prose-less species", async () => {
    routeCompareDb();
    const noModels = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo" }),
    } as never)) as { status: number; data: { kind: string } };
    expect(noModels.status).toBe(400);

    const badModel = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo", models: ["gpt-5"] }),
    } as never)) as { status: number; data: { error: string } };
    expect(badModel.status).toBe(400);
    expect(badModel.data.error).toMatch(/Unknown model/);

    queryHandler = () => ({ rows: [] }); // no taxonomy row
    const badSpecies = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "nosuch", models: ["claude-haiku-4-5"] }),
    } as never)) as { status: number; data: { error: string } };
    expect(badSpecies.status).toBe(400);
    expect(badSpecies.data.error).toMatch(/No species/);

    routeCompareDb();
    mocks.aiStageInputFor.mockResolvedValue(null);
    const noProse = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo", models: ["claude-haiku-4-5"] }),
    } as never)) as { status: number; data: { error: string } };
    expect(noProse.status).toBe(400);
    expect(noProse.data.error).toMatch(/no stored Wikipedia prose/);
    expect(mocks.generateSpeciesAnnotation).not.toHaveBeenCalled();
  });

  it("PINNED (spend boundary): rejects duplicate model fields before any provider call", async () => {
    routeCompareDb();
    const r = (await actions.run_compare({
      ...ADMIN,
      request: req({
        species: "dowwoo",
        models: ["claude-haiku-4-5", "claude-haiku-4-5"],
      }),
    } as never)) as { status: number; data: { kind: string; error: string } };

    expect(r.status).toBe(400);
    expect(r.data.kind).toBe("compare");
    expect(r.data.error).toMatch(/only once/);
    expect(mocks.generateSpeciesAnnotation).not.toHaveBeenCalled();
    expect(dbCalls.filter((c) => c.text.includes("INSERT INTO ai_usage"))).toHaveLength(0);
  });

  it("runs the selected models in parallel, prices each column, and writes one ledger call per model", async () => {
    routeCompareDb();
    mocks.generateSpeciesAnnotation.mockImplementation(
      async (_input: unknown, model: { id: string }) => annotationResult(model.id),
    );
    const r = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "DOWWOO", models: ["claude-opus-5", "claude-haiku-4-5"] }),
    } as never)) as {
      kind: string;
      ok: boolean;
      speciesName: string;
      columns: {
        modelId: string;
        ok: boolean;
        dollars: number | null;
        fallback: boolean;
        similar: { comName: string }[];
      }[];
    };
    expect(r.kind).toBe("compare");
    expect(r.speciesName).toBe("Downy Woodpecker");
    expect(r.columns).toHaveLength(2);
    const opus = r.columns.find((c) => c.modelId === "claude-opus-5")!;
    const haiku = r.columns.find((c) => c.modelId === "claude-haiku-4-5")!;
    // 1000 in + 200 out: $5/$25 vs $1/$5 per MTok — the 5x differential visible
    expect(opus.dollars).toBeCloseTo(0.01, 9);
    expect(haiku.dollars).toBeCloseTo(0.002, 9);
    expect(opus.fallback).toBe(false);
    expect(opus.similar[0].comName).toBe("Hairy Woodpecker"); // code → name via candidates
    // one metered call per model, none of it persisted to species tables
    expect(dbCalls.filter((c) => c.text.includes("INSERT INTO ai_usage"))).toHaveLength(2);
    expect(dbCalls.some((c) => c.text.includes("species_enrichment SET"))).toBe(false);
  });

  it("PINNED: compare column tokens sum the whole fallback chain, not just the final attempt", async () => {
    routeCompareDb();
    mocks.generateSpeciesAnnotation.mockImplementation(async (_input: unknown, model: { id: string }) => {
      const base = annotationResult(model.id);
      return {
        ...base,
        envelope: {
          ...base.envelope,
          attempts: [
            {
              ...base.envelope.attempts[0],
              attemptIndex: 0,
              isFinal: false,
              billed: true,
              servedModel: "claude-opus-5",
              inputTokens: 535,
              outputTokens: 90,
            },
            {
              ...base.envelope.attempts[0],
              attemptIndex: 1,
              isFinal: true,
              billed: true,
              servedModel: "claude-opus-4-8",
              inputTokens: 412,
              outputTokens: 264,
            },
          ],
        },
      };
    });
    const r = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo", models: ["claude-opus-5"] }),
    } as never)) as { columns: { inputTokens: number | null; outputTokens: number | null; dollars: number | null }[] };
    expect(r.columns[0].inputTokens).toBe(947);
    expect(r.columns[0].outputTokens).toBe(354);
    // Both billed attempts priced: (535+412)*$5/M + (90+264)*$25/M
    expect(r.columns[0].dollars).toBeCloseTo((535 + 412) * 5e-6 + (90 + 264) * 25e-6, 9);
  });

  it("a dated variant of the requested model is NOT flagged as fallback; a different model IS", async () => {
    routeCompareDb();
    mocks.generateSpeciesAnnotation.mockImplementation(
      async (_input: unknown, model: { id: string }) => {
        const r = annotationResult(model.id);
        // Anthropic serves dated ids (observed live: claude-haiku-4-5-20251001);
        // Opus 5's real fallback serves a genuinely different model.
        r.envelope.attempts[0].servedModel =
          model.id === "claude-haiku-4-5" ? "claude-haiku-4-5-20251001" : "claude-opus-4-8";
        return r;
      },
    );
    const r = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo", models: ["claude-haiku-4-5", "claude-opus-5"] }),
    } as never)) as {
      columns: { modelId: string; fallback: boolean; servedModel: string | null; dollars: number | null }[];
    };
    const haiku = r.columns.find((c) => c.modelId === "claude-haiku-4-5")!;
    expect(haiku.servedModel).toBe("claude-haiku-4-5-20251001");
    expect(haiku.fallback).toBe(false); // same model, dated — not a fallback
    expect(haiku.dollars).not.toBeNull(); // family-prefix rate matching held
    const opus = r.columns.find((c) => c.modelId === "claude-opus-5")!;
    expect(opus.fallback).toBe(true); // opus-4-8 IS a different model
  });

  it("an aborted model renders dollars=null (—), never $0.00, and does not sink the other columns", async () => {
    routeCompareDb();
    mocks.generateSpeciesAnnotation.mockImplementation(
      async (_input: unknown, model: { id: string }) => {
        if (model.id === "claude-opus-5")
          throw new Error("AI request timed out before a response arrived.");
        return annotationResult(model.id);
      },
    );
    const r = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo", models: ["claude-opus-5", "claude-haiku-4-5"] }),
    } as never)) as {
      columns: { modelId: string; ok: boolean; dollars: number | null; aborted: boolean }[];
    };
    const opus = r.columns.find((c) => c.modelId === "claude-opus-5")!;
    expect(opus.ok).toBe(false);
    expect(opus.aborted).toBe(true);
    expect(opus.dollars).toBeNull();
    expect(r.columns.find((c) => c.modelId === "claude-haiku-4-5")!.ok).toBe(true);
  });

  it("PINNED (single-flight): a second compare while one runs is a 409, not a second spend", async () => {
    routeCompareDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mocks.generateSpeciesAnnotation.mockImplementation(
      async (_input: unknown, model: { id: string }) => {
        await gate;
        return annotationResult(model.id);
      },
    );
    const first = actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo", models: ["claude-haiku-4-5"] }),
    } as never);
    await new Promise((r) => setTimeout(r, 20)); // let it pass validation into flight
    const second = (await actions.run_compare({
      ...ADMIN,
      request: req({ species: "dowwoo", models: ["claude-haiku-4-5"] }),
    } as never)) as { status: number; data: { kind: string; error: string } };
    expect(second.status).toBe(409);
    expect(second.data.error).toMatch(/already running/);
    release();
    const done = (await first) as { ok: boolean };
    expect(done.ok).toBe(true);
    expect(mocks.generateSpeciesAnnotation).toHaveBeenCalledTimes(1); // the 409 spent nothing
  });
});

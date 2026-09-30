/**
 * td-894144 B4 (plan rev 23 §B4a/B4b): the AI draft job. The AI call and its
 * metering are mocked — no live AI, no ai_usage rows. Real birds_test for the
 * authoring freeze and the proposal insert; everything created is removed
 * through the birds_test-only owner escape.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const ai = vi.hoisted(() => ({
  responses: [] as unknown[],
  seen: [] as { previousError?: string | null; examples: unknown[] }[],
  models: [] as { configKey?: string; defaultModelId?: string; override?: string }[],
  /** When set, the next draft call hangs until its signal aborts. */
  hang: false,
  onHang: null as (() => void) | null,
}));
vi.mock("$server/ai-call", () => ({
  meteredAiCall: async (opts: {
    configKey?: string;
    defaultModelId?: string;
    modelOverride?: { id: string };
    run: (m: unknown, s: AbortSignal) => Promise<{ result: unknown }>;
  }) => {
    ai.models.push({
      configKey: opts.configKey,
      defaultModelId: opts.defaultModelId,
      override: opts.modelOverride?.id,
    });
    const { result } = await opts.run(
      { id: "fake" },
      new AbortController().signal,
    );
    return {
      result,
      requestedModel: "fake",
      servedModel: "fake",
      envelope: { attempts: [] },
    };
  },
}));
vi.mock("$server/ai-tag-draft", async (orig) => ({
  ...(await orig<typeof import("./ai-tag-draft")>()),
  draftTagRules: async (
    input: { previousError?: string | null; examples: unknown[] },
    _model: unknown,
    opts: { signal: AbortSignal },
  ) => {
    ai.seen.push(input);
    if (ai.hang) {
      ai.hang = false;
      return new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
        ai.onHang?.();
      });
    }
    return { raw: ai.responses.shift(), envelope: { attempts: [] } };
  },
}));

import { query } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import { withOwnerClient } from "./tag-fixtures.test-helper";
import {
  checkTaxonRules,
  runTagDraftJob,
  type KnownTaxa,
  type TaxonGroup,
} from "./tag-draft-job";
import type { TaxonRule } from "./tag-engine/rules";

describe("checkTaxonRules", () => {
  const groups: TaxonGroup[] = [
    { order: "Procellariiformes", family: "Procellariidae", n: 90 },
    { order: "Charadriiformes", family: "Alcidae", n: 25 },
    { order: "Charadriiformes", family: "Scolopacidae", n: 97 },
    { order: "Passeriformes", family: "Turdidae", n: 170 },
    { order: null, family: null, n: 3 },
  ];
  // The whole species taxonomy: includes a real family with no article yet.
  const known: KnownTaxa = {
    order: new Set(["Procellariiformes", "Charadriiformes", "Passeriformes"]),
    family: new Set(["Procellariidae", "Alcidae", "Scolopacidae", "Turdidae", "Mohoidae"]),
  };
  const rule = (
    id: string,
    rank: "order" | "family",
    action: TaxonRule["action"],
    values: string[],
  ): TaxonRule => ({ id, rank, action, values, note: "" });

  it("no taxon rules: nothing to check", () => {
    expect(checkTaxonRules([], groups, known).problems).toEqual([]);
  });

  it("ANDed requirements across ranks that no species meets are refused (the Haiku draft)", () => {
    const r = checkTaxonRules(
      [
        rule("t1", "family", "require_one_of", ["Alcidae"]),
        rule("t2", "order", "require_one_of", ["Procellariiformes"]),
      ],
      groups,
      known,
    );
    expect(r.admitted).toBe(0);
    expect(r.problems.join()).toMatch(/admit no species/);
  });

  it("alternatives listed in one rule are fine; forbids subtract; unknown ranks never count", () => {
    const r = checkTaxonRules(
      [
        rule("t1", "order", "require_one_of", ["Procellariiformes", "Charadriiformes"]),
        rule("t2", "family", "forbid", ["Scolopacidae"]),
      ],
      groups,
      known,
    );
    expect(r).toEqual({ admitted: 115, problems: [] });
  });

  it("a real family outside the current article universe is not an unknown name", () => {
    expect(
      checkTaxonRules([rule("t1", "family", "forbid", ["Turdidae", "Mohoidae"])], groups, known),
    ).toEqual({ admitted: 212, problems: [] });
  });

  it("names that match no order or family are refused even when others admit species", () => {
    const r = checkTaxonRules(
      [
        rule("t1", "family", "forbid", ["Turdidae", "Phalaropidae"]),
        rule("t2", "order", "forbid", ["Passeriforms"]),
      ],
      groups,
      known,
    );
    expect(r.admitted).toBe(212);
    expect(r.problems).toEqual([
      "taxon rule t1 names no known family: Phalaropidae",
      "taxon rule t2 names no known order: Passeriforms",
    ]);
  });
});

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT to_regclass('public.tag_authoring_example') IS NOT NULL AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

const TAG = "habitat:open-ocean";
const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
let adminId = 0;
const jobIds: number[] = [];
let hadAuthoring = false;

const VALID = {
  schema: 1,
  tag: TAG,
  rev: "ai-draft-1",
  denySections: ["taxonomy"],
  comparisonMarkers: ["unlike"],
  support: [
    {
      id: "s-pelagic",
      group: "pelagic",
      match: { type: "literal", phrase: "pelagic" },
      note: "lives at sea",
    },
  ],
  exclude: [
    {
      id: "x-migration",
      binds: ["*"],
      match: { type: "literal", phrase: "migration" },
      scope: { unit: "clause" },
      note: "transit",
    },
  ],
  taxon: [],
};

async function asOwner(sql: string, params: unknown[] = []) {
  await withOwnerClient(async (c) => {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('birds.tag_fixture', 'on', true)`);
    await c.query(sql, params);
    await c.query("COMMIT");
  });
}

async function claimedJob(): Promise<JobRow> {
  const r = await query<JobRow>(
    `INSERT INTO jobs (type, payload, dedup_key, requested_by, label, status, attempts, started_at)
		 VALUES ('tag_draft_rules', $1, $2, $3, 'fixture', 'running', 1, now()) RETURNING *`,
    [
      JSON.stringify({ tag: TAG }),
      `tag_draft_rules:fixture-${RUN}-${jobIds.length}`,
      adminId,
    ],
  );
  jobIds.push(r.rows[0].id);
  return r.rows[0];
}

const jobRow = async (id: number) =>
  (
    await query<{
      status: string;
      error: string | null;
      result: Record<string, unknown> | null;
    }>("SELECT status, error, result FROM jobs WHERE id = $1", [id])
  ).rows[0];

describe.runIf(migrated).sequential("tag_draft_rules job", () => {
  beforeAll(async () => {
    hadAuthoring =
      (await query("SELECT 1 FROM tag_authoring_example WHERE tag = $1", [TAG]))
        .rows.length > 0;
    adminId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, 'Draft fixture', '!unset', 'admin') RETURNING id`,
        [`tag-draft-${RUN}`],
      )
    ).rows[0].id;
  });
  beforeEach(() => {
    ai.responses = [];
    ai.seen = [];
    ai.models = [];
    ai.hang = false;
    ai.onHang = null;
  });
  afterAll(async () => {
    const props = (
      await query<{ id: string }>(
        `SELECT id::text FROM tag_rule_proposal WHERE tag = $1 AND source = 'ai' AND created_at > now() - interval '1 hour'`,
        [TAG],
      )
    ).rows.map((r) => r.id);
    if (props.length)
      await asOwner(
        "DELETE FROM tag_rule_proposal WHERE id = ANY($1::uuid[])",
        [props],
      );
    if (!hadAuthoring)
      await asOwner("DELETE FROM tag_authoring_example WHERE tag = $1", [TAG]);
    if (jobIds.length) {
      await query("DELETE FROM job_events WHERE job_id = ANY($1::bigint[])", [
        jobIds,
      ]);
      await query("DELETE FROM jobs WHERE id = ANY($1::bigint[])", [jobIds]);
    }
    await query("DELETE FROM users WHERE id = $1", [adminId]);
  });

  it("freezes the authoring set, retries once with the loader error, and stores an ai proposal", async () => {
    ai.responses = [{ ...VALID, support: [] }, VALID];
    const job = await claimedJob();
    await runTagDraftJob(job);
    const row = await jobRow(job.id);
    expect(row.status).toBe("succeeded");
    expect(ai.seen).toHaveLength(2);
    // Drafting reads its OWN Model choice setting (Tag rules), never the
    // enrichment dropdown; Opus 5 is only the default.
    const pick = {
      configKey: "ai.model.tag-draft",
      defaultModelId: "claude-opus-5",
      override: undefined,
    };
    expect(ai.models).toEqual([pick, pick]);
    expect(ai.seen[0].previousError ?? null).toBeNull();
    expect(ai.seen[1].previousError).toMatch(/at least one support rule/);
    expect((ai.seen[0].examples as unknown[]).length).toBeGreaterThan(0);
    expect((ai.seen[0].examples as unknown[]).length).toBeLessThanOrEqual(48);
    const p = (
      await query<{ status: string; source: string; artifact: unknown }>(
        "SELECT status, source, artifact FROM tag_rule_proposal WHERE id = $1",
        [row.result!.proposalId],
      )
    ).rows[0];
    expect(p).toMatchObject({ status: "proposed", source: "ai" });
    expect(p.artifact).toEqual(VALID);
    expect(row.result!.designHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.result!.attempts).toEqual([
      expect.objectContaining({
        loaderOk: false,
        loaderError: expect.stringMatching(/at least one support rule/),
        requestedModel: "fake",
        servedModel: "fake",
        aiUsageCallId: null,
      }),
      {
        loaderOk: true,
        loaderError: null,
        requestedModel: "fake",
        servedModel: "fake",
        aiUsageCallId: null,
      },
    ]);
    expect(
      (await query("SELECT 1 FROM tag_authoring_example WHERE tag = $1", [TAG]))
        .rows.length,
    ).toBeGreaterThan(0);
  }, 120_000);

  it("the authoring set stays frozen: a second draft sees the same examples", async () => {
    ai.responses = [VALID];
    await runTagDraftJob(await claimedJob());
    const first = ai.seen[0].examples;
    ai.seen = [];
    ai.responses = [VALID];
    await runTagDraftJob(await claimedJob());
    expect(ai.seen[0].examples).toEqual(first);
  }, 120_000);

  it("two invalid drafts fail the job and store nothing", async () => {
    const before = (
      await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tag_rule_proposal WHERE tag = $1`,
        [TAG],
      )
    ).rows[0].n;
    ai.responses = [
      { ...VALID, tag: "habitat:beach" },
      { ...VALID, bogus: 1 },
    ];
    const job = await claimedJob();
    await runTagDraftJob(job);
    const row = await jobRow(job.id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/failed validation twice/);
    expect(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM tag_rule_proposal WHERE tag = $1`,
          [TAG],
        )
      ).rows[0].n,
    ).toBe(before);
  }, 120_000);

  it("a draft whose taxon rules admit no species is refused, and the retry is told why", async () => {
    const impossible = {
      ...VALID,
      taxon: [
        { id: "t1", rank: "family", values: ["Alcidae"], action: "require_one_of", note: "auks" },
        { id: "t2", rank: "order", values: ["Procellariiformes"], action: "require_one_of", note: "petrels" },
      ],
    };
    ai.responses = [impossible, impossible];
    const job = await claimedJob();
    await runTagDraftJob(job);
    const row = await jobRow(job.id);
    expect(ai.seen[1].previousError).toMatch(/admit no species/);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/failed validation twice: .*admit no species/);
  }, 120_000);

  it("a worker drain mid-call aborts the call and requeues the job with its attempt refunded", async () => {
    const before = (
      await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tag_rule_proposal WHERE tag = $1`,
        [TAG],
      )
    ).rows[0].n;
    let draining = false;
    ai.hang = true;
    ai.onHang = () => {
      draining = true;
    };
    const job = await claimedJob();
    const started = Date.now();
    await runTagDraftJob(job, { isDraining: () => draining });
    expect(Date.now() - started).toBeLessThan(10_000);
    const row = (
      await query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM jobs WHERE id = $1",
        [job.id],
      )
    ).rows[0];
    expect(row).toEqual({ status: "pending", attempts: 0 });
    expect(
      (
        await query(
          `SELECT 1 FROM job_events WHERE job_id = $1 AND action = 'interrupted'`,
          [job.id],
        )
      ).rows.length,
    ).toBe(1);
    expect(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM tag_rule_proposal WHERE tag = $1`,
          [TAG],
        )
      ).rows[0].n,
    ).toBe(before);
  }, 120_000);

  it("a drain before a call starts requeues without calling the AI", async () => {
    const job = await claimedJob();
    await runTagDraftJob(job, { isDraining: () => true });
    expect(ai.seen).toHaveLength(0);
    expect(
      (await query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [job.id]))
        .rows[0].status,
    ).toBe("pending");
  }, 120_000);

  it("a real Draft enqueue survives one hard crash: max_attempts 2, so startup reclaim re-pends attempt 1", async () => {
    const { enqueueTagDraft } = await import("./tag-admin");
    const r = await enqueueTagDraft(TAG, adminId);
    jobIds.push(r.jobId);
    expect(r.deduped).toBe(false);
    // Simulate the crash state: claimed once, still 'running', worker gone.
    await query(
      `UPDATE jobs SET status = 'running', attempts = 1, started_at = now() WHERE id = $1`,
      [r.jobId],
    );
    const row = (
      await query<{ max_attempts: number; reclaim_to: string }>(
        // The same decision reclaimStartupJobs makes (jobs.ts), evaluated for
        // this row only — the real reclaim sweeps every running row on the
        // shared cluster, which a test must never do.
        `SELECT max_attempts,
                CASE WHEN cancel_requested THEN 'cancelled'
                     WHEN attempts < max_attempts THEN 'pending'
                     ELSE 'failed' END AS reclaim_to
           FROM jobs WHERE id = $1`,
        [r.jobId],
      )
    ).rows[0];
    expect(row).toEqual({ max_attempts: 2, reclaim_to: "pending" });
  });

  it("refuses a tag with no definition, and a non-admin requester", async () => {
    const job = await claimedJob();
    await query(
      `UPDATE jobs SET payload = '{"tag":"habitat:beach"}' WHERE id = $1`,
      [job.id],
    );
    await runTagDraftJob({ ...job, payload: { tag: "habitat:beach" } });
    expect((await jobRow(job.id)).error).toMatch(/no definition/);
    await query(`UPDATE users SET role = 'user' WHERE id = $1`, [adminId]);
    try {
      const j2 = await claimedJob();
      await runTagDraftJob(j2);
      expect((await jobRow(j2.id)).error).toMatch(/no longer an admin/);
    } finally {
      await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [adminId]);
    }
  });
});

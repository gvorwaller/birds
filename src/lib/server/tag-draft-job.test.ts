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
}));
vi.mock("$server/ai-call", () => ({
  meteredAiCall: async (opts: {
    run: (m: unknown, s: AbortSignal) => Promise<{ result: unknown }>;
  }) => {
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
  draftTagRules: async (input: {
    previousError?: string | null;
    examples: unknown[];
  }) => {
    ai.seen.push(input);
    return { raw: ai.responses.shift(), envelope: { attempts: [] } };
  },
}));

import { query } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import { withOwnerClient } from "./tag-fixtures.test-helper";
import { runTagDraftJob } from "./tag-draft-job";

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

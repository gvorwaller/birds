/**
 * td-894144 B5 Phase 1 — migration 0072's contract against real birds_test
 * SQL (plan docs/2026-09-30-open-ocean-rules-v2-plan.md §3d/§3e/§3g/§3j/
 * §3k/§3n/§3o/§3t/§3x/§4). Owned fixtures (zzv…) through the shared engine
 * fixture; everything created is removed.
 *
 * The Preview job runs end to end over the WHOLE test universe (~11k
 * species), so these tests are slow by design.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import { requeueInterrupted, runWithClaim } from "$server/jobs";
import { approvalRefusal, approveProposal, tagDetail } from "$server/tag-admin";
import { runTagPreviewJob } from "$server/tag-preview-job";
import { withOwnerClient } from "../tag-fixtures.test-helper";
import {
  __registerEvalDesignForTests,
  tagEvalDesign,
} from "./eval-design";
import { tagEngineFixture } from "./engine-fixture.test-helper";
import { previewDesignHash } from "./preview";
import { tagRepairState } from "./repair";
import { withTagWriteTx } from "./runtime";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      "SELECT to_regclass('public.tag_proposal_preview') IS NOT NULL AS ok",
    ).then((r) => r.rows[0].ok === true)
  : false;

const fx = tagEngineFixture("zzv");
let T = "";
const S: Record<string, string> = {};

const artifact = (over: Record<string, unknown> = {}) => ({
  schema: 2,
  tag: T,
  rev: `zzv-${fx.RUN}`,
  denySections: [],
  comparisonMarkers: [],
  support: [],
  exclude: [],
  taxon: [
    {
      id: "a_fixture",
      rank: "family",
      action: "assign",
      values: ["Fixtureidae"],
      note: "fixture family",
    },
  ],
  ...over,
});

async function propose(a: unknown): Promise<string> {
  const id = (
    await query<{ id: string }>(
      "SELECT public.create_human_tag_proposal($1, $2::jsonb, $3)::text AS id",
      [T, JSON.stringify(a), fx.adminId],
    )
  ).rows[0].id;
  fx.proposals.push(id);
  return id;
}

async function previewJob(proposalId: string): Promise<JobRow> {
  const id = (
    await query<{ id: number }>(
      `INSERT INTO jobs (type, payload, requested_by, label, max_attempts)
       VALUES ('tag_preview', $1, $2, 'zzv preview', 2) RETURNING id`,
      [JSON.stringify({ proposalId, tag: T }), fx.adminId],
    )
  ).rows[0].id;
  return fx.claim(id); // tracks the job for cleanup; claim_seq + 1 below
}

async function claimSeqBump(job: JobRow): Promise<JobRow> {
  return (
    await query<JobRow>(
      "UPDATE jobs SET claim_seq = claim_seq + 1 WHERE id = $1 RETURNING *",
      [job.id],
    )
  ).rows[0];
}

const jobState = async (id: number) =>
  (
    await query<{ status: string; error: string | null; result: { previewId?: string } | null }>(
      "SELECT status, error, result FROM jobs WHERE id = $1",
      [id],
    )
  ).rows[0];

const crosscheck = (proposalId: string, verdict = "approve") =>
  withOwnerClient((c) =>
    c.query("SELECT public.record_tag_crosscheck($1, 'CODEX1', $2, 'fixture review')", [
      proposalId,
      verdict,
    ]),
  );

describe.runIf(migrated).sequential("0072: rules v2, Preview, cross-check binding", () => {
  beforeAll(async () => {
    if ((await tagRepairState())?.pending)
      throw new Error("refusing to run while a repair is pending");
    await fx.setup(1);
    T = fx.tags[0];
    __registerEvalDesignForTests(T);
    for (const k of ["a", "b", "c"]) S[k] = await fx.addSpecies(k);
    await fx.settleUniverse();
    await fx.asOwner(
      "INSERT INTO tag_preview_design (tag, design_hash) VALUES ($1, $2)",
      [T, previewDesignHash(T, tagEvalDesign(T)!)],
    );
  }, 600_000);

  afterAll(async () => {
    await fx.asOwner("DELETE FROM tag_preview_design WHERE tag = $1", [T]);
    await fx.cleanup();
  }, 600_000);

  it("schema_version: missing, null, string, 0 and 3 are refused at INSERT; 1 and 2 are accepted", async () => {
    for (const schema of [undefined, null, "2", 0, 3, 2.5]) {
      const a: Record<string, unknown> = { tag: T, x: 1 };
      if (schema !== undefined) a.schema = schema;
      await expect(
        query(
          "INSERT INTO tag_rule_proposal (tag, artifact, source) VALUES ($1, $2::jsonb, 'human')",
          [T, JSON.stringify(a)],
        ),
      ).rejects.toThrow(/schema_version/);
    }
    for (const schema of [1, 2]) {
      const r = await query<{ id: string; schema_version: number }>(
        "INSERT INTO tag_rule_proposal (tag, artifact, source) VALUES ($1, $2::jsonb, 'human') RETURNING id::text, schema_version",
        [T, JSON.stringify({ schema, tag: T })],
      );
      fx.proposals.push(r.rows[0].id);
      expect(r.rows[0].schema_version).toBe(schema);
    }
  });

  it("create_human_tag_proposal: admin only, tag must match, source 'human'", async () => {
    await expect(
      query("SELECT public.create_human_tag_proposal($1, $2::jsonb, 0)", [
        T,
        JSON.stringify(artifact()),
      ]),
    ).rejects.toThrow(/not an admin/);
    await expect(
      query("SELECT public.create_human_tag_proposal($1, $2::jsonb, $3)", [
        T,
        JSON.stringify(artifact({ tag: "habitat:beach" })),
        fx.adminId,
      ]),
    ).rejects.toThrow(/does not match/);
    const id = await propose(artifact());
    const r = await query<{ source: string; status: string }>(
      "SELECT source, status FROM tag_rule_proposal WHERE id = $1",
      [id],
    );
    expect(r.rows[0]).toEqual({ source: "human", status: "proposed" });
  });

  it("evidence shapes are validated at the state boundary (plan §3e)", async () => {
    const ok = async (ev: unknown) =>
      (
        await query<{ ok: boolean }>("SELECT public.tag_evidence_ok($1::jsonb) AS ok", [
          JSON.stringify(ev),
        ])
      ).rows[0].ok;
    const text = { section: "", sentence: "x", matchStart: 0, matchEnd: 1, ruleId: "s" };
    const taxon = {
      kind: "taxon",
      matchedCount: 1,
      matchedRules: [{ ruleId: "a", rank: "family", value: "Laridae" }],
    };
    expect(await ok([text])).toBe(true);
    expect(await ok([text, text, text])).toBe(true);
    expect(await ok([{ ...text, scopes: [{ rank: "family", value: "Laridae" }] }])).toBe(true);
    expect(await ok([taxon])).toBe(true);
    expect(await ok([{ ...taxon, matchedCount: 8 }])).toBe(true);
    // refused
    expect(await ok([taxon, text])).toBe(false);
    expect(await ok([{ ...taxon, matchedCount: 0 }])).toBe(false);
    expect(
      await ok([{ ...taxon, matchedRules: Array(6).fill(taxon.matchedRules[0]), matchedCount: 6 }]),
    ).toBe(false);
    expect(await ok([{ ...text, scopes: [] }])).toBe(false);
    expect(
      await ok([{ ...text, scopes: Array(4).fill({ rank: "family", value: "L" }) }]),
    ).toBe(false);
    expect(await ok([{ ...text, scopes: [{ rank: "species", value: "L" }] }])).toBe(false);
    expect(await ok([{ ...text, extra: 1 }])).toBe(false);
    expect(await ok([{ rule: "s", section: "lead", start: 0, end: 1, text: "x" }])).toBe(false);
    const c = await query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'species_tag_state_evidence_shape'",
    );
    expect(c.rows).toHaveLength(1);
  });

  let P = "";
  let firstPreview = "";

  it("Preview runs end to end: certified inputs, a stored body, the one current Preview", async () => {
    P = await propose(artifact());
    const job = await previewJob(P);
    await runWithClaim(job, () => runTagPreviewJob(job));
    const st = await jobState(job.id);
    expect(st.error).toBeNull();
    expect(st.status).toBe("succeeded");
    firstPreview = st.result!.previewId!;
    const pv = (
      await query<{ body: { counts: { assignedByTaxon: number }; tag: string } }>(
        "SELECT body FROM tag_proposal_preview WHERE id = $1",
        [firstPreview],
      )
    ).rows[0];
    expect(pv.body.tag).toBe(T);
    expect(pv.body.counts.assignedByTaxon).toBeGreaterThanOrEqual(3);
    const cur = await query<{ id: string }>(
      "SELECT public.tag_current_preview_id($1)::text AS id",
      [P],
    );
    expect(cur.rows[0].id).toBe(firstPreview);
  }, 600_000);

  it("a second run over the same corpus reproduces the same body (idempotent row)", async () => {
    const job = await previewJob(P);
    await runWithClaim(job, () => runTagPreviewJob(job));
    expect((await jobState(job.id)).result?.previewId).toBe(firstPreview);
  }, 600_000);

  it("record_tag_preview: no app DML; a different body for the same key, a moved corpus and a stale claim are refused", async () => {
    await expect(
      query(
        `INSERT INTO tag_proposal_preview (proposal_id, artifact_sha256, corpus_fingerprint, preview_design_hash, job_id, body, body_sha256)
         SELECT $1, artifact_sha256, $2, $2, 1, '{}'::jsonb, $2 FROM tag_rule_proposal WHERE id = $1`,
        [P, "0".repeat(64)],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      query("DELETE FROM tag_proposal_preview WHERE id = $1", [firstPreview]),
    ).rejects.toThrow(/permission denied/);
    const job = await previewJob(P);
    const fp = (await query<{ f: string }>("SELECT public.tag_corpus_fingerprint() AS f")).rows[0].f;
    const record = (j: JobRow, fingerprint: string, body: unknown) =>
      withTagWriteTx("shared", `test-preview-${fx.RUN}`, "test", (tx) =>
        tx.exec("SELECT public.record_tag_preview($1, $2, $3, $4, $5, $6::jsonb)", [
          P,
          j.id,
          j.attempts,
          j.claim_seq,
          fingerprint,
          JSON.stringify(body),
        ]),
      );
    await expect(record(job, fp, { different: true })).rejects.toThrow(/nondeterministic body/);
    await expect(record(job, "f".repeat(64), { any: 1 })).rejects.toThrow(
      /changed during the Preview/,
    );
    const stale = { ...job };
    await claimSeqBump(job); // a newer claim now owns the job
    await expect(record(stale, fp, { any: 1 })).rejects.toThrow(/stale claim/);
    // Not under the engine lock at all:
    await expect(
      query("SELECT public.record_tag_preview($1, $2, $3, $4, $5, '{}'::jsonb)", [
        P,
        job.id,
        job.attempts,
        job.claim_seq,
        fp,
      ]),
    ).rejects.toThrow(/lock not held/);
  }, 600_000);

  it("a stale Preview job (drain + re-claim) stores nothing", async () => {
    const P2 = await propose(artifact({ rev: `zzv-${fx.RUN}-2` }));
    const a = await previewJob(P2);
    await runWithClaim(a, () => requeueInterrupted(a.id, a.attempts));
    await query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, claim_seq = claim_seq + 1 WHERE id = $1`,
      [a.id],
    );
    await runWithClaim(a, () => runTagPreviewJob(a)).catch(() => {});
    const rows = await query("SELECT 1 FROM tag_proposal_preview WHERE proposal_id = $1", [P2]);
    expect(rows.rows).toHaveLength(0);
    expect((await jobState(a.id)).status).toBe("running"); // the live claim's, untouched
  }, 600_000);

  it("cross-check binds the current Preview; schema 2 without one is refused", async () => {
    const P3 = await propose(artifact({ rev: `zzv-${fx.RUN}-3` }));
    await expect(crosscheck(P3)).rejects.toThrow(/no current Preview/);
    await expect(
      withOwnerClient((c) =>
        c.query(
          `INSERT INTO tag_crosscheck (proposal_id, reviewer, verdict, text, reviewed_sha256)
           SELECT id, 'CODEX1', 'approve', 'direct', artifact_sha256 FROM tag_rule_proposal WHERE id = $1`,
          [P3],
        ),
      ),
    ).rejects.toThrow(/needs its current Preview/);
    await crosscheck(P);
    const c = await query<{ preview_id: string }>(
      "SELECT preview_id::text FROM tag_crosscheck WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1",
      [P],
    );
    expect(c.rows[0].preview_id).toBe(firstPreview);
  });

  it("approval: refused once the corpus moves after the cross-check; allowed when current", async () => {
    // Move the corpus: one fixture species' article changes → its input hash.
    const extra = await fx.addSpecies("d");
    await fx.settleUniverse();
    expect(await approvalRefusal(P)).toBeNull(); // the rules themselves are fine
    await expect(approveProposal(P, fx.adminId)).rejects.toThrow(/data changed since the cross-check/);
    // A fresh Preview + a fresh cross-check make it approvable again.
    const job = await previewJob(P);
    await runWithClaim(job, () => runTagPreviewJob(job));
    expect((await jobState(job.id)).status).toBe("succeeded");
    await crosscheck(P);
    const rev = await approveProposal(P, fx.adminId);
    expect(rev).toMatch(/^[0-9]+$/);
    fx.revisions[`${T}#v2`] = rev;
    void extra;
  }, 600_000);

  it("the tag page read model shows each proposal's Preview and whether it is current", async () => {
    const d = (await tagDetail(T))!;
    const p = d.proposals.find((x) => x.id === P)!;
    expect(p.schemaVersion).toBe(2);
    expect(p.preview).toMatchObject({ current: true });
    expect(p.crosscheck).toMatchObject({ verdict: "approve", previewCurrent: true });
    const never = d.proposals.find((x) => x.preview === null && x.schemaVersion === 2);
    expect(never).toBeDefined();
  });

  it("approval refuses rules that no longer fit the taxonomy (TS loader + taxonomy check)", async () => {
    const bad = await propose(
      artifact({
        rev: `zzv-${fx.RUN}-bad`,
        taxon: [
          { id: "a", rank: "family", action: "assign", values: ["Fixtureidae"], note: "n" },
          { id: "f", rank: "order", action: "forbid", values: ["Charadriiformes"], note: "n" },
        ],
      }),
    );
    expect(await approvalRefusal(bad)).toMatch(/do not fit the current taxonomy/);
  });

  it("the NEWEST cross-check decides: a later 'changes' revokes an earlier 'approve' (CODEX1 review P1-2)", async () => {
    const Q = await propose(artifact({ rev: `zzv-${fx.RUN}-newest` }));
    const job = await previewJob(Q);
    await runWithClaim(job, () => runTagPreviewJob(job));
    expect((await jobState(job.id)).status).toBe("succeeded");
    await crosscheck(Q, "approve");
    await crosscheck(Q, "changes");
    await expect(approveProposal(Q, fx.adminId)).rejects.toThrow(/latest cross-check/);
    await expect(
      query("SELECT public.approve_tag_proposal($1, $2)", [Q, fx.adminId]),
    ).rejects.toThrow(/latest cross-check/);
    await crosscheck(Q, "approve");
    const rev = await approveProposal(Q, fx.adminId);
    fx.revisions[`${T}#newest`] = rev;
  }, 600_000);

  it("even a DIRECT definer call cannot approve rules whose bound Preview recorded taxonomy problems (P1-1)", async () => {
    const bad = await propose(
      artifact({
        rev: `zzv-${fx.RUN}-direct`,
        taxon: [
          { id: "a", rank: "family", action: "assign", values: ["Fixtureidae"], note: "n" },
          { id: "f", rank: "order", action: "forbid", values: ["Charadriiformes"], note: "n" },
        ],
      }),
    );
    const job = await previewJob(bad);
    await runWithClaim(job, () => runTagPreviewJob(job));
    const pv = (
      await query<{ body: { taxonCheck: { overlapCount: number } } }>(
        "SELECT body FROM tag_proposal_preview WHERE proposal_id = $1",
        [bad],
      )
    ).rows[0];
    expect(pv.body.taxonCheck.overlapCount).toBeGreaterThan(0);
    await crosscheck(bad, "approve");
    await expect(
      query("SELECT public.approve_tag_proposal($1, $2)", [bad, fx.adminId]),
    ).rejects.toThrow(/do not fit the current taxonomy/);
    await expect(approveProposal(bad, fx.adminId)).rejects.toThrow(/do not fit the current taxonomy/);
  }, 600_000);

  it("family-reference writes from the job are fenced to its live claim and requester (P2-2)", async () => {
    await expect(
      query("SELECT public.record_tag_family_reference('x', 'x', 'missing', NULL, NULL, NULL, NULL)"),
    ).rejects.toThrow(/permission denied/);
    const id = (
      await query<{ id: number }>(
        `INSERT INTO jobs (type, payload, requested_by, label, max_attempts)
         VALUES ('tag_family_refs', '{}', $1, 'zzv family refs', 2) RETURNING id`,
        [fx.adminId],
      )
    ).rows[0].id;
    const job = await fx.claim(id);
    const code = `zzv-fam-${fx.RUN}`;
    const write = (j: { attempts: number; claim_seq?: string }, rev: number) =>
      query(
        "SELECT public.record_tag_family_reference_for_job($1, $2, $3, $4, 'Zzvidae', 'ok', 'Zzvidae', $5, 'Lead.', NULL)",
        [id, j.attempts, j.claim_seq, code, rev],
      );
    await write(job, 1);
    const newer = await claimSeqBump(job);
    await expect(write(job, 2)).rejects.toThrow(/stale claim/);
    await write(newer, 3);
    expect(
      (
        await query<{ rev_id: string }>(
          "SELECT rev_id::text FROM tag_family_reference WHERE family_code = $1",
          [code],
        )
      ).rows[0].rev_id,
    ).toBe("3");
    await query("UPDATE users SET role = 'user' WHERE id = $1", [fx.adminId]);
    try {
      await expect(write(newer, 4)).rejects.toThrow(/no longer an admin/);
    } finally {
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [fx.adminId]);
    }
    await withOwnerClient((c) =>
      c.query("DELETE FROM tag_family_reference WHERE family_code = $1", [code]),
    );
  });

  it("family references: the definer computes the hash; the frame binds family code and reference", async () => {
    const code = `zzv-ref-${fx.RUN}`;
    await withOwnerClient((c) => c.query("SELECT public.record_tag_family_reference($1, 'Zzvidae', 'ok', 'Zzvidae', 7, 'Lead.', NULL)", [code]));
    const r = await query<{ reference_sha: string; want: string }>(
      `SELECT reference_sha, public.tag_reference_sha($1, 'Zzvidae', 7, 'Lead.') AS want
         FROM tag_family_reference WHERE family_code = $1`,
      [code],
    );
    expect(r.rows[0].reference_sha).toBe(r.rows[0].want);
    // A revision-only change moves the hash; a failed fetch clears it.
    await withOwnerClient((c) => c.query("SELECT public.record_tag_family_reference($1, 'Zzvidae', 'ok', 'Zzvidae', 8, 'Lead.', NULL)", [code]));
    const r2 = await query<{ reference_sha: string }>(
      "SELECT reference_sha FROM tag_family_reference WHERE family_code = $1",
      [code],
    );
    expect(r2.rows[0].reference_sha).not.toBe(r.rows[0].reference_sha);
    await withOwnerClient((c) => c.query("SELECT public.record_tag_family_reference($1, 'Zzvidae', 'missing', NULL, NULL, NULL, NULL)", [code]));
    const r3 = await query<{ status: string; reference_sha: string | null }>(
      "SELECT status, reference_sha FROM tag_family_reference WHERE family_code = $1",
      [code],
    );
    expect(r3.rows[0]).toEqual({ status: "missing", reference_sha: null });
    await expect(
      query("INSERT INTO tag_family_reference (family_code, family_sci_name, status) VALUES ('x', 'x', 'missing')"),
    ).rejects.toThrow(/permission denied/);
    await withOwnerClient((c) => c.query("DELETE FROM tag_family_reference WHERE family_code = $1", [code]));
  });

  it("integrity: an owned schema-2 revision whose assign overlaps a forbid is reported (taxon_overlap)", async () => {
    const art = artifact({
      rev: `zzv-${fx.RUN}-overlap`,
      taxon: [
        { id: "a_fx", rank: "family", action: "assign", values: ["Fixtureidae"], note: "n" },
        { id: "f_ch", rank: "order", action: "forbid", values: ["Charadriiformes"], note: "n" },
      ],
    });
    const ids = await withOwnerClient(async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('birds.tag_fixture', 'on', true)");
      const rev = (
        await c.query<{ id: string }>(
          `INSERT INTO tag_revision (tag, source, artifact, artifact_sha256, approved_by)
           VALUES ($1, 'rules', $2::jsonb, public.tag_artifact_sha256($2::jsonb), $3) RETURNING id::text`,
          [T, JSON.stringify(art), fx.adminId],
        )
      ).rows[0].id;
      const act = (
        await c.query<{ id: string }>(
          `INSERT INTO tag_activation (tag, revision_id, action, activated_by)
           VALUES ($1, $2, 'activate', $3) RETURNING id::text`,
          [T, rev, fx.adminId],
        )
      ).rows[0].id;
      await c.query("INSERT INTO tag_ownership (tag, activation_id) VALUES ($1, $2)", [T, act]);
      await c.query("COMMIT");
      return { rev, act };
    });
    try {
      const v = await query<{ kind: string; detail: string }>(
        "SELECT kind, detail FROM tag_integrity_violations() WHERE kind = 'taxon_overlap'",
      );
      expect(v.rows.some((r) => r.detail.startsWith(`${T}: ${S.a} (a_fx vs f_ch)`))).toBe(true);
    } finally {
      await withOwnerClient(async (c) => {
        await c.query("BEGIN");
        await c.query("SELECT set_config('birds.tag_fixture', 'on', true)");
        await c.query("DELETE FROM tag_ownership WHERE tag = $1", [T]);
        await c.query("DELETE FROM tag_activation WHERE id = $1", [ids.act]);
        await c.query("DELETE FROM tag_revision WHERE id = $1", [ids.rev]);
        await c.query("COMMIT");
      });
    }
  });
});

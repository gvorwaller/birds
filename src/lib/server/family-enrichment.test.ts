import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { env } from "$env/dynamic/private";
import { randomUUID } from "node:crypto";
import { query } from "$lib/db";
import {
  familyInputHash,
  reconcileFamilyInputs,
  ensureFamilyEnrichment,
  runFamilyEnrichment,
  familyDependencies,
  familyReference,
  setFamilyPaused,
  retryFamilyGaps,
  collectFamilySource,
} from "./family-enrichment";
import {
  FamilySourceInsufficient,
  validateFamilyDescription,
  type FamilySource,
} from "./family-enrichment-ai";
import { fetchWikidataFamily } from "./wikidata";
import { taxonomySummary } from "./taxonomy-reference";
import { EnrichmentAiError } from "./ai-enrichment";
import { claimNextJob } from "./jobs";
import type { JobRow } from "./job-policy";
let admin: number;
let saved: Record<string, unknown>[];
let control: Record<string, unknown>;
let oldJobs: number[];
let oldFamilyJobs: Record<string, unknown>[];
const source: FamilySource = {
  title: "Osprey",
  url: "https://en.wikipedia.org/w/index.php?title=Osprey&oldid=1",
  revision: 1,
  qid: "Q1",
  fetchedAt: new Date().toISOString(),
  text: "Pandionidae are fish-eating birds with hooked bills and long wings. This is a source fixture used only in tests.",
};
const draft = {
  paragraphs: [
    {
      topic: "Traits",
      text: "These fish-eating birds have hooked bills and long wings.",
      evidence: ["fish-eating birds with hooked bills and long wings."],
    },
  ],
};
const attempt = (result: unknown) => ({
  result,
  servedModel: "test-model",
  requestedModel: "test-model",
  envelope: {
    requestId: null,
    httpStatus: 200,
    providerErrorType: null,
    attempts: [],
  },
});
const deps = () => ({
  ...familyDependencies,
  resolve: vi.fn().mockResolvedValue({ qid: "Q1", title: "Osprey" }),
  article: vi.fn().mockResolvedValue({
    title: "Osprey",
    revId: 1,
    extract: source.text.repeat(4),
    sections: [],
  }),
  generate: vi.fn().mockResolvedValue(attempt(draft)),
  verify: vi.fn().mockResolvedValue(attempt({ supported: true, reason: "" })),
});
const ctx = { isDraining: () => false, isPauseRequested: async () => false };
beforeAll(async () => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires isolated birds_test");
  saved = (await query("SELECT * FROM family_enrichment")).rows;
  control = (await query("SELECT * FROM family_enrichment_control")).rows[0];
  oldFamilyJobs = (
    await query(
      "SELECT * FROM jobs WHERE type='enrich_families' AND status IN ('pending','running')",
    )
  ).rows;
  oldJobs = (await query("SELECT id FROM jobs")).rows.map((r) => r.id);
  await query(
    "UPDATE jobs SET status='cancelled' WHERE type='enrich_families' AND status IN ('pending','running')",
  );
  admin = (
    await query(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Family QA','!unset','admin') RETURNING id",
      ["family-" + randomUUID()],
    )
  ).rows[0].id;
});
beforeEach(async () => {
  await query(
    "DELETE FROM jobs WHERE type='enrich_families' AND NOT(id=ANY($1::bigint[]))",
    [oldJobs],
  );
  await reconcileFamilyInputs();
  await query(
    "UPDATE family_enrichment SET content=NULL,published_hash=NULL,status='pending',next_attempt_at=NOW()+interval '1 year',failures=0,pending_source=NULL,pending_draft=NULL,pending_model=NULL",
  );
  await query(
    "UPDATE family_enrichment SET next_attempt_at=NOW() WHERE family_code='pandio1'",
  );
  await query(
    "UPDATE family_enrichment_control SET paused=false,blocked_until=NULL,reason=NULL",
  );
});
afterAll(async () => {
  await query(
    "DELETE FROM jobs WHERE type='enrich_families' AND NOT(id=ANY($1::bigint[]))",
    [oldJobs],
  );
  for (const j of oldFamilyJobs)
    await query("UPDATE jobs SET status=$2 WHERE id=$1", [j.id, j.status]);
  await query("DELETE FROM family_enrichment");
  if (saved.length)
    await query(
      "INSERT INTO family_enrichment SELECT * FROM json_populate_recordset(NULL::family_enrichment,$1::json)",
      [JSON.stringify(saved)],
    );
  await query(
    "UPDATE family_enrichment_control SET paused=$1,blocked_until=$2,reason=$3",
    [control.paused, control.blocked_until, control.reason],
  );
  await query("DELETE FROM users WHERE id=$1", [admin]);
});
async function job() {
  await ensureFamilyEnrichment(true);
  return (
    await query<JobRow>(
      "UPDATE jobs SET status='running',attempts=attempts+1 WHERE type='enrich_families' AND status='pending' RETURNING *",
    )
  ).rows[0];
}
it("requires exact family rank and rejects ambiguous Wikidata matches", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        results: {
          bindings: [
            {
              item: { value: "https://www.wikidata.org/entity/Q1" },
              article: { value: "https://en.wikipedia.org/wiki/Osprey" },
            },
          ],
        },
      }),
    ),
  );
  expect(await fetchWikidataFamily("Pandionidae", { fetcher })).toEqual({
    qid: "Q1",
    title: "Osprey",
  });
  expect(String(fetcher.mock.calls[0][1].body)).toContain("Q35409");
  const ambiguous = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        results: {
          bindings: [{ item: { value: "Q1" } }, { item: { value: "Q2" } }],
        },
      }),
    ),
  );
  expect(
    await fetchWikidataFamily("Pandionidae", { fetcher: ambiguous }),
  ).toBeNull();
  await expect(fetchWikidataFamily('bad"query', { fetcher })).rejects.toThrow();
});
it("rejects fabricated evidence and malformed drafts", () => {
  expect(validateFamilyDescription(draft, source)).toEqual(draft);
  expect(() =>
    validateFamilyDescription(
      {
        paragraphs: [
          {
            ...draft.paragraphs[0],
            evidence: ["Unsupported evidence invented by a model"],
          },
        ],
      },
      source,
    ),
  ).toThrow(/evidence/);
  expect(() => validateFamilyDescription({ paragraphs: [] }, source)).toThrow();
});
it("hash tracks identity and membership but ignores sort order", async () => {
  const f = (await taxonomySummary()).families.find(
    (f) => f.code === "pandio1",
  )!;
  expect(familyInputHash(f, ["a", "b"])).toBe(familyInputHash(f, ["b", "a"]));
  expect(familyInputHash(f, ["a"])).not.toBe(familyInputHash(f, ["b"]));
  expect(familyInputHash(f, ["a"])).not.toBe(
    familyInputHash({ ...f, scientificName: "Other" }, ["a"]),
  );
});
it("automatically publishes sourced audited content, then skips fresh work", async () => {
  const d = deps();
  await runFamilyEnrichment(await job(), ctx, d);
  const r = await familyReference("pandio1");
  expect(r.note?.content).toEqual(draft);
  expect(r.note?.status).toBe("ready");
  expect(r.note?.source?.url).toContain("oldid=1");
  expect(r.note).not.toHaveProperty("pending_draft");
  expect(r.note?.source).not.toHaveProperty("text");
  await runFamilyEnrichment(await job(), ctx, d);
  expect(d.generate).toHaveBeenCalledTimes(1);
});
it("deduplicates the recurring scheduler", async () => {
  await Promise.all([
    ensureFamilyEnrichment(),
    ensureFamilyEnrichment(),
    ensureFamilyEnrichment(),
  ]);
  expect(
    (
      await query(
        "SELECT count(*)::int AS n FROM jobs WHERE type='enrich_families' AND status IN ('pending','running')",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("checkpoints a paid draft across pause and resumes with verification only", async () => {
  const d = deps();
  d.generate.mockImplementation(async () => {
    await setFamilyPaused(true);
    return attempt(draft);
  });
  const j = await job();
  await runFamilyEnrichment(j, ctx, d);
  expect(d.verify).not.toHaveBeenCalled();
  expect(
    (
      await query(
        "SELECT pending_draft FROM family_enrichment WHERE family_code=$1",
        ["pandio1"],
      )
    ).rows[0].pending_draft,
  ).toEqual(draft);
  await setFamilyPaused(false);
  await runFamilyEnrichment(await job(), ctx, d);
  expect(d.generate).toHaveBeenCalledTimes(1);
  expect(d.verify).toHaveBeenCalledTimes(1);
});
it("preserves previous description if grounding audit fails", async () => {
  const d = deps();
  await runFamilyEnrichment(await job(), ctx, d);
  await query(
    "UPDATE family_enrichment SET next_attempt_at=NOW() WHERE family_code='pandio1'",
  );
  d.verify.mockResolvedValue(
    attempt({ supported: false, reason: "Unsupported assertion" }),
  );
  await runFamilyEnrichment(await job(), ctx, d);
  const r = await familyReference("pandio1");
  expect(r.note?.content).toEqual(draft);
  expect(r.note?.status).toBe("error");
  expect(r.note?.stale).toBe(true);
});
it("records no source without an AI call and allows retrying gaps", async () => {
  const d = deps();
  d.resolve.mockResolvedValue(null);
  await runFamilyEnrichment(await job(), ctx, d);
  expect((await familyReference("pandio1")).note?.status).toBe("no_source");
  expect(d.generate).not.toHaveBeenCalled();
  await retryFamilyGaps();
  expect(
    (
      await query(
        "SELECT next_attempt_at<=NOW() AS due FROM family_enrichment WHERE family_code='pandio1'",
      )
    ).rows[0].due,
  ).toBe(true);
});
it("rate-limits the entire family lane and pauses on AI credentials", async () => {
  const d = deps();
  d.generate.mockRejectedValue(
    new EnrichmentAiError("throttled", 429, true, 3600_000),
  );
  await runFamilyEnrichment(await job(), ctx, d);
  expect(
    (
      await query(
        "SELECT blocked_until>NOW() AS blocked FROM family_enrichment_control",
      )
    ).rows[0].blocked,
  ).toBe(true);
  await query("UPDATE family_enrichment_control SET blocked_until=NULL");
  await retryFamilyGaps();
  d.generate.mockRejectedValue(new EnrichmentAiError("invalid", 401, false));
  await runFamilyEnrichment(await job(), ctx, d);
  expect(
    (await query("SELECT paused FROM family_enrichment_control")).rows[0]
      .paused,
  ).toBe(true);
});
it("does not confuse source permission errors with AI credential failures", async () => {
  const d = deps();
  d.resolve.mockRejectedValue(
    Object.assign(Error("Forbidden"), { status: 403 }),
  );
  await runFamilyEnrichment(await job(), ctx, d);
  expect(
    (await query("SELECT paused FROM family_enrichment_control")).rows[0]
      .paused,
  ).toBe(false);
});
it("honors drain before source or paid calls", async () => {
  const d = deps();
  const j = await job();
  await runFamilyEnrichment(j, { isDraining: () => true }, d);
  expect(d.resolve).not.toHaveBeenCalled();
  expect(
    (await query("SELECT status,attempts FROM jobs WHERE id=$1", [j.id]))
      .rows[0],
  ).toEqual({ status: "pending", attempts: 0 });
});
it("claim skips paused family scheduler while serving other queued work", async () => {
  await ensureFamilyEnrichment();
  await setFamilyPaused(true);
  const pending = (
    await query(
      "SELECT id,next_retry_at FROM jobs WHERE status='pending' AND type<>'enrich_families'",
    )
  ).rows;
  let otherId: number | undefined;
  try {
    await query(
      "UPDATE jobs SET next_retry_at=NOW()+interval '1 year' WHERE id=ANY($1::bigint[])",
      [pending.map((r) => r.id)],
    );
    expect(await claimNextJob()).toBeNull();
    otherId = (
      await query(
        "INSERT INTO jobs(type,payload,requested_by,label) VALUES('sync_taxonomy','{}',$1,'Family queue QA') RETURNING id",
        [admin],
      )
    ).rows[0].id;
    expect((await claimNextJob())?.id).toBe(otherId);
    await setFamilyPaused(false);
    expect((await claimNextJob())?.type).toBe("enrich_families");
  } finally {
    if (otherId) await query("DELETE FROM jobs WHERE id=$1", [otherId]);
    for (const row of pending)
      await query("UPDATE jobs SET next_retry_at=$2 WHERE id=$1", [
        row.id,
        row.next_retry_at,
      ]);
  }
});
it.runIf(process.env.BIRDS_FAMILY_LIVE_SOURCE === "1")(
  "live family sources are usable",
  async () => {
    for (const code of ["pandio1", "anatid1", "ardeid1"]) {
      const family = (await taxonomySummary()).families.find(
        (f) => f.code === code,
      )!;
      const source = await collectFamilySource(family);
      console.log(
        "LIVE FAMILY",
        code,
        source
          ? {
              title: source.title,
              revision: source.revision,
              chars: source.text.length,
            }
          : null,
      );
      expect(source).not.toBeNull();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        ".local/family-source-" + code + ".json",
        JSON.stringify(source, null, 2),
      );
    }
  },
  180_000,
);

it.runIf(process.env.BIRDS_FAMILY_LIVE_AI === "1")(
  "live configured AI generates and audits a family account",
  async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const source = JSON.parse(
      readFileSync(".local/family-source-anatid1.json", "utf8"),
    );
    const j = await job();
    let generated = await familyDependencies.generate(j.id, "Anatidae", source);
    let verified = await familyDependencies.verify(
      j.id,
      "Anatidae",
      source,
      generated.result,
    );
    for (let repair = 0; !verified.result.supported && repair < 2; repair++) {
      generated = await familyDependencies.generate(j.id, "Anatidae", source, {
        draft: generated.result,
        feedback: verified.result.reason,
      });
      verified = await familyDependencies.verify(
        j.id,
        "Anatidae",
        source,
        generated.result,
      );
    }
    writeFileSync(
      ".local/family-live-ai.json",
      JSON.stringify(
        {
          source: { title: source.title, url: source.url },
          draft: generated.result,
          verification: verified.result,
          model: generated.servedModel,
          verifier: verified.servedModel,
        },
        null,
        2,
      ),
    );
    expect(verified.result.supported).toBe(true);
  },
  750_000,
);

it("discards a draft when taxonomy changes during generation", async () => {
  const d = deps();
  const old = (
    await query(
      "SELECT species_code,order_name FROM taxonomy_cache WHERE family_code='pandio1'",
    )
  ).rows;
  d.verify.mockImplementation(async () => {
    await query(
      "UPDATE taxonomy_cache SET order_name='Changed order for test' WHERE family_code='pandio1'",
    );
    return attempt({ supported: true, reason: "" });
  });
  try {
    await runFamilyEnrichment(await job(), ctx, d);
    expect((await familyReference("pandio1")).note?.content).toBeNull();
  } finally {
    for (const row of old)
      await query(
        "UPDATE taxonomy_cache SET order_name=$2 WHERE species_code=$1",
        [row.species_code, row.order_name],
      );
  }
});
it("cancellation before publication prevents exposing the draft", async () => {
  const d = deps(),
    j = await job();
  d.verify.mockImplementation(async () => {
    await query("UPDATE jobs SET cancel_requested=true WHERE id=$1", [j.id]);
    return attempt({ supported: true, reason: "" });
  });
  await runFamilyEnrichment(j, ctx, d);
  expect((await familyReference("pandio1")).note?.content).toBeNull();
  expect(
    (await query("SELECT status FROM jobs WHERE id=$1", [j.id])).rows[0].status,
  ).toBe("cancelled");
});

it("passes the rejected draft and audit into the corrective attempt", async () => {
  const d = deps();
  d.verify.mockResolvedValueOnce(
    attempt({ supported: false, reason: "Do not generalize that trait" }),
  );
  await runFamilyEnrichment(await job(), ctx, d);
  await retryFamilyGaps();
  await runFamilyEnrichment(await job(), ctx, d);
  expect(d.generate.mock.calls[1][3]).toMatchObject({
    draft,
    feedback: "Do not generalize that trait",
  });
  expect((await familyReference("pandio1")).note?.status).toBe("ready");
});
it("retains a paid draft when the verification service is temporarily unavailable", async () => {
  const d = deps();
  d.verify.mockRejectedValueOnce(Error("Unavailable"));
  await runFamilyEnrichment(await job(), ctx, d);
  await retryFamilyGaps();
  await runFamilyEnrichment(await job(), ctx, d);
  expect(d.generate).toHaveBeenCalledTimes(1);
  expect(d.verify).toHaveBeenCalledTimes(2);
  expect((await familyReference("pandio1")).note?.status).toBe("ready");
});

it('treats insufficient evidence as a source gap and retries source discovery later',async()=>{
 const d=deps();d.generate.mockRejectedValue(new FamilySourceInsufficient('Insufficient evidence'));
 await runFamilyEnrichment(await job(),ctx,d);
 expect(d.verify).not.toHaveBeenCalled();
 expect((await familyReference('pandio1')).note?.status).toBe('no_source');
 expect((await query("SELECT pending_source,next_attempt_at>NOW()+interval '29 days' AS deferred FROM family_enrichment WHERE family_code='pandio1'")).rows[0]).toEqual({pending_source:null,deferred:true});
});

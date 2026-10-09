/**
 * td-b99b6d Phase A (spec §6.3 "B writers"): every business writer a handler
 * reaches commits only under the LIVE claim. For each writer: under the stale
 * claim A (drained + re-claimed as B) it throws StaleClaimError and its tables
 * are unchanged; under B it writes; with no claim (page actions, admin,
 * scripts) it writes exactly as before.
 *
 * Real birds_test. Owns every row: a fixture admin, CLAIMTEST job rows, one
 * reserved species code and one reserved location code that cannot collide
 * with eBird identifiers (lower-case `zz…`, which no region/hotspot/species
 * code uses); everything is deleted by those exact keys.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, withTransaction } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import { requeueInterrupted, runWithClaim, StaleClaimError } from "./jobs";
import { ensureFrequencies, storeFrequencies } from "./barchart";
import {
  markAiError,
  markInatError,
  markMediaError,
  markWikiError,
  upsertAiProseData,
  upsertInatSimilar,
  upsertMediaOk,
} from "./species-enrichment";
import { TAG_FAILKEY_NS, withTagWriteTx } from "./tag-engine/runtime";
import { withOwnerClient } from "./tag-fixtures.test-helper";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
const LABEL = `CLAIMTEST ${RUN}`;
const CODE = `zzcw${RUN}`; // species_enrichment has no taxonomy FK; never a real code
const LOC = `zzcwloc${RUN}`; // not a region grammar (parseRegionCode → null), not an L-id
let userId = 0;

async function claim(id: number): Promise<JobRow> {
  const r = await query<JobRow>(
    `UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1,
                     heartbeat_at = NOW(), claim_seq = claim_seq + 1
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id],
  );
  expect(r.rows[0], `job ${id} claimable`).toBeDefined();
  return r.rows[0];
}

/** A drained-and-reclaimed job: A is the stale claim, B the live one. */
async function staleAndLive(): Promise<{ a: JobRow; b: JobRow }> {
  const id = (
    await query<{ id: number }>(
      `INSERT INTO jobs (type, payload, requested_by, label, max_attempts)
       VALUES ('tag_preview', '{}', $1, $2, 3) RETURNING id`,
      [userId, LABEL],
    )
  ).rows[0].id;
  const a = await claim(id);
  await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
  return { a, b: await claim(id) };
}

const enrichment = async () =>
  (
    await query("SELECT * FROM species_enrichment WHERE species_code = $1", [
      CODE,
    ])
  ).rows[0] ?? null;
const attempt = async () =>
  (
    await query(
      "SELECT status, error FROM frequency_fetch_attempts WHERE loc_code = $1",
      [LOC],
    )
  ).rows[0] ?? null;
const fetchRow = async () =>
  (
    await query("SELECT loc_name FROM frequency_fetch WHERE loc_code = $1", [
      LOC,
    ])
  ).rows[0] ?? null;

async function cleanupRows() {
  for (const t of [
    "species_media",
    "species_similar",
    "species_similar_display",
    "species_inat_similar",
    "species_enrichment",
  ])
    await query(`DELETE FROM ${t} WHERE species_code = $1`, [CODE]);
  for (const t of [
    "species_month_freq",
    "loc_month_samples",
    "frequency_fetch_attempts",
    "frequency_fetch",
  ])
    await query(`DELETE FROM ${t} WHERE loc_code = $1`, [LOC]);
}

describe
  .runIf(dbUp)
  .sequential("claim-fenced business writers (td-b99b6d Phase A)", () => {
    beforeAll(async () => {
      userId = (
        await query<{ id: number }>(
          `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Claim writers fixture', '!unset', 'admin') RETURNING id`,
          [`claimw-${RUN}`],
        )
      ).rows[0].id;
    });
    afterAll(async () => {
      await cleanupRows();
      // A successful tag transaction stamps its key cleared; the app role cannot delete it.
      await withOwnerClient((c) =>
        c.query("DELETE FROM tag_materialization_failure WHERE key LIKE $1", [
          `claimtest:${RUN}:%`,
        ]),
      );
      await query("DELETE FROM jobs WHERE label = $1", [LABEL]);
      await query("DELETE FROM users WHERE id = $1", [userId]);
    });

    it("species error marks: refused for A (row unchanged), written for B and without a claim", async () => {
      const { a, b } = await staleAndLive();
      await markWikiError(CODE, "no claim"); // creates the row, exactly as before
      expect((await enrichment()).wiki_error).toBe("no claim");
      const before = await enrichment();
      for (const f of [
        () => markWikiError(CODE, "A"),
        () => markAiError(CODE, "A"),
        () => markAiError(CODE, "A", { similarParticipating: false }),
        () => markMediaError(CODE, "A"),
        () => markInatError(CODE, "A"),
      ])
        await expect(runWithClaim(a, f)).rejects.toBeInstanceOf(
          StaleClaimError,
        );
      expect(await enrichment()).toEqual(before);
      await runWithClaim(b, () => markWikiError(CODE, "B wiki"));
      await runWithClaim(b, () => markAiError(CODE, "B ai"));
      await runWithClaim(b, () => markMediaError(CODE, "B media"));
      await runWithClaim(b, () => markInatError(CODE, "B inat"));
      const after = await enrichment();
      expect([
        after.wiki_error,
        after.ai_error,
        after.media_error,
        after.inat_similar_error,
      ]).toEqual(["B wiki", "B ai", "B media", "B inat"]);
    });

    it("transactional species writers (AI prose, media, iNat edges): refused for A, written for B", async () => {
      const { a, b } = await staleAndLive();
      const prose = {
        fieldCraft: "Fixture field craft.",
        model: "fixture-model",
        sourceRevId: 1,
        similar: [],
        similarCandidatesHash: null,
        candidateCount: 0,
        owedCodes: [],
        offeredCodes: [],
      };
      const before = await enrichment();
      await expect(
        runWithClaim(a, () => upsertAiProseData(CODE, prose)),
      ).rejects.toBeInstanceOf(StaleClaimError);
      await expect(
        runWithClaim(a, () => upsertMediaOk(CODE, [], "no_media")),
      ).rejects.toBeInstanceOf(StaleClaimError);
      await expect(
        runWithClaim(a, () =>
          upsertInatSimilar(
            CODE,
            { taxonId: 999_999_999, source: "search", sciName: null },
            [],
          ),
        ),
      ).rejects.toBeInstanceOf(StaleClaimError);
      expect(await enrichment()).toEqual(before);
      await runWithClaim(b, () => upsertAiProseData(CODE, prose));
      await runWithClaim(b, () => upsertMediaOk(CODE, [], "no_media"));
      await runWithClaim(b, () =>
        upsertInatSimilar(
          CODE,
          { taxonId: 999_999_999, source: "search", sciName: null },
          [],
        ),
      );
      const after = await enrichment();
      expect(after.ai_status).toBe("ok");
      expect(after.media_status).toBe("no_media");
      expect(after.inat_similar_status).toBe("none");
    });

    it("storeFrequencies: a stale claim stores nothing; the live claim and no claim store", async () => {
      const { a, b } = await staleAndLive();
      const params = (name: string) => ({
        locCode: LOC,
        locKind: "hotspot" as const,
        locName: name,
        beginYear: 2016,
        endYear: 2025,
        regionCode: null,
        parsed: { sampleSizes: Array(48).fill(0), rows: [] },
        matched: {
          bySpecies: new Map<string, number[]>(),
          unmatched: [],
          collisions: 0,
        },
      });
      await expect(
        runWithClaim(a, () => storeFrequencies(params("A"))),
      ).rejects.toBeInstanceOf(StaleClaimError);
      expect(await fetchRow()).toBeNull();
      expect(await attempt()).toBeNull();
      await runWithClaim(b, () => storeFrequencies(params("B")));
      expect((await fetchRow()).loc_name).toBe("B");
      expect((await attempt()).status).toBe("ok");
      await storeFrequencies(params("no claim"));
      expect((await fetchRow()).loc_name).toBe("no claim");
    });

    it("a failed unit's attempt record: a stale claim leaves none and stops the load; the live claim records it", async () => {
      const { a, b } = await staleAndLive();
      await query("DELETE FROM frequency_fetch_attempts WHERE loc_code = $1", [
        LOC,
      ]);
      await query("DELETE FROM frequency_fetch WHERE loc_code = $1", [LOC]);
      const loc = { code: LOC, kind: "hotspot" as const, name: "Fixture" };
      const failing = {
        fetcher: async () => Promise.reject(new Error("provider down")),
        sleep: async () => {},
      };
      await expect(
        runWithClaim(a, () => ensureFrequencies(userId, [loc], failing)),
      ).rejects.toBeInstanceOf(StaleClaimError);
      expect(await attempt()).toBeNull();
      const r = await runWithClaim(b, () =>
        ensureFrequencies(userId, [loc], failing),
      );
      expect(r.failed.map((f) => f.code)).toEqual([LOC]);
      expect(await attempt()).toEqual({
        status: "error",
        error: "provider down",
      });
    });

    it("the central tag-transaction fence: a stale claim never runs the callback and records no materialization failure", async () => {
      const { a, b } = await staleAndLive();
      const key = `claimtest:${RUN}:tag`;
      let ran = 0;
      await expect(
        runWithClaim(a, () =>
          withTagWriteTx("shared", key, "claimtest", async () => {
            ran++;
          }),
        ),
      ).rejects.toBeInstanceOf(StaleClaimError);
      expect(ran).toBe(0);
      expect(
        (
          await query(
            "SELECT 1 FROM tag_materialization_failure WHERE key = $1",
            [key],
          )
        ).rows,
      ).toHaveLength(0);
      await runWithClaim(b, () =>
        withTagWriteTx("shared", key, "claimtest", async () => {
          ran++;
        }),
      );
      expect(ran).toBe(1);
    });

    // ── the tag engine's failure record (CODEX1 Phase A review #1) ──────────
    const failureRow = async (key: string) =>
      (
        await query<{ entry_point: string; last_attempt_no: string }>(
          "SELECT entry_point, last_attempt_no::text FROM tag_materialization_failure WHERE key = $1",
          [key],
        )
      ).rows[0] ?? null;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("a failure after the fence, then a re-claim before the follow-up record: no failure row, StaleClaimError", async () => {
      const { b } = await staleAndLive();
      const key = `claimtest:${RUN}:fail-after-fence`;
      let reclaim: Promise<unknown> | null = null;
      await expect(
        runWithClaim(b, () =>
          withTagWriteTx("shared", key, "claimtest", async () => {
            // Another worker re-claims the job: it waits on this transaction's
            // FOR SHARE and lands the moment the failure rolls it back.
            reclaim = query(
              "UPDATE jobs SET claim_seq = claim_seq + 1 WHERE id = $1",
              [b.id],
            );
            await sleep(150);
            throw new Error("materialize failed");
          }),
        ),
      ).rejects.toBeInstanceOf(StaleClaimError);
      await reclaim;
      expect(await failureRow(key)).toBeNull();
    });

    it("a lock-phase error BEFORE the fence under a stale claim records no failure", async () => {
      const { a } = await staleAndLive();
      const key = `claimtest:${RUN}:lock-phase`;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let held!: (pid: number) => void;
      const holderPid = new Promise<number>((r) => (held = r));
      // Connection 2 holds this key's fail-key lock, so the transaction waits
      // at its second lock — before the claim fence — and is cancelled there.
      const holder = withTransaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [
          TAG_FAILKEY_NS,
          key,
        ]);
        held(
          (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid,
        );
        await gate;
      });
      try {
        const other = await holderPid;
        const attempt = runWithClaim(a, () =>
          withTagWriteTx("shared", key, "claimtest", async () => {}),
        ).then(
          () => null,
          (e: unknown) => e,
        );
        let waiter: number | undefined;
        for (let i = 0; i < 50 && waiter == null; i++) {
          await sleep(50);
          waiter = (
            await query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> $1 AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
              [other],
            )
          ).rows[0]?.pid;
        }
        expect(
          waiter,
          "the tag transaction is waiting on the fail-key lock",
        ).toBeDefined();
        await query("SELECT pg_cancel_backend($1)", [waiter]);
        expect(await attempt).toBeInstanceOf(StaleClaimError);
        expect(await failureRow(key)).toBeNull();
      } finally {
        release();
        await holder;
      }
    });

    it("with no claim a failure still records exactly as before (post-attempt token)", async () => {
      const key = `claimtest:${RUN}:no-claim`;
      let post = "";
      await expect(
        withTagWriteTx("shared", key, "claimtest", async (tx) => {
          post = tx.postAttemptNo.toString();
          throw new Error("materialize failed");
        }),
      ).rejects.toThrow("materialize failed");
      expect(await failureRow(key)).toEqual({
        entry_point: "claimtest",
        last_attempt_no: post,
      });
    });
  });

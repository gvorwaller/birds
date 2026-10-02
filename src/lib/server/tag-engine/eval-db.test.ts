/**
 * td-894144 B4 (plan rev 25 §B4c, §B4g2, §B4h, §B4i): migration 0071's
 * contract against real birds_test SQL. Owned fixtures (zze…) through the
 * shared engine fixture; everything created is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { activateRevision, stageRevision } from "./activation";
import { __registerEvalDesignForTests, designHash } from "./eval-design";
import { buildFrame, canonicalFrameHash } from "./eval-frame";
import { createEvalSet, rankKey, selectSample } from "./eval-sample";
import { PROPOSED_GATES, STRATA } from "./eval-stats";
import {
  censusGate,
  cleanupEvalSets,
  cleanupFamilyReferences,
  FIXTURE_GATES,
  tagEngineFixture,
} from "./engine-fixture.test-helper";
import { tagRepairState } from "./repair";
import { withOwnerClient } from "../tag-fixtures.test-helper";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT to_regprocedure('public.tag_eval_frame_hash(text,bigint,text[],text)') IS NOT NULL AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

const fx = tagEngineFixture("zze");
const sets = { setIds: new Set<string>(), refs: new Set<string>() };
let T = "";
let rev = "";
const S: Record<string, string> = {};
const SEED = "a".repeat(64);

async function approveOnly(tag: string): Promise<string> {
  // Reuse the fixture's approve path, then retire so the tag is unowned.
  await fx.approveAndActivate(tag);
  await fx.retire(tag);
  return fx.revisions[tag];
}

describe.runIf(migrated).sequential("0071 blind-test contract", () => {
  beforeAll(async () => {
    if ((await tagRepairState())?.pending)
      throw new Error("refusing to run while a repair is pending");
    await fx.setup(1);
    T = fx.tags[0];
    __registerEvalDesignForTests(T);
    for (const k of ["a", "b", "c", "d", "e", "f"])
      S[k] = await fx.addSpecies(k);
    await fx.settleUniverse();
    rev = await approveOnly(T);
    await stageRevision(T, rev);
  }, 240_000);

  afterAll(async () => {
    await cleanupEvalSets(sets.setIds);
    await cleanupFamilyReferences(sets.refs);
    await fx.cleanup();
  }, 240_000);

  it("the SQL frame hash equals the TypeScript canonical bytes", async () => {
    const frame = await buildFrame(T, rev);
    expect(frame.missingStates).toBe(0);
    expect(frame.N.B).toBeGreaterThanOrEqual(6);
    const sql = (
      await query<{ h: string }>(
        "SELECT tag_eval_frame_hash($1, $2, $3::text[], $4) AS h",
        [T, rev, [], frame.designHash],
      )
    ).rows[0].h;
    expect(sql).toBe(frame.frameHash);
    // Order-independent on the TS side; the SQL side orders by code COLLATE "C".
    expect(
      canonicalFrameHash(frame.designHash, [...frame.rows].reverse()),
    ).toBe(frame.frameHash);
  }, 60_000);

  it("create_tag_eval_set reproduces the seeded selection and refuses a tampered one", async () => {
    const frame = await buildFrame(T, rev);
    const n = Object.fromEntries(STRATA.map((h) => [h, 0])) as typeof frame.N;
    n.B = 3;
    const expected = selectSample(frame, n, SEED)
      .map((r) => r.code)
      .sort();
    // The DB's own ranking agrees with the TS one.
    const ranked = frame.rows
      .filter((r) => r.stratum === "B")
      .map((r) => ({ c: r.code, k: rankKey(SEED, T, rev, "B", r.code) }))
      .sort((a, b) => (a.k < b.k ? -1 : 1))
      .slice(0, 3)
      .map((x) => x.c)
      .sort();
    expect(expected).toEqual(ranked);
    // Tamper: substitute one selected species with an unselected one.
    const picked = selectSample(frame, n, SEED);
    const spare = frame.rows.find(
      (r) => r.stratum === "B" && !expected.includes(r.code),
    )!;
    const design = {
      algorithm: "sha256-rank-v1",
      seed: SEED,
      designHash: frame.designHash,
      frameHash: frame.frameHash,
      marineOrders: [],
      N: frame.N,
      n,
    };
    const item = (r: (typeof picked)[number], i: number) => ({
      species_code: r.code,
      stratum: r.stratum,
      rules_yes: r.rulesYes,
      legacy_yes: r.legacyYes,
      rules_status: r.status,
      marine: r.marine,
      display_position: i + 1,
      eval_text_hash: r.evalTextHash,
      article: r.evalText,
    });
    const tampered = [...picked.slice(0, 2), spare].map(item);
    await expect(
      query(
        "SELECT create_tag_eval_set($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)",
        [
          T,
          rev,
          JSON.stringify(design),
          JSON.stringify(tampered),
          JSON.stringify(FIXTURE_GATES),
          fx.adminId,
        ],
      ),
    ).rejects.toThrow(/not the seeded selection/);
    // A stale frame hash is refused too.
    await expect(
      query(
        "SELECT create_tag_eval_set($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)",
        [
          T,
          rev,
          JSON.stringify({ ...design, frameHash: "f".repeat(64) }),
          JSON.stringify(picked.map(item)),
          JSON.stringify(FIXTURE_GATES),
          fx.adminId,
        ],
      ),
    ).rejects.toThrow(/frame changed/);
    // The honest selection is accepted, with π = n/N.
    const set = await createEvalSet({
      tag: T,
      revisionId: rev,
      n,
      expectedFrameHash: frame.frameHash,
      gates: FIXTURE_GATES,
      userId: fx.adminId,
      seed: SEED,
    });
    sets.setIds.add(set.setId);
    const items = (
      await query<{ species_code: string; inclusion_prob: number }>(
        "SELECT species_code, inclusion_prob FROM tag_eval_item WHERE set_id = $1 ORDER BY species_code",
        [set.setId],
      )
    ).rows;
    expect(items.map((i) => i.species_code)).toEqual(expected);
    expect(items[0].inclusion_prob).toBeCloseTo(3 / frame.N.B);
    // Abandon it so later tests can open a new labelling set for this revision.
    await query("SELECT abandon_tag_eval_set($1, $2)", [set.setId, fx.adminId]);
  }, 60_000);

  it("labels: reused across sets by page; write-once; only for an item of a labelling set; freeze needs every label", async () => {
    // Every existing frame page was labelled by the setup census set. A new species' page was not.
    S.g = await fx.addSpecies("g");
    await fx.settleUniverse();
    await stageRevision(T, rev);
    const frame = await buildFrame(T, rev);
    const n = Object.fromEntries(
      STRATA.map((h) => [h, frame.N[h]]),
    ) as typeof frame.N;
    const s1 = await createEvalSet({
      tag: T,
      revisionId: rev,
      n,
      expectedFrameHash: frame.frameHash,
      gates: FIXTURE_GATES,
      userId: fx.adminId,
      seed: "b".repeat(64),
    });
    sets.setIds.add(s1.setId);
    const items = (
      await query<{ id: string; species_code: string; labelled: boolean }>(
        `SELECT i.id::text, i.species_code,
				        EXISTS (SELECT 1 FROM tag_eval_label l WHERE l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash) AS labelled
				   FROM tag_eval_item i WHERE i.set_id = $1`,
        [s1.setId, T],
      )
    ).rows;
    const fresh = items.filter((i) => !i.labelled);
    expect(fresh.map((i) => i.species_code)).toEqual([S.g]); // reuse: only the new page needs a label
    await expect(
      query("SELECT freeze_tag_eval_set($1, $2)", [s1.setId, fx.adminId]),
    ).rejects.toThrow(/1 item\(s\) are not labelled/);
    const old = items.find((i) => i.labelled)!;
    await expect(
      query("SELECT record_tag_eval_label($1, $2, $3, $4)", [
        s1.setId,
        old.id,
        fx.adminId,
        "no",
      ]),
    ).rejects.toThrow(/write-once/);
    await expect(
      query("SELECT record_tag_eval_label($1, $2, $3, $4)", [
        s1.setId,
        "999999999",
        fx.adminId,
        "no",
      ]),
    ).rejects.toThrow(/not in set/);
    await expect(
      query(
        `INSERT INTO tag_eval_label (tag, species_code, eval_text_hash, label, labeled_by, first_set_id) VALUES ($1, 'x', $2, 'yes', 1, $3)`,
        [T, "c".repeat(64), s1.setId],
      ),
    ).rejects.toThrow(/permission denied/);
    await query("SELECT record_tag_eval_label($1, $2, $3, $4)", [
      s1.setId,
      fresh[0].id,
      fx.adminId,
      "yes",
    ]); // carried over to later sets
    await query("SELECT freeze_tag_eval_set($1, $2)", [s1.setId, fx.adminId]);
    await expect(
      query("SELECT record_tag_eval_label($1, $2, $3, $4)", [
        s1.setId,
        fresh[0].id,
        fx.adminId,
        "no",
      ]),
    ).rejects.toThrow(/not labelling/);
  }, 120_000);

  it("cross-checks are owner-role only; the hash is recomputed; the reviewer must be CODEX1/CODEX", async () => {
    const p = (
      await query<{ id: string }>(
        `INSERT INTO tag_rule_proposal (tag, artifact, source) VALUES ($1, '{"schema":1,"x":1}'::jsonb, 'human') RETURNING id::text`,
        [T],
      )
    ).rows[0].id;
    fx.proposals.push(p);
    await expect(
      query(`SELECT record_tag_crosscheck($1, 'CODEX1', 'approve', 'ok')`, [p]),
    ).rejects.toThrow(/permission denied/);
    await withOwnerClient(async (c) => {
      await expect(
        c.query(
          `SELECT record_tag_crosscheck($1, 'Someone', 'approve', 'ok')`,
          [p],
        ),
      ).rejects.toThrow(/reviewer must be/);
      await c.query(
        `SELECT record_tag_crosscheck($1, 'CODEX1', 'approve', 'ok')`,
        [p],
      );
    });
    const r = (
      await query<{ same: boolean; status: string }>(
        `SELECT c.reviewed_sha256 = tag_artifact_sha256(p.artifact) AS same, p.status
				   FROM tag_crosscheck c JOIN tag_rule_proposal p ON p.id = c.proposal_id WHERE p.id = $1`,
        [p],
      )
    ).rows[0];
    expect(r).toEqual({ same: true, status: "crosschecked" });
  });

  it("a rename alone (scientific epithet) changes the frame — the page's masked names are bound (CODEX1 rev-25 P1-1)", async () => {
    const before = (await buildFrame(T, rev)).frameHash;
    const code = S.b;
    const old = (
      await query<{ sci_name: string }>(
        "SELECT sci_name FROM taxonomy_cache WHERE species_code = $1",
        [code],
      )
    ).rows[0].sci_name;
    await query(
      "UPDATE taxonomy_cache SET sci_name = $2 WHERE species_code = $1",
      [code, `${old.split(" ")[0]} renamed`],
    );
    try {
      expect((await buildFrame(T, rev)).frameHash).not.toBe(before);
      const sql = (
        await query<{ h: string }>(
          "SELECT tag_eval_frame_hash($1, $2, $3::text[], $4) AS h",
          [T, rev, [], (await buildFrame(T, rev)).designHash],
        )
      ).rows[0].h;
      expect(sql).toBe((await buildFrame(T, rev)).frameHash);
    } finally {
      await query(
        "UPDATE taxonomy_cache SET sci_name = $2 WHERE species_code = $1",
        [code, old],
      );
    }
    expect((await buildFrame(T, rev)).frameHash).toBe(before);
  }, 60_000);

  it("a gate report carrying a different gates hash than the set's confirmed JSON is refused (strict vs lax)", async () => {
    const g = await censusGate(T, rev, fx.adminId, sets);
    const body = (
      await query<{ body: Record<string, unknown> }>(
        "SELECT body FROM tag_report WHERE id = $1",
        [g.gate],
      )
    ).rows[0].body;
    const lax = { ...FIXTURE_GATES, precision: { point_min: 0, lower_min: 0 } };
    const { createHash } = await import("node:crypto");
    const laxSha = createHash("sha256")
      .update(JSON.stringify(lax))
      .digest("hex");
    await expect(
      query("SELECT record_tag_report('gate', $1, $2, $3::jsonb)", [
        T,
        rev,
        JSON.stringify({ ...body, gatesSha256: laxSha }),
      ]),
    ).rejects.toThrow(/frozen eval set/);
  }, 120_000);

  it("a gate report must name a frozen set of the same revision with its gates hash", async () => {
    await expect(
      query(
        `SELECT record_tag_report('gate', $1, $2, '{"passed":true}'::jsonb)`,
        [T, rev],
      ),
    ).rejects.toThrow(/frozen eval set/);
  });

  it("activation verifies the frame INSIDE the switch: drift after the blind test refuses; a dry run never commits", async () => {
    const g = await censusGate(T, rev, fx.adminId, sets);
    // Dry run: nothing persists.
    const before = Number(
      (
        await query<{ n: string }>(
          "SELECT count(*)::text AS n FROM tag_activation WHERE tag = $1",
          [T],
        )
      ).rows[0].n,
    );
    await activateRevision({
      tag: T,
      revisionId: rev,
      userId: fx.adminId,
      dryRun: true,
    });
    expect(
      Number(
        (
          await query<{ n: string }>(
            "SELECT count(*)::text AS n FROM tag_activation WHERE tag = $1",
            [T],
          )
        ).rows[0].n,
      ),
    ).toBe(before);
    expect(
      (await query("SELECT 1 FROM tag_ownership WHERE tag = $1", [T])).rows,
    ).toHaveLength(0);
    // Drift: a frame member's article changes after the set froze.
    await fx.plant(async (exec) => {
      await fx.repoint(exec, S.a, { text: "d".repeat(64) });
    });
    await expect(
      activateRevision({
        tag: T,
        revisionId: rev,
        gateReportId: g.gate,
        benchmarkReportId: g.bench,
        userId: fx.adminId,
      }),
    ).rejects.toThrow(/frame changed since the blind test/);
    expect(
      (await query("SELECT 1 FROM tag_ownership WHERE tag = $1", [T])).rows,
    ).toHaveLength(0);
    await fx.settleUniverse();
  }, 120_000);

  it("pinned hashes and grants: the proposed gate JSON's DB hash, the open-ocean design hash, and no app EXECUTE on tag_eval_frame_rows", async () => {
    const g = (
      await query<{ h: string }>(
        "SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') AS h",
        [JSON.stringify(PROPOSED_GATES)],
      )
    ).rows[0].h;
    expect(g).toBe(
      "24ae83e5f160eb506c29c14bf913cf2fd97183b52375b7331d594b1454971604",
    );
    expect(designHash("habitat:open-ocean")).toBe(
      "52566103b720bf581f6325fd1f8b80f888296d8eb91dd682f53c71399c21e362",
    );
    const priv = (
      await query<{ rows_ok: boolean; hash_ok: boolean }>(
        `SELECT has_function_privilege('birds_app', 'public.tag_eval_frame_rows(text,bigint,text[])', 'EXECUTE') AS rows_ok,
                has_function_privilege('birds_app', 'public.tag_eval_frame_hash(text,bigint,text[],text)', 'EXECUTE') AS hash_ok`,
      )
    ).rows[0];
    expect(priv).toEqual({ rows_ok: false, hash_ok: true });
  });

  it("a set records its selection and π, and the definer refuses a design that misstates them (CODEX1 rev-26 #4)", async () => {
    const frame = await buildFrame(T, rev);
    const n = Object.fromEntries(STRATA.map((h) => [h, 0])) as typeof frame.N;
    n.B = 2;
    const picked = selectSample(frame, n, "e".repeat(64));
    const item = (r: (typeof picked)[number], i: number) => ({
      species_code: r.code,
      stratum: r.stratum,
      rules_yes: r.rulesYes,
      legacy_yes: r.legacyYes,
      rules_status: r.status,
      marine: r.marine,
      display_position: i + 1,
      eval_text_hash: r.evalTextHash,
      article: r.evalText,
      family_reference: r.familyReference,
    });
    const base = {
      algorithm: "sha256-rank-v1",
      seed: "e".repeat(64),
      designHash: frame.designHash,
      frameHash: frame.frameHash,
      marineOrders: [],
      N: frame.N,
      n,
      pi: Object.fromEntries(
        Object.entries(frame.N)
          .filter(([, v]) => v > 0)
          .map(([h, v]) => [h, n[h as keyof typeof n] / v]),
      ),
      selectedCodes: picked.map((r) => r.code).sort(),
    };
    const create = (design: unknown) =>
      query(
        "SELECT create_tag_eval_set($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)::text AS id",
        [
          T,
          rev,
          JSON.stringify(design),
          JSON.stringify(picked.map(item)),
          JSON.stringify(FIXTURE_GATES),
          fx.adminId,
        ],
      );
    await expect(
      create({
        ...base,
        selectedCodes: [...base.selectedCodes.slice(1), "zzz"],
      }),
    ).rejects.toThrow(/selectedCodes/);
    await expect(
      create({ ...base, pi: { ...base.pi, B: 0.99 } }),
    ).rejects.toThrow(/design.pi/);
    const ok = (await create(base)).rows[0] as { id: string };
    sets.setIds.add(ok.id);
    const stored = (
      await query<{ design: { selectedCodes: string[] } }>(
        "SELECT design FROM tag_eval_set WHERE id = $1",
        [ok.id],
      )
    ).rows[0].design;
    expect(stored.selectedCodes).toEqual(base.selectedCodes);
    await query("SELECT abandon_tag_eval_set($1, $2)", [ok.id, fx.adminId]);
  }, 60_000);
});

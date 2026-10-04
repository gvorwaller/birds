/**
 * TEST-ONLY owned-tag fixture for tag-engine DB suites (td-894144 Release B).
 *
 * Ownership is global and accepts only the controlled vocabulary, so a suite
 * that owns tags must: pick the unowned tags with the fewest real carriers,
 * snapshot every affected real row and restore it exactly in cleanup (even
 * after a failed assertion), act through a dedicated fixture admin, and delete
 * every job / activation / revision it created by its exact id. The pattern is
 * CODEX1's (repair-db review); this factory shares it.
 *
 * Never import this from runtime code — the static guard enforces it.
 */
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { query } from "$lib/db";
import { ALL_TAGS } from "$lib/species-tags";
import type { JobRow } from "$server/job-policy";
import { upsertWikiOk } from "../species-enrichment";
import { withOwnerClient } from "../tag-fixtures.test-helper";
import {
  activateRevision,
  retireTagToLegacy,
  stageRevision,
} from "./activation";
import {
  __resetTagEngineCachesForTests,
  lexiconFor,
  materializeMany,
} from "./materialize";
import { closePendingRepairInline, tagRepairState } from "./repair";
import { __registerEvalDesignForTests, tagEvalDesign } from "./eval-design";
import { buildFrame } from "./eval-frame";
import { PROPOSED_GATES, STRATA } from "./eval-stats";
import { createEvalSet, recordGateReport } from "./eval-sample";
import { withTagWriteTx } from "./runtime";
import { scannerRev } from "./segment";

export const hex = (s: string) =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

export type Exec = (
  sql: string,
  p?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface InputRow {
  input_hash: string;
  text_hash: string;
  order_name: string | null;
  family_sci_name: string | null;
  lexicon_hash: string;
  focal_exempt_hash: string;
  scanner_rev: string;
  genus: string | null;
}

/** Fixture gates: the proposed thresholds, no named cases (fixture tags have none). */
export const FIXTURE_GATES = {
  ...PROPOSED_GATES,
  named_cases_must_not: [] as string[],
};

/**
 * A real, frozen CENSUS blind-test set for a fixture tag revision plus its
 * gate and benchmark reports (plan rev 25: activation verifies gate → frozen
 * set → frame hash). Labels: rules-yes → "yes", legacy-only → "no", so the
 * fixture passes; pages already labelled are reused (labels are write-once).
 */
export async function censusGate(
  tag: string,
  revisionId: string,
  adminId: number,
  track: { setIds: Set<string>; refs?: Set<string> },
  opts: {
    /** The answer each unlabelled page gets (default: what the rules say, so the gate passes). */
    label?: (rulesYes: boolean) => "yes" | "no" | "unsure";
    /** The gate JSON confirmed for the set (default FIXTURE_GATES). */
    gates?: typeof FIXTURE_GATES;
    /** Return a gate that did not pass instead of throwing (0078 tests). */
    allowFail?: boolean;
  } = {},
): Promise<{ gate: string; bench: string; setId: string; passed: boolean }> {
  if (!tagEvalDesign(tag)) __registerEvalDesignForTests(tag);
  // Every frame species needs a family reference (td-894144 B5, plan §4).
  for (const code of await seedFrameReferences(tag, revisionId))
    track.refs?.add(code);
  const frame = await buildFrame(tag, revisionId);
  const n = Object.fromEntries(
    STRATA.map((h) => [h, frame.N[h]]),
  ) as typeof frame.N;
  const set = await createEvalSet({
    tag,
    revisionId,
    n,
    expectedFrameHash: frame.frameHash,
    gates: opts.gates ?? FIXTURE_GATES,
    userId: adminId,
    seed: createHash("sha256")
      .update(`fixture|${tag}|${revisionId}`)
      .digest("hex"),
  });
  track.setIds.add(set.setId);
  const items = (
    await query<{ id: string; rules_yes: boolean; labelled: boolean }>(
      `SELECT i.id::text, i.rules_yes,
              EXISTS (SELECT 1 FROM tag_eval_label l WHERE l.tag = $2 AND l.species_code = i.species_code
                        AND l.eval_text_hash = i.eval_text_hash) AS labelled
         FROM tag_eval_item i WHERE i.set_id = $1`,
      [set.setId, tag],
    )
  ).rows;
  for (const it of items)
    if (!it.labelled)
      await query("SELECT public.record_tag_eval_label($1, $2, $3, $4)", [
        set.setId,
        it.id,
        adminId,
        (opts.label ?? ((y: boolean) => (y ? "yes" : "no")))(it.rules_yes),
      ]);
  await query("SELECT public.freeze_tag_eval_set($1, $2)", [
    set.setId,
    adminId,
  ]);
  const gate = await recordGateReport(set.setId);
  if (!gate.passed && !opts.allowFail)
    throw new Error("fixture census gate did not pass");
  const bench = (
    await query<{ id: string }>(
      `SELECT record_tag_report('benchmark', $1, $2, '{"passed":true}'::jsonb)::text AS id`,
      [tag, revisionId],
    )
  ).rows[0].id;
  return { gate: gate.reportId, bench, setId: set.setId, passed: gate.passed };
}

/**
 * Seed a fixture reference for every family of the revision's current frame
 * that lacks one; returns the family codes created (the caller deletes them
 * with cleanupFamilyReferences). Species without a family code cannot have a
 * reference — fixtures give theirs one.
 */
export async function seedFrameReferences(
  tag: string,
  revisionId: string,
): Promise<string[]> {
  const need = (
    await query<{ family_code: string; family: string }>(
      `SELECT DISTINCT tc.family_code, coalesce(tc.family_sci_name, tc.family_code) AS family
         FROM public.tag_universe_codes() u(code)
         JOIN species_tag_input i ON i.species_code = u.code
         JOIN species_tag_state s ON s.species_code = u.code AND s.tag = $1 AND s.revision_id = $2
                                 AND s.input_hash = i.input_hash
         JOIN species_enrichment se ON se.species_code = u.code
         JOIN taxonomy_cache tc ON tc.species_code = u.code
         LEFT JOIN tag_family_reference r ON r.family_code = tc.family_code AND r.status = 'ok'
        WHERE tc.family_code IS NOT NULL AND r.family_code IS NULL
          AND (s.status = 'assigned' OR coalesce($1 = ANY (se.legacy_tags), false))`,
      [tag, revisionId],
    )
  ).rows;
  // The unfenced writer is owner-only (0073); fixtures use the owner role.
  for (const f of need)
    await withOwnerClient((c) =>
      c.query(
        "SELECT public.record_tag_family_reference($1, $2, 'ok', $2, 1, $3, NULL)",
        [f.family_code, f.family, `The family ${f.family} (fixture reference).`],
      ),
    );
  return need.map((f) => f.family_code);
}

export async function cleanupFamilyReferences(codes: Iterable<string>): Promise<void> {
  const list = [...codes];
  if (!list.length) return;
  await withOwnerClient((c) =>
    c.query("DELETE FROM tag_family_reference WHERE family_code = ANY($1::text[])", [list]),
  );
}

/** Remove fixture eval sets and the labels they created (birds_test owner escape). */
export async function cleanupEvalSets(setIds: Iterable<string>): Promise<void> {
  const ids = [...setIds];
  if (!ids.length) return;
  await withOwnerClient(async (c) => {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('birds.tag_fixture', 'on', true)`);
    await c.query(
      "DELETE FROM tag_eval_label WHERE first_set_id = ANY($1::bigint[])",
      [ids],
    );
    await c.query("DELETE FROM tag_eval_set WHERE id = ANY($1::bigint[])", [
      ids,
    ]);
    await c.query("COMMIT");
  });
}

export function tagEngineFixture(prefix: string) {
  const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
  const signal = `${prefix}signal${RUN}`;
  const codes = new Set<string>();
  const revisions: Record<string, string> = {};
  const reports: Record<string, { gate: string; bench: string }> = {};
  const proposals: string[] = [];
  const activationIds = new Set<number>();
  const jobIds = new Set<number>();
  /** Family references this fixture created (deleted at cleanup; never others'). */
  const createdRefs = new Set<string>();
  const evalSets = { setIds: new Set<string>(), refs: createdRefs };
  let adminId = 0;
  let tags: string[] = [];
  let realCarriersBefore: {
    species_code: string;
    tags: string[];
    legacy_tags: string[] | null;
  }[] = [];

  async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return withOwnerClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(`SELECT set_config('birds.tag_fixture', 'on', true)`);
        await c.query(`SELECT set_config('birds.legacy_fixture', 'on', true)`);
        const r = await c.query(sql, params);
        await c.query("COMMIT");
        return r.rows as T[];
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
  }

  const realCarriers = async () =>
    (
      await query<{
        species_code: string;
        tags: string[];
        legacy_tags: string[] | null;
      }>(
        `SELECT species_code, tags, legacy_tags FROM species_enrichment
				  WHERE species_code NOT LIKE 'zz%'
				    AND (tags && $1::text[] OR coalesce(legacy_tags, '{}') && $1::text[])
				  ORDER BY species_code`,
        [tags],
      )
    ).rows;

  const tagsOf = async (code: string) =>
    (
      await query<{ tags: string[] | null }>(
        "SELECT tags FROM species_enrichment WHERE species_code = $1",
        [code],
      )
    ).rows[0]?.tags ?? null;

  const inputOf = async (code: string) =>
    (
      await query<InputRow>(
        "SELECT * FROM species_tag_input WHERE species_code = $1",
        [code],
      )
    ).rows[0] ?? null;

  /** Re-derive the whole universe for the current taxonomy; close any pending generation. */
  async function settleUniverse() {
    __resetTagEngineCachesForTests();
    await withTagWriteTx(
      "exclusive",
      `global:test-settle-${prefix}${RUN}`,
      "test",
      async (tx) => {
        const lex = await lexiconFor(tx, { rebuild: true });
        await materializeMany(tx, null);
        await closePendingRepairInline(tx, lex.hash);
      },
    );
  }

  async function plant(fn: (exec: Exec) => Promise<void>) {
    await withTagWriteTx(
      "exclusive",
      `global:test-plant-${prefix}${RUN}`,
      "test",
      async (tx) => {
        await fn((sql, p) => tx.exec(sql, p));
      },
    );
  }

  /**
   * Blind tests need a family reference for every frame species (td-894144
   * B5, plan §4). Seed one for each family among our species and the real
   * carriers of our tags that lacks one — test files run one at a time
   * (fileParallelism: false), so "create if absent, delete what I created"
   * never removes another file's rows.
   */
  async function seedFamilyReferences(): Promise<void> {
    const need = (
      await query<{ family_code: string; family: string }>(
        `SELECT DISTINCT tc.family_code, coalesce(tc.family_sci_name, tc.family_code) AS family
		   FROM taxonomy_cache tc
		   JOIN species_enrichment se ON se.species_code = tc.species_code
		   LEFT JOIN tag_family_reference r ON r.family_code = tc.family_code AND r.status = 'ok'
		  WHERE tc.category = 'species' AND tc.family_code IS NOT NULL AND r.family_code IS NULL
		    AND (tc.species_code = ANY ($1::text[])
		         OR se.tags && $2::text[] OR coalesce(se.legacy_tags, '{}') && $2::text[])`,
        [[...codes], tags],
      )
    ).rows;
    for (const f of need) {
      await withOwnerClient((c) =>
        c.query(
          "SELECT public.record_tag_family_reference($1, $2, 'ok', $2, 1, $3, NULL)",
          [f.family_code, f.family, `The family ${f.family} (fixture reference).`],
        ),
      );
      createdRefs.add(f.family_code);
    }
  }

  /** Point `code` at a synthetic input: its current fields, with overrides. */
  async function repoint(
    exec: Exec,
    code: string,
    o: {
      text?: string;
      order?: string | null;
      family?: string | null;
      lexicon?: string;
      focal?: string;
      scanner?: string;
    } = {},
  ): Promise<string> {
    const i = await inputOf(code);
    const current = (await tagRepairState())!.lexiconHash;
    const r = await exec(
      "SELECT public.record_tag_input($1, $2, $3, $4, $5, $6, $7, $8) AS h",
      [
        code,
        o.text ?? i?.text_hash ?? hex(`text-${code}`),
        o.order !== undefined ? o.order : (i?.order_name ?? null),
        o.family !== undefined ? o.family : (i?.family_sci_name ?? null),
        i?.genus ?? null,
        o.lexicon ?? i?.lexicon_hash ?? current,
        o.focal ?? i?.focal_exempt_hash ?? hex(`focal-${code}`),
        o.scanner ?? scannerRev(),
      ],
    );
    return r.rows[0].h as string;
  }

  /** Claim OUR job row the way claimNextJob would (never another file's row). */
  async function claim(jobId: number): Promise<JobRow> {
    jobIds.add(jobId);
    const r = await query<JobRow>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = now(), heartbeat_at = now()
			  WHERE id = $1 AND status = 'pending' RETURNING *`,
      [jobId],
    );
    expect(r.rows[0], `job ${jobId} claimable`).toBeDefined();
    return r.rows[0];
  }

  const jobRow = async (id: number) =>
    (
      await query<{
        status: string;
        result: Record<string, unknown> | null;
        error: string | null;
      }>("SELECT status, result, error FROM jobs WHERE id = $1", [id])
    ).rows[0];

  /** A species with an article; `taxon` makes it a universe member. */
  async function addSpecies(
    suffix: string,
    o: {
      member?: boolean;
      text?: string;
      order?: string | null;
      family?: string | null;
    } = {},
  ): Promise<string> {
    const code = `${prefix}${RUN}${suffix}`;
    codes.add(code);
    if (o.member ?? true)
      await query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family, order_name, family_sci_name, family_code)
				 VALUES ($1, $2, $3, 'species', 'Fixture family', $4, $5, $6)`,
        [
          code,
          `${prefix} ${code} Plover`,
          `${prefix[0].toUpperCase()}${prefix.slice(1)}ia ${code}`,
          o.order === undefined ? "Charadriiformes" : o.order,
          o.family === undefined ? "Fixtureidae" : o.family,
          o.family === null ? null : `zzfx-${(o.family ?? "Fixtureidae").toLowerCase()}`,
        ],
      );
    await upsertWikiOk(code, {
      title: `${prefix} ${RUN}`,
      revId: 1,
      extract: o.text ?? `A shorebird with a ${signal} habit.`,
      sections: [],
    });
    await seedFamilyReferences();
    return code;
  }

  /** Pick `n` unowned vocabulary tags with the fewest real carriers; make the fixture admin. */
  async function setup(n: number): Promise<void> {
    tags = (
      await query<{ tag: string }>(
        `SELECT candidate.tag
				   FROM unnest($1::text[]) WITH ORDINALITY candidate(tag, ord)
				   LEFT JOIN species_enrichment se
				     ON se.species_code NOT LIKE 'zz%'
				    AND (candidate.tag = ANY (se.tags) OR candidate.tag = ANY (coalesce(se.legacy_tags, '{}')))
				  WHERE NOT EXISTS (SELECT 1 FROM tag_ownership o WHERE o.tag = candidate.tag)
				  GROUP BY candidate.tag, candidate.ord
				  ORDER BY count(se.species_code), candidate.ord LIMIT $2`,
        [[...ALL_TAGS], n],
      )
    ).rows.map((r) => r.tag);
    if (tags.length < n)
      throw new Error(`fixture needs ${n} unowned vocabulary tags`);
    realCarriersBefore = await realCarriers();
    adminId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
				 VALUES ($1, 'Tag engine fixture', '!unset', 'admin') RETURNING id`,
        [`tag-${prefix}-${RUN}`],
      )
    ).rows[0].id;
    await seedFamilyReferences();
  }

  const ruleset = (tag: string) => ({
    schema: 1,
    tag,
    rev: `${prefix}-fixture-${RUN}`,
    denySections: [],
    comparisonMarkers: [],
    support: [
      {
        id: "s-signal",
        group: "signal",
        match: { type: "literal", phrase: signal },
        note: "fixture signal",
      },
    ],
    exclude: [],
    taxon: [],
  });

  /** Approve the fixture ruleset for `tag` once (no staging, no activation). */
  async function approve(tag: string): Promise<string> {
    if (!revisions[tag]) {
      const p = (
        await query<{ id: string; artifact_sha256: string }>(
          `INSERT INTO tag_rule_proposal (tag, artifact, source) VALUES ($1, $2::jsonb, 'human') RETURNING id, artifact_sha256`,
          [tag, JSON.stringify(ruleset(tag))],
        )
      ).rows[0];
      proposals.push(p.id);
      await asOwner(
        `INSERT INTO tag_crosscheck (proposal_id, reviewer, verdict, text, reviewed_sha256) VALUES ($1, 'CODEX1', 'approve', 'fixture', $2)`,
        [p.id, p.artifact_sha256],
      );
      revisions[tag] = (
        await query<{ id: string }>(
          "SELECT approve_tag_proposal($1, $2)::text AS id",
          [p.id, adminId],
        )
      ).rows[0].id;
    }
    return revisions[tag];
  }

  async function approveAndActivate(tag: string) {
    await approve(tag);
    await stageRevision(tag, revisions[tag]);
    reports[tag] = await censusGate(tag, revisions[tag], adminId, evalSets);
    const id = await activateRevision({
      tag,
      revisionId: revisions[tag],
      gateReportId: reports[tag].gate,
      benchmarkReportId: reports[tag].bench,
      userId: adminId,
    });
    expect(id).not.toBeNull();
    activationIds.add(Number(id));
  }

  async function retire(tag: string) {
    activationIds.add(Number(await retireTagToLegacy(tag, adminId)));
  }

  /** Undo everything, restoring every affected real row exactly. */
  async function cleanup() {
    for (const tag of tags) {
      const owned =
        (await query("SELECT 1 FROM tag_ownership WHERE tag = $1", [tag])).rows
          .length > 0;
      if (owned && adminId) await retire(tag);
    }
    await query("DELETE FROM species_enrichment WHERE species_code = ANY($1)", [
      [...codes],
    ]);
    await query("DELETE FROM taxonomy_cache WHERE species_code = ANY($1)", [
      [...codes],
    ]);
    await settleUniverse();
    for (const row of realCarriersBefore)
      await asOwner(
        "UPDATE species_enrichment SET tags = $2, legacy_tags = $3 WHERE species_code = $1",
        [row.species_code, row.tags, row.legacy_tags],
      );
    if (jobIds.size) {
      await query("DELETE FROM job_events WHERE job_id = ANY($1::bigint[])", [
        [...jobIds],
      ]);
      await query("DELETE FROM jobs WHERE id = ANY($1::bigint[])", [
        [...jobIds],
      ]);
    }
    const revs = Object.values(revisions);
    await cleanupEvalSets(evalSets.setIds);
    if (revs.length)
      await asOwner(
        "DELETE FROM species_tag_state WHERE revision_id = ANY($1::bigint[])",
        [revs],
      );
    if (activationIds.size)
      await asOwner("DELETE FROM tag_activation WHERE id = ANY($1::bigint[])", [
        [...activationIds],
      ]);
    if (revs.length) {
      await asOwner(
        "DELETE FROM tag_report WHERE revision_id = ANY($1::bigint[])",
        [revs],
      );
      await asOwner("DELETE FROM tag_revision WHERE id = ANY($1::bigint[])", [
        revs,
      ]);
    }
    if (proposals.length) {
      await asOwner(
        "DELETE FROM tag_crosscheck WHERE proposal_id = ANY($1::uuid[])",
        [proposals],
      );
      // Previews (B5) reference proposals; crosschecks reference previews.
      await asOwner(
        "DELETE FROM tag_proposal_preview WHERE proposal_id = ANY($1::uuid[])",
        [proposals],
      );
      await asOwner(
        "DELETE FROM tag_rule_proposal WHERE id = ANY($1::uuid[])",
        [proposals],
      );
    }
    if (adminId) await query("DELETE FROM users WHERE id = $1", [adminId]);
    if (createdRefs.size)
      await asOwner(
        "DELETE FROM tag_family_reference WHERE family_code = ANY($1::text[])",
        [[...createdRefs]],
      );
  }

  return {
    RUN,
    signal,
    get adminId() {
      return adminId;
    },
    get tags() {
      return tags;
    },
    revisions,
    reports,
    jobIds,
    activationIds,
    proposals,
    realCarriers,
    get realCarriersBefore() {
      return realCarriersBefore;
    },
    asOwner,
    tagsOf,
    inputOf,
    settleUniverse,
    seedFamilyReferences,
    plant,
    repoint,
    claim,
    jobRow,
    addSpecies,
    setup,
    approve,
    approveAndActivate,
    retire,
    cleanup,
  };
}

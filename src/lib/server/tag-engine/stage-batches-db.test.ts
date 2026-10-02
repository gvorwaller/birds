/**
 * td-894144 (prod job 6985): staging the whole universe (~10,900 species) in
 * ONE shared-lock transaction ran past the 20 s transaction cap on prod and
 * was killed. Staging now runs in short transactions of at most `perTx`
 * members each. Other test files add and remove fixture species while this
 * runs, so the assertions use the stage's own per-transaction counts, never
 * an absolute universe size. Owned fixtures (zzs…) through the shared engine
 * fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { stageRevision } from "./activation";
import { tagEngineFixture } from "./engine-fixture.test-helper";
import { tagRepairState } from "./repair";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT to_regclass('public.tag_legacy_baseline') IS NOT NULL AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

const fx = tagEngineFixture("zzs");

describe.runIf(migrated).sequential("staging in short transactions", () => {
  let T = "";
  let rev = "";
  let a = "";
  beforeAll(async () => {
    if ((await tagRepairState())?.pending)
      throw new Error("refusing to run while a repair is pending");
    await fx.setup(1);
    T = fx.tags[0];
    a = await fx.addSpecies("a");
    await fx.settleUniverse();
    rev = await fx.approve(T);
  }, 240_000);

  afterAll(async () => {
    await fx.cleanup();
  }, 240_000);

  it("each transaction stages at most perTx members, progress only grows, every member gets a state, and a rerun does nothing", async () => {
    const perTx = 3000;
    const seen: { done: number; total: number }[] = [];
    const r = await stageRevision(T, rev, {
      perTx,
      onProgress: (done, total) => {
        seen.push({ done, total });
      },
    });
    // More than one states transaction was needed, each a full share except the last.
    expect(r.states).toBeGreaterThan(perTx);
    const steps = seen.map((s, i) => s.done - (i ? seen[i - 1].done : 0));
    expect(steps.slice(0, -1).every((n) => n === perTx)).toBe(true);
    expect(steps.at(-1)!).toBeLessThan(perTx);
    expect(seen.length).toBe(Math.floor(r.states / perTx) + 1);
    // One inputs pass (nothing missing), one count, then the states passes.
    expect(r.transactions).toBe(seen.length + 2);
    expect(seen.at(-1)!.done).toBe(r.states);
    expect(seen.every((s) => s.total >= s.done)).toBe(true);
    // The fixture bird has a state for its CURRENT input.
    const current = await query(
      `SELECT 1 FROM species_tag_state s
         JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
        WHERE s.species_code = $1 AND s.tag = $2 AND s.revision_id = $3`,
      [a, T, rev],
    );
    expect(current.rows.length).toBe(1);
    // A rerun finds (almost) nothing to do: one pass of each kind.
    const again = await stageRevision(T, rev, { perTx });
    expect(again.states).toBeLessThan(perTx);
    expect(again.transactions).toBe(3);
  }, 240_000);
});

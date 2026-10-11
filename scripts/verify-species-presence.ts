/**
 * AGENT tool (never an owner step): prove the species-presence tables (0083)
 * give exactly the Hotspots & data totals of the old whole-table aggregate
 * (td-7162f6). Bundled by scripts/build-verify-species-presence.mjs into
 * .local/verify-species-presence.mjs.
 *
 * READ ONLY: both computations run in one REPEATABLE READ READ ONLY snapshot,
 * so a load committing meanwhile cannot make them disagree. Safe on birds_test,
 * a restored birds_bench* clone, or prod (the reference aggregate reads the
 * whole frequency tables: ~5 s on the M4, ~30-40 s on the droplet).
 *
 *   node .local/verify-species-presence.mjs
 *
 * Exit 0 = identical for every area, country, first-level region and the
 * world (a key missing on one side counts as 0); exit 1 = differences listed.
 */
import { withReadSnapshot } from "../src/lib/db";
import {
  diffCounts,
  presenceCounts,
  referenceCountsFromFrequency,
} from "../src/lib/server/species-presence";

async function main() {
  const result = await withReadSnapshot(async (client) => {
    const run = (text: string, params?: unknown[]) => client.query(text, params as never[]);
    const db = (await run("SELECT current_database() AS db")).rows[0].db as string;
    await run("SET LOCAL statement_timeout = '10min'");
    await run("SET LOCAL work_mem = '64MB'");
    let t = performance.now();
    const presence = await presenceCounts(run as never);
    const presenceMs = Math.round(performance.now() - t);
    t = performance.now();
    const reference = await referenceCountsFromFrequency(run as never);
    const referenceMs = Math.round(performance.now() - t);
    return { db, presence, presenceMs, reference, referenceMs };
  });
  const diffs = diffCounts(result.presence, result.reference);
  console.log(
    JSON.stringify({
      db: result.db,
      presenceMs: result.presenceMs,
      referenceMs: result.referenceMs,
      world: { presence: result.presence.world, reference: result.reference.world },
      regions: Object.keys(result.reference.regions).length,
      areas: Object.keys(result.reference.areas).length,
      differences: diffs.length,
    }),
  );
  if (diffs.length) {
    console.log(diffs.slice(0, 50).join("\n"));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));

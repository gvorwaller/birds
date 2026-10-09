/**
 * AGENT tool (never an owner step): time replaceTaxonomy's exclusive
 * transaction on prod-sized data (td-861855). Bundled by
 * scripts/build-bench-taxonomy-sync.mjs into .local/bench-taxonomy-sync.mjs.
 *
 * Runs ONLY against a scratch database whose name starts with "birds_bench"
 * (a restored backup) — never the live `birds` or `birds_test`. It checks
 * current_database() before doing anything.
 *
 *   PGDATABASE=birds_bench ... node .local/bench-taxonomy-sync.mjs [--runs N]
 *
 * Each scenario runs the same three steps as replaceTaxonomy, inside the real
 * withTagWriteTx('exclusive') with the real 30 s cap lifted (SET LOCAL
 * transaction_timeout = 0) so the true duration is measured, then rolls back
 * on purpose with TagTxRollback. The taxonomy, job and ownership writes roll
 * back; only withTagWriteTx's pre-transaction attempt counter
 * (begin_tag_attempt, a sequence) advances. The payload is the database's own
 * taxonomy_cache with synthetic com_name edits, so no eBird request is made.
 * Any scenario error makes the process exit non-zero.
 *
 * Scenarios:
 *   noop          unchanged taxonomy                  -> mode "changed", 0 rows
 *   rename-200    200 species renamed (lexicon moves) -> mode "repair"
 *   rename-1500   1,500 species renamed               -> mode "repair"
 *   full-200      rename-200 with tag_ownership emptied inside the tx (needs a
 *                 superuser connection)               -> mode "repair"
 *
 * Before td-861855 the lexicon-change scenarios re-derived species inside the
 * transaction (droplet, 2026-10-09: rename-1500 8.0 s; full-200 ~25 s of the
 * 30 s cap). Now every lexicon change hands the re-derivation to the batched
 * tag_repair job, so all three should cost about the same as noop.
 */
import { query } from "../src/lib/db";
import { withTagWriteTx, TagTxRollback } from "../src/lib/server/tag-engine/runtime";
import {
  beginTaxonomyChange,
  finishTaxonomyChange,
  writeTaxonomy,
  type TaxonomyEntry,
} from "../src/lib/server/taxonomy-sync";

const CAP_MS = 30_000;
const runsArg = process.argv.indexOf("--runs");
const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 2;

async function main() {
  const db = (await query<{ db: string }>("SELECT current_database() AS db")).rows[0].db;
  if (!db.startsWith("birds_bench")) {
    console.error(`refusing to run: current_database() is "${db}", expected birds_bench*`);
    process.exitCode = 2;
    return;
  }
  const base = (
    await query<{
      species_code: string; com_name: string; sci_name: string; category: string;
      family: string | null; taxon_order: number | null; order_name: string | null;
      family_code: string | null; family_sci_name: string | null;
      banding_codes: string[] | null; report_as: string | null; extinct: boolean | null;
    }>(
      `SELECT species_code, com_name, sci_name, category, family, taxon_order::float8 AS taxon_order,
              order_name, family_code, family_sci_name, banding_codes, report_as, extinct
         FROM taxonomy_cache ORDER BY taxon_order NULLS LAST, species_code`,
    )
  ).rows.map(
    (r): TaxonomyEntry => ({
      speciesCode: r.species_code,
      comName: r.com_name,
      sciName: r.sci_name,
      category: r.category,
      familyComName: r.family,
      taxonOrder: r.taxon_order,
      order: r.order_name,
      familyCode: r.family_code,
      familySciName: r.family_sci_name,
      bandingCodes: r.banding_codes,
      reportAs: r.report_as,
      extinct: r.extinct,
    }),
  );
  // finishTaxonomyChange's repair job needs a real requester (jobs FK).
  const requester = (
    await query<{ id: number }>("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
  ).rows[0].id;
  const owned = Number((await query<{ n: string }>("SELECT count(*)::text AS n FROM tag_ownership")).rows[0].n);
  console.log(`db=${db} taxa=${base.length} owned_tags=${owned} runs=${runs}`);

  const renamed = (n: number) => {
    let left = n;
    return base.map((t) =>
      left > 0 && t.category === "species" ? (left--, { ...t, comName: `${t.comName} (bench)` }) : t,
    );
  };
  const scenarios: { name: string; taxa: TaxonomyEntry[]; dropOwnership?: boolean }[] = [
    { name: "noop", taxa: base },
    { name: "rename-200", taxa: renamed(200) },
    { name: "rename-1500", taxa: renamed(1500) },
    { name: "full-200", taxa: renamed(200), dropOwnership: true },
  ];

  for (const s of scenarios) {
    for (let run = 1; run <= runs; run++) {
      const t: Record<string, number> = {};
      let mode = "?";
      const t0 = performance.now();
      try {
        await withTagWriteTx("exclusive", "global:benchTaxonomy", "benchTaxonomy", async (tx) => {
          await tx.client.query("SET LOCAL transaction_timeout = 0");
          await tx.client.query("SET LOCAL statement_timeout = 0");
          t.lock = performance.now() - t0;
          if (s.dropOwnership) await tx.exec("DELETE FROM tag_ownership");
          let m = performance.now();
          const before = await beginTaxonomyChange(tx);
          t.begin = performance.now() - m;
          m = performance.now();
          await writeTaxonomy(tx.client, s.taxa);
          t.write = performance.now() - m;
          m = performance.now();
          const r = await finishTaxonomyChange(tx, before, requester);
          t.finish = performance.now() - m;
          mode = r.mode + ("changed" in r ? ` changed=${r.changed}` : "");
          throw new TagTxRollback();
        });
      } catch (err) {
        if (!(err instanceof TagTxRollback)) {
          console.log(`${s.name} run ${run}: ERROR ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          continue;
        }
      }
      const total = t.lock + t.begin + t.write + t.finish;
      const fmt = (x: number) => (x / 1000).toFixed(2) + "s";
      console.log(
        `${s.name.padEnd(12)} run ${run}: total ${fmt(total)} (lock ${fmt(t.lock)}, before ${fmt(t.begin)}, ` +
          `write ${fmt(t.write)}, finish ${fmt(t.finish)}) mode=${mode} ` +
          `cap margin ${fmt(CAP_MS - total)}${total > CAP_MS ? "  ** OVER 30 s CAP **" : ""}`,
      );
    }
  }
}

await main();
// The shared pool keeps the process alive; exit only after stdout drains
// (a bare process.exit() can truncate piped output).
process.stdout.write("", () => process.exit(process.exitCode ?? 0));

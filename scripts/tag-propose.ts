/**
 * AGENT tool (never an owner step): file a HAND-WRITTEN rule proposal
 * (td-894144 B5, plan §3x / Phase 1 pilot). Bundled by
 * scripts/build-tag-propose.mjs into .local/tag-propose.mjs and run with the
 * target's env file:
 *
 *   node --env-file=<.env or .env.test> .local/tag-propose.mjs <artifact.json> [--user-id N] [--apply]
 *
 * Dry-run unless --apply. The same checks as approval run first — the rules
 * loader and the taxonomy check (unknown names, rule sets admitting no
 * species, assign/forbid overlaps) — so a proposal that could never be
 * approved is never filed. The row goes in through the
 * create_human_tag_proposal definer (source 'human'; user id = audit data,
 * default the lowest-id admin).
 */
import { readFileSync } from "node:fs";
import { query } from "../src/lib/db";
import { ALL_TAGS } from "../src/lib/species-tags";
import { parseRuleset } from "../src/lib/server/tag-engine/rules";
import {
  checkTaxonRules,
  loadTaxonomyForCheck,
} from "../src/lib/server/tag-engine/taxon-check";

const [file, ...rest] = process.argv.slice(2);
const apply = rest.includes("--apply");
const ui = rest.indexOf("--user-id");
if (!file) {
  console.error(
    "usage: tag-propose.mjs <artifact.json> [--user-id N] [--apply]",
  );
  process.exitCode = 2;
} else {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const rs = parseRuleset(raw, ALL_TAGS);
  const taxonomy = await loadTaxonomyForCheck(query as never);
  const check = checkTaxonRules(rs, taxonomy);
  console.log(
    `rules load: tag ${rs.tag}, schema ${rs.schema}, ${rs.taxon.length} taxon rules, ${rs.support.length} support, ${rs.exclude.length} exclude; admitted by gates: ${check.admitted}`,
  );
  if (check.problems.length) {
    console.error("REFUSED — taxonomy problems:\n- " + check.problems.join("\n- "));
    process.exitCode = 1;
  } else if (!apply) {
    console.log("dry run: checks pass; re-run with --apply to file the proposal");
  } else {
    const userId =
      ui >= 0
        ? Number(rest[ui + 1])
        : (
            await query<{ id: number }>(
              "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1",
            )
          ).rows[0].id;
    const r = await query<{ id: string }>(
      "SELECT public.create_human_tag_proposal($1, $2::jsonb, $3)::text AS id",
      [rs.tag, JSON.stringify(raw), userId],
    );
    console.log(`filed proposal ${r.rows[0].id} (source human, audit user ${userId})`);
  }
}
process.exit();

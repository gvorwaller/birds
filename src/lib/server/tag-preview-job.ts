/**
 * `tag_preview` worker job (td-894144 B5, plan §3d/§3k/§3o/§3cc).
 *
 *  1. Scan — ONE REPEATABLE READ, READ ONLY snapshot: certify every universe
 *     member's recorded tag input (the SQL encoder recomputes each input hash
 *     from what this scan will actually use; any mismatch refuses the whole
 *     Preview as stale), read tag_corpus_fingerprint() in the same snapshot,
 *     then run the proposal's rules over every member (preview.ts).
 *  2. Store — a short shared-lock transaction: record_tag_preview locks the
 *     job row under the claim fence (running + attempts + claim_seq) and
 *     stores the body only if the live fingerprint still equals the scanned
 *     one. A corpus that moved mid-scan stores nothing.
 *
 * Every side effect is behind a fenced SQL checkpoint (the store) or a fenced
 * queue transition, so a stale claim stores nothing (plan §3cc).
 */
import { query, withTransaction } from "$lib/db";
import { ALL_TAGS } from "$lib/species-tags";
import { sanitizeErrorText, type JobRow } from "$server/job-policy";
import {
  completeJob,
  currentClaim,
  failJob,
  isStaleClaim,
  recordClaimedEvent,
  StaleClaimError,
} from "$server/jobs";
import { tagEvalDesign } from "$server/tag-engine/eval-design";
import {
  focalExemptHash,
  focalExemptions,
  lexiconFromRows,
} from "$server/tag-engine/materialize";
import {
  PreviewAccumulator,
  previewDesignHash,
} from "$server/tag-engine/preview";
import { parseRuleset, RulesetError } from "$server/tag-engine/rules";
import { TagTxRefusal, withTagWriteTx } from "$server/tag-engine/runtime";
import { genusOf } from "$server/tag-engine/scanner";
import { scannerRev, segmentArticle } from "$server/tag-engine/segment";
import {
  checkTaxonRules,
  knownTaxaOf,
  loadTaxonomyForCheck,
} from "$server/tag-engine/taxon-check";

/** Species scored per round trip in pass 1 (bounded memory). */
export const PREVIEW_BATCH = 300;

/** An owner-facing refusal (not a bug): the job fails with this message. */
class PreviewRefused extends Error {}

async function isAdmin(userId: number): Promise<boolean> {
  return (
    (
      await query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
        userId,
      ])
    ).rows[0]?.role === "admin"
  );
}

interface ScanRow extends Record<string, unknown> {
  code: string;
  com_name: string | null;
  sci_name: string | null;
  family: string | null;
  order_name: string | null;
  family_sci_name: string | null;
  wikipedia_extract: string;
  wikipedia_sections: { title: string; text: string }[] | null;
  legacy: boolean;
  stored_hash: string | null;
}

export async function runTagPreviewJob(job: JobRow): Promise<void> {
  const attempts = job.attempts;
  const proposalId = (job.payload as { proposalId?: unknown } | null)
    ?.proposalId;
  await recordClaimedEvent(job.id, { attempt: attempts, proposalId });
  try {
    if (!(await isAdmin(job.requested_by)))
      throw new PreviewRefused("requester is no longer an admin");
    if (typeof proposalId !== "string" || !/^[0-9a-f-]{36}$/.test(proposalId))
      throw new PreviewRefused("malformed payload");
    const prop = (
      await query<{ tag: string; artifact_text: string; sha: string }>(
        `SELECT tag, artifact::text AS artifact_text, artifact_sha256 AS sha
           FROM tag_rule_proposal WHERE id = $1`,
        [proposalId],
      )
    ).rows[0];
    if (!prop) throw new PreviewRefused(`no proposal ${proposalId}`);
    let ruleset;
    try {
      ruleset = parseRuleset(JSON.parse(prop.artifact_text), ALL_TAGS);
    } catch (e) { // stale-safe: parse only; rethrows non-RulesetError
      if (e instanceof RulesetError)
        throw new PreviewRefused(`the rules do not load: ${e.message}`);
      throw e;
    }
    if (ruleset.tag !== prop.tag)
      throw new PreviewRefused("the rules name a different tag");
    const design = tagEvalDesign(prop.tag);
    if (!design)
      throw new PreviewRefused(`${prop.tag} has no evaluation design yet`);
    const pinned = (
      await query<{ design_hash: string }>(
        "SELECT design_hash FROM tag_preview_design WHERE tag = $1",
        [prop.tag],
      )
    ).rows[0]?.design_hash;
    if (pinned !== previewDesignHash(prop.tag, design))
      throw new PreviewRefused(
        "this Preview code and its pinned design differ — the deploy is incomplete (re-pin tag_preview_design)",
      );

    // ── 1. scan, in one read-only snapshot ────────────────────────────────
    const scan = await withTransaction(async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      );
      const exec = ((text: string, params?: unknown[]) =>
        client.query(text, params as never[])) as never;
      const state = (
        await client.query<{ lexicon_hash: string; scanner_rev: string }>(
          "SELECT lexicon_hash, scanner_rev FROM tag_lexicon_state WHERE id = 1",
        )
      ).rows[0];
      if (!state || state.scanner_rev !== scannerRev())
        throw new PreviewRefused(
          "the tag inputs are being re-derived after an update — try Preview again when the repair finishes",
        );
      const lex = lexiconFromRows(
        (
          await client.query<{
            com_name: string;
            sci_name: string;
            family: string | null;
          }>(
            "SELECT com_name, sci_name, family FROM taxonomy_cache WHERE category = 'species'",
          )
        ).rows,
      );
      if (lex.hash !== state.lexicon_hash)
        throw new PreviewRefused(
          "the taxonomy changed and the tag inputs have not caught up — try Preview again later",
        );
      // Pass 1: every member in batches (bounded memory — ~37 MB of stored
      // text on prod), each batch certified before it is scored. All reads
      // share this transaction's single snapshot.
      const codes = (
        await client.query<{ code: string }>(
          "SELECT u.code FROM public.tag_universe_codes() u(code) ORDER BY u.code COLLATE \"C\"",
        )
      ).rows.map((r) => r.code);
      const acc = new PreviewAccumulator({
        tag: prop.tag,
        ruleset,
        artifactSha256: prop.sha,
        scannerRev: state.scanner_rev,
        design,
        lexicon: lex.lexicon,
      });
      const loadBatch = async (batch: readonly string[]) =>
        (
          await client.query<ScanRow>(
            `SELECT u.code, tc.com_name, tc.sci_name, tc.family, tc.order_name, tc.family_sci_name,
                    se.wikipedia_extract, se.wikipedia_sections,
                    coalesce($1 = ANY (se.legacy_tags), false) AS legacy,
                    i.input_hash AS stored_hash
               FROM unnest($2::text[]) u(code)
               JOIN species_enrichment se ON se.species_code = u.code
               JOIN taxonomy_cache tc ON tc.species_code = u.code
               LEFT JOIN species_tag_input i ON i.species_code = u.code
              ORDER BY u.code`,
            [prop.tag, batch],
          )
        ).rows.map((r) => {
          const article = {
            extract: r.wikipedia_extract,
            sections: r.wikipedia_sections ?? [],
          };
          const exempt = focalExemptions(r);
          return {
            r,
            article,
            exempt,
            genus: genusOf(r.sci_name),
            text_hash: segmentArticle(article).textHash,
            focal_hash: focalExemptHash(exempt),
          };
        });
      const stale: string[] = [];
      for (let i = 0; i < codes.length; i += PREVIEW_BATCH) {
        const parts = await loadBatch(codes.slice(i, i + PREVIEW_BATCH));
        // Certify: recompute each input hash with the ONE SQL encoder from
        // exactly what this scan uses (§3k).
        const recomputed = (
          await client.query<{ code: string; h: string }>(
            `SELECT x.code, public.tag_input_hash(x.text_hash, x.order_name, x.family_sci_name, x.genus,
                                                  $2, x.focal_hash, $3) AS h
               FROM jsonb_to_recordset($1::jsonb)
                 AS x(code text, text_hash text, order_name text, family_sci_name text, genus text, focal_hash text)`,
            [
              JSON.stringify(
                parts.map((p) => ({
                  code: p.r.code,
                  text_hash: p.text_hash,
                  order_name: p.r.order_name,
                  family_sci_name: p.r.family_sci_name,
                  genus: p.genus,
                  focal_hash: p.focal_hash,
                })),
              ),
              state.lexicon_hash,
              state.scanner_rev,
            ],
          )
        ).rows;
        const want = new Map(recomputed.map((x) => [x.code, x.h]));
        for (const p of parts) {
          if (want.get(p.r.code) !== p.r.stored_hash) {
            stale.push(p.r.code);
            continue;
          }
          acc.add({
            code: p.r.code,
            name: p.r.com_name ?? p.r.code,
            order: p.r.order_name,
            family: p.r.family_sci_name,
            genus: p.genus,
            legacy: p.r.legacy,
            article: p.article,
            exempt: p.exempt,
          });
        }
      }
      if (stale.length > 0)
        throw new PreviewRefused(
          `${stale.length} species' tag inputs are not current (e.g. ${stale
            .slice(0, 5)
            .join(", ")}) — the consistency job re-derives them; try Preview again after it runs`,
        );
      // Pass 2: only the examples' articles, from the same snapshot.
      const examples = new Map(
        (await loadBatch(acc.exampleCodes())).map((p) => [
          p.r.code,
          { article: p.article, exempt: p.exempt },
        ]),
      );
      const fingerprint = (
        await client.query<{ f: string }>(
          "SELECT public.tag_corpus_fingerprint() AS f",
        )
      ).rows[0].f;
      const taxonomy = await loadTaxonomyForCheck(exec);
      const body = acc.finish(
        examples,
        checkTaxonRules(ruleset, taxonomy, knownTaxaOf(taxonomy)),
      );
      return { fingerprint, body };
    });

    // ── 2. store, fenced ──────────────────────────────────────────────────
    const claimSeq = currentClaim(job.id)?.claimSeq ?? String(job.claim_seq ?? "0");
    const previewId = await withTagWriteTx(
      "shared",
      `preview:${proposalId}`,
      "tag_preview",
      async (tx) => {
        try {
          return (
            await tx.exec<{ id: string }>(
              "SELECT public.record_tag_preview($1, $2, $3, $4, $5, $6::jsonb)::text AS id",
              [
                proposalId,
                job.id,
                attempts,
                claimSeq,
                scan.fingerprint,
                JSON.stringify(scan.body),
              ],
            )
          ).rows[0].id;
        } catch (e) { // stale-safe: stale-aware: a definer stale claim becomes a refusal, mapped back to StaleClaimError
          const msg = e instanceof Error ? e.message : String(e);
          if (/^stale claim\b/.test(msg)) throw new TagTxRefusal(msg);
          if (/changed during the Preview/.test(msg))
            throw new TagTxRefusal(msg);
          throw e;
        }
      },
    ).catch((e) => {
      if (e instanceof TagTxRefusal) {
        if (/^stale claim\b/.test(e.reason))
          throw new StaleClaimError(job.id, "record_tag_preview");
        throw new PreviewRefused(e.reason);
      }
      throw e;
    });
    await completeJob(job.id, attempts, {
      proposalId,
      previewId,
      counts: scan.body.counts,
    });
  } catch (err) {
    if (isStaleClaim(err)) throw err;
    const message =
      err instanceof PreviewRefused
        ? err.message
        : sanitizeErrorText(
            err instanceof Error ? err.message : String(err),
          ).slice(0, 300);
    await failJob(job.id, attempts, message);
  }
}

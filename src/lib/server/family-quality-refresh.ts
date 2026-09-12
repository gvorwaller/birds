/** Operator-only publication of reviewed improvements. Normal refresh scheduling
 * and the Admin gap retry remain unchanged. Every replacement is compare-and-set. */
import { createHash } from "node:crypto";
import { withTransaction } from "$lib/db";
import { familyInputHash } from "./family-enrichment";
import {
  validateFamilyDescription,
  type FamilyDescription,
  type FamilySource,
} from "./family-enrichment-ai";
import type { AiAttempt } from "./ai-call";

export function familyPublicationFingerprint(row: {
  content: unknown;
  source: unknown;
  published_hash: string | null;
  generated_at: Date | string | null;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.content,
        row.source,
        row.published_hash,
        row.generated_at,
      ]),
    )
    .digest("hex");
}
export interface ReviewedFamilyCandidate {
  code: string;
  fingerprint: string;
  outcome: string;
  source: FamilySource;
  generated: AiAttempt<FamilyDescription>;
  audit: AiAttempt<{ supported: boolean; reason: string }>;
  comparison: AiAttempt<{ improved: boolean; reason: string }>;
}
export async function applyFamilyQualityRefresh(
  candidates: ReviewedFamilyCandidate[],
  apply = false,
) {
  if (new Set(candidates.map((c) => c.code)).size !== candidates.length)
    throw Error("Duplicate candidate");
  const results = [];
  for (const candidate of candidates) {
    if (
      candidate.outcome !== "approved" ||
      candidate.audit?.result.supported !== true ||
      candidate.comparison?.result.improved !== true
    )
      throw Error(
        "Candidate lacks source audit or educational improvement approval",
      );
    for (const attempt of [
      candidate.generated,
      candidate.audit,
      candidate.comparison,
    ])
      if (
        !["claude-sonnet-5", "claude-opus-5"].includes(
          attempt.servedModel ?? "",
        )
      )
        throw Error("Unverified model provenance");
    const draft = validateFamilyDescription(
      candidate.generated.result,
      candidate.source,
    );
    const outcome = await withTransaction(async (client) => {
      if (!apply) await client.query("SET TRANSACTION READ ONLY");
      else await client.query("LOCK TABLE taxonomy_cache IN SHARE MODE");
      const row = (
        await client.query(
          `SELECT * FROM family_enrichment WHERE family_code=$1${apply ? " FOR UPDATE" : ""}`,
          [candidate.code],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== "ready" ||
        familyPublicationFingerprint(row) !== candidate.fingerprint
      )
        return "changed_since_review";
      const taxonomy = (
        await client.query(
          "SELECT species_code,sci_name,family_sci_name,order_name FROM taxonomy_cache WHERE category='species' AND family_code=$1 ORDER BY species_code",
          [candidate.code],
        )
      ).rows;
      if (!taxonomy.length) return "taxonomy_changed";
      const input = familyInputHash(
        {
          code: candidate.code,
          scientificName: taxonomy[0].family_sci_name,
          order: taxonomy[0].order_name,
          name: null,
          count: taxonomy.length,
          taxonOrder: null,
        },
        taxonomy.map((t) => t.species_code + ":" + t.sci_name),
      );
      if (input !== row.input_hash || row.published_hash !== row.input_hash)
        return "taxonomy_changed";
      const currentMembers = new Set(taxonomy.map((t) => String(t.sci_name)));
      if (
        candidate.source.resolverVersion !== "3" ||
        !candidate.source.members ||
        candidate.source.members.length !== currentMembers.size ||
        candidate.source.members.some((m) => !currentMembers.has(m))
      )
        throw Error("Candidate source taxonomy does not match current family");
      if (!apply) return "eligible";
      await client.query(
        `INSERT INTO family_enrichment_diagnostics(family_code,input_hash,resolver_version,outcome,source,draft,diagnostics)
        VALUES($1,$2,'3','quality_refresh_replaced',$3,$4,$5)`,
        [
          candidate.code,
          row.input_hash,
          row.source,
          row.content,
          JSON.stringify({
            previousFingerprint: candidate.fingerprint,
            previousModel: row.model,
            previousVerifier: row.verifier_model,
            previousGeneratedAt: row.generated_at,
            comparison: candidate.comparison.result,
            comparisonModel: candidate.comparison.servedModel,
            sourceAudit: candidate.audit.result,
          }),
        ],
      );
      await client.query(
        `UPDATE family_enrichment SET content=$2,source=$3,model=$4,verifier_model=$5,published_hash=input_hash,
        status='ready',generated_at=NOW(),next_attempt_at=NOW()+interval '180 days',failures=0,last_error=NULL,
        pending_source=NULL,pending_draft=NULL,pending_model=NULL WHERE family_code=$1`,
        [
          candidate.code,
          JSON.stringify(draft),
          JSON.stringify(candidate.source),
          candidate.generated.servedModel,
          candidate.audit.servedModel,
        ],
      );
      return "published";
    });
    results.push({ code: candidate.code, outcome });
  }
  return results;
}

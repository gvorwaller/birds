import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { query } from "$lib/db";
import { familyInputHash } from "./family-enrichment";
import {
  applyFamilyQualityRefresh,
  familyPublicationFingerprint,
  type ReviewedFamilyCandidate,
} from "./family-quality-refresh";
let saved: Record<string, unknown>[];
let candidate: ReviewedFamilyCandidate;
let hash: string;
const old = {
  paragraphs: [
    {
      topic: "History",
      text: "The old account discusses historical classification instead of useful field traits.",
      evidence: ["P1"],
    },
  ],
};
const fresh = {
  paragraphs: [
    {
      topic: "Feeding",
      text: "These fish-eating birds hunt over water and catch their prey with their feet.",
      evidence: ["P1"],
    },
  ],
};
beforeAll(async () => {
  const db = (
    await query("SELECT current_database() AS db,inet_server_port() AS port")
  ).rows[0];
  if (db.db !== "birds_test" || db.port !== 15436)
    throw Error("Requires isolated birds_test");
  saved = (
    await query("SELECT * FROM family_enrichment WHERE family_code='pandio1'")
  ).rows;
});
beforeEach(async () => {
  const taxonomy = (
    await query(
      "SELECT species_code,sci_name,family_sci_name,order_name FROM taxonomy_cache WHERE category='species' AND family_code='pandio1' ORDER BY species_code",
    )
  ).rows;
  hash = familyInputHash(
    {
      code: "pandio1",
      name: null,
      scientificName: taxonomy[0].family_sci_name,
      order: taxonomy[0].order_name,
      count: taxonomy.length,
      taxonOrder: null,
    },
    taxonomy.map((r) => r.species_code + ":" + r.sci_name),
  );
  const source = {
    title: "Osprey",
    url: "https://en.wikipedia.org/w/index.php?title=Osprey&oldid=1",
    revision: 1,
    qid: "Q1",
    fetchedAt: new Date().toISOString(),
    text: fresh.paragraphs[0].text,
    resolverVersion: "3",
    members: taxonomy.map((r) => r.sci_name),
  };
  await query(
    "INSERT INTO family_enrichment(family_code,input_hash,published_hash,status,content,source,generated_at) VALUES('pandio1',$1,$1,'ready',$2,$3,NOW()) ON CONFLICT(family_code) DO UPDATE SET input_hash=$1,published_hash=$1,status='ready',content=$2,source=$3,generated_at=NOW()",
    [hash, JSON.stringify(old), JSON.stringify(source)],
  );
  const row = (
    await query("SELECT * FROM family_enrichment WHERE family_code='pandio1'")
  ).rows[0];
  const provenance = {
    requestedModel: "claude-sonnet-5",
    servedModel: "claude-sonnet-5",
    envelope: {
      requestId: null,
      httpStatus: 200,
      providerErrorType: null,
      attempts: [],
    },
  };
  candidate = {
    code: "pandio1",
    fingerprint: familyPublicationFingerprint(row as never),
    outcome: "approved",
    source,
    generated: { ...provenance, result: fresh },
    audit: {
      ...provenance,
      result: { supported: true, reason: "Supported fixture" },
    },
    comparison: {
      ...provenance,
      result: { improved: true, reason: "Adds useful natural history" },
    },
  };
});
afterAll(async () => {
  await query("DELETE FROM family_enrichment WHERE family_code='pandio1'");
  if (saved.length)
    await query(
      "INSERT INTO family_enrichment SELECT * FROM json_populate_recordset(NULL::family_enrichment,$1::json)",
      [JSON.stringify(saved)],
    );
});
it("previews without changing publications or schedules", async () => {
  const before = (
    await query("SELECT * FROM family_enrichment WHERE family_code='pandio1'")
  ).rows[0];
  expect(await applyFamilyQualityRefresh([candidate])).toEqual([
    { code: "pandio1", outcome: "eligible" },
  ]);
  expect(
    (await query("SELECT * FROM family_enrichment WHERE family_code='pandio1'"))
      .rows[0],
  ).toEqual(before);
});
it("publishes only approved improvements, archives the original, and retains the six-month interval", async () => {
  const others = (
    await query(
      "SELECT * FROM family_enrichment WHERE family_code<>'pandio1' ORDER BY family_code",
    )
  ).rows;
  expect(await applyFamilyQualityRefresh([candidate], true)).toEqual([
    { code: "pandio1", outcome: "published" },
  ]);
  const row = (
    await query(
      "SELECT content,input_hash,published_hash,next_attempt_at-generated_at AS interval FROM family_enrichment WHERE family_code='pandio1'",
    )
  ).rows[0];
  expect(row.content).toEqual(fresh);
  expect(row.input_hash).toBe(hash);
  expect(row.published_hash).toBe(hash);
  expect(row.interval.days).toBe(180);
  expect(
    (
      await query(
        "SELECT draft FROM family_enrichment_diagnostics WHERE family_code='pandio1' AND outcome='quality_refresh_replaced' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0].draft,
  ).toEqual(old);
  expect(
    (
      await query(
        "SELECT * FROM family_enrichment WHERE family_code<>'pandio1' ORDER BY family_code",
      )
    ).rows,
  ).toEqual(others);
});
it("refuses stale reviews and unapproved replacements", async () => {
  await query(
    "UPDATE family_enrichment SET content=$1 WHERE family_code='pandio1'",
    [JSON.stringify(fresh)],
  );
  expect(await applyFamilyQualityRefresh([candidate], true)).toEqual([
    { code: "pandio1", outcome: "changed_since_review" },
  ]);
  await expect(
    applyFamilyQualityRefresh([{ ...candidate, outcome: "keep_old" }], true),
  ).rejects.toThrow("approval");
});
it("refuses taxonomy drift even when the old publication fingerprint still matches", async () => {
  await query(
    "UPDATE family_enrichment SET input_hash='changed-taxonomy' WHERE family_code='pandio1'",
  );
  expect(await applyFamilyQualityRefresh([candidate], true)).toEqual([
    { code: "pandio1", outcome: "taxonomy_changed" },
  ]);
});

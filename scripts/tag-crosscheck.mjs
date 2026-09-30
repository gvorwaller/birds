#!/usr/bin/env node
/**
 * AGENT tool (never an owner step): show a rule proposal to the cross-check
 * reviewer, then record the reviewer's verdict (td-894144 Release B4, plan
 * rev 26 §B4c).
 *
 *   node scripts/tag-crosscheck.mjs show   <proposal-uuid> --env <file>
 *   node scripts/tag-crosscheck.mjs record <proposal-uuid> --env <file> \
 *        --reviewer CODEX1 --verdict approve|changes|reject --text-file <path>
 *
 * Runs as the table OWNER (MIGRATION_PGUSER / MIGRATION_PGPASSWORD from the
 * env file) because record_tag_crosscheck is deliberately not executable by
 * the app role. The database recomputes the artifact hash itself; nothing
 * here supplies it. --env is required so the target database is always a
 * deliberate choice (.env.test locally; /opt/birds/.env on the droplet).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");

const [cmd, id, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const usage = () => {
  console.error(
    "usage: tag-crosscheck.mjs show|record <proposal-uuid> --env <file> [--reviewer CODEX1 --verdict approve|changes|reject --text-file <path>]",
  );
  process.exitCode = 2;
};

async function main() {
  if (
    !["show", "record"].includes(cmd) ||
    !/^[0-9a-f-]{36}$/.test(id ?? "") ||
    !arg("env")
  )
    return usage();
  const env = Object.fromEntries(
    readFileSync(arg("env"), "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, "")]),
  );
  const required = [
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "MIGRATION_PGUSER",
    "MIGRATION_PGPASSWORD",
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length)
    throw new Error(
      `the env file is missing required database settings: ${missing.join(", ")}`,
    );
  const port = Number(env.PGPORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PGPORT must be an integer from 1 to 65535");
  const client = new pg.Client({
    host: env.PGHOST,
    port,
    database: env.PGDATABASE,
    user: env.MIGRATION_PGUSER,
    password: env.MIGRATION_PGPASSWORD,
  });
  await client.connect();
  try {
    const p = (
      await client.query(
        "SELECT id, tag, status, source, artifact, artifact_sha256, created_at FROM tag_rule_proposal WHERE id = $1",
        [id],
      )
    ).rows[0];
    if (!p) throw new Error(`no proposal ${id}`);
    if (cmd === "show") {
      console.log(
        `database: ${env.MIGRATION_PGUSER}@${env.PGHOST}:${port}/${env.PGDATABASE}  proposal ${p.id}  tag ${p.tag}  status ${p.status}  source ${p.source}`,
      );
      console.log(`artifact_sha256: ${p.artifact_sha256}`);
      console.log(JSON.stringify(p.artifact, null, 2));
      return;
    }
    const reviewer = arg("reviewer");
    const verdict = arg("verdict");
    const textFile = arg("text-file");
    if (!reviewer || !verdict || !textFile) return usage();
    const text = readFileSync(textFile, "utf8").trim();
    const r = await client.query(
      "SELECT public.record_tag_crosscheck($1, $2, $3, $4)::text AS id",
      [id, reviewer, verdict, text],
    );
    const c = (
      await client.query(
        "SELECT reviewed_sha256 FROM tag_crosscheck WHERE id = $1",
        [r.rows[0].id],
      )
    ).rows[0];
    console.log(
      `recorded cross-check ${r.rows[0].id}: ${reviewer} ${verdict} on sha ${c.reviewed_sha256}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

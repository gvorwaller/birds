#!/usr/bin/env node
/**
 * Create an ingest token for an external-source connector (td-eec7db Phase 1)
 * and write it straight into the connector's env file. Run by agents on the
 * droplet; the owner never handles a token.
 *
 *   node --env-file=/opt/birds/.env scripts/connector-token.mjs \
 *     --source artsobs-gbif --label droplet \
 *     --out /opt/birds/connectors/gbif-artsobs.env \
 *     --ingest-url http://127.0.0.1:3003/api/ingest/ [--rotate]
 *
 * - The token is never printed, logged or passed as an argument. Only its
 *   SHA-256 is stored (external_connectors.token_sha256).
 * - The env file is written atomically (temp file, then rename) with mode
 *   0600. Lines other than INGEST_URL / INGEST_TOKEN are kept.
 * - An existing env file is refused unless --rotate; --rotate revokes the
 *   source's earlier unrevoked tokens with the same label, but only after the
 *   new file is installed (see the rotation order below).
 * - Database settings come from the environment (PGHOST, PGPORT, PGDATABASE,
 *   PGUSER, PGPASSWORD); a missing one is an error, never a default.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function die(message) {
  console.error(`[connector-token] ${message}`);
  process.exit(1);
}

const sourceId = arg("source");
const label = arg("label");
// Not "--env-file": Node claims that flag even after the script name.
const envFile = arg("out");
const ingestUrl = arg("ingest-url");
const rotate = process.argv.includes("--rotate");

if (!sourceId || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(sourceId)) die("--source <id> is required.");
if (!label || label.trim().length === 0 || label.length > 80) die("--label <name> (1–80 characters) is required.");
if (!envFile || !path.isAbsolute(envFile)) die("--out <absolute path to the connector env file> is required.");
if (!ingestUrl || !/^https?:\/\/[^\s]+\/api\/ingest\/$/.test(ingestUrl)) {
  die("--ingest-url must be the app's ingest base, ending in /api/ingest/.");
}
for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
  if (!process.env[key]) die(`${key} is not set; run with --env-file pointing at the app's .env.`);
}
// Every step below runs under one database session lock per source+label and
// per output file, so two rotations at once run one after the other and never
// revoke each other's new token. The lock is taken before the file is checked
// and released when the session ends (also on a crash).
const client = new pg.Client({ application_name: "birds-connector-token" });
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('connector-token:label:' || $1 || ':' || $2))", [sourceId, label.trim()]);
  await client.query("SELECT pg_advisory_lock(hashtext('connector-token:file:' || $1))", [path.resolve(envFile)]);
} catch (err) {
  await client.end().catch(() => {});
  die(`could not reach the database: ${err instanceof Error ? err.message : String(err)}`);
}
async function fail(message) {
  await client.end().catch(() => {});
  die(message);
}

if (existsSync(envFile) && !rotate) await fail(`${envFile} already exists; pass --rotate to replace its token.`);

const token = `ext_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token, "utf8").digest();

// Keep the connector's other settings; replace only the two ingest lines.
const kept = existsSync(envFile)
  ? readFileSync(envFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !/^(INGEST_URL|INGEST_TOKEN)=/.test(line))
  : [];
const content = [...kept, `INGEST_URL=${ingestUrl}`, `INGEST_TOKEN=${token}`, ""].join("\n");

mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
const tmp = `${envFile}.tmp-${process.pid}`;
const fd = openSync(tmp, "wx", 0o600);
try {
  writeSync(fd, content);
  fsyncSync(fd);
} finally {
  closeSync(fd);
}

// Rotation order keeps a working token installed at every moment: store the
// new hash (old token still valid) → install the new file → only then revoke
// the earlier tokens. A crash between steps leaves either the old file with a
// still-valid token, or the new file plus an extra valid old token that a
// re-run (or Admin → Sources) revokes.
let connectorId;
try {
  const src = await client.query("SELECT 1 FROM external_sources WHERE id = $1", [sourceId]);
  if (!src.rows[0]) throw new Error(`no source "${sourceId}" is registered`);
  const ins = await client.query(
    `INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, $2, $3) RETURNING id`,
    [sourceId, label.trim(), hash],
  );
  connectorId = ins.rows[0].id;
} catch (err) {
  rmSync(tmp, { force: true });
  await fail(`nothing was changed: ${err instanceof Error ? err.message : String(err)}`);
}

try {
  renameSync(tmp, envFile);
} catch (err) {
  rmSync(tmp, { force: true });
  await client
    .query("UPDATE external_connectors SET revoked_at = now() WHERE id = $1", [connectorId])
    .catch(() => {});
  await fail(
    `${envFile} could not be written (${err instanceof Error ? err.message : String(err)}); ` +
      `the new token #${connectorId} was revoked and the existing file is unchanged.`,
  );
}

let revoked = 0;
if (rotate) {
  try {
    const r = await client.query(
      `UPDATE external_connectors SET revoked_at = now()
        WHERE source_id = $1 AND label = $2 AND revoked_at IS NULL AND id <> $3`,
      [sourceId, label.trim(), connectorId],
    );
    revoked = r.rowCount ?? 0;
  } catch (err) {
    await fail(
      `the new token #${connectorId} is installed in ${envFile}, but the earlier tokens could not be revoked ` +
        `(${err instanceof Error ? err.message : String(err)}); revoke them in Admin → Sources.`,
    );
  }
}
await client.end();
console.log(
  `[connector-token] connector #${connectorId} (${label.trim()}) created for ${sourceId}; ` +
    `token written to ${envFile} (mode 600)${rotate ? `; ${revoked} earlier token(s) with this label revoked` : ""}.`,
);

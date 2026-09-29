/**
 * TEST-ONLY fixture helper for species tags (td-894144 Release A).
 *
 * The running app can no longer write `tags`, `legacy_tags` or `search_tsv`:
 * migration 0065 removed birds_app's privileges on those columns, and AI never
 * produces tags. Tests that need a tagged species therefore write through the
 * TABLE OWNER role (birds_owner, from .env.test) with the test-database,
 * owner-role and transaction-local fixture keys required by the guard.
 *
 * Never import this from runtime code — the static guard test enforces that
 * only *.test.ts files may import a *.test-helper.ts module.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

function loadEnvTest(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try {
    raw = readFileSync(new URL("../../../.env.test", import.meta.url), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

/** Run `fn` on a fresh connection as the table owner (birds_owner). */
export async function withOwnerClient<T>(
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const env = loadEnvTest();
  const host = env.PGHOST;
  const port = Number(env.PGPORT);
  const database = env.PGDATABASE;
  const user = env.MIGRATION_PGUSER;
  if (
    env.BIRDS_ENV !== "test" ||
    !["127.0.0.1", "localhost"].includes(host ?? "") ||
    port !== 15436 ||
    database !== "birds_test" ||
    user !== "birds_owner" ||
    !env.MIGRATION_PGPASSWORD
  ) {
    throw new Error(
      "tag fixture owner connection refused: .env.test must explicitly select the local birds_test owner",
    );
  }
  const c = new pg.Client({
    host,
    port,
    database,
    user,
    password: env.MIGRATION_PGPASSWORD,
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Give an OWNED fixture species effective tags (and, by default, the same
 * legacy baseline, so the species reads as "tags available"). The row must
 * already exist. `legacy: false` leaves legacy_tags NULL — the "never
 * evaluated" state a species annotated after the Release A cutover has.
 */
export async function setFixtureTags(
  code: string,
  tags: readonly string[],
  opts: { legacy?: boolean } = {},
): Promise<void> {
  const legacy = opts.legacy ?? true;
  await withOwnerClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('birds.legacy_fixture', 'on', true)`);
      const r = await c.query(
        `UPDATE species_enrichment
				    SET tags = $2::text[], legacy_tags = CASE WHEN $3 THEN $2::text[] ELSE NULL END
				  WHERE species_code = $1`,
        [code, [...tags], legacy],
      );
      if (r.rowCount !== 1)
        throw new Error(
          `setFixtureTags: no species_enrichment row for ${code}`,
        );
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

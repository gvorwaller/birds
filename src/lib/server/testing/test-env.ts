/**
 * Test support for DB-backed suites: load `.env.test` like the established DB
 * tests, refuse to run against anything but the dedicated test cluster, and FAIL
 * (not skip) when that database is unreachable, so a clean run can never pass by
 * silently skipping its DB assertions. Never used by production code.
 */
import { readFileSync } from "node:fs";

/** Parse `.env.test` and expose the connection variables before the first query. */
export function loadTestEnv(): void {
  let raw = "";
  try {
    raw = readFileSync(new URL("../../../../.env.test", import.meta.url), "utf8");
  } catch {
    // Fall through: the safety check below reports what is missing.
  }
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
    if (env[key]) process.env[key] = env[key];
  }
  process.env.EBIRD_KEY_SECRET ??= env.EBIRD_KEY_SECRET ?? "test-secret";
  if (
    process.env.PGHOST !== "127.0.0.1" ||
    process.env.PGPORT !== "15436" ||
    process.env.PGDATABASE !== "birds_test"
  )
    throw new Error("DB tests require the dedicated birds_test cluster on 127.0.0.1:15436 (.env.test).");
}

/** Throws (rather than skipping) unless the isolated test database answers. */
export async function requireTestDb(query: (sql: string) => Promise<unknown>): Promise<void> {
  try {
    await query("SELECT 1");
  } catch (err) {
    throw new Error(
      `birds_test is unreachable (${err instanceof Error ? err.message : String(err)}); start it with npm run test:db:up.`,
    );
  }
}

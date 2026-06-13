import pg from "pg";
import { b as private_env } from "./shared-server.js";
const { Pool } = pg;
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: private_env.PGHOST ?? "127.0.0.1",
      port: Number(private_env.PGPORT ?? 5436),
      database: private_env.PGDATABASE ?? "birds",
      user: private_env.PGUSER ?? "birds_app",
      password: private_env.PGPASSWORD,
      max: 10,
      idleTimeoutMillis: 3e4,
      application_name: "birds-app"
    });
  }
  return pool;
}
async function query(text, params) {
  return getPool().query(text, params);
}
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}
async function dbHealthCheck() {
  try {
    const r = await query("SELECT 1 AS one");
    return r.rows[0]?.one === 1;
  } catch {
    return false;
  }
}
export {
  dbHealthCheck as d,
  query as q,
  withTransaction as w
};

import { redirect } from "@sveltejs/kit";
import { randomBytes } from "node:crypto";
import { q as query } from "./db.js";
import { D as DEV } from "./false.js";
const SESSION_COOKIE_NAME = "birds_session";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1e3;
function newToken() {
  return randomBytes(32).toString("base64url");
}
async function createSession(userId) {
  const id = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
    id,
    userId,
    expiresAt
  ]);
  return id;
}
async function validateSession(token) {
  const res = await query(
    `SELECT s.id AS sid, s.expires_at,
		        u.id AS uid, u.username, u.role, u.display_name
		   FROM sessions s
		   JOIN users u ON u.id = s.user_id
		  WHERE s.id = $1`,
    [token]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query("DELETE FROM sessions WHERE id = $1", [token]);
    return null;
  }
  const nextExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await query("UPDATE sessions SET expires_at = $1 WHERE id = $2", [nextExpiry, token]);
  return {
    id: row.uid,
    username: row.username,
    role: row.role,
    display_name: row.display_name
  };
}
async function destroySession(token) {
  await query("DELETE FROM sessions WHERE id = $1", [token]);
}
const SESSION_COOKIE_OPTS = {
  path: "/",
  httpOnly: true,
  sameSite: "strict",
  secure: !DEV,
  maxAge: 60 * 60 * 24 * 30
};
const PUBLIC_PATHS = ["/login", "/api/health"];
function isPublic(path) {
  return PUBLIC_PATHS.some((p) => path === p);
}
const handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE_NAME);
  if (token) {
    const user = await validateSession(token);
    if (user) {
      event.locals.user = user;
    } else {
      event.cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
    }
  }
  const path = event.url.pathname;
  if (!isPublic(path) && !event.locals.user) {
    if (event.request.method === "GET") {
      const returnTo = encodeURIComponent(path);
      throw redirect(303, `/login?returnTo=${returnTo}`);
    }
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  return resolve(event);
};
export {
  SESSION_COOKIE_NAME as S,
  SESSION_COOKIE_OPTS as a,
  createSession as c,
  destroySession as d,
  handle as h
};

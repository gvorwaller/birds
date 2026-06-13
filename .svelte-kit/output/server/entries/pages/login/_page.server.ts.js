import { redirect, fail } from "@sveltejs/kit";
import argon2 from "argon2";
import { q as query } from "../../../chunks/db.js";
import { S as SESSION_COOKIE_NAME, d as destroySession, c as createSession, a as SESSION_COOKIE_OPTS } from "../../../chunks/hooks.server.js";
({
  type: argon2.argon2id
});
async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
async function findUserByUsername(username) {
  const res = await query(
    `SELECT id, username, display_name, role, password_hash, home_lat, home_lon, last_login_at
		   FROM users WHERE username = $1`,
    [username]
  );
  return res.rows[0] ?? null;
}
async function recordLogin(userId) {
  await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [userId]);
}
const DUMMY_HASH = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
function safeReturnTo(value) {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value === "/login") return null;
  return value;
}
const load = ({ locals, url }) => {
  if (locals.user) {
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
    throw redirect(303, returnTo ?? "/");
  }
  return {};
};
const actions = {
  login: async ({ cookies, request, url }) => {
    const form = await request.formData();
    const username = (form.get("username") ?? "").toString().trim().toLowerCase();
    const password = (form.get("password") ?? "").toString();
    if (!username || !password) {
      return fail(400, { username, error: "Enter a username and password." });
    }
    const user = await findUserByUsername(username);
    if (!user) {
      await verifyPassword(DUMMY_HASH, password);
      return fail(401, { username, error: "Username or password is incorrect." });
    }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      return fail(401, { username, error: "Username or password is incorrect." });
    }
    await recordLogin(user.id);
    const sessionId = await createSession(user.id);
    cookies.set(SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTS);
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
    throw redirect(303, returnTo ?? "/");
  },
  logout: async ({ cookies }) => {
    const token = cookies.get(SESSION_COOKIE_NAME);
    if (token) {
      await destroySession(token);
      cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
    }
    throw redirect(303, "/login");
  }
};
export {
  actions,
  load
};

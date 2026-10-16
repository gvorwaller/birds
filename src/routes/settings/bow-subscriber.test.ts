import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { scopeOwnerId } from "$server/access";
import type { SessionUser } from "$server/session";
import { actions, load as settingsLoad } from "./+page.server";
import { load as speciesLoad } from "../species/[code]/+page.server";

// td-9308e2: the Birds of the World tick is personal to the signed-in account.
const nonce = randomUUID();
const actors: SessionUser[] = [];
let owner: SessionUser, other: SessionUser, viewer: SessionUser;
let speciesCode: string;

async function actor(
  name: string,
  role: SessionUser["role"] = "user",
  parent: number | null = null,
) {
  const row = (
    await query<SessionUser>(
      `INSERT INTO users(username,display_name,password_hash,role,views_user_id)
       VALUES($1,$2,'!test-unset',$3,$4) RETURNING id,username,display_name,role,views_user_id,theme`,
      [name + nonce, name, role, parent],
    )
  ).rows[0];
  actors.push(row);
  return row;
}
function saveEvent(
  user: SessionUser | undefined,
  body: Record<string, string>,
) {
  return {
    locals: { user, scopeId: user && scopeOwnerId(user) },
    request: new Request("http://localhost/settings?/bow_subscriber", {
      method: "POST",
      body: new URLSearchParams(body),
    }),
  } as Parameters<NonNullable<typeof actions.bow_subscriber>>[0];
}
const save = (user: SessionUser, on: boolean) =>
  actions.bow_subscriber!(
    saveEvent(user, {
      accountId: String(user.id),
      ...(on ? { bow_subscriber: "on" } : {}),
    }),
  );
async function speciesFlag(user: SessionUser) {
  const data = await speciesLoad({
    locals: { user, scopeId: scopeOwnerId(user) },
    params: { code: speciesCode },
    url: new URL(`http://localhost/species/${speciesCode}`),
    request: new Request(`http://localhost/species/${speciesCode}`),
    depends: () => {},
  } as unknown as Parameters<typeof speciesLoad>[0]);
  return (data as { bowSubscriber: boolean }).bowSubscriber;
}
async function settingsFlag(user: SessionUser) {
  const data = await settingsLoad({
    locals: { user, scopeId: scopeOwnerId(user) },
    url: new URL("http://localhost/settings"),
  } as unknown as Parameters<typeof settingsLoad>[0]);
  return (data as { bowSubscriber: boolean }).bowSubscriber;
}

beforeAll(async () => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires isolated birds_test");
  // Reading these pages must never reach a provider.
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("unexpected network call")),
  );
  const code = await query<{ species_code: string }>(
    "SELECT species_code FROM taxonomy_cache WHERE species_code = 'norcar' AND category = 'species'",
  );
  if (!code.rows[0]) throw Error("birds_test taxonomy lacks norcar");
  speciesCode = code.rows[0].species_code;
  owner = await actor("BOW owner");
  other = await actor("BOW other");
  viewer = await actor("BOW viewer", "viewer", owner.id);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  // Viewers first: views_user_id points at the owner.
  for (const u of [...actors].reverse())
    await query("DELETE FROM users WHERE id = $1", [u.id]);
  const left = await query(
    "SELECT count(*)::int AS n FROM users WHERE username LIKE $1",
    [`%${nonce}`],
  );
  expect(left.rows[0].n).toBe(0);
});

describe("Birds of the World subscription setting (td-9308e2)", () => {
  it("starts off on Settings and on species pages", async () => {
    expect(await settingsFlag(owner)).toBe(false);
    expect(await speciesFlag(owner)).toBe(false);
  });

  it("turns on for the saving account only — not another user, not its viewer", async () => {
    expect(await save(owner, true)).toMatchObject({ ok: true });
    expect(await settingsFlag(owner)).toBe(true);
    expect(await speciesFlag(owner)).toBe(true);
    expect(await speciesFlag(other)).toBe(false);
    // The viewer reads the owner's life list but has its own subscription.
    expect(await speciesFlag(viewer)).toBe(false);
  });

  it("turns off again", async () => {
    expect(await save(owner, false)).toMatchObject({ ok: true });
    expect(await speciesFlag(owner)).toBe(false);
  });

  it("refuses a stale account, a bad value and a signed-out request without saving", async () => {
    expect(
      await actions.bow_subscriber!(
        saveEvent(other, { accountId: String(owner.id), bow_subscriber: "on" }),
      ),
    ).toMatchObject({ status: 409 });
    expect(
      await actions.bow_subscriber!(
        saveEvent(other, {
          accountId: String(other.id),
          bow_subscriber: "yes",
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await actions.bow_subscriber!(
        saveEvent(undefined, { bow_subscriber: "on" }),
      ),
    ).toMatchObject({
      status: 401,
    });
    const rows = await query<{ bow_subscriber: boolean }>(
      "SELECT bow_subscriber FROM users WHERE id = ANY($1)",
      [[owner.id, other.id]],
    );
    expect(rows.rows.every((r) => r.bow_subscriber === false)).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { scopeOwnerId } from "$server/access";
import type { SessionUser } from "$server/session";
import { load } from "./+page.server";
import { actions } from "../settings/+page.server";

const nonce = randomUUID();
const actors: SessionUser[] = [];
const loc = "Lsharing-" + nonce;
let alice: SessionUser,
  bob: SessionUser,
  hidden: SessionUser,
  viewer: SessionUser,
  empty: SessionUser;
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
function event(user: SessionUser | undefined, search = "") {
  return {
    locals: { user, scopeId: user && scopeOwnerId(user) },
    url: new URL("http://localhost/life" + search),
  } as Parameters<typeof load>[0];
}
async function read(user: SessionUser, search = "") {
  const result = await load(event(user, search));
  if (!result) throw Error("Missing life-list data");
  return result;
}
function shareEvent(
  user: SessionUser | undefined,
  enabled: boolean,
  accountId = user?.id,
) {
  return {
    locals: { user, scopeId: user && scopeOwnerId(user) },
    request: new Request("http://localhost/settings?/share_life_list", {
      method: "POST",
      body: new URLSearchParams({
        accountId: String(accountId),
        ...(enabled ? { share_life_list: "on" } : {}),
      }),
    }),
  } as Parameters<NonNullable<typeof actions.share_life_list>>[0];
}
async function share(user: SessionUser, enabled: boolean) {
  return actions.share_life_list!(shareEvent(user, enabled));
}
beforeAll(async () => {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  )
    throw Error("Requires isolated birds_test");
  alice = await actor("Alice sharing");
  bob = await actor("Bob sharing");
  hidden = await actor("Private sharing");
  viewer = await actor("Family sharing", "viewer", alice.id);
  empty = await actor("Empty sharing");
  for (const [user, code, lat] of [
    [alice, "osprey", 30],
    [bob, "redhea", 40],
    [hidden, "moublu", 50],
  ] as const) {
    await query(
      `INSERT INTO seen_species(user_id,species_code,first_seen,csv_row_num,location_name,loc_id,region_code,sub_id)
      VALUES($1,$2,'2026-01-01',1,'Shared fixture location',$3,'US-FL','Ssharing-fixture')`,
      [user.id, code, loc],
    );
    await query(
      `INSERT INTO lifer_loc_coords(user_id,source_loc_id,source_sub_id,lat,lng,provenance)
      VALUES($1,$2,'Ssharing-fixture',$3,-80,'owner_html')`,
      [user.id, loc, lat],
    );
  }
  await query(
    `INSERT INTO user_ebird(user_id,life_list_synced_at,life_list_status,life_list_error,
    login_username_enc,login_password_enc,loc_resolution_status,loc_resolution_error)
    VALUES($1,NOW(),'error','private-sync-test','test-not-credentials','test-not-credentials','error','private-resolution-test')`,
    [alice.id],
  );
});
afterAll(async () => {
  await query("DELETE FROM users WHERE id=ANY($1::int[])", [
    actors.map((a) => a.id),
  ]);
});

describe("opt-in life-list sharing on PostgreSQL", () => {
  it("starts private and never lists or exposes a private owner via a guessed ID", async () => {
    expect(
      (await query("SELECT share_life_list FROM users WHERE id=$1", [alice.id]))
        .rows[0].share_life_list,
    ).toBe(false);
    const own = await read(bob);
    expect(own.lifers.map((r) => r.species_code)).toEqual(["redhea"]);
    expect(
      own.listChoices.some(
        (choice) => choice.id === alice.id || choice.id === hidden.id,
      ),
    ).toBe(false);
    await expect(read(bob, `?user=${alice.id}`)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("shares only the chosen life list, using its owner coordinates and preserving normal account scope", async () => {
    await share(alice, true);
    const e = event(bob, `?user=${alice.id}`);
    const data = await load(e);
    expect(data).toMatchObject({
      selectedUser: { id: alice.id },
      canManage: false,
      isOtherList: true,
      listHref: `/life?user=${alice.id}`,
    });
    expect(data!.lifers).toEqual([
      expect.objectContaining({
        species_code: "osprey",
        lat: 30,
        lng: -80,
        sub_id: "Ssharing-fixture",
      }),
    ]);
    expect(e.locals.scopeId).toBe(bob.id);
    expect(scopeOwnerId(bob)).toBe(bob.id);
    expect((await read(bob)).lifers.map((r) => r.species_code)).toEqual([
      "redhea",
    ]);
    expect(data!.listChoices.some((choice) => choice.id === hidden.id)).toBe(
      false,
    );
  });
  it("never serializes someone else's sync errors or credential metadata", async () => {
    const shared = await read(bob, `?user=${alice.id}`);
    expect(shared.syncedAt).not.toBeNull();
    expect(shared).toMatchObject({
      syncStatus: null,
      syncError: null,
      hasCreds: false,
      locResolutionStatus: null,
      locResolutionError: null,
    });
    expect(JSON.stringify(shared)).not.toMatch(
      /private-sync-test|private-resolution-test|test-not-credentials/,
    );
    const own = await read(alice);
    expect(own.syncError).toBe("private-sync-test");
    expect(own.canManage).toBe(true);
  });
  it("revokes new reads and picker entries while keeping existing family access", async () => {
    await share(alice, false);
    expect(
      (await read(bob)).listChoices.some((choice) => choice.id === alice.id),
    ).toBe(false);
    await expect(read(bob, `?user=${alice.id}`)).rejects.toMatchObject({
      status: 404,
    });
    const family = await read(viewer);
    expect(family.selectedUser.id).toBe(alice.id);
    expect(family.canManage).toBe(false);
    expect(family.lifers.map((r) => r.species_code)).toEqual(["osprey"]);
  });
  it("lets family viewers browse opted-in owners without granting write permission", async () => {
    await share(bob, true);
    const shared = await read(viewer, `?user=${bob.id}`);
    expect(shared.lifers.map((r) => r.species_code)).toEqual(["redhea"]);
    expect(shared.canManage).toBe(false);
    const denied = await actions.share_life_list!(
      shareEvent(viewer, true, alice.id),
    );
    expect(denied).toMatchObject({ status: 403 });
    expect(
      (await query("SELECT share_life_list FROM users WHERE id=$1", [alice.id]))
        .rows[0].share_life_list,
    ).toBe(false);
  });
  it("saves only the signed-in account and rejects stale-account forms", async () => {
    expect(
      await actions.share_life_list!(shareEvent(bob, true, alice.id)),
    ).toMatchObject({ status: 409 });
    const e = shareEvent(bob, true);
    const form = new URLSearchParams({
      accountId: String(bob.id),
      share_life_list: "on",
      user_id: String(alice.id),
    });
    e.request = new Request("http://localhost/settings?/share_life_list", {
      method: "POST",
      body: form,
    });
    await actions.share_life_list!(e);
    expect(
      (await query("SELECT share_life_list FROM users WHERE id=$1", [alice.id]))
        .rows[0].share_life_list,
    ).toBe(false);
    expect(
      (await query("SELECT share_life_list FROM users WHERE id=$1", [bob.id]))
        .rows[0].share_life_list,
    ).toBe(true);
  });
  it("handles an opted-in empty list and rejects malformed, missing and deleted targets", async () => {
    await share(empty, true);
    expect((await read(bob, `?user=${empty.id}`)).lifers).toEqual([]);
    for (const search of [
      "?user=",
      "?user=0",
      "?user=-1",
      "?user=abc",
      "?user=1&user=2",
      "?user=2147483648",
    ])
      await expect(read(bob, search)).rejects.toMatchObject({ status: 400 });
    await query("DELETE FROM users WHERE id=$1", [empty.id]);
    await expect(read(bob, `?user=${empty.id}`)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("requires authentication for both list reads and sharing changes", async () => {
    await expect(load(event(undefined))).rejects.toMatchObject({
      status: 303,
      location: "/login",
    });
    expect(
      await actions.share_life_list!(shareEvent(undefined, true)),
    ).toMatchObject({ status: 401 });
  });
});

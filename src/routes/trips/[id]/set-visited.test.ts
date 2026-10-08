/**
 * Trip stop check-off (td-40a1b5) on real birds_test: the owner and the
 * owner's viewer share one flag per stop; nobody else can touch it. Fixture
 * accounts and trips only (stops have no coordinates and the action never
 * loads the page), so no eBird, NWS, NOAA or Google traffic. The hooks
 * guard that lets viewers reach this action is pinned in hooks.server.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { getStops, listTrips } from "$server/trips";
import { actions } from "./+page.server";

describe("set_visited (birds_test)", () => {
  let owner: number, viewer: number, stranger: number;
  let trip: number, otherTrip: number;
  let stopA: number, stopB: number, strangerStop: number;

  beforeAll(async () => {
    if (
      env.PGHOST !== "127.0.0.1" ||
      env.PGPORT !== "15436" ||
      env.PGDATABASE !== "birds_test"
    )
      throw Error("Requires dedicated birds_test");
    const id = async (sql: string, params: unknown[]) =>
      (await query<{ id: number }>(sql, params)).rows[0].id;
    const user = (role: string, viewsUserId: number | null) =>
      id(
        "INSERT INTO users(username,display_name,password_hash,role,views_user_id) VALUES($1,'Trip check-off QA','!unset',$2,$3) RETURNING id",
        ["trip-visited-" + randomUUID(), role, viewsUserId],
      );
    owner = await user("user", null);
    viewer = await user("viewer", owner);
    stranger = await user("user", null);
    const newTrip = (userId: number) =>
      id(
        "INSERT INTO trips(user_id,name) VALUES($1,'Check-off QA') RETURNING id",
        [userId],
      );
    const newStop = (tripId: number, order: number) =>
      id(
        "INSERT INTO trip_stops(trip_id,sort_order,custom_name) VALUES($1,$2,'QA stop') RETURNING id",
        [tripId, order],
      );
    trip = await newTrip(owner);
    otherTrip = await newTrip(stranger);
    stopA = await newStop(trip, 0);
    stopB = await newStop(trip, 1);
    strangerStop = await newStop(otherTrip, 0);
  });
  beforeEach(async () => {
    await query(
      "UPDATE trip_stops SET visited = FALSE WHERE id = ANY($1::int[])",
      [[stopA, stopB, strangerStop]],
    );
  });
  afterAll(async () => {
    // Trips and stops cascade from the fixture users.
    await query("DELETE FROM users WHERE id = ANY($1::int[])", [
      [owner, viewer, stranger].filter(Boolean),
    ]);
  });

  const who = (account: number) => ({
    user: { id: account, role: account === viewer ? "viewer" : "user" },
    scopeId: account === viewer ? owner : account,
  });
  const submit = async (
    account: number,
    tripId: number,
    fields: Record<string, string | number>,
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
    const url = `http://localhost/trips/${tripId}?/set_visited`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await actions.set_visited({
      locals: who(account),
      params: { id: String(tripId) },
      url: new URL(url),
      request: new Request(url, { method: "POST", body: form }),
    } as never)) as any;
  };
  const flags = async (tripId: number) =>
    (await getStops(tripId)).map((s) => [s.id, s.visited]);

  it("the owner checks a stop off and un-checks it", async () => {
    expect(
      await submit(owner, trip, { stop_id: stopA, visited: "true" }),
    ).toEqual({ ok: true });
    expect(await flags(trip)).toEqual([
      [stopA, true],
      [stopB, false],
    ]);
    await submit(owner, trip, { stop_id: stopA, visited: "false" });
    expect(await flags(trip)).toEqual([
      [stopA, false],
      [stopB, false],
    ]);
  });

  it("sets, never toggles: submitting the same value twice keeps it", async () => {
    await submit(owner, trip, { stop_id: stopB, visited: "true" });
    await submit(owner, trip, { stop_id: stopB, visited: "true" });
    expect((await getStops(trip)).find((s) => s.id === stopB)?.visited).toBe(
      true,
    );
  });

  it("the owner's viewer checks off on the owner's trip, and the owner sees it", async () => {
    expect(
      await submit(viewer, trip, { stop_id: stopB, visited: "true" }),
    ).toEqual({ ok: true });
    expect(await flags(trip)).toEqual([
      [stopA, false],
      [stopB, true],
    ]);
  });

  it("another account can't check off someone else's stop, from either trip URL", async () => {
    const viaOwnerTrip = await submit(stranger, trip, {
      stop_id: stopA,
      visited: "true",
    });
    expect(viaOwnerTrip.status).toBe(404);
    const viaOwnTrip = await submit(stranger, otherTrip, {
      stop_id: stopA,
      visited: "true",
    });
    expect(viaOwnTrip.status).toBe(404);
    // ...and the owner can't reach the stranger's stop through their own trip.
    expect(
      (await submit(owner, trip, { stop_id: strangerStop, visited: "true" }))
        .status,
    ).toBe(404);
    expect(await flags(trip)).toEqual([
      [stopA, false],
      [stopB, false],
    ]);
    expect(await flags(otherTrip)).toEqual([[strangerStop, false]]);
  });

  it("rejects a malformed request instead of guessing a value", async () => {
    for (const fields of [
      { stop_id: stopA, visited: "1" },
      { stop_id: stopA, visited: "" },
      { stop_id: stopA },
      { stop_id: "abc", visited: "true" },
      { stop_id: 0, visited: "true" },
    ] as Record<string, string | number>[]) {
      expect(
        (await submit(owner, trip, fields)).status,
        JSON.stringify(fields),
      ).toBe(400);
    }
    expect(await flags(trip)).toEqual([
      [stopA, false],
      [stopB, false],
    ]);
  });

  it("the Trips list counts what is checked off", async () => {
    await submit(owner, trip, { stop_id: stopA, visited: "true" });
    const t = (await listTrips(owner)).find((x) => x.id === trip);
    expect(t?.stop_count).toBe(2);
    expect(t?.visited_count).toBe(1);
  });
});

/**
 * Trip start & end point (td-0f3c63) on real birds_test: set from a map
 * place, a stop or the saved home; cleared; owner-only; and the straight-line
 * Optimize order loops from it however far away it is. Fixture accounts and
 * trips only; the actions never load the page, so no provider traffic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { getStops, getTrip } from "$server/trips";
import { tripAnchor } from "$lib/trip-anchor";
import { actions } from "./+page.server";

describe("trip start & end point (birds_test)", () => {
  let owner: number, homeless: number;
  let trip: number, otherTrip: number;
  let stopA: number, stopB: number, stopC: number, unlocated: number;
  let otherStop: number;

  beforeAll(async () => {
    if (
      env.PGHOST !== "127.0.0.1" ||
      env.PGPORT !== "15436" ||
      env.PGDATABASE !== "birds_test"
    )
      throw Error("Requires dedicated birds_test");
    const id = async (sql: string, params: unknown[]) =>
      (await query<{ id: number }>(sql, params)).rows[0].id;
    owner = await id(
      `INSERT INTO users(username,display_name,password_hash,role,home_lat,home_lon,home_label)
       VALUES($1,'Trip anchor QA','!unset','user',30.33,-81.66,'QA Home') RETURNING id`,
      ["trip-anchor-" + randomUUID()],
    );
    homeless = await id(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Trip anchor no-home QA','!unset','user') RETURNING id",
      ["trip-anchor-" + randomUUID()],
    );
    trip = await id(
      "INSERT INTO trips(user_id,name) VALUES($1,'Anchor QA') RETURNING id",
      [owner],
    );
    otherTrip = await id(
      "INSERT INTO trips(user_id,name) VALUES($1,'Anchor QA other') RETURNING id",
      [homeless],
    );
    const stop = (t: number, order: number, name: string, lat: number | null) =>
      id(
        "INSERT INTO trip_stops(trip_id,sort_order,custom_name,lat,lon) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [t, order, name, lat, lat == null ? null : -68.0],
      );
    // Stored order C, A, B; going north A (44) -> B (45) -> C (46).
    stopC = await stop(trip, 0, "Stop C", 46.0);
    stopA = await stop(trip, 1, "Stop A", 44.0);
    stopB = await stop(trip, 2, "Stop B", 45.0);
    unlocated = await stop(trip, 3, "No coords", null);
    otherStop = await stop(otherTrip, 0, "Other trip stop", 40.0);
  });
  beforeEach(async () => {
    await query(
      "UPDATE trips SET anchor_source=NULL, anchor_label=NULL, anchor_lat=NULL, anchor_lon=NULL WHERE id = ANY($1::int[])",
      [[trip, otherTrip]],
    );
  });
  afterAll(async () => {
    await query("DELETE FROM users WHERE id = ANY($1::int[])", [
      [owner, homeless].filter(Boolean),
    ]);
  });

  const act = async (
    name: "set_anchor" | "clear_anchor" | "optimize",
    account: number,
    tripId: number,
    fields: Record<string, string | number> = {},
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
    const url = `http://localhost/trips/${tripId}?/${name}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await actions[name]({
      locals: { user: { id: account, role: "user" }, scopeId: account },
      params: { id: String(tripId) },
      url: new URL(url),
      request: new Request(url, { method: "POST", body: form }),
    } as never)) as any;
  };
  const anchorOf = async (tripId: number) =>
    tripAnchor((await getTrip(tripId === trip ? owner : homeless, tripId))!);

  it("a map place is stored as picked", async () => {
    const r = await act("set_anchor", owner, trip, {
      source: "place",
      label: "Harbor Inn",
      lat: 43.0,
      lon: -68.0,
    });
    expect(r).toEqual({ ok: true, message: "Start & end set to Harbor Inn." });
    expect(await anchorOf(trip)).toEqual({
      source: "place",
      label: "Harbor Inn",
      lat: 43,
      lon: -68,
    });
  });

  it("a 200-character name is accepted whole", async () => {
    const label = "y".repeat(200);
    await act("set_anchor", owner, trip, {
      source: "place",
      label,
      lat: -12.5,
      lon: 130.25,
    });
    expect(await anchorOf(trip)).toEqual({
      source: "place",
      label,
      lat: -12.5,
      lon: 130.25,
    });
  });

  it("a stop is copied from the database, not the form", async () => {
    await act("set_anchor", owner, trip, {
      source: "stop",
      stop_id: stopB,
      lat: 1,
      lon: 1,
      label: "spoofed",
    });
    expect(await anchorOf(trip)).toEqual({
      source: "stop",
      label: "Stop B",
      lat: 45,
      lon: -68,
    });
  });

  it("the saved home is read from the account", async () => {
    await act("set_anchor", owner, trip, { source: "home" });
    expect(await anchorOf(trip)).toEqual({
      source: "home",
      label: "QA Home",
      lat: 30.33,
      lon: -81.66,
    });
  });

  it("refuses what it can't place, leaving the anchor unset", async () => {
    for (const [account, tripId, fields] of [
      [owner, trip, { source: "place", label: "", lat: 43, lon: -68 }],
      [owner, trip, { source: "place", label: "X", lat: "", lon: -68 }],
      [owner, trip, { source: "place", label: "X", lat: 91, lon: -68 }],
      [owner, trip, { source: "place", label: "X", lat: 43, lon: "abc" }],
      // CODEX1: Number() reads these as 0 or as numbers; none is a picked point.
      [owner, trip, { source: "place", label: "Inn", lon: -81.6 }],
      [owner, trip, { source: "place", label: "Inn", lat: " ", lon: -81.6 }],
      [owner, trip, { source: "place", label: "Inn", lat: "1e1", lon: -81.6 }],
      [
        owner,
        trip,
        { source: "place", label: "Inn", lat: "Infinity", lon: -81.6 },
      ],
      [owner, trip, { source: "place", label: "Inn", lat: " 43", lon: -81.6 }],
      [
        owner,
        trip,
        { source: "place", label: "x".repeat(201), lat: 43, lon: -68 },
      ],
      [owner, trip, { source: "stop", stop_id: unlocated }],
      [owner, trip, { source: "stop", stop_id: otherStop }],
      [owner, trip, { source: "stop", stop_id: "abc" }],
      [homeless, otherTrip, { source: "home" }],
      [owner, trip, { source: "hotel" }],
    ] as const) {
      const r = await act("set_anchor", account, tripId, fields);
      expect(r.status, JSON.stringify(fields)).toBe(400);
    }
    expect(await anchorOf(trip)).toBeNull();
    expect(await anchorOf(otherTrip)).toBeNull();
  });

  it("another account can't set or clear it", async () => {
    await act("set_anchor", owner, trip, { source: "home" });
    expect(
      (
        await act("set_anchor", homeless, trip, {
          source: "place",
          label: "X",
          lat: 1,
          lon: 1,
        })
      ).status,
    ).toBe(404);
    expect((await act("clear_anchor", homeless, trip)).status).toBe(404);
    expect((await anchorOf(trip))?.label).toBe("QA Home");
  });

  it("Remove clears all of it", async () => {
    await act("set_anchor", owner, trip, { source: "home" });
    expect(await act("clear_anchor", owner, trip)).toEqual({
      ok: true,
      message: "Start & end removed.",
    });
    const t = await getTrip(owner, trip);
    expect([
      t?.anchor_source,
      t?.anchor_label,
      t?.anchor_lat,
      t?.anchor_lon,
    ]).toEqual([null, null, null, null]);
  });

  it("the database refuses a half-set anchor", async () => {
    await expect(
      query(
        "UPDATE trips SET anchor_source='place', anchor_label='X' WHERE id=$1",
        [trip],
      ),
    ).rejects.toThrow(/trips_anchor_whole/);
  });

  it("straight-line Optimize order loops from a far-away anchor", async () => {
    const order = async () => (await getStops(trip)).map((s) => s.id);
    // No anchor, home far away: keeps the current first stop (C) as the start.
    await act("optimize", owner, trip);
    expect(await order()).toEqual([stopC, stopB, stopA, unlocated]);
    // Anchor ~111 km south of A: starts from it regardless of distance.
    await act("set_anchor", owner, trip, {
      source: "place",
      label: "South",
      lat: 43,
      lon: -68,
    });
    await act("optimize", owner, trip);
    expect(await order()).toEqual([stopA, stopB, stopC, unlocated]);
  });
});

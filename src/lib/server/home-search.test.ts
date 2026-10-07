import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { isRedirect } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { homeSearchToSave, loadHomeSearch } from "./home-search";
import {
  actions as homeActions,
  load as homeLoad,
} from "../../routes/+page.server";
import { actions as settingsActions } from "../../routes/settings/+page.server";

// Typed places resolve without Google: one known name, everything else unfound.
vi.mock("$server/geocode", () => ({
  geocodePlace: async (q: string) =>
    q === "Typed Place QA"
      ? {
          lat: 30.33,
          lng: -81.66,
          name: "Typed Place QA, FL",
          place_id: null,
          bounds: null,
        }
      : null,
}));

const P = { lat: 44.4, lng: -68.3, label: "Picked Point QA" };

describe("homeSearchToSave", () => {
  it("keeps only the parts that differ from the defaults", () => {
    expect(homeSearchToSave(P, 16, 40, 30, 7)).toEqual({
      place: P,
      distKm: 16,
      backDays: 30,
    });
    expect(homeSearchToSave(null, 40, 40, 30, 7)).toEqual({
      place: null,
      distKm: null,
      backDays: 30,
    });
  });

  it("is nothing to remember when every part is the default", () => {
    expect(homeSearchToSave(null, 40, 40, 7, 7)).toBeNull();
  });
});

// Real birds_test: Home remembers per ACCOUNT, only through the search/reset
// actions, and reopens on a bare `/`. Fixture accounts have no eBird key and
// typed places go through the mocked geocoder above, so no eBird or Google
// traffic.
describe("Home remembers the last search (birds_test)", () => {
  let owner: number, viewer: number, homeless: number;
  const SAVED_RADIUS = 40;

  beforeAll(async () => {
    if (
      env.PGHOST !== "127.0.0.1" ||
      env.PGPORT !== "15436" ||
      env.PGDATABASE !== "birds_test"
    )
      throw Error("Requires dedicated birds_test");
    const make = async (sql: string, params: unknown[]) =>
      (await query<{ id: number }>(sql, params)).rows[0].id;
    owner = await make(
      `INSERT INTO users(username,display_name,password_hash,role,home_lat,home_lon,home_label,near_me_radius_km)
       VALUES($1,'Home search QA','!unset','user',44.3876,-68.2039,'QA Home',$2) RETURNING id`,
      ["home-search-" + randomUUID(), SAVED_RADIUS],
    );
    viewer = await make(
      "INSERT INTO users(username,display_name,password_hash,role,views_user_id) VALUES($1,'Home search viewer QA','!unset','viewer',$2) RETURNING id",
      ["home-search-" + randomUUID(), owner],
    );
    homeless = await make(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Home search no-home QA','!unset','user') RETURNING id",
      ["home-search-" + randomUUID()],
    );
  });
  beforeEach(async () => {
    await query("DELETE FROM home_search WHERE user_id=ANY($1::int[])", [
      [owner, viewer, homeless],
    ]);
  });
  afterAll(async () => {
    await query("DELETE FROM users WHERE id=ANY($1::int[])", [
      [owner, viewer, homeless].filter(Boolean),
    ]);
  });

  const who = (account: number) => ({
    user: { id: account, role: account === viewer ? "viewer" : "user" },
    scopeId: account === viewer ? owner : account,
  });
  const visit = async (account: number, search: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await homeLoad({
      locals: who(account),
      url: new URL(`http://localhost/${search}`),
      request: new Request("http://localhost/"),
    } as never)) as any;
  /** Submit a Home action; returns the redirect target. */
  const submit = async (
    action: "search" | "reset",
    account: number,
    fields: Record<string, string | number>,
  ): Promise<string> => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
    try {
      await homeActions[action]({
        locals: who(account),
        url: new URL(`http://localhost/?/${action}`),
        request: new Request(`http://localhost/?/${action}`, {
          method: "POST",
          body: form,
        }),
      } as never);
    } catch (e) {
      if (isRedirect(e)) return e.location;
      throw e;
    }
    throw Error(`${action} did not redirect`);
  };
  const pick = { place: P.label, lat: P.lat, lng: P.lng, pin: P.label };
  const pinQuery = `?place=${encodeURIComponent(P.label)}&lat=${P.lat}&lng=${P.lng}&pin=${encodeURIComponent(P.label)}`;

  it("Search near … remembers the picked point; a bare / reopens it with Within and Window", async () => {
    const to = await submit("search", owner, { ...pick, dist: 16, back: 30 });
    const shown = await visit(owner, to.slice(1));
    expect(shown.location).toEqual(P);
    const data = await visit(owner, "");
    expect(data.location).toEqual(P);
    expect(data.pin).toEqual(P);
    expect(data.placeQuery).toBe(P.label);
    expect(data.dist).toBe(16);
    expect(data.back).toBe(30);
    expect(data.usingSavedHome).toBe(false);
    expect(data.showingHome).toBe(false);
  });

  it("CODEX1 P2: loading a search URL (Back, an old link, another tab) never changes what is remembered", async () => {
    await submit("search", owner, { ...pick, dist: 16, back: 30 });
    const other = `?place=Other&lat=27.5&lng=-82.6&pin=Other&dist=24&back=7`;
    expect((await visit(owner, other)).location.label).toBe("Other");
    expect((await loadHomeSearch(owner))?.place).toEqual(P);
    expect((await visit(owner, "")).location).toEqual(P);
  });

  it("CODEX1 P1: on the saved home the place box is empty, so changing only Within keeps the home", async () => {
    const home = await visit(owner, "");
    expect(home.showingHome).toBe(true);
    // The form posts an empty place (the home name is only a placeholder).
    const to = await submit("search", owner, { place: "", dist: 16, back: 7 });
    expect(
      new URL(to, "http://localhost").searchParams.get("place"),
    ).toBeNull();
    const data = await visit(owner, "");
    expect(data.location.label).toBe("QA Home");
    expect(data.showingHome).toBe(true);
    expect(data.dist).toBe(16);
    expect(data.usingSavedHome).toBe(false);
  });

  it("keeps a viewer's search to the viewer's own account", async () => {
    await submit("search", viewer, { ...pick, dist: 16, back: 7 });
    expect((await loadHomeSearch(viewer))?.place).toEqual(P);
    expect(await loadHomeSearch(owner)).toBeNull();
    expect((await visit(owner, "")).location.label).toBe("QA Home");
    expect((await visit(viewer, "")).location).toEqual(P);
  });

  it("Reset home defaults forgets the place and radius, keeps the Window", async () => {
    await submit("search", owner, { ...pick, dist: 16, back: 30 });
    expect(await submit("reset", owner, { back: 30 })).toBe("/");
    const data = await visit(owner, "");
    expect(data.location.label).toBe("QA Home");
    expect(data.dist).toBe(SAVED_RADIUS);
    expect(data.back).toBe(30);
    expect(data.usingSavedHome).toBe(true);
  });

  it("CODEX1 P2: an account without a saved home can clear its remembered search", async () => {
    await submit("search", homeless, { ...pick, dist: 16, back: 7 });
    const before = await visit(homeless, "");
    expect(before.location).toEqual(P);
    expect(before.hasHome).toBe(false);
    expect(before.usingSavedHome).toBe(false); // the clear control shows
    await submit("reset", homeless, { back: 7 });
    expect(await loadHomeSearch(homeless)).toBeNull();
    expect((await visit(homeless, "")).needsLocation).toBe(true);
  });

  it("CODEX1 P2 (round 2): a no-home account with only a remembered Within shows no place but can still clear", async () => {
    await submit("search", homeless, { place: "", dist: 16, back: 7 });
    const data = await visit(homeless, "");
    expect(data.location).toBeNull();
    expect(data.usingSavedHome).toBe(false); // the Clear control renders
    await submit("reset", homeless, { back: 7 });
    expect(await loadHomeSearch(homeless)).toBeNull();
    expect((await visit(homeless, "")).usingSavedHome).toBe(true);
  });

  it("CODEX1 round 3: a no-home account with only a remembered Window can see and use Clear", async () => {
    await submit("search", homeless, {
      place: "",
      dist: SAVED_RADIUS,
      back: 30,
    });
    const data = await visit(homeless, "");
    expect(data.back).toBe(30);
    expect(data.canReset).toBe(true);
    await submit("reset", homeless, { back: 30 });
    expect(await loadHomeSearch(homeless)).toBeNull();
    const after = await visit(homeless, "");
    expect(after.back).toBe(7);
    expect(after.canReset).toBe(false);
  });

  it("CODEX1 round 3: Clear without a home forgets the Window too, even after a place search", async () => {
    await submit("search", homeless, { ...pick, dist: 16, back: 30 });
    expect((await visit(homeless, "")).canReset).toBe(true);
    await submit("reset", homeless, { back: 30 });
    expect(await loadHomeSearch(homeless)).toBeNull();
    expect((await visit(homeless, "")).canReset).toBe(false);
  });

  it("with a saved home, a Window-only remembered search shows no Reset (Window is just remembered)", async () => {
    await submit("search", owner, { place: "", dist: SAVED_RADIUS, back: 30 });
    const data = await visit(owner, "");
    expect(data.back).toBe(30);
    expect(data.canReset).toBe(false);
  });

  it("a search back to all defaults leaves nothing remembered", async () => {
    await submit("search", owner, { ...pick, dist: 16, back: 30 });
    await submit("search", owner, { place: "", dist: SAVED_RADIUS, back: 7 });
    expect(await loadHomeSearch(owner)).toBeNull();
  });

  it("view-state params alone (?list=, ?loc=) still reopen the remembered search", async () => {
    await submit("search", owner, { ...pick, dist: 16, back: 30 });
    const data = await visit(owner, "?list=seen&loc=x");
    expect(data.location).toEqual(P);
    expect(data.dist).toBe(16);
  });

  it("an explicit search URL shows that search, not the remembered one", async () => {
    await submit("search", owner, { ...pick, dist: 16, back: 30 });
    expect((await visit(owner, `${pinQuery}&dist=24&back=7`)).dist).toBe(24);
  });

  it("a typed place is resolved once and remembered as that exact point", async () => {
    const to = await submit("search", owner, {
      place: "Typed Place QA",
      dist: SAVED_RADIUS,
      back: 7,
    });
    const typed = { lat: 30.33, lng: -81.66, label: "Typed Place QA, FL" };
    const u = new URL(to, "http://localhost");
    expect(u.searchParams.get("pin")).toBe(typed.label);
    expect((await visit(owner, to.slice(1))).location).toEqual(typed);
    expect((await visit(owner, "")).location).toEqual(typed);
  });

  it("a typed place that can't be found is shown as an error but not remembered", async () => {
    await submit("search", owner, { ...pick, dist: 16, back: 30 });
    const to = await submit("search", owner, {
      place: "Nowhere QA",
      dist: SAVED_RADIUS,
      back: 7,
    });
    expect((await visit(owner, to.slice(1))).error).toContain("Nowhere QA");
    expect((await visit(owner, "")).location).toEqual(P);
  });

  it("saving a new home in Settings forgets that account's remembered search only", async () => {
    await submit("search", owner, { ...pick, dist: 16, back: 30 });
    await submit("search", viewer, { ...pick, dist: 16, back: 30 });
    const form = new FormData();
    form.set("home_lat", "44.5");
    form.set("home_lon", "-68.4");
    form.set("home_label", "New QA Home");
    const result = await settingsActions.save_home({
      locals: { user: { id: owner, role: "user" }, scopeId: owner },
      request: new Request("http://localhost/settings?/save_home", {
        method: "POST",
        body: form,
      }),
    } as never);
    expect(result).toMatchObject({ ok: true });
    expect(await loadHomeSearch(owner)).toBeNull();
    expect((await loadHomeSearch(viewer))?.place).toEqual(P);
    const data = await visit(owner, "");
    expect(data.location).toEqual({
      lat: 44.5,
      lng: -68.4,
      label: "New QA Home",
    });
    expect(data.dist).toBe(SAVED_RADIUS);
    expect(data.back).toBe(7);
  });
});

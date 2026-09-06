import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue({ rowCount: 1 }),
}));
vi.mock("$lib/db", () => db);
import { actions, load } from "./+page.server";
function event(theme: string) {
  return {
    locals: {
      user: { id: 42, role: "viewer", theme: "light", views_user_id: 1 },
      scopeId: 1,
    },
    request: new Request("http://localhost/settings/appearance?/save_theme", {
      method: "POST",
      body: new URLSearchParams({ theme, user_id: "1" }),
    }),
  } as unknown as Parameters<NonNullable<typeof actions.save_theme>>[0];
}
describe("appearance settings boundaries", () => {
  beforeEach(() => db.query.mockClear());
  it("saves to the signed-in viewer, never the shared data owner or submitted ID", async () => {
    const e = event("dark");
    expect(await actions.save_theme(e)).toEqual({
      message: "Theme saved for your account.",
    });
    expect(db.query).toHaveBeenCalledWith(
      "UPDATE users SET theme = $1 WHERE id = $2",
      ["dark", 42],
    );
    expect(e.locals.user!.theme).toBe("dark");
  });
  it("rejects unsupported themes without touching the database", async () => {
    expect(await actions.save_theme(event("dark;anything"))).toMatchObject({
      status: 400,
    });
    expect(db.query).not.toHaveBeenCalled();
  });
  it("loads only appearance, with no private-settings query", async () => {
    expect(
      await load(event("light") as unknown as Parameters<typeof load>[0]),
    ).toEqual({ theme: "light" });
    expect(db.query).not.toHaveBeenCalled();
  });
});

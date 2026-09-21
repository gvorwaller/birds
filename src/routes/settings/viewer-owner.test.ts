import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("$lib/db", () => ({ query: db.query }));
vi.mock("$server/auth", () => ({ hashPassword: vi.fn(async () => "hashed") }));

const { actions } = await import("./+page.server");

function event(action: "create_user" | "set_viewer_owner", fields: Record<string, string>, role = "admin") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return {
    locals: { user: { id: 1, role } },
    request: new Request(`http://localhost/settings?/${action}`, { method: "POST", body: form }),
  } as never;
}

describe("admin viewer-to-owner assignment", () => {
  beforeEach(() => db.query.mockReset());

  it("requires an explicit real owner when creating a viewer", async () => {
    const missing = await actions.create_user(event("create_user", {
      new_username: "jane", new_display_name: "Jane", new_role: "viewer", new_password: "password1",
    }));
    expect(missing).toMatchObject({ status: 400, data: { error: expect.stringContaining("Choose whose") } });
    expect(db.query).not.toHaveBeenCalled();

    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const invalid = await actions.create_user(event("create_user", {
      new_username: "jane", new_display_name: "Jane", new_role: "viewer", new_password: "password1", views_user_id: "77",
    }));
    expect(invalid).toMatchObject({ status: 400 });
    expect(db.query.mock.calls[0][0]).toContain("role IN ('admin','user')");
  });

  it("creates a viewer tied to the selected owner, not the acting admin", async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const result = await actions.create_user(event("create_user", {
      new_username: "jane", new_display_name: "Jane", new_role: "viewer", new_password: "password1", views_user_id: "7",
    }));
    expect(result).toMatchObject({ ok: true });
    expect(db.query.mock.calls[2][1]).toEqual(["jane", "Jane", "hashed", "viewer", 7]);
  });

  it("lets only an admin reassign an existing viewer to an owner account", async () => {
    const denied = await actions.set_viewer_owner(event("set_viewer_owner", {
      viewer_id: "9", views_user_id: "7",
    }, "user"));
    expect(denied).toMatchObject({ status: 403 });

    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ display_name: "Jane" }] });
    const result = await actions.set_viewer_owner(event("set_viewer_owner", {
      viewer_id: "9", views_user_id: "7",
    }));
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("Jane") });
    expect(db.query.mock.calls[0][0]).toContain("viewer.role = 'viewer'");
    expect(db.query.mock.calls[0][0]).toContain("owner.role IN ('admin','user')");
    expect(db.query.mock.calls[0][1]).toEqual([9, 7]);
  });

  it("does not reveal whether an invalid target was a viewer or missing account", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await actions.set_viewer_owner(event("set_viewer_owner", {
      viewer_id: "9", views_user_id: "999",
    }));
    expect(result).toMatchObject({ status: 400, data: { error: "That viewer-to-owner assignment is not available." } });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const del = vi.hoisted(() => ({ deleteAccount: vi.fn() }));
vi.mock("$lib/db", () => ({ query: vi.fn() }));
vi.mock("$server/auth", () => ({ hashPassword: vi.fn(async () => "hashed") }));
vi.mock("$server/account-delete", () => ({ deleteAccount: del.deleteAccount }));

const { actions } = await import("./+page.server");

function event(fields: Record<string, string>, role = "admin") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return {
    locals: { user: { id: 1, role } },
    request: new Request("http://localhost/settings?/delete_user", { method: "POST", body: form }),
  } as never;
}

describe("Settings → User admin → Delete account (td-12bd33)", () => {
  beforeEach(() => del.deleteAccount.mockReset());

  it("is admin-only and needs an account id", async () => {
    expect(await actions.delete_user(event({ user_id: "5", confirm_username: "x" }, "user"))).toMatchObject({ status: 403 });
    expect(await actions.delete_user(event({ user_id: "abc" }))).toMatchObject({ status: 400 });
    expect(del.deleteAccount).not.toHaveBeenCalled();
  });

  it("passes the acting admin, the account and the typed username, and reports cancelled jobs", async () => {
    del.deleteAccount.mockResolvedValueOnce({ ok: true, username: "jane", displayName: "Jane", cancelledJobs: 2 });
    const r = await actions.delete_user(event({ user_id: "5", confirm_username: "jane" }));
    expect(del.deleteAccount).toHaveBeenCalledWith(1, 5, "jane");
    expect(r).toEqual({ ok: true, message: "Deleted Jane's account (@jane). 2 queued jobs were cancelled." });
  });

  it.each([
    [{ reason: "self" }, 400, "your own account"],
    [{ reason: "not_found" }, 404, "no longer exists"],
    [{ reason: "confirm" }, 400, "Nothing was deleted"],
    [{ reason: "viewers", viewers: ["Ann"] }, 409, "Ann shows this account's life list"],
    [{ reason: "viewers", viewers: ["Ann", "Bo"] }, 409, "Ann, Bo show this account's life list"],
    [{ reason: "running" }, 409, "is running"],
    [{ reason: "system_jobs" }, 409, "scheduled background jobs"],
    [{ reason: "busy" }, 409, "try again"],
  ])("explains a refusal: %o", async (refusal, status, text) => {
    del.deleteAccount.mockResolvedValueOnce({ ok: false, ...refusal });
    const r = await actions.delete_user(event({ user_id: "5", confirm_username: "jane" }));
    expect(r).toMatchObject({ status, data: { error: expect.stringContaining(text) } });
  });
});

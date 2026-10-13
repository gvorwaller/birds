import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock("$lib/db", () => ({ withTransaction: db.withTransaction }));

const { deleteAccount } = await import("./account-delete");

describe("deleteAccount races (td-12bd33)", () => {
  it("refuses the admin's own account without opening a transaction", async () => {
    expect(await deleteAccount(3, 3, "me")).toEqual({ ok: false, reason: "self" });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it.each(["23514", "23503", "40P01"])("reports a job that went live mid-delete (%s) as busy", async (code) => {
    db.withTransaction.mockRejectedValueOnce(Object.assign(new Error("race"), { code }));
    expect(await deleteAccount(1, 5, "jane")).toEqual({ ok: false, reason: "busy" });
  });

  it("lets any other database failure surface", async () => {
    db.withTransaction.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "57P01" }));
    await expect(deleteAccount(1, 5, "jane")).rejects.toThrow("down");
  });
});

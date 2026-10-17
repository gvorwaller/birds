import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$server/system-health", () => ({
  systemHealth: vi.fn(),
}));

import { systemHealth } from "$server/system-health";
import { GET } from "./+server";

const mocked = vi.mocked(systemHealth);

describe("GET /api/admin/system-health", () => {
  beforeEach(() => mocked.mockReset());

  it.each([
    ["a signed-out visitor", undefined],
    ["a viewer", { id: 2, role: "viewer" }],
    ["an ordinary user", { id: 3, role: "user" }],
  ])("is a 404 for %s, without reading anything", async (_who, user) => {
    await expect(GET({ locals: { user } } as never)).rejects.toMatchObject({ status: 404 });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("returns uncached cards to an admin, a failed card included", async () => {
    mocked.mockResolvedValue({
      now: "2026-10-17T16:00:00.000Z",
      worker: { ok: false, reason: "Timed out after 3 s." },
      queue: { ok: true, data: { rows: [], retentionDays: 90 } },
      postgres: { ok: false, reason: "Timed out after 3 s." },
      disk: { ok: true, data: { path: "/", totalBytes: 10, freeBytes: 5 } },
      tables: { ok: true, data: [] },
      coverage: { ok: false, reason: "Timed out after 3 s." },
    });
    const res = await GET({ locals: { user: { id: 1, role: "admin" } } } as never);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    await expect(res.json()).resolves.toMatchObject({
      worker: { ok: false, reason: "Timed out after 3 s." },
      queue: { ok: true, data: { retentionDays: 90 } },
    });
  });
});

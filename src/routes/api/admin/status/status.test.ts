import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$server/admin-status", () => ({
  adminLiveStatus: vi.fn(),
}));

import { adminLiveStatus } from "$server/admin-status";
import { GET } from "./+server";

const mockedStatus = vi.mocked(adminLiveStatus);

describe("GET /api/admin/status", () => {
  beforeEach(() => mockedStatus.mockReset());

  it("conceals the endpoint from non-admin accounts", async () => {
    await expect(
      GET({ locals: { user: { id: 2, role: "viewer" } } } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(mockedStatus).not.toHaveBeenCalled();
  });

  it("returns uncached lightweight status to an admin", async () => {
    mockedStatus.mockResolvedValue({
      now: "2026-08-23T16:00:00.000Z",
      worker: {
        alive: true,
        state: "idle",
        pid: 12,
        version: "abc123",
        startedAt: "2026-08-23T15:00:00.000Z",
        heartbeatAt: "2026-08-23T15:59:59.000Z",
        currentJobId: null,
      },
      jobs: [],
    });

    const response = await GET({
      locals: { user: { id: 1, role: "admin" } },
    } as never);

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      now: "2026-08-23T16:00:00.000Z",
      worker: { alive: true, state: "idle" },
      jobs: [],
    });
  });
});

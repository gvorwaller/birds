import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$server/page-timing", () => ({ pageTimingReport: vi.fn() }));

import { pageTimingReport } from "$server/page-timing";
import { GET } from "./+server";

const mocked = vi.mocked(pageTimingReport);
const admin = { user: { id: 1, role: "admin" } };
const call = (locals: unknown, qs = "") =>
  GET({ locals, url: new URL(`http://x/api/admin/page-timing${qs}`) } as never);

describe("GET /api/admin/page-timing", () => {
  beforeEach(() => {
    mocked.mockReset();
    mocked.mockResolvedValue({ thresholdMs: 750, version: null, recent: [], routes: [], versions: [], retentionDays: 30 });
  });

  it.each([
    ["a signed-out visitor", {}],
    ["a viewer", { user: { id: 2, role: "viewer" } }],
    ["an ordinary user", { user: { id: 3, role: "user" } }],
  ])("is a 404 for %s, without reading anything", async (_who, locals) => {
    await expect(call(locals)).rejects.toMatchObject({ status: 404 });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("reads all deploys by default and one deploy when asked, uncached", async () => {
    const res = await call(admin);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked).toHaveBeenLastCalledWith(750, null);
    await call(admin, "?version=79ea7c8");
    expect(mocked).toHaveBeenLastCalledWith(750, "79ea7c8");
  });

  it.each([["?version=a&version=b"], ["?version=%27%3B%20drop"], [`?version=${"x".repeat(65)}`]])(
    "refuses %s",
    async (qs) => {
      await expect(call(admin, qs)).rejects.toMatchObject({ status: 400 });
      expect(mocked).not.toHaveBeenCalled();
    },
  );
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$server/user-activity", () => ({ recordActivity: vi.fn(async () => {}) }));

import { POST } from "./+server";
import { recordActivity } from "$server/user-activity";

const call = (body: string, user: object | null = { id: 7, role: "user" }) =>
  POST({
    request: new Request("http://localhost/api/activity", { method: "POST", body, headers: { "content-type": "application/json" } }),
    locals: user ? { user } : {},
  } as never);

describe("POST /api/activity (td-c8e6a3)", () => {
  beforeEach(() => vi.mocked(recordActivity).mockClear());

  it("records the section of a counted route for the signed-in account", async () => {
    expect((await call(JSON.stringify({ routeId: "/forecast/data" }))).status).toBe(204);
    expect(recordActivity).toHaveBeenCalledWith(7, "hotspots_data");
  });

  it("accepts and ignores uncounted or bogus routes; rejects bad bodies and signed-out calls", async () => {
    expect((await call(JSON.stringify({ routeId: "/login" }))).status).toBe(204);
    expect((await call(JSON.stringify({ routeId: 42 }))).status).toBe(204);
    expect((await call("not json")).status).toBe(400);
    expect((await call(JSON.stringify({ routeId: "/" }), null)).status).toBe(401);
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

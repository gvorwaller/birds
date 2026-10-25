import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$server/client-stalls", () => ({ recordClientStalls: vi.fn(async () => 1) }));

import { POST } from "./+server";
import { recordClientStalls } from "$server/client-stalls";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/27.0.1 Mobile/15E148 Safari/604.1";
const event = (over: object = {}) => ({
  id: "0b6f3a9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  kind: "freeze",
  occurredAt: Date.now() - 1000,
  fromRoute: null,
  toRoute: "/species/[code]",
  toPath: "/species/indbun",
  navType: null,
  stage: null,
  waitedMs: 4200,
  dataMs: null,
  aliveMs: null,
  hiddenMs: null,
  errors: [],
  standalone: true,
  online: true,
  version: "b50f11b",
  ...over,
});
const body = (events: unknown[], accountId: unknown = 7) => JSON.stringify({ accountId, events });
const call = (body: string, user: object | null = { id: 7, role: "viewer" }) =>
  POST({
    request: new Request("http://localhost/api/client-stalls", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "user-agent": UA },
    }),
    locals: user ? { user } : {},
  } as never);

describe("POST /api/client-stalls (td-1cb094)", () => {
  beforeEach(() => vi.mocked(recordClientStalls).mockClear());

  it("stores the well-formed reports for the signed-in account (viewers too), with this request's device", async () => {
    const res = await call(
      body([
        event(),
        { bogus: true },
        event({ id: "2b6f3a9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", errors: [{ toString: null }] }),
        event({ id: "1b6f3a9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", kind: "lost" }),
      ]),
    );
    expect(res.status).toBe(204);
    expect(recordClientStalls).toHaveBeenCalledTimes(1);
    const [userId, device, events] = vi.mocked(recordClientStalls).mock.calls[0];
    expect(userId).toBe(7);
    expect(device).toBe(UA);
    expect(events.map((e) => e.kind)).toEqual(["freeze", "lost"]);
  });

  it("answers 503 when the write failed, so the browser keeps its queue", async () => {
    vi.mocked(recordClientStalls).mockRejectedValueOnce(new Error("db down"));
    expect((await call(body([event()]))).status).toBe(503);
  });

  it("refuses events recorded under another account than the session's (a tab left open across an account switch)", async () => {
    expect((await call(body([event()], 1))).status).toBe(409);
    expect((await call(body([event()], "7"))).status).toBe(409);
    expect((await call(JSON.stringify({ events: [event()] }))).status).toBe(409);
    expect(recordClientStalls).not.toHaveBeenCalled();
  });

  it("refuses signed-out calls, bad bodies and oversized batches", async () => {
    expect((await call(body([event()]), null)).status).toBe(401);
    expect((await call("not json")).status).toBe(400);
    expect((await call(JSON.stringify({ accountId: 7, events: "x" }))).status).toBe(400);
    expect((await call(body(Array.from({ length: 21 }, () => event())))).status).toBe(400);
    expect(recordClientStalls).not.toHaveBeenCalled();
  });
});

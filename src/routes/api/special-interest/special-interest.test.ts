import { beforeEach, expect, it, vi } from "vitest";
vi.mock("$server/special-interest", () => ({ setSpecialInterest: vi.fn() }));
import { setSpecialInterest } from "$server/special-interest";
import { POST } from "./+server";
import { isSpecialInterestRequest } from "$lib/special-interest";

function req(
  body: unknown,
  origin: string | null = "http://localhost",
  user: unknown = { id: 2, role: "viewer" },
) {
  return {
    locals: { user, scopeId: 1 },
    url: new URL("http://localhost/api/special-interest"),
    request: new Request("http://localhost/api/special-interest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}
beforeEach(() => vi.mocked(setSpecialInterest).mockReset());
it("sets explicit state for the actual account, ignoring a supplied owner id", async () => {
  vi.mocked(setSpecialInterest).mockResolvedValue({ saved: true });
  expect(
    await (
      await POST(
        req({ accountId: 2, speciesCode: "osprey", saved: true, userId: 1 }),
      )
    ).json(),
  ).toEqual({ saved: true });
  expect(setSpecialInterest).toHaveBeenCalledWith(2, "osprey", true);
});
it("rejects anonymous, foreign-origin and stale-account requests before writing", async () => {
  const b = { accountId: 2, speciesCode: "osprey", saved: true };
  await expect(POST(req(b, "http://localhost", null))).rejects.toMatchObject({
    status: 401,
  });
  for (const origin of [null, "https://other.test"])
    await expect(POST(req(b, origin))).rejects.toMatchObject({ status: 403 });
  await expect(POST(req({ ...b, accountId: 1 }))).rejects.toMatchObject({
    status: 409,
  });
  expect(setSpecialInterest).not.toHaveBeenCalled();
});
it("rejects malformed selections and invalid JSON", async () => {
  for (const b of [
    null,
    [],
    { accountId: 2, speciesCode: "bad/code", saved: true },
    { accountId: 2, speciesCode: "osprey", saved: "false" },
  ])
    await expect(POST(req(b))).rejects.toMatchObject({ status: 400 });
  const e = req(null);
  e.request = new Request(e.url, {
    method: "POST",
    headers: { origin: e.url.origin },
    body: "{",
  });
  await expect(POST(e)).rejects.toMatchObject({ status: 400 });
  expect(setSpecialInterest).not.toHaveBeenCalled();
});
it("personal write exception is exact by route and method", () => {
  expect(isSpecialInterestRequest("/api/special-interest", "POST")).toBe(true);
  for (const p of [
    "/api/special-interest/extra",
    "/api/special-interest-other",
    "/settings",
    "/trips",
    "/species/osprey",
  ])
    expect(isSpecialInterestRequest(p, "POST")).toBe(false);
  for (const m of ["PUT", "DELETE", "PATCH"])
    expect(isSpecialInterestRequest("/api/special-interest", m)).toBe(false);
});

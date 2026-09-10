import { beforeEach, expect, it, vi } from "vitest";
vi.mock("$server/species-views", () => ({ recordSpeciesView: vi.fn() }));
import { recordSpeciesView } from "$server/species-views";
import { POST } from "./+server";
const visitId = "83ae018d-f2b0-4626-9657-350a05329855";
function req(
  body: unknown,
  origin: string | null = "http://localhost",
  user: unknown = { id: 2, role: "viewer" },
) {
  return {
    locals: { user, scopeId: 1 },
    url: new URL("http://localhost/api/species-views"),
    request: new Request("http://localhost/api/species-views", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}
beforeEach(() => vi.mocked(recordSpeciesView).mockReset());
it("uses the signed-in viewer, never the shared scope owner", async () => {
  vi.mocked(recordSpeciesView).mockResolvedValue({ enabled: true, view: null });
  await POST(req({ accountId: 2, speciesCode: "osprey", visitId, userId: 1 }));
  expect(recordSpeciesView).toHaveBeenCalledWith(2, "osprey", visitId);
});
it("rejects unauthenticated, foreign-origin and stale-account requests before writing", async () => {
  const body = { accountId: 2, speciesCode: "osprey", visitId };
  await expect(POST(req(body, "http://localhost", null))).rejects.toMatchObject(
    { status: 401 },
  );
  for (const origin of [null, "https://elsewhere.test"])
    await expect(POST(req(body, origin))).rejects.toMatchObject({
      status: 403,
    });
  await expect(POST(req({ ...body, accountId: 1 }))).rejects.toMatchObject({
    status: 409,
  });
  expect(recordSpeciesView).not.toHaveBeenCalled();
});
it("rejects malformed events", async () => {
  for (const body of [
    null,
    [],
    { accountId: 2, speciesCode: "bad/code", visitId },
    { accountId: 2, speciesCode: "osprey", visitId: "bad" },
  ])
    await expect(POST(req(body))).rejects.toMatchObject({ status: 400 });
  expect(recordSpeciesView).not.toHaveBeenCalled();
});

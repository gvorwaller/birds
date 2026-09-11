import { beforeEach, expect, it, vi } from "vitest";
vi.mock("$server/species-study", () => ({ studyCountrySpecies: vi.fn() }));
vi.mock("$server/regions", () => ({ getRegion: vi.fn() }));
import { studyCountrySpecies } from "$server/species-study";
import { getRegion } from "$server/regions";
import { GET } from "./+server";
function event(params: string, user: unknown = { id: 2, role: "viewer" }) {
  return {
    locals: { user, scopeId: 1 },
    url: new URL("https://birds.test/api/species-study?" + params),
  } as Parameters<typeof GET>[0];
}
beforeEach(() => {
  vi.mocked(studyCountrySpecies).mockReset();
  vi.mocked(getRegion).mockReset();
});
it("keeps country reads private to the signed-in account and forwards study filters", async () => {
  vi.mocked(getRegion).mockResolvedValue({ level: "country" } as Awaited<
    ReturnType<typeof getRegion>
  >);
  vi.mocked(studyCountrySpecies).mockResolvedValue({
    rows: [],
    locCodes: [],
    wholeArea: false,
    beginYear: null,
    endYear: null,
  });
  const response = await GET(
    event("accountId=2&country=US&status=unviewed&q=osprey&sort=recent"),
  );
  expect(studyCountrySpecies).toHaveBeenCalledWith(
    2,
    "osprey",
    "unviewed",
    true,
    "US",
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("rejects logged-out, stale-account and invalid-country requests before reading history", async () => {
  await expect(GET(event("", null))).rejects.toMatchObject({ status: 401 });
  await expect(GET(event("accountId=1&country=US"))).rejects.toMatchObject({
    status: 409,
  });
  vi.mocked(getRegion).mockResolvedValue(null);
  await expect(GET(event("accountId=2&country=bad"))).rejects.toMatchObject({
    status: 400,
  });
  expect(studyCountrySpecies).not.toHaveBeenCalled();
});
it("surfaces failed country reads as retryable errors, not empty results", async () => {
  vi.mocked(getRegion).mockResolvedValue({ level: "country" } as Awaited<
    ReturnType<typeof getRegion>
  >);
  vi.mocked(studyCountrySpecies).mockRejectedValue(Error("DB unavailable"));
  await expect(GET(event("accountId=2&country=US"))).rejects.toMatchObject({
    status: 503,
  });
});

it("forwards explicit taxonomic sorting to country expansion", async () => {
  vi.mocked(getRegion).mockResolvedValue({level:"country"} as Awaited<ReturnType<typeof getRegion>>);
  vi.mocked(studyCountrySpecies).mockResolvedValue({rows:[],locCodes:[],wholeArea:false,beginYear:null,endYear:null});
  await GET(event("accountId=2&country=US&status=unviewed&sort=taxonomic"));
  expect(studyCountrySpecies).toHaveBeenCalledWith(2,"","unviewed","taxonomic","US");
});

vi.mock('$server/taxonomy-reference',()=>({taxonomySummary:vi.fn(async()=>({ordered:1}))}));
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("$server/species-study", () => ({
  studySpecies: vi.fn(),
  studyCountries: vi.fn(),
}));
vi.mock("$server/species-views", () => ({
  clearSpeciesViews: vi.fn(),
  setSpeciesViewTracking: vi.fn(),
}));
import { studyCountries, studySpecies } from "$server/species-study";
import { load } from "./+page.server";
function event(path: string) {
  return {
    locals: { user: { id: 2 }, scopeId: 1 },
    url: new URL(path, "https://birds.test"),
    depends: vi.fn(),
  } as unknown as Parameters<typeof load>[0];
}
beforeEach(() => {
  vi.mocked(studySpecies).mockReset();
  vi.mocked(studyCountries).mockReset();
  vi.mocked(studySpecies).mockResolvedValue({
    enabled: true,
    rows: [
      {
        code: "osprey",
        name: "Osprey",
        scientificName: "Pandion haliaetus",
        current: true,
        family: "Osprey",
        view: null,
      },
    ],
  });
});
it("streams counts for the exact signed-in user's filtered study result", async () => {
  vi.mocked(studyCountries).mockResolvedValue([]);
  const data = await load(
    event("/viewed?status=unviewed&group=country&q=osprey"),
  );
  expect(studySpecies).toHaveBeenCalledWith(2, "osprey", "unviewed", true);
  expect(studyCountries).toHaveBeenCalledWith(["osprey"]);
  expect(await data!.countryGroups).toEqual({
    countries: [],
    unavailable: false,
  });
});
it("keeps count failures distinct from a successful empty list", async () => {
  vi.mocked(studyCountries).mockRejectedValue(Error("DB deadline"));
  const data = await load(event("/viewed?group=country"));
  expect(await data!.countryGroups).toEqual({
    countries: [],
    unavailable: true,
  });
});
it("does not calculate country counts for family or flat lists", async () => {
  await load(event("/viewed?group=family"));
  expect(studyCountries).not.toHaveBeenCalled();
});

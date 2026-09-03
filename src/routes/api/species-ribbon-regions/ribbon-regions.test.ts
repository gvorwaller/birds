import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$server/ribbon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$server/ribbon")>();
  return { ...actual, ribbonRegions: vi.fn() };
});

import { ribbonRegions } from "$server/ribbon";
import { GET } from "./+server";

const mockedRibbonRegions = vi.mocked(ribbonRegions);

function req(url: string, scopeId: number | null = 1) {
  return {
    locals: { scopeId },
    url: new URL(`http://localhost${url}`),
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /api/species-ribbon-regions", () => {
  beforeEach(() => mockedRibbonRegions.mockReset());

  it("401s without a scopeId", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?species=osprey&band=40&cont=NAE", null)),
    ).rejects.toMatchObject({ status: 401 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("400s for a missing species", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?band=40&cont=NAE")),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("400s for an invalid species code", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?species=NOT-VALID!&band=40&cont=NAE")),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("400s for band 45 (not one of the ribbon's bands)", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?species=osprey&band=45&cont=NAE")),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("400s for a missing band param (CODEX1 P2-1 — Number('') is 0, a valid band)", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?species=osprey&cont=NAE")),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("400s for a blank band param", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?species=osprey&band=&cont=NAE")),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("400s for a whitespace-only band param", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?species=osprey&band=%20&cont=NAE")),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("400s for cont XX", async () => {
    await expect(
      GET(req("/api/species-ribbon-regions?species=osprey&band=40&cont=XX")),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedRibbonRegions).not.toHaveBeenCalled();
  });

  it("returns the {rows,total,capped} shape on a valid request", async () => {
    mockedRibbonRegions.mockResolvedValue({
      rows: [
        {
          locCode: "US-NJ",
          label: "New Jersey, United States",
          country: "US",
          column: "NAE",
          band: 40,
          curve: [],
          weeks: [],
          peak: 0.05,
          best: null,
          peakPhrase: null,
          good: [],
          migration: null,
        },
      ],
      total: 1,
      capped: false,
    });

    const response = await GET(
      req("/api/species-ribbon-regions?species=osprey&band=40&cont=NAE"),
    );
    expect(mockedRibbonRegions).toHaveBeenCalledWith("osprey", 40, "NAE");
    await expect(response.json()).resolves.toEqual({
      rows: [
        expect.objectContaining({ locCode: "US-NJ", column: "NAE" }),
      ],
      total: 1,
      capped: false,
    });
  });

  it("accepts cont=ALL", async () => {
    mockedRibbonRegions.mockResolvedValue({ rows: [], total: 0, capped: false });
    await GET(req("/api/species-ribbon-regions?species=osprey&band=40&cont=ALL"));
    expect(mockedRibbonRegions).toHaveBeenCalledWith("osprey", 40, "ALL");
  });
});

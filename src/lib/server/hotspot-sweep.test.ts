import { beforeEach, describe, expect, it, vi } from "vitest";

const ebird = vi.hoisted(() => ({
  getEbirdApiKey: vi.fn(),
  subregions: vi.fn(),
  hotspotsInRegion: vi.fn(),
  EbirdError: class EbirdError extends Error {},
}));
const barchart = vi.hoisted(() => ({
  frequencyMeta: vi.fn(),
  attemptMeta: vi.fn(),
  lastCompleteYear: vi.fn(() => 2025),
}));
const jobs = vi.hoisted(() => ({ enqueueJob: vi.fn() }));

vi.mock("$server/ebird", () => ebird);
vi.mock("$server/barchart", () => barchart);
vi.mock("$server/jobs", () => jobs);

const { sweepAreaHotspots } = await import("./hotspot-sweep");

const COUNTY = "US-WA-033";
const hotspot = (locId: string, locName = locId) => ({
  locId,
  locName,
  subnational2Code: COUNTY,
});

beforeEach(() => {
  vi.clearAllMocks();
  ebird.getEbirdApiKey.mockResolvedValue("key");
  ebird.subregions.mockResolvedValue({ data: [{ code: COUNTY, name: "King" }] });
  barchart.frequencyMeta.mockResolvedValue(new Map());
  barchart.attemptMeta.mockResolvedValue(new Map());
  jobs.enqueueJob.mockResolvedValue({ jobId: 7, deduped: false });
});

describe("sweepAreaHotspots", () => {
  it("queues every hotspot eBird lists for the county", async () => {
    ebird.hotspotsInRegion.mockResolvedValue({
      data: [hotspot("L1", "Marymoor"), hotspot("L2", "Union Bay")],
    });

    const res = await sweepAreaHotspots(1, COUNTY);

    expect(res).toMatchObject({ ok: true, label: "2 hotspots in King" });
    const payload = jobs.enqueueJob.mock.calls[0][0];
    expect(payload.type).toBe("load_hotspots");
    expect(payload.payload.locs.map((l: { code: string }) => l.code)).toEqual(["L1", "L2"]);
    // County-tagged so /forecast/data nests them under the right block.
    expect(payload.payload.locs[0].regionCode).toBe(COUNTY);
  });

  it("skips hotspots that are already current — a re-run only picks up gaps", async () => {
    ebird.hotspotsInRegion.mockResolvedValue({
      data: [hotspot("L1"), hotspot("L2"), hotspot("L3")],
    });
    barchart.frequencyMeta.mockResolvedValue(
      new Map([
        ["L1", { endYear: 2025 }], // current — skip
        ["L2", { endYear: 2019 }], // stale — still needs loading
      ]),
    );

    const res = await sweepAreaHotspots(1, COUNTY);

    expect(res).toMatchObject({ ok: true, label: "2 hotspots in King" });
    expect(
      jobs.enqueueJob.mock.calls[0][0].payload.locs.map((l: { code: string }) => l.code),
    ).toEqual(["L2", "L3"]);
  });

  it("skips hotspots in failure cooldown so a sweep doesn't hammer them", async () => {
    ebird.hotspotsInRegion.mockResolvedValue({ data: [hotspot("L1"), hotspot("L2")] });
    barchart.attemptMeta.mockResolvedValue(
      new Map([["L1", { status: "error", lastAttemptAt: new Date() }]]),
    );

    const res = await sweepAreaHotspots(1, COUNTY);

    expect(res).toMatchObject({ ok: true });
    expect(
      jobs.enqueueJob.mock.calls[0][0].payload.locs.map((l: { code: string }) => l.code),
    ).toEqual(["L2"]);
  });

  it("reports the fully-loaded case instead of queueing an empty job", async () => {
    ebird.hotspotsInRegion.mockResolvedValue({ data: [hotspot("L1")] });
    barchart.frequencyMeta.mockResolvedValue(new Map([["L1", { endYear: 2025 }]]));

    const res = await sweepAreaHotspots(1, COUNTY);

    expect(res).toMatchObject({
      ok: false,
      status: 400,
      error: "All 1 hotspots in King are already loaded.",
    });
    expect(jobs.enqueueJob).not.toHaveBeenCalled();
  });

  it("rejects an area that isn't in eBird's official child list", async () => {
    ebird.subregions.mockResolvedValue({ data: [{ code: "US-WA-001", name: "Adams" }] });

    const res = await sweepAreaHotspots(1, COUNTY);

    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(ebird.hotspotsInRegion).not.toHaveBeenCalled();
    expect(jobs.enqueueJob).not.toHaveBeenCalled();
  });

  it("rejects country-level and malformed codes without calling eBird", async () => {
    for (const code of ["US", "", "L602509", "not-a-code"]) {
      expect(await sweepAreaHotspots(1, code)).toMatchObject({ ok: false, status: 400 });
    }
    expect(ebird.subregions).not.toHaveBeenCalled();
  });

  it("sweeps a subnational1 region for countries with no counties", async () => {
    ebird.subregions.mockResolvedValue({ data: [{ code: "NO-03", name: "Oslo" }] });
    ebird.hotspotsInRegion.mockResolvedValue({
      data: [{ locId: "L9", locName: "Fornebu", subnational2Code: null }],
    });

    const res = await sweepAreaHotspots(1, "NO-03");

    expect(res).toMatchObject({ ok: true, label: "1 hotspot in Oslo" });
    // Parent lookup is the country's subnational1 list, not subnational2.
    expect(ebird.subregions).toHaveBeenCalledWith("key", "NO", "subnational1");
    // No county on record — the region itself tags the row.
    expect(jobs.enqueueJob.mock.calls[0][0].payload.locs[0].regionCode).toBe("NO-03");
  });
});

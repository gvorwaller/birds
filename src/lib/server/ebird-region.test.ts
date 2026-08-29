import { describe, expect, it, vi } from "vitest";
import { EbirdError, fetchRegionCentroid } from "./ebird";

const response = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("fetchRegionCentroid", () => {
  it("returns finite in-range coordinates from the region-info envelope", async () => {
    const fetcher = vi.fn(async () =>
      response('{"latitude":44.1,"longitude":-68.2}'),
    );
    await expect(
      fetchRegionCentroid("key", "US-ME", { fetcher }),
    ).resolves.toEqual({
      lat: 44.1,
      lon: -68.2,
    });
  });

  it.each([404, 410])(
    "treats HTTP %s as a durable unavailable region",
    async (status) => {
      const fetcher = vi.fn(async () => response("", status));
      await expect(
        fetchRegionCentroid("key", "US-ME", { fetcher }),
      ).resolves.toBeNull();
    },
  );

  it.each([
    ["empty", ""],
    ["malformed", "not-json"],
    ["missing coordinate", '{"latitude":44.1}'],
    ["out of range", '{"latitude":91,"longitude":-68.2}'],
  ])(
    "rejects a transient/invalid %s response instead of poisoning the negative cache",
    async (_name, body) => {
      const fetcher = vi.fn(async () => response(body));
      await expect(
        fetchRegionCentroid("key", "US-ME", { fetcher }),
      ).rejects.toBeInstanceOf(EbirdError);
    },
  );
});

import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("$lib/db", () => db);
vi.mock("$server/ebird", () => ({ hotspotsNear: vi.fn() }));

const { cachedVerifiedHotspotLocIds } = await import("./hotspots");

describe("cachedVerifiedHotspotLocIds", () => {
  it("returns no rows and makes no query for an empty id list", async () => {
    db.query.mockClear();
    await expect(cachedVerifiedHotspotLocIds([])).resolves.toEqual(new Set());
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses one parameterized batch query and returns exact reference ids", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ loc_id: "L127286" }] });
    const ids = await cachedVerifiedHotspotLocIds([
      "L127286",
      "L35320851",
      "L127286",
    ]);
    expect(ids).toEqual(new Set(["L127286"]));
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain("hotspots:%");
    expect(sql).toContain("hotspotsRegion:%");
    expect(sql).toContain("ANY($1::text[])");
    expect(values).toEqual([["L127286", "L35320851"]]);
  });
});

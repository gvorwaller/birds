import { describe, expect, it } from "vitest";
import { filterLifeList, type LifeListFilterRow } from "./life-list-filter";

const rows: LifeListFilterRow[] = [
  {
    com_name: "Gull-billed Tern",
    location_name: "Big Talbot Island",
    loc_id: "L1",
    region_code: "US-FL",
    first_seen: "2026-08-19",
  },
  {
    com_name: "Red-breasted Nuthatch",
    location_name: "Peter Brook Trail Preserve",
    loc_id: "L2",
    region_code: "US-ME",
    first_seen: "2026-08-02",
  },
  {
    com_name: "Common Loon",
    location_name: null,
    loc_id: "L3",
    region_code: "NO-03",
    first_seen: null,
  },
  {
    com_name: "Eastern Screech-Owl",
    location_name: "Backyard",
    loc_id: "L4",
    region_code: "US-FL",
    first_seen: "2024-01-01",
  },
  {
    com_name: "American Bittern",
    location_name: "Marsh",
    loc_id: "L5",
    region_code: "US-FL",
    first_seen: "2023-01-01",
  },
];

const defaults = { species: "", location: "", from: "", to: "", region: null };

describe("filterLifeList", () => {
  it("matches species and location case-insensitively", () => {
    expect(
      filterLifeList(rows, {
        ...defaults,
        species: "TERN",
        location: "talbot",
      }),
    ).toEqual([rows[0]]);
  });

  it("matches species token prefixes without treating substrings as species hits", () => {
    expect(filterLifeList(rows, { ...defaults, species: "tern" })).toEqual([
      rows[0],
    ]);
    expect(filterLifeList(rows, { ...defaults, species: "gull tern" })).toEqual(
      [rows[0]],
    );
  });

  it("matches location IDs and region codes", () => {
    expect(filterLifeList(rows, { ...defaults, location: "us-me" })).toEqual([
      rows[1],
    ]);
    expect(filterLifeList(rows, { ...defaults, location: "l3" })).toEqual([
      rows[2],
    ]);
  });

  it("applies an inclusive date range and excludes undated rows", () => {
    expect(
      filterLifeList(rows, {
        ...defaults,
        from: "2026-08-02",
        to: "2026-08-19",
      }),
    ).toEqual([rows[0], rows[1]]);
  });

  it("combines region with the text and date filters", () => {
    expect(
      filterLifeList(rows, {
        ...defaults,
        species: "nuthatch",
        from: "2026-01-01",
        region: "US-ME",
      }),
    ).toEqual([rows[1]]);
  });
});

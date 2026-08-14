import { describe, expect, it } from "vitest";
import { sortNeedsByNearest, type NearestSortable } from "./needs-sort";

function species(
  code: string,
  distances: (number | null)[],
): NearestSortable & { code: string } {
  return { code, places: distances.map((distanceKm) => ({ distanceKm })) };
}

describe("sortNeedsByNearest", () => {
  it("orders ascending by the nearest place distance", () => {
    const needs = [
      species("far", [12]),
      species("near", [3]),
      species("mid", [7]),
    ];
    expect(sortNeedsByNearest(needs).map((n) => n.code)).toEqual([
      "near",
      "mid",
      "far",
    ]);
  });

  it("uses the minimum distance across a species' places, not the first one", () => {
    const needs = [
      species("a", [20, 2, 15]),
      species("b", [5]),
    ];
    expect(sortNeedsByNearest(needs).map((n) => n.code)).toEqual(["a", "b"]);
  });

  it("sorts species with no distance last, after every real distance", () => {
    const needs = [
      species("none", [null]),
      species("far", [12]),
      species("near", [3]),
    ];
    expect(sortNeedsByNearest(needs).map((n) => n.code)).toEqual([
      "near",
      "far",
      "none",
    ]);
  });

  it("keeps incoming relative order among ties, including no-distance species", () => {
    const needs = [
      species("first-none", []),
      species("second-none", [null]),
      species("tied-a", [5]),
      species("tied-b", [5]),
    ];
    expect(sortNeedsByNearest(needs).map((n) => n.code)).toEqual([
      "tied-a",
      "tied-b",
      "first-none",
      "second-none",
    ]);
  });

  it("does not mutate the input array", () => {
    const needs = [species("b", [5]), species("a", [1])];
    const original = [...needs];
    sortNeedsByNearest(needs);
    expect(needs).toEqual(original);
  });
});

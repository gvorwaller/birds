import { describe, expect, it } from "vitest";
import {
  isTripVisitedRequest,
  remainingRoute,
  visitedCountLabel,
} from "./trip-visited";

describe("isTripVisitedRequest", () => {
  it("allows exactly a POST whose first action is /set_visited on one trip", () => {
    expect(isTripVisitedRequest("/trips/7", "POST", "/set_visited")).toBe(true);
    expect(isTripVisitedRequest("/trips/123", "POST", "/set_visited")).toBe(
      true,
    );
  });

  it("refuses every adjacent path, method and action", () => {
    for (const [path, method, action] of [
      ["/trips/7", "POST", "/remove_stop"],
      ["/trips/7", "POST", undefined],
      ["/trips/7", "PUT", "/set_visited"],
      ["/trips", "POST", "/set_visited"],
      ["/trips/plan", "POST", "/set_visited"],
      ["/trips/0", "POST", "/set_visited"],
      ["/trips/07", "POST", "/set_visited"],
      ["/trips/7/export", "POST", "/set_visited"],
      ["/trips/7/", "POST", "/set_visited"],
      ["/", "POST", "/set_visited"],
    ] as const) {
      expect(
        isTripVisitedRequest(path, method, action),
        `${method} ${path} ${action}`,
      ).toBe(false);
    }
  });
});

describe("remainingRoute", () => {
  // Stop n sits at (n, n); `pt` is the point a link drives through.
  const p = (visited: boolean, n: number) => ({ lat: n, lng: n, visited });
  const pt = (n: number) => ({ lat: n, lng: n });

  it("drives through every stop while none is checked off", () => {
    expect(remainingRoute([p(false, 1), p(false, 2)])).toEqual({
      points: [pt(1), pt(2)],
      label: "Navigate all stops",
    });
  });

  it("skips checked-off stops, keeping trip order", () => {
    expect(
      remainingRoute([p(true, 1), p(false, 2), p(true, 3), p(false, 4)]),
    ).toEqual({
      points: [pt(2), pt(4)],
      label: "Navigate the 2 stops left",
    });
  });

  it("still links the one stop left on a multi-stop trip", () => {
    expect(remainingRoute([p(true, 1), p(false, 2)])).toEqual({
      points: [pt(2)],
      label: "Navigate to the last stop left",
    });
  });

  it("has no link when everything is visited, or the trip has under two located stops", () => {
    expect(remainingRoute([p(true, 1), p(true, 2)])).toBeNull();
    expect(remainingRoute([p(false, 1)])).toBeNull();
    expect(remainingRoute([])).toBeNull();
  });

  it("treats a stop with no visited flag (the planner preview) as not visited", () => {
    expect(remainingRoute([pt(1), pt(2)])?.label).toBe("Navigate all stops");
  });

  describe("with a start & end point (td-0f3c63)", () => {
    const hotel = { lat: 9, lng: 9, label: "Harbor Inn" };

    it("ends every route back at the anchor", () => {
      expect(remainingRoute([p(false, 1), p(false, 2)], hotel)).toEqual({
        points: [pt(1), pt(2), pt(9)],
        label: "Navigate all stops and back to Harbor Inn",
      });
      expect(
        remainingRoute([p(true, 1), p(false, 2), p(false, 3)], hotel),
      ).toEqual({
        points: [pt(2), pt(3), pt(9)],
        label: "Navigate the 2 stops left and back to Harbor Inn",
      });
      expect(remainingRoute([p(true, 1), p(false, 2)], hotel)?.label).toBe(
        "Navigate the last stop left and back to Harbor Inn",
      );
    });

    it("a one-stop trip still gets a route, and with everything visited it is the drive back", () => {
      expect(remainingRoute([p(false, 1)], hotel)?.points).toEqual([
        pt(1),
        pt(9),
      ]);
      expect(remainingRoute([p(true, 1), p(true, 2)], hotel)).toEqual({
        points: [pt(9)],
        label: "Navigate back to Harbor Inn",
      });
    });

    it("no located stops yet: the drive to the anchor (CODEX1)", () => {
      expect(remainingRoute([], hotel)).toEqual({
        points: [pt(9)],
        label: "Navigate to Harbor Inn",
      });
    });
  });
});

it("visitedCountLabel", () => {
  expect(visitedCountLabel(2, 5)).toBe("2 / 5 visited");
});

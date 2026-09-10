import { expect, it } from "vitest";
import { isSpeciesViewsRequest } from "./species-views";
it("allows only exact personal history mutations for viewers", () => {
  expect(isSpeciesViewsRequest("/api/species-views", "POST")).toBe(true);
  for (const action of ["/tracking", "/clear"])
    expect(isSpeciesViewsRequest("/viewed", "POST", action)).toBe(true);
  for (const [path, method, action] of [
    ["/api/species-views/other", "POST", ""],
    ["/viewed", "DELETE", "/clear"],
    ["/viewed", "POST", "/owner_action"],
    ["/settings", "POST", "/clear"],
    ["/viewed/other", "POST", "/tracking"],
  ])
    expect(isSpeciesViewsRequest(path, method, action)).toBe(false);
});

import { describe, expect, it } from "vitest";
import { canonicalHref, withReturnTo } from "./navigation-context";

describe("adopted navigation sources", () => {
  it("retains full Field guide content state through an adopted bird hop", () => {
    const guide =
      "/species?q=tern&family=laridae&tags=habitat%3Acoast&tags=behavior%3Amigratory&sort=name&page=2&country=US&region=US-FL&future=kept#results";
    const bird = withReturnTo("/species/roster", guide, undefined, "Field guide");
    const url = new URL(bird, "https://birds.test");
    expect(url.searchParams.get("returnTo")).toBe(guide);
    expect(url.searchParams.get("returnLabel")).toBe("Field guide");
  });

  it("keeps one immediate fallback while Forecast continues to a hotspot", () => {
    const forecast =
      "/forecast/species?species=roster&country=US&region=US-FL&county=US-FL-001&month=9&future=kept#ranking";
    const hotspot = withReturnTo(
      "/hotspots/L123?month=9",
      forecast,
      undefined,
      "Where to find Roseate Spoonbill",
    );
    const url = new URL(hotspot, "https://birds.test");
    expect(url.searchParams.get("returnTo")).toBe(forecast);
    expect(canonicalHref(url.searchParams.get("returnTo"))).toBe(forecast);
    expect(url.searchParams.get("returnLabel")).toBe(
      "Where to find Roseate Spoonbill",
    );
  });
});

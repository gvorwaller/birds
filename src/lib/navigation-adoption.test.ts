import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalHref, withReturnTo } from "./navigation-context";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("adopted navigation sources", () => {
  it("retains full Field guide content state through an adopted bird hop", () => {
    const guide =
      "/species?q=tern&family=laridae&tags=habitat%3Acoast&tags=behavior%3Amigratory&sort=name&page=2&country=US&region=US-FL&future=kept#results";
    const bird = withReturnTo(
      "/species/roster",
      guide,
      undefined,
      "Field guide",
    );
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

  it("wires Home and trip-planner hotspot links into the navigation adapter", () => {
    const bestPlaces = source("src/lib/components/BestPlaces.svelte");
    const comparison = source("src/lib/components/HotspotComparison.svelte");
    const home = source("src/routes/+page.svelte");
    const planner = source("src/routes/trips/plan/+page.svelte");

    expect(bestPlaces).toContain(
      "withReturnTo(`/hotspots/${encodeURIComponent(p.locId)}`",
    );
    expect(bestPlaces).toContain("onclick={navigationAction(accountId");
    expect(comparison).toContain(
      "withReturnTo(`/hotspots/${encodeURIComponent(row.locId)}`",
    );
    expect(comparison).toContain(
      "withReturnTo(`/species/${encodeURIComponent(species.code)}`",
    );
    expect(comparison).toContain("onclick={navigationAction(accountId");
    expect(home).toContain("accountId={data.user?.id}");
    expect(home).toContain(
      "sourceHref={page.url.pathname + page.url.search + page.url.hash}",
    );
    expect(planner).toContain('sourceLabel="Trip planner"');
  });

  it("wires similar-species hops with the signed-in account and current bird", () => {
    const card = source("src/lib/components/SimilarSpeciesCard.svelte");
    const species = source("src/routes/species/[code]/+page.svelte");

    expect(card).toContain(
      "withReturnTo(baseHref, returnTo, undefined, currentSpeciesName)",
    );
    expect(card).toContain("onclick={navigationAction(accountId");
    expect(species).toContain("accountId={data.user?.id}");
    expect(species).toContain("currentSpeciesName={data.taxon.com_name}");
  });

  it("loads a trusted common name for alert-to-species path labels", () => {
    const loader = source("src/routes/alerts/+page.server.ts");
    const page = source("src/routes/alerts/+page.svelte");

    expect(loader).toContain(
      "LEFT JOIN taxonomy_cache t ON t.species_code = l.species_code",
    );
    expect(loader).toContain("t.com_name");
    expect(page).toContain("label:row.com_name ?? row.title");
  });
});

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { UNCOUNTED_PAGE_ROUTES, USAGE_FEATURES, usageFeatureFor } from "./usage-features";

/** Every page route id under src/routes (a directory holding +page.svelte). */
function pageRoutes(dir = "src/routes"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pageRoutes(full));
    else if (name === "+page.svelte") {
      const rel = relative("src/routes", dir).replace(/\\/g, "/");
      out.push(rel ? `/${rel}` : "/");
    }
  }
  return out;
}

describe("usage sections (td-c8e6a3)", () => {
  it("every page route belongs to a section or is deliberately uncounted", () => {
    const missing = pageRoutes().filter((r) => !UNCOUNTED_PAGE_ROUTES.has(r) && usageFeatureFor(r) == null);
    expect(missing).toEqual([]);
  });

  it("maps routes to the most specific section", () => {
    expect(usageFeatureFor("/")).toBe("home");
    expect(usageFeatureFor("/forecast/data")).toBe("hotspots_data");
    expect(usageFeatureFor("/hotspots/[locId]")).toBe("hotspots_data");
    expect(usageFeatureFor("/forecast/species")).toBe("forecast");
    expect(usageFeatureFor("/species/[code]")).toBe("field_guide");
    expect(usageFeatureFor("/special-interest")).toBe("study");
    expect(usageFeatureFor("/settings/appearance")).toBe("settings");
    expect(usageFeatureFor("/admin/tags/[tag]")).toBe("admin");
    expect(usageFeatureFor("/lifelist")).toBeNull(); // prefix must end at a segment
    expect(usageFeatureFor("/login")).toBeNull();
    expect(usageFeatureFor("/api/jobs")).toBeNull();
    expect(usageFeatureFor(null)).toBeNull();
  });

  it("section keys satisfy the table's CHECK", () => {
    for (const f of USAGE_FEATURES) expect(f).toMatch(/^[a-z][a-z_]{1,30}$/);
  });
});

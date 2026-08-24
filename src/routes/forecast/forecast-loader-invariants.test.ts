import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mechanical guards for the Forecast loaders' "cached reads only" invariant
 * (plan §6 / CODEX1 2026-08-11 #6). Loaders must never touch
 * ebird.org/barchartData; those fetches live only in form actions.
 *
 * Same style as `home-loader-url-tracking.test.ts`: scan source so a
 * regression fails without a SvelteKit request harness.
 */

const AREA = "src/routes/forecast/+page.server.ts";
const SPECIES = "src/routes/forecast/species/+page.server.ts";

const BARCHART_FETCH = [
  "ensureFrequencies",
  "fetchBarchart",
  "barchartData",
  "fetchAuthenticatedEbird",
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function exportBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name}`);
  expect(start, `should export ${name}`).toBeGreaterThan(-1);
  return stripComments(src.slice(start));
}

function loadBody(path: string): string {
  const src = readFileSync(path, "utf8");
  const start = src.indexOf("export const load");
  expect(start, `${path} should export a load function`).toBeGreaterThan(-1);
  // Loaders sit above `export const actions`; if actions are missing, scan
  // to EOF so a missing-actions refactor still fails the fetch check.
  const actions = src.indexOf("export const actions", start);
  return stripComments(src.slice(start, actions === -1 ? undefined : actions));
}

describe("Forecast loaders never fetch barchart data", () => {
  for (const path of [AREA, SPECIES]) {
    it(`${path} load() does not call the unofficial fetch path`, () => {
      const body = loadBody(path);
      const offenders = BARCHART_FETCH.filter((name) =>
        new RegExp(`\\b${name}\\b`).test(body),
      );
      expect(
        offenders,
        `${path} load() must not reference ${offenders.join(", ")} — ` +
          `barchart fetches belong in form actions only.`,
      ).toEqual([]);
    });
  }
});

describe("loadHotspots rejects a county outside the selected region", () => {
  it("validates region, then requires county membership under that region", () => {
    const body = exportBody(readFileSync(SPECIES, "utf8"), "actions");
    // Syntax + prefix check (US-FL-051 under US-FL, not US-ME-009). The
    // parent is `parsed.code` (td-f1d6da — a normalized code, country or
    // subnational1), not a raw form value.
    expect(body).toMatch(/countyCode\.startsWith\(`\$\{parsed\.code\}-`\)/);
    // Official list membership, not just the code shape. The level is
    // `childLvl` (subnational2 under a state, or subnational1 under a
    // whole-country region) rather than a hardcoded 'subnational2'.
    expect(body).toMatch(/subregions\(\s*apiKey,\s*parsed\.code,\s*childLvl/);
    expect(body).toMatch(/counties\.some\(\s*\(c\)\s*=>\s*c\.code === countyCode/);
  });
});

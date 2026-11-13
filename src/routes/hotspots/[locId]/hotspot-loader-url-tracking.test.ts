import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mechanical guard for the hotspot loader's URL-tracking invariant
 * (td-3aadc3), the same one Home relies on (home-loader-url-tracking.test.ts).
 *
 * SvelteKit records load dependencies per URL access: `searchParams.get/has/
 * getAll` tracks ONE key, while reading `url.search`/`href`/`pathname`/
 * `toString`/`toJSON` marks the WHOLE url as a dependency. The Recent reports
 * All / Need / Seen lens (`?list=`) is deliberately untracked, so switching it
 * reuses the loaded reports instead of re-running the loader and its eBird
 * request.
 */
const LOADER = "src/routes/hotspots/[locId]/+page.server.ts";
const WHOLE_URL_READS = ["search", "href", "pathname", "toString", "toJSON"];

function loaderBody(): string {
  const src = readFileSync(LOADER, "utf8");
  const start = src.indexOf("export const load");
  const end = src.indexOf("export const actions");
  expect(start, `${LOADER} should export a load function`).toBeGreaterThan(-1);
  return src
    .slice(start, end > start ? end : undefined)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("Hotspot loader URL tracking", () => {
  it("never reads a whole-URL property", () => {
    const body = loaderBody();
    const offenders = WHOLE_URL_READS.filter((prop) =>
      new RegExp(`\\burl\\s*\\.\\s*${prop}\\b`).test(body),
    );
    expect(
      offenders,
      `Reading url.${offenders.join("/url.")} in the hotspot loader re-runs it ` +
        `(and its eBird request) on every lens change. Read searchParams one key at a time.`,
    ).toEqual([]);
  });

  it("does not track the Recent reports lens param", () => {
    expect(/searchParams\s*\.\s*(get|has|getAll)\(\s*["'`]list["'`]/.test(loaderBody())).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mechanical guard for the Home loader's URL-tracking invariant.
 *
 * SvelteKit records load dependencies per URL access: `searchParams.get/has/
 * getAll` tracks ONE key, while reading `url.search`/`href`/`pathname`/
 * `toString`/`toJSON` marks the WHOLE url as a dependency
 * (`make_trackable`, @sveltejs/kit `src/utils/url.js`).
 *
 * Home relies on that distinction. `?loc=` (the place-focus param) is
 * deliberately untracked, which is what lets focusing a place be a client-side
 * navigation that reuses server data instead of re-running `geoTargets()` and
 * its per-species eBird fan-out. One whole-URL read anywhere in this loader
 * silently restores a full re-run on every param change — with no test failure,
 * no type error and no visible symptom beyond the page getting slow.
 *
 * That regression already happened once: temporary gate instrumentation logged
 * `url.pathname + url.search` and re-created the exact dependency it was
 * measuring. Hence a test rather than a comment.
 */
const LOADER = "src/routes/+page.server.ts";

/** Reads that mark the entire URL as a load dependency. */
const WHOLE_URL_READS = ["search", "href", "pathname", "toString", "toJSON"];

function loaderBody(): string {
  const src = readFileSync(LOADER, "utf8");
  const start = src.indexOf("export const load");
  expect(start, `${LOADER} should export a load function`).toBeGreaterThan(-1);
  // Strip comments so the INVARIANT note (which names these properties) and any
  // explanatory comments do not trip the scan.
  return src
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("Home loader URL tracking", () => {
  it("never reads a whole-URL property", () => {
    const body = loaderBody();
    const offenders = WHOLE_URL_READS.filter((prop) =>
      new RegExp(`\\burl\\s*\\.\\s*${prop}\\b`).test(body),
    );
    expect(
      offenders,
      `Reading url.${offenders.join("/url.")} in ${LOADER} marks the whole URL ` +
        `as a load dependency, so every param change — including the untracked ` +
        `?loc= focus param — re-runs geoTargets(). Use url.searchParams.get("key") ` +
        `instead, one key at a time.`,
    ).toEqual([]);
  });

  it("does not track the focus param", () => {
    const body = loaderBody();
    expect(
      /searchParams\s*\.\s*(get|has|getAll)\(\s*["'`]loc["'`]/.test(body),
      `${LOADER} must not read "loc" from searchParams: doing so registers it ` +
        `as a tracked key and re-runs this loader on every focus change.`,
    ).toBe(false);
  });
});

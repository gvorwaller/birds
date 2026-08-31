/**
 * Home must not be hover-preloaded (td-d561a8 §7).
 *
 * `app.html` turns on `preload-data="hover"` app-wide. A preload of a STREAMED
 * route starts its deferred server work immediately, and discarding the
 * preload does not abort it — so once Home defers its per-species fan-out, a
 * hover that never becomes a click still spends ~27 eBird calls. Streaming
 * made this worse, not moot.
 *
 * A source scan rather than a DOM test because the failure mode is someone
 * adding a FIFTH Home link (a new nav, an empty-state CTA in the chrome) and
 * silently reopening the hole. Scoped to the persistent chrome: a repo-wide
 * `href="/"` grep would also flag ordinary in-page links and redirects, which
 * are not preload surfaces worth gating.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const layout = readFileSync(
  resolve("src/routes/+layout.svelte"),
  "utf8",
);
const appHtml = readFileSync(resolve("src/app.html"), "utf8");

describe("Home preload policy", () => {
  it("still relies on the app-wide hover default for other routes", () => {
    // If this ever changes, the opt-out below stops being necessary — but it
    // must be a deliberate edit, not a surprise.
    expect(appHtml).toContain('data-sveltekit-preload-data="hover"');
  });

  it("marks every literal Home anchor in the chrome as tap-only", () => {
    const anchors = [...layout.matchAll(/<a\b[^>]*href="\/"[^>]*>/g)].map(
      (m) => m[0],
    );
    // The brand link is the only hard-coded `href="/"` in the layout today.
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a, `hover-preloads Home: ${a}`).toContain(
        'data-sveltekit-preload-data="tap"',
      );
    }
  });

  it("routes every nav item through the preload helper", () => {
    // The top nav, the drawer and the bottom nav each render Home from
    // `primaryItems`, so the guard belongs on the shared `<a>` — three
    // renderers, one rule.
    const itemAnchors = [
      ...layout.matchAll(/<a\b[^>]*href=\{item\.href\}[^>]*>/g),
    ].map((m) => m[0]);
    expect(itemAnchors).toHaveLength(3);
    for (const a of itemAnchors) {
      expect(a, `nav item link without preloadFor(): ${a}`).toContain(
        "data-sveltekit-preload-data={preloadFor(item.href)}",
      );
    }
  });

  it("opts out Home and nothing else", () => {
    const fn = layout.match(
      /function preloadFor\(href: string\)[\s\S]*?\n\t\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain("href === '/'");
    expect(fn).toContain("'tap'");
  });
});

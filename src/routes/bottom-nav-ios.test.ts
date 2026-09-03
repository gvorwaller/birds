import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const layout = readFileSync(resolve("src/routes/+layout.svelte"), "utf8");

describe("iOS bottom navigation stability", () => {
  it("does not promote the fixed bar into a transformed compositor layer", () => {
    const css = layout.match(/\.bottom-nav\s*\{([\s\S]*?)\n\t\}/)?.[1];

    expect(css).toBeTruthy();
    expect(css).toContain("position: fixed");
    expect(css).not.toContain("transform:");
    expect(css).not.toContain("backdrop-filter:");
  });

  it("repins the bar after visual viewport transitions settle", () => {
    expect(layout).toContain("use:stabilizeBottomNav");
    expect(layout).toContain("window.visualViewport");
    expect(layout).toContain("viewport?.addEventListener('resize', repin");
    expect(layout).toContain("viewport?.addEventListener('scroll', repin");
    expect(layout.match(/requestAnimationFrame/g)).toHaveLength(2);
  });
});

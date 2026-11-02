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

  it("pins both fixed bars to the visual viewport once the keyboard has settled", () => {
    expect(layout).toContain("use:pinFixedBars");
    expect(layout).toContain("window.visualViewport");
    expect(layout).toContain("fixedBarOffsets");
    expect(layout).toContain("opensKeyboard(document.activeElement)");
    expect(layout).toContain("display-mode: standalone");
    expect(layout).toContain("vv.addEventListener('resize', onViewportChange");
    expect(layout).toContain("vv.addEventListener('scroll', onViewportChange");
    expect(layout).toContain("topNav.style.transform");
    expect(layout).toContain("node.style.visibility = held ? 'hidden' : ''");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync("src/routes/+layout.svelte", "utf8");
const forecast = readFileSync("src/routes/forecast/+page.svelte", "utf8");
const planner = readFileSync("src/routes/trips/plan/+page.svelte", "utf8");
const mapPicker = readFileSync("src/lib/components/MapPicker.svelte", "utf8");

/**
 * The current unit environment does not mount Svelte route components. These
 * source contracts protect the keyboard and focus wiring that browser
 * acceptance exercises on the rendered shell.
 */
describe("Phase 6 shell and map controls", () => {
  it("connects both menu openers to one dialog-opening path", () => {
    expect(layout).toContain("const drawerId = 'navigation-drawer'");
    expect(layout).toMatch(/class="hamburger"[\s\S]*?aria-controls=\{drawerId\}[\s\S]*?onclick=\{openMenu\}/);
    expect(layout).toMatch(/class="more-btn"[\s\S]*?aria-controls=\{drawerId\}[\s\S]*?onclick=\{openMenu\}/);
    expect(layout).toContain('id={drawerId} class="drawer" role="dialog" aria-modal="true"');
    expect(layout).toContain("event.currentTarget instanceof HTMLElement");
  });

  it("contains drawer focus and distinguishes route selection from dismissal", () => {
    expect(layout).toContain("event.key === 'Escape'");
    expect(layout).toContain("event.key !== 'Tab'");
    expect(layout).toContain("last.focus()");
    expect(layout).toContain("first.focus()");
    expect(layout).toContain("document.addEventListener('focusin', containFocus)");
    expect(layout).toContain("if (menuOpen && drawer && event.target instanceof Node && !drawer.contains(event.target))");
    expect(layout).toContain("void closeMenu(false)");
    expect(layout).toContain("if (restoreFocus && menuOpener?.isConnected) menuOpener.focus()");
    expect(layout).toContain("element.inert = true");
    expect(layout).toContain("document.body.style.overflow = 'hidden'");
  });

  it("gives the Forecast editor a named region and explicit open/cancel focus paths", () => {
    expect(forecast).toContain('const pickerId = "forecast-location-picker"');
    expect(forecast).toContain("async function openPicker()");
    expect(forecast).toContain("pickerHeading?.focus({ preventScroll: true })");
    expect(forecast).toContain('aria-controls={pickerId}');
    expect(forecast).toContain('aria-labelledby="forecast-location-picker-heading"');
    expect(forecast).toContain('Choose a forecast location');
    expect(forecast).toContain("async function dismissPicker()");
    expect(forecast).toContain("pickOnMapButton?.focus()");
    expect(forecast).toMatch(
      /\.picker-wrap h2[\s\S]*?scroll-margin-top: calc\(var\(--nav-h\) \+ 16px\);/,
    );
  });

  it("keeps each touched control at the measured target", () => {
    expect(layout).toMatch(/\.hamburger[\s\S]*?width: 48px;[\s\S]*?height: 48px;/);
    expect(layout).toMatch(/\.close[\s\S]*?width: 48px;[\s\S]*?height: 48px;/);
    expect(layout).toContain("min-height: 48px;");
    expect(planner).toMatch(/\.pick-toggle[\s\S]*?min-height: 48px;/);
    expect(mapPicker).toMatch(/\.search input[\s\S]*?min-height: 48px;[\s\S]*?font-size: 16px;/);
    expect(mapPicker).toMatch(/\.search button[\s\S]*?min-height: 48px;/);
  });
});

/**
 * SearchableSelect markup contract (td-daff98 §3b). Behaviour (matching,
 * paging) is covered in place-filter.test.ts; this pins the accessibility and
 * form-submission shape.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SearchableSelect.svelte", import.meta.url), "utf8");
const route = readFileSync(new URL("../../routes/species/+page.svelte", import.meta.url), "utf8");

describe("SearchableSelect", () => {
  it("is a WAI-ARIA 1.2 editable combobox with a listbox popup", () => {
    for (const attr of [
      'role="combobox"',
      'aria-autocomplete="list"',
      "aria-expanded={open}",
      "aria-controls={listId}",
      "aria-activedescendant={activeId}",
      'role="listbox"',
      'role="option"',
      "aria-selected={row.code === value}",
    ])
      expect(source).toContain(attr);
  });

  it("submits the committed code through one hidden input, never the typed text", () => {
    expect(source).toContain("<input type=\"hidden\" {name} {value} />");
    expect(source.match(/\{name\}/g)).toHaveLength(1);
    // Every way of leaving without choosing puts the committed label back.
    expect(source).toMatch(/function dismiss\(\)[\s\S]*?text = committedLabel;/);
    expect(source).toMatch(/case "Escape":[\s\S]*?dismiss\(\)/);
    expect(source).toMatch(/case "Tab":[\s\S]*?dismiss\(\)/);
    expect(source).toContain("onblur={() => { if (open) dismiss(); }}");
    // Option presses don't blur the input before they commit (touch included).
    expect(source.match(/onpointerdown=\{\(e\) => e\.preventDefault\(\)\}/g)).toHaveLength(2);
  });

  it("never submits the form on Enter and ignores Enter during IME composition", () => {
    expect(source).toContain("if (event.isComposing) return;");
    expect(source).toMatch(/case "Enter":\s*\/\/[^\n]*\n\s*event\.preventDefault\(\);/);
    expect(source).not.toContain("enterkeyhint");
    expect(source).toContain('active = rows.findIndex((row) => row.kind === "choice")');
    expect(source).toContain("An unmatched query has");
    // GROK: Enter on a no-match query restores the committed label, like Escape.
    expect(source).toMatch(/if \(open && active >= 0\) activate\(active\);[\s\S]*?else if \(open\) dismiss\(\);/);
  });

  it("pages large lists with a reachable 'Show next' option instead of dropping choices", () => {
    expect(source).toContain("placePage(matches, pages)");
    expect(source).toContain("Show next {Math.min(PLACE_PAGE_SIZE, page.remaining)}");
    expect(source).toMatch(/if \(row\.kind === "more"\) \{\s*pages \+= 1;/);
  });

  it("keeps iOS from zooming and every option at least 48px tall", () => {
    expect(source).toContain("font-size: max(1rem, 16px);");
    expect(source).toMatch(/\.list li \{[^}]*min-height: 48px;/);
    expect(source).toMatch(/\.clear \{[^}]*min-width: 48px;[^}]*min-height: 48px;/);
  });
});

describe("Field Guide Place fields", () => {
  it("renders exactly one submitting control per Place field in each phase", () => {
    for (const [id, name] of [
      ["guide-country", "country"],
      ["guide-region", "region"],
      ["guide-county", "county"],
      ["guide-hotspot", "hotspot"],
    ]) {
      // Hydrated: the combobox (its hidden input carries `name`).
      expect(route).toContain(`<SearchableSelect id="${id}" name="${name}"`);
      // Before hydration: the native select, in the {:else} branch.
      expect(route).toContain(`<select id="${id}" name="${name}"`);
    }
    const hydrated = route.indexOf("{#if placeHydrated}");
    const native = route.indexOf("{:else}", hydrated);
    expect(hydrated).toBeGreaterThan(-1);
    expect(route.indexOf('<SearchableSelect id="guide-country"')).toBeGreaterThan(hydrated);
    expect(route.indexOf('<SearchableSelect id="guide-country"')).toBeLessThan(native);
    expect(route.indexOf('<select id="guide-country"')).toBeGreaterThan(native);
  });

  it("puts Place first in the panel", () => {
    const panel = route.slice(route.indexOf('class="card filter-card"'));
    expect(panel.indexOf("<legend>Place</legend>")).toBeLessThan(panel.indexOf("Special interest only"));
    expect(panel.indexOf("<legend>Place</legend>")).toBeLessThan(panel.indexOf("TAG_DIMENSIONS"));
  });

  it("reads the live native selects before swapping, and waits while one has focus", () => {
    // Captured when the script first runs, before hydration re-applies the
    // server's values, so a pre-hydration native choice survives (GROK).
    expect(route).toContain("const nativePlaceAtBoot = browser ? readNativePlace() : {};");
    expect(route).toContain("if (el instanceof HTMLSelectElement) out[level] = el.value.trim().toUpperCase();");
    expect(route).toContain('focused!.addEventListener("blur", () => requestAnimationFrame(adoptNativePlace), { once: true });');
  });

  it("resets every transient edit state when the applied filters change", () => {
    expect(route).toMatch(/function resetToApplied\(\) \{[\s\S]*?loader\.invalidate\(\);[\s\S]*?mapOpen = false;[\s\S]*?seedLists\(\);[\s\S]*?draft = copyDraft\(applied\);/);
    expect(route).toContain("$effect.pre(() => {");
  });
});

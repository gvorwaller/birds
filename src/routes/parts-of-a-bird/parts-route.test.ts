import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import PartsDiagram from "$components/PartsDiagram.svelte";
import { DIAGRAMS } from "$lib/bird-parts";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const route = read("src/routes/parts-of-a-bird/+page.svelte");
const component = read("src/lib/components/PartsDiagram.svelte");
const tabs = read("src/lib/components/FieldGuideTabs.svelte");

describe("Parts of a Bird page (td-9c9655)", () => {
  it("is a Field Guide tab page with a collapsible section per bird that the page controls", () => {
    expect(route).toContain("<title>Parts of a Bird — birds</title>");
    expect(route).toContain('<FieldGuideTabs active="parts" />');
    expect(route).toContain('<details class="card bird" id={d.id} bind:open={open[d.id]}>');
    expect(route).toContain("<summary><h2>{d.title}</h2></summary>");
    expect(route).toMatch(/onclick=\{\(\) => setAll\(true\)\}>Expand all/);
    expect(route).toMatch(/onclick=\{\(\) => setAll\(false\)\}>Collapse all/);
  });

  it("starts every section closed, also in SSR", () => {
    expect(route).toContain("Object.fromEntries(DIAGRAMS.map((d) => [d.id, false]))");
    expect(route).not.toMatch(/<details[^>]*\sopen[\s>]/);
  });

  it("reveals fragment targets from the data on load and on every hash change", () => {
    expect(route).toContain("const target = parseHash(hash);");
    // page.url.hash, not afterNavigate: same-page hash links and Back/Forward between hashes are shallow.
    expect(route).toMatch(/\$effect\(\(\) => \{\s*const hash = page\.url\.hash;\s*untrack\(\(\) => void revealFromHash\(hash\)\);/);
    expect(route).not.toContain("afterNavigate(");
    // A part opens in a view and layer that draw it: feathers-only and flight-only parts included.
    expect(route).toContain("const place = placePart(diagram, target.part, views[target.diagram], layers[target.diagram]);");
    expect(route).toMatch(/views\[target\.diagram\] = place\.view;\s*layers\[target\.diagram\] = place\.layer;/);
  });

  it("owns each bird's view and drawing size, starting standing and whole (td-a1bfd9)", () => {
    expect(route).toContain('Object.fromEntries(DIAGRAMS.map((d) => [d.id, "standing" as View]))');
    expect(route).toContain("bind:view={views[d.id]}");
    expect(route).toContain("bind:wingOnly={wingOnly[d.id]}");
  });

  it("adds the tab, spanning the phone grid and joining the row from 640px", () => {
    expect(tabs).toContain('href="/parts-of-a-bird" class="wide"');
    expect(tabs).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");
    expect(tabs).toMatch(/a\.wide \{\s*grid-column: 1 \/ -1;/);
    expect(tabs).toContain("a.wide { grid-column: auto; }");
  });
});

describe("PartsDiagram", () => {
  it("server-renders the whole glossary with anchors and no inert controls", () => {
    for (const diagram of DIAGRAMS) {
      const { body } = render(PartsDiagram, { props: { diagram } });
      for (const p of diagram.glossary) {
        expect(body, `${diagram.id}-${p.id}`).toContain(`id="${diagram.id}-${p.id}"`);
      }
      expect(body).not.toContain("All feather groups");
      expect(body).not.toContain("Tap a part");
      expect(body).not.toContain("<button");
      // A name and its other name read as two words, e.g. "Ear coverts (auriculars)" (td-dd4f9c).
      for (const p of diagram.glossary.filter((q) => q.aka)) {
        expect(body.replace(/<!--.*?-->/g, ""), `${diagram.id}-${p.id}`).toMatch(new RegExp(`${p.name.replace(/[.()]/g, "\\$&")} <span class="aka[^"]*">\\(`));
      }
      // Every view is drawn without JS, labelled, with no selection painted.
      const title = diagram.title.toLowerCase();
      expect(body).toContain(`aria-label="Diagram of a ${title}, ${diagram.model.pose}"`);
      expect(body).toContain(`aria-label="Diagram of a ${title}, in flight, from above"`);
      expect(body).toContain(`aria-label="Diagram of a ${title}, in flight, from below"`);
      expect(body.match(/<figure class="plate/g)).toHaveLength(3);
      expect(body).not.toContain('class="selection"');
    }
  });

  it("keeps the drawing a pointer shortcut and the list the accessible control", () => {
    expect(component).toContain("use:tapParts");
    expect(component).toContain("aria-pressed={p.id === selected}");
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("aria-describedby={p.id === selected ? captionId : undefined}");
    // No a11y lint suppressions.
    expect(component).not.toContain("svelte-ignore");
  });

  it("marks a selection with a dashed outline, not colour alone", () => {
    expect(component).toMatch(/\.selection \{[^}]*stroke-dasharray/);
    expect(component).toMatch(/\.selection \{[^}]*vector-effect: non-scaling-stroke/);
  });

  it("offers the layer switch only where it adds parts, and the size only in flight", () => {
    expect(component).toContain("{#if twoLayers}");
    expect(component).toContain("{#if active.wingViewBox}");
    expect(component).toContain(">One wing, larger</button>");
    expect(component).toContain('role="group" aria-label="View"');
    // Only the shared breakpoints (cs.md: 640px and 1024px).
    expect(component).toContain("@media (max-width: 639.98px)");
    expect(component).not.toMatch(/@media \((?:max|min)-width: (?!639\.98px|640px|1023\.98px|1024px)/);
  });

  it("keeps a selection across views and says where a part not drawn here can be seen", () => {
    expect(component).toMatch(/async function setView\(next: View\) \{[^}]*layer = layerAfterViewChange\(diagram, selected, next, layer\);/);
    expect(component).not.toMatch(/async function setView[^}]*selected = /);
    expect(component).toContain("Not drawn in this view. Show it:");
    // The caption's link vanishes once the part is drawn; focus moves to the part's name.
    expect(component).toContain("onclick={() => showIn(v.id)}");
    expect(component).toMatch(/async function showIn\(next: View\) \{\s*await setView\(next\);\s*const chip = selected \? document\.getElementById/);
  });
});

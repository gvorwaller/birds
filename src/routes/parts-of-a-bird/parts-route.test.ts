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
  it("is a Field Guide tab page with four collapsible sections the page controls", () => {
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
    // A feathers-only part switches its section to a layer that draws it.
    expect(route).toContain("if (!part.layers.includes(layers[target.diagram])) layers[target.diagram] = part.layers[0];");
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
      for (const p of diagram.parts) {
        expect(body, `${diagram.id}-${p.id}`).toContain(`id="${diagram.id}-${p.id}"`);
      }
      expect(body).not.toContain("All feather groups");
      expect(body).not.toContain("Tap a part");
      expect(body).not.toContain("<button");
      expect(body).toContain(`aria-label="Diagram of a ${diagram.title.toLowerCase()}"`);
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

  it("offers the layer switch only where it adds parts", () => {
    expect(component).toContain("{#if hydrated && twoLayers}");
  });
});

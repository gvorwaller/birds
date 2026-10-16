import { describe, expect, it } from "vitest";
import {
  DIAGRAMS,
  getView,
  hasFeatherLayer,
  joinDiagram,
  layerAfterViewChange,
  parseHash,
  placePart,
  selectionAfterLayerChange,
  viewsDrawing,
  visibleParts,
  type ViewGeometries,
} from "./index";
import { PART_GROUPS, VIEWS, type DiagramGeometry } from "./types";
import { songbird } from "./songbird";
import songbirdGeometry from "./geometry/songbird.json";
import songbirdAbove from "./geometry/songbird-above.json";
import songbirdBelow from "./geometry/songbird-below.json";

const TONES = new Set([
  "pale", "light", "mid", "wing", "dark", "darker", "bill", "leg", "legyellow", "billyellow",
  "accent2", "water", "gullgray", "legpink", "eye", "perch", "accent", "orbital", "mallardgreen", "chestnut",
  "gullpale", "linegray", "orange",
]);

// Absolute M/L/Z only (what scripts/bird-parts/geom.py:to_d writes).
function pathIsValid(d: string): boolean {
  if (!/^M/.test(d)) return false;
  const tokens = d.match(/[MLZ]|-?\d+(?:\.\d+)?|[^\s,]/g) ?? [];
  let pending = 0;
  for (const t of tokens) {
    if (t === "M" || t === "L") {
      if (pending % 2 !== 0) return false;
      pending = 0;
    } else if (t === "Z") {
      if (pending !== 0 && pending % 2 !== 0) return false;
      pending = 0;
    } else if (Number.isFinite(Number(t))) pending++;
    else return false;
  }
  return true;
}

describe("Parts of a Bird data", () => {
  it("has the four v1 diagrams in order, each standing and in flight from above and below", () => {
    expect(DIAGRAMS.map((d) => d.id)).toEqual(["songbird", "shorebird", "duck", "gull"]);
    for (const d of DIAGRAMS) expect(d.views.map((v) => v.id)).toEqual(["standing", "above", "below"]);
    expect(VIEWS.map((v) => v.label)).toEqual(["Standing", "Flight, above", "Flight, below"]);
  });

  for (const d of DIAGRAMS) {
    describe(d.id, () => {
      it("has unique, fragment-safe part ids in its glossary and in each view", () => {
        const ids = d.glossary.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
        for (const v of d.views) {
          const vids = v.parts.map((p) => p.id);
          expect(new Set(vids).size, v.id).toBe(vids.length);
        }
      });

      it("draws every glossary part in at least one view", () => {
        const drawn = new Set(d.views.flatMap((v) => v.parts.map((p) => p.id)));
        expect([...drawn].sort()).toEqual(d.glossary.map((p) => p.id).sort());
      });

      it("names every part and says what to look for", () => {
        for (const p of d.glossary) {
          expect(p.name.trim(), p.id).not.toBe("");
          expect(p.lookFor.trim().length, p.id).toBeGreaterThan(10);
          expect(PART_GROUPS).toContain(p.group);
        }
        for (const v of d.views) {
          for (const p of v.parts) {
            expect(p.layers.length, `${v.id}/${p.id}`).toBeGreaterThan(0);
            expect(TONES.has(p.tone), `${v.id}/${p.id} tone ${p.tone}`).toBe(true);
          }
        }
      });

      it("draws every part with a valid path in every view", () => {
        for (const v of d.views) {
          for (const p of v.parts) {
            expect(pathIsValid(p.d), `${v.id}/${p.id}`).toBe(true);
            for (const m of p.marks ?? []) {
              expect(pathIsValid(m.d), `${v.id}/${p.id} mark`).toBe(true);
              expect(TONES.has(m.tone)).toBe(true);
            }
          }
          for (const s of [...v.under, ...v.over]) {
            expect(pathIsValid(s.d), v.id).toBe(true);
            expect(TONES.has(s.tone)).toBe(true);
          }
          if (v.outline) expect(pathIsValid(v.outline)).toBe(true);
          expect(v.viewBox).toMatch(/^\d+ \d+ \d+ \d+$/);
        }
      });

      it("offers the one-wing size only on flight views, inside the whole drawing", () => {
        expect(getView(d, "standing").wingViewBox).toBeNull();
        for (const id of ["above", "below"] as const) {
          const v = getView(d, id);
          const [x, y, w, h] = v.viewBox.split(" ").map(Number);
          const [wx, wy, ww, wh] = v.wingViewBox!.split(" ").map(Number);
          expect(wx).toBeGreaterThan(x);
          expect(wx + ww).toBe(x + w);
          expect([wy, wh]).toEqual([y, h]);
          expect(ww / w).toBeLessThan(0.65);
        }
      });

      it("offers the feathers layer only when it adds parts", () => {
        const standing = getView(d, "standing");
        expect(visibleParts(standing, "main").length).toBeGreaterThan(5);
        expect(visibleParts(standing, "feathers").length).toBeGreaterThan(5);
        const addsParts = standing.parts.some((p) => !p.layers.includes("main"));
        expect(hasFeatherLayer(standing)).toBe(addsParts);
        // The swimming duck already shows its wing groups; every other bird has a real second layer.
        expect(addsParts).toBe(d.id !== "duck");
        // From above the open wing splits into feather groups; from below there's one layer.
        expect(hasFeatherLayer(getView(d, "above"))).toBe(true);
        expect(hasFeatherLayer(getView(d, "below"))).toBe(false);
      });

      it("uses the same ids for the same feathers on the open wing", () => {
        const above = getView(d, "above").parts.map((p) => p.id);
        const below = getView(d, "below").parts.map((p) => p.id);
        for (const id of ["primaries", "primary-coverts", "alula", "greater-coverts", "tertials", "scapulars", "tail"]) {
          expect(above, `above has ${id}`).toContain(id);
        }
        for (const id of ["primaries", "underwing-coverts", "axillaries", "undertail-coverts", "tail"]) {
          expect(below, `below has ${id}`).toContain(id);
        }
        // Parts shared with the standing drawing keep their standing names.
        const standing = new Set(getView(d, "standing").parts.map((p) => p.id));
        expect(above.filter((id) => standing.has(id)).length).toBeGreaterThan(6);
      });

      it("records its model and sources", () => {
        expect(d.model.species).not.toBe("");
        expect(d.model.age).not.toBe("");
        expect(d.model.pose).not.toBe("");
        expect(d.sources.some((s) => s.credit && /CC BY/.test(s.credit))).toBe(true);
        for (const s of d.sources) expect(s.url).toMatch(/^https:\/\//);
      });
    });
  }

  it("keeps the gull's look-alike parts separate, with the open-wingtip inset on the standing gull", () => {
    const g = DIAGRAMS.find((d) => d.id === "gull")!;
    for (const id of ["mirrors", "apical-spots", "gonys", "gonydeal-spot", "tertial-crescent", "trailing-edge"]) {
      expect(g.glossary.some((p) => p.id === id), id).toBe(true);
    }
    expect(getView(g, "standing").insets).toHaveLength(1);
    expect(getView(g, "above").insets).toHaveLength(0);
    expect(g.glossary.find((p) => p.id === "mirrors")!.visibility).toBeTruthy();
    // The black wingtip is drawn over the primaries, never as its own tap target.
    expect(getView(g, "above").parts.find((p) => p.id === "primaries")!.marks?.length).toBe(1);
  });

  it("makes the open-wingtip inset's spots and black tips the same tappable parts as on the bird", () => {
    const g = getView(DIAGRAMS.find((d) => d.id === "gull")!, "standing");
    const [inset] = g.insets;
    const inInset = (d: string) =>
      [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].some(
        ([, x, y]) => Math.hypot(Number(x) - inset.cx, Number(y) - inset.cy) < inset.r,
      );
    const outside = (d: string) =>
      [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].some(
        ([, x, y]) => Math.hypot(Number(x) - inset.cx, Number(y) - inset.cy) > inset.r,
      );
    for (const id of ["apical-spots", "primaries"]) {
      const d = g.parts.find((p) => p.id === id)!.d;
      expect(inInset(d) && outside(d), id).toBe(true);
    }
    // Nothing in the inset is drawn as an untappable copy of those parts.
    expect(g.under.filter((s) => inInset(s.d)).map((s) => s.tone)).toEqual(["gullgray"]);
  });

  it("names the songbird's primary coverts as their own feather group", () => {
    const sb = DIAGRAMS.find((d) => d.id === "songbird")!;
    const pc = getView(sb, "standing").parts.find((p) => p.id === "primary-coverts")!;
    expect(pc.layers).toEqual(["feathers"]);
    expect(pc.group).toBe("Wing");
  });

  it("keeps primary projection and wingtip vs. tail as separate shorebird parts", () => {
    const s = getView(DIAGRAMS.find((d) => d.id === "shorebird")!, "standing");
    const pp = s.parts.find((p) => p.id === "primary-projection")!;
    const wt = s.parts.find((p) => p.id === "wingtip-vs-tail")!;
    expect(pp.lookFor).toMatch(/tertials/);
    expect(wt.lookFor).toMatch(/tail/);
    expect(pp.d).not.toBe(wt.d);
  });

  it("puts the duck's speculum on the open wing between its two white borders", () => {
    const above = getView(DIAGRAMS.find((d) => d.id === "duck")!, "above");
    expect(above.parts.find((p) => p.id === "speculum")!.marks?.map((m) => m.tone)).toEqual(["pale", "darker"]);
    expect(above.parts.find((p) => p.id === "greater-coverts")!.marks?.map((m) => m.tone)).toEqual(["pale", "darker"]);
  });

  it("refuses text and drawings that don't match", () => {
    const geometries: ViewGeometries = {
      standing: songbirdGeometry as DiagramGeometry,
      above: songbirdAbove as DiagramGeometry,
      below: songbirdBelow as DiagramGeometry,
    };
    expect(() => joinDiagram(songbird, geometries)).not.toThrow();
    expect(() => joinDiagram({ ...songbird, parts: songbird.parts.slice(1) }, geometries)).toThrow(/no text/);
    expect(() =>
      joinDiagram({ ...songbird, parts: [...songbird.parts, { ...songbird.parts[0], id: "extra" }] }, geometries),
    ).toThrow(/no drawing/);
    expect(() => joinDiagram(songbird, { ...geometries, above: geometries.below })).toThrow(/songbird-above drawing is songbird-below/);
  });
});

describe("layers, views and selection", () => {
  const sb = DIAGRAMS[0];
  const standing = getView(sb, "standing");
  const gull = DIAGRAMS.find((d) => d.id === "gull")!;

  it("shows main parts in main only, feathers-only parts only in feathers, shared parts in both", () => {
    const main = visibleParts(standing, "main").map((p) => p.id);
    const feathers = visibleParts(standing, "feathers").map((p) => p.id);
    expect(main).toContain("wing");
    expect(feathers).not.toContain("wing");
    expect(feathers).toContain("median-coverts");
    expect(main).not.toContain("median-coverts");
    expect(main).toContain("primaries");
    expect(feathers).toContain("primaries");
  });

  it("keeps a selection that is still drawn and clears one that isn't, on a layer change", () => {
    expect(selectionAfterLayerChange(standing, "primaries", "main")).toBe("primaries");
    expect(selectionAfterLayerChange(standing, "median-coverts", "main")).toBeNull();
    expect(selectionAfterLayerChange(standing, "wing", "feathers")).toBeNull();
    expect(selectionAfterLayerChange(standing, null, "feathers")).toBeNull();
  });

  it("switches to the layer that draws the selected part on a view change", () => {
    // Greater coverts are feathers-only on the gull's open wing (the mantle covers them in Main parts).
    expect(layerAfterViewChange(gull, "greater-coverts", "above", "main")).toBe("feathers");
    expect(layerAfterViewChange(gull, "trailing-edge", "above", "main")).toBe("main");
    expect(layerAfterViewChange(gull, null, "above", "feathers")).toBe("feathers");
    // From below there is one layer.
    expect(layerAfterViewChange(gull, "greater-coverts", "below", "feathers")).toBe("main");
  });

  it("places a part in the current view if drawn there, else the first view that draws it", () => {
    expect(placePart(gull, "mirrors", "above", "main")).toEqual({ view: "above", layer: "main" });
    expect(placePart(gull, "mirrors", "standing", "main")).toEqual({ view: "standing", layer: "main" });
    expect(placePart(gull, "axillaries", "standing", "main")).toEqual({ view: "below", layer: "main" });
    expect(placePart(gull, "alula", "standing", "main")).toEqual({ view: "above", layer: "feathers" });
    expect(placePart(gull, "gonys", "below", "main")).toEqual({ view: "standing", layer: "main" });
  });

  it("names the views that draw a part", () => {
    expect(viewsDrawing(gull, "axillaries").map((v) => v.id)).toEqual(["below"]);
    expect(viewsDrawing(gull, "primaries").map((v) => v.id)).toEqual(["standing", "above", "below"]);
  });
});

describe("parseHash", () => {
  it("finds a section or a part, including parts drawn only in flight", () => {
    expect(parseHash("#gull")).toEqual({ diagram: "gull", part: null });
    expect(parseHash("#gull-mirrors")).toEqual({ diagram: "gull", part: "mirrors" });
    expect(parseHash("#gull-axillaries")).toEqual({ diagram: "gull", part: "axillaries" });
    expect(parseHash("#shorebird-wingtip-vs-tail")).toEqual({ diagram: "shorebird", part: "wingtip-vs-tail" });
    expect(parseHash("songbird-median-coverts")).toEqual({ diagram: "songbird", part: "median-coverts" });
  });

  it("ignores unknown, malformed and injection-looking hashes", () => {
    for (const h of ["", "#", "#heron", "#gull-wattle", "#gull-", "#Gull", "#gull mirrors", "#%E0%A4%A", "#gull-mirrors\"><img src=x>", "#songbird-wing-bars;alert(1)", "#gull-above"]) {
      expect(parseHash(h), h).toBeNull();
    }
  });
});

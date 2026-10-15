import { describe, expect, it } from "vitest";
import { DIAGRAMS, hasFeatherLayer, joinDiagram, parseHash, selectionAfterLayerChange, visibleParts } from "./index";
import { PART_GROUPS, type DiagramGeometry } from "./types";
import { songbird } from "./songbird";
import songbirdGeometry from "./geometry/songbird.json";

const TONES = new Set([
  "pale", "light", "mid", "wing", "dark", "darker", "bill", "leg", "legyellow", "billyellow",
  "accent2", "water", "gullgray", "legpink", "eye", "perch", "accent", "orbital", "mallardgreen", "chestnut",
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
  it("has the four v1 diagrams in order", () => {
    expect(DIAGRAMS.map((d) => d.id)).toEqual(["songbird", "shorebird", "duck", "gull"]);
  });

  for (const d of DIAGRAMS) {
    describe(d.id, () => {
      it("has unique, fragment-safe part ids", () => {
        const ids = d.parts.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      });

      it("lists every part once, in the order the text module gives", () => {
        expect([...d.listOrder].sort()).toEqual(d.parts.map((p) => p.id).sort());
      });

      it("names every part and says what to look for", () => {
        for (const p of d.parts) {
          expect(p.name.trim(), p.id).not.toBe("");
          expect(p.lookFor.trim().length, p.id).toBeGreaterThan(10);
          expect(PART_GROUPS).toContain(p.group);
          expect(p.layers.length, p.id).toBeGreaterThan(0);
          expect(TONES.has(p.tone), `${p.id} tone ${p.tone}`).toBe(true);
        }
      });

      it("draws every part with a valid path", () => {
        for (const p of d.parts) expect(pathIsValid(p.d), p.id).toBe(true);
        for (const s of [...d.under, ...d.over]) {
          expect(pathIsValid(s.d)).toBe(true);
          expect(TONES.has(s.tone)).toBe(true);
        }
        if (d.outline) expect(pathIsValid(d.outline)).toBe(true);
        expect(d.viewBox).toMatch(/^0 0 \d+ \d+$/);
      });

      it("offers the feathers layer only when it adds parts", () => {
        expect(visibleParts(d, "main").length).toBeGreaterThan(5);
        expect(visibleParts(d, "feathers").length).toBeGreaterThan(5);
        const addsParts = d.parts.some((p) => !p.layers.includes("main"));
        expect(hasFeatherLayer(d)).toBe(addsParts);
        // The swimming duck already shows its wing groups; every other bird has a real second layer.
        expect(addsParts).toBe(d.id !== "duck");
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

  it("keeps the gull's look-alike parts separate, with the open-wingtip inset", () => {
    const g = DIAGRAMS.find((d) => d.id === "gull")!;
    for (const id of ["mirrors", "apical-spots", "gonys", "gonydeal-spot", "tertial-crescent"]) {
      expect(g.parts.some((p) => p.id === id), id).toBe(true);
    }
    expect(g.insets).toHaveLength(1);
    expect(g.parts.find((p) => p.id === "mirrors")!.visibility).toBeTruthy();
  });

  it("makes the open-wingtip inset's spots and black tips the same tappable parts as on the bird", () => {
    const g = DIAGRAMS.find((d) => d.id === "gull")!;
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
    const pc = sb.parts.find((p) => p.id === "primary-coverts")!;
    expect(pc.layers).toEqual(["feathers"]);
    expect(pc.group).toBe("Wing");
  });

  it("keeps primary projection and wingtip vs. tail as separate shorebird parts", () => {
    const s = DIAGRAMS.find((d) => d.id === "shorebird")!;
    const pp = s.parts.find((p) => p.id === "primary-projection")!;
    const wt = s.parts.find((p) => p.id === "wingtip-vs-tail")!;
    expect(pp.lookFor).toMatch(/tertials/);
    expect(wt.lookFor).toMatch(/tail/);
    expect(pp.d).not.toBe(wt.d);
  });

  it("refuses text and drawings that don't match", () => {
    const geometry = songbirdGeometry as DiagramGeometry;
    expect(() => joinDiagram({ ...songbird, parts: songbird.parts.slice(1) }, geometry)).toThrow(/no text/);
    expect(() =>
      joinDiagram({ ...songbird, parts: [...songbird.parts, { ...songbird.parts[0], id: "extra" }] }, geometry),
    ).toThrow(/no drawing/);
  });
});

describe("layers and selection", () => {
  const sb = DIAGRAMS[0];

  it("shows main parts in main only, feathers-only parts only in feathers, shared parts in both", () => {
    const main = visibleParts(sb, "main").map((p) => p.id);
    const feathers = visibleParts(sb, "feathers").map((p) => p.id);
    expect(main).toContain("wing");
    expect(feathers).not.toContain("wing");
    expect(feathers).toContain("median-coverts");
    expect(main).not.toContain("median-coverts");
    expect(main).toContain("primaries");
    expect(feathers).toContain("primaries");
  });

  it("keeps a selection that is still drawn and clears one that isn't", () => {
    expect(selectionAfterLayerChange(sb, "primaries", "main")).toBe("primaries");
    expect(selectionAfterLayerChange(sb, "median-coverts", "main")).toBeNull();
    expect(selectionAfterLayerChange(sb, "wing", "feathers")).toBeNull();
    expect(selectionAfterLayerChange(sb, null, "feathers")).toBeNull();
  });
});

describe("parseHash", () => {
  it("finds a section or a part", () => {
    expect(parseHash("#gull")).toEqual({ diagram: "gull", part: null });
    expect(parseHash("#gull-mirrors")).toEqual({ diagram: "gull", part: "mirrors" });
    expect(parseHash("#shorebird-wingtip-vs-tail")).toEqual({ diagram: "shorebird", part: "wingtip-vs-tail" });
    expect(parseHash("songbird-median-coverts")).toEqual({ diagram: "songbird", part: "median-coverts" });
  });

  it("ignores unknown, malformed and injection-looking hashes", () => {
    for (const h of ["", "#", "#heron", "#gull-wattle", "#gull-", "#Gull", "#gull mirrors", "#%E0%A4%A", "#gull-mirrors\"><img src=x>", "#songbird-wing-bars;alert(1)"]) {
      expect(parseHash(h), h).toBeNull();
    }
  });
});

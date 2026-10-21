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
import { TERMS } from "./terms";
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

/** The swimming loon and grebe hide their folded wings, so their standing view has one layer (td-a3a17d, td-7adea3). */
const WINGS_HIDDEN = new Set(["loon", "grebe"]);
/** Feather groups a bird's open wing or body really lacks: a hummingbird's wing has no alula, and a grebe has almost no tail. */
const LACKS: Record<string, string[]> = { hummingbird: ["alula"], grebe: ["tail"] };

/** The rings of an absolute M/L/Z path, as point lists. */
function rings(d: string): number[][][] {
  return d.split("M").filter(Boolean).map((r) => (r.replace(/Z/g, "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number))
    .map((n) => n.flatMap((_, i) => (i % 2 ? [] : [[n[i], n[i + 1]]])));
}

/** Even-odd point-in-path, as the drawings are filled. */
function inside(d: string, x: number, y: number): boolean {
  let hit = false;
  for (const ring of rings(d)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/** The share of a grid of points inside path `a` that are also inside path `b` (or any of the paths `b`). */
function coveredShare(a: string, b: string | string[]): number {
  const bs = typeof b === "string" ? [b] : b;
  const pts = rings(a).flat();
  const [x0, y0, x1, y1] = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  let n = 0, both = 0;
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 60; j++) {
    const x = x0 + ((x1 - x0) * i) / 60, y = y0 + ((y1 - y0) * j) / 60;
    if (!inside(a, x, y)) continue;
    n++;
    if (bs.some((d) => inside(d, x, y))) both++;
  }
  return n ? both / n : 1;
}

describe("Parts of a Bird data", () => {
  it("has the fourteen diagrams in order, each standing and in flight from above and below", () => {
    expect(DIAGRAMS.map((d) => d.id)).toEqual([
      "songbird", "shorebird", "duck", "gull", "raptor", "heron", "cormorant", "auk", "tubenose", "woodpecker", "hummingbird", "gamebird", "loon", "grebe",
    ]);
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
        if (!WINGS_HIDDEN.has(d.id)) expect(visibleParts(standing, "feathers").length).toBeGreaterThan(5);
        const addsParts = standing.parts.some((p) => !p.layers.includes("main"));
        expect(hasFeatherLayer(standing)).toBe(addsParts);
        // The swimming duck already shows its wing groups, and the swimming loon and grebe hide theirs; every other bird
        // has a real second layer.
        expect(addsParts).toBe(d.id !== "duck" && !WINGS_HIDDEN.has(d.id));
        // From above the open wing splits into feather groups; from below there's one layer.
        expect(hasFeatherLayer(getView(d, "above"))).toBe(true);
        expect(hasFeatherLayer(getView(d, "below"))).toBe(false);
      });

      it("uses the same ids for the same feathers on the open wing", () => {
        const above = getView(d, "above").parts.map((p) => p.id);
        const below = getView(d, "below").parts.map((p) => p.id);
        const lacks = LACKS[d.id] ?? [];
        for (const id of ["primaries", "primary-coverts", "alula", "greater-coverts", "tertials", "scapulars", "tail"]) {
          if (lacks.includes(id)) expect(above, `above lacks ${id}`).not.toContain(id);
          else expect(above, `above has ${id}`).toContain(id);
        }
        for (const id of ["primaries", "underwing-coverts", "axillaries", "undertail-coverts", "tail"]) {
          if (lacks.includes(id)) expect(below, `below lacks ${id}`).not.toContain(id);
          else expect(below, `below has ${id}`).toContain(id);
        }
        // Parts shared with the standing drawing keep their standing names (fewer where the standing bird hides its wings).
        const standing = new Set(getView(d, "standing").parts.map((p) => p.id));
        expect(above.filter((id) => standing.has(id)).length).toBeGreaterThan(WINGS_HIDDEN.has(d.id) ? 3 : 6);
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

  it("paints the gull's white trailing edge over the inner primaries it runs onto (CODEX1 P2)", () => {
    const g = DIAGRAMS.find((d) => d.id === "gull")!;
    for (const id of ["above", "below"] as const) {
      const v = getView(g, id);
      const order = v.parts.map((p) => p.id);
      expect(order.indexOf("trailing-edge"), id).toBeGreaterThan(order.indexOf("primaries"));
      // The band reaches past the wrist (the arm/hand split is at x≈590 on the right wing).
      const xs = [...v.parts.find((p) => p.id === "trailing-edge")!.d.matchAll(/(-?\d+(?:\.\d+)?),-?\d/g)].map((m) => Number(m[1]));
      expect(Math.max(...xs), id).toBeGreaterThan(640);
    }
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

  it("draws the raptor's flight marks from below and its fingers in both flight views (td-dd4f9c)", () => {
    const r = DIAGRAMS.find((d) => d.id === "raptor")!;
    for (const id of ["patagial-bar", "carpal-patch", "trailing-edge", "underwing-coverts", "axillaries", "belly-band"]) {
      expect(viewsDrawing(r, id).map((v) => v.id), id).toContain("below");
    }
    expect(viewsDrawing(r, "fingers").map((v) => v.id)).toEqual(["above", "below"]);
    for (const id of ["cere", "tarsus", "talons", "wingtip-vs-tail", "belly-band", "subterminal-band", "malar"]) {
      expect(viewsDrawing(r, id).map((v) => v.id), id).toContain("standing");
    }
    // Patagial bar and carpal patch are separate parts, both drawn over the wing linings.
    const below = getView(r, "below").parts.map((p) => p.id);
    expect(below.indexOf("patagial-bar")).toBeGreaterThan(below.indexOf("underwing-coverts"));
    expect(below.indexOf("carpal-patch")).toBeGreaterThan(below.indexOf("underwing-coverts"));
    // Main parts on the perched hawk: the covert rows as one area, and the exposed secondaries
    // below them as their own part, never inside "Wing coverts" (CODEX1 P2).
    const standing = getView(r, "standing");
    expect(standing.parts.find((p) => p.id === "secondaries")!.layers).toEqual(["main", "feathers"]);
    expect(standing.parts.find((p) => p.id === "wing-coverts")!.layers).toEqual(["main"]);
    // The perched hawk is upright: the one drawing taller than wide.
    const [, , w, h] = getView(r, "standing").viewBox.split(" ").map(Number);
    expect(h).toBeGreaterThan(w);
  });

  it("draws the heron's legs in every view and its folded neck in flight (td-46e6e3)", () => {
    const h = DIAGRAMS.find((d) => d.id === "heron")!;
    // A heron's long legs trail past the tail in flight. From above the tibiae are hidden behind the
    // rump and tail, so only the tarsi and toes are drawn there (CODEX1 P2: a tibia 2% visible).
    for (const id of ["tarsus", "toes"]) {
      expect(viewsDrawing(h, id).map((v) => v.id), id).toEqual(["standing", "above", "below"]);
    }
    expect(viewsDrawing(h, "tibia").map((v) => v.id)).toEqual(["standing", "below"]);
    // The streaked foreneck shows on the standing bird and as the bulge under the head in flight.
    expect(viewsDrawing(h, "foreneck").map((v) => v.id)).toEqual(["standing", "below"]);
    for (const id of ["head-plumes", "breast-plumes", "back-plumes", "flank-stripe", "thighs", "lores"]) {
      expect(viewsDrawing(h, id).map((v) => v.id), id).toContain("standing");
    }
    // The perched hawk and the standing heron are the two upright drawings, taller than wide.
    const [, , w, ht] = getView(h, "standing").viewBox.split(" ").map(Number);
    expect(ht).toBeGreaterThan(w);
  });

  it("draws the cormorant's bare throat skin and webbed feet, and its scaly wing (td-af7c6b)", () => {
    const c = DIAGRAMS.find((d) => d.id === "cormorant")!;
    // The orange skin under the bill shows on the perched bird and from below.
    expect(viewsDrawing(c, "gular-skin").map((v) => v.id)).toEqual(["standing", "below"]);
    // The webbed feet grip the perch and show beside the tail from below; from above the tail hides them.
    expect(viewsDrawing(c, "toes").map((v) => v.id)).toEqual(["standing", "below"]);
    for (const v of viewsDrawing(c, "toes")) expect(v.parts.find((p) => p.id === "toes")!.marks?.length, v.id).toBe(1);
    for (const id of ["crests", "lores", "flanks", "wing-coverts"]) {
      expect(viewsDrawing(c, id).map((v) => v.id), id).toContain("standing");
    }
    // The dark feather edges are drawn over the coverts and scapulars, never as tap targets.
    for (const id of ["scapulars", "wing-coverts"]) {
      expect(getView(c, "standing").parts.find((p) => p.id === id)!.marks?.length, id).toBe(1);
    }
    expect(getView(c, "standing").parts.find((p) => p.id === "wing-coverts")!.layers).toEqual(["main"]);
  });

  it("stands the murre upright, with streaked flanks and webbed feet beside the tail in flight (td-5076e6)", () => {
    const a = DIAGRAMS.find((d) => d.id === "auk")!;
    const [, , w, ht] = getView(a, "standing").viewBox.split(" ").map(Number);
    expect(ht).toBeGreaterThan(w);
    // The dark flank streaks and the toes inside each web are marks, never tap targets.
    expect(getView(a, "standing").parts.find((p) => p.id === "flanks")!.marks?.length).toBe(1);
    expect(viewsDrawing(a, "toes").map((v) => v.id)).toEqual(["standing", "below"]);
    for (const v of viewsDrawing(a, "toes")) expect(v.parts.find((p) => p.id === "toes")!.marks?.length, v.id).toBe(1);
    // The throat and face are drawn standing and from below, where the dark neck meets the white breast.
    for (const id of ["throat", "face", "breast"]) expect(viewsDrawing(a, id).map((v) => v.id), id).toEqual(["standing", "below"]);
    expect(getView(a, "standing").parts.find((p) => p.id === "wing-coverts")!.layers).toEqual(["main"]);
  });

  it("draws the shearwater's bill plates on the bird and in the close-up, and its silvery underwing (td-315613)", () => {
    const t = DIAGRAMS.find((d) => d.id === "tubenose")!;
    const standing = getView(t, "standing");
    expect(standing.insets.map((i) => i.label)).toEqual(["Bill, close up"]);
    // Each plate is one part drawn twice: on the swimming bird and, larger, in the close-up.
    for (const id of ["bill", "nostril-tubes", "unguis"]) {
      expect(viewsDrawing(t, id).map((v) => v.id), id).toContain("standing");
      const d = standing.parts.find((p) => p.id === id)!.d;
      expect(d.match(/M/g)!.length, id).toBeGreaterThanOrEqual(2);
    }
    expect(getView(t, "below").parts.find((p) => p.id === "underwing-coverts")!.marks?.length).toBe(1);
    expect(viewsDrawing(t, "rump").map((v) => v.id)).toEqual(["above"]);
  });

  it("draws the woodpecker's foot on the trunk and in the close-up, and its spotted wing (td-71bf41)", () => {
    const w = DIAGRAMS.find((d) => d.id === "woodpecker")!;
    const standing = getView(w, "standing");
    expect(standing.insets.map((i) => i.label)).toEqual(["Foot, close up"]);
    // Two toes forward and two back, on the bird and again, larger, in the close-up.
    expect(standing.parts.find((p) => p.id === "toes")!.d.match(/M/g)!.length).toBeGreaterThanOrEqual(4);
    for (const id of ["nasal-tufts", "nape-patch", "malar", "outer-tail-feathers"]) expect(viewsDrawing(w, id).length, id).toBeGreaterThan(0);
    // The white wing spots and the tail bars are marks, never tap targets.
    expect(standing.parts.find((p) => p.id === "primaries")!.marks?.length).toBe(1);
    expect(standing.parts.find((p) => p.id === "outer-tail-feathers")!.marks?.length).toBe(1);
    expect(viewsDrawing(w, "rump").map((v) => v.id)).toEqual(["above"]);
  });

  it("draws the hummingbird's gorget and the spot behind its eye, on a wing with no alula (td-725e4c)", () => {
    const h = DIAGRAMS.find((d) => d.id === "hummingbird")!;
    expect(getView(h, "standing").parts.find((p) => p.id === "gorget")!.tone).toBe("accent");
    expect(viewsDrawing(h, "post-ocular-spot").map((v) => v.id)).toContain("standing");
    expect(h.glossary.some((p) => p.id === "alula")).toBe(false);
    // Its tiny tertials show only on the open wing (td-2a2f94).
    expect(viewsDrawing(h, "tertials").map((v) => v.id)).toEqual(["above"]);
    expect(viewsDrawing(h, "underwing-coverts").map((v) => v.id)).toEqual(["below"]);
  });

  it("draws the grouse's comb, ruff, crest and banded fan tail (td-71be07)", () => {
    const g = DIAGRAMS.find((d) => d.id === "gamebird")!;
    for (const id of ["comb", "ruff", "crest", "subterminal-band"]) expect(viewsDrawing(g, id).map((v) => v.id), id).toContain("standing");
    // The tail bars are marks over the tail, which stays one tap target.
    expect(getView(g, "standing").parts.find((p) => p.id === "tail")!.marks?.length).toBe(2);
  });

  it("swims the loon low, its wings hidden, with feet trailing past the tail in flight (td-a3a17d)", () => {
    const l = DIAGRAMS.find((d) => d.id === "loon")!;
    const standing = getView(l, "standing");
    expect(hasFeatherLayer(standing)).toBe(false);
    expect(standing.parts.some((p) => p.group === "Wing")).toBe(false);
    expect(viewsDrawing(l, "necklace").map((v) => v.id)).toEqual(["standing"]);
    expect(standing.parts.find((p) => p.id === "back")!.marks?.length).toBe(1);
    expect(viewsDrawing(l, "toes").map((v) => v.id)).toEqual(["above", "below"]);
  });

  it("draws the grebe's ear tufts, and its lobed foot only in the close-up (td-7adea3)", () => {
    const g = DIAGRAMS.find((d) => d.id === "grebe")!;
    const standing = getView(g, "standing");
    expect(standing.insets.map((i) => i.label)).toEqual(["Foot, close up"]);
    expect(viewsDrawing(g, "ear-tufts").map((v) => v.id)).toContain("standing");
    // A grebe has almost no tail; nothing in its glossary is the tail.
    expect(g.glossary.some((p) => p.id === "tail")).toBe(false);
    expect(viewsDrawing(g, "toes").map((v) => v.id)).toEqual(["standing", "above", "below"]);
  });

  it("keeps every wing bar inside the bird's combined wing coverts, which a bar only marks (CODEX1, td-2a2f94)", () => {
    // A bar is the pale or dark tips of a covert row, drawn over the coverts as its own part; cutting it out of the
    // combined area left a stripe of holes. The duck's bars border the speculum: the greater coverts' tips (drawn apart
    // from its combined coverts) and the secondaries' tips.
    for (const d of DIAGRAMS) {
      for (const v of d.views) {
        const bars = v.parts.find((p) => p.id === "wing-bars");
        const coverts = v.parts.find((p) => p.id === "wing-coverts");
        if (!bars || !coverts) continue;
        const under = d.id === "duck" ? v.parts.filter((p) => ["wing-coverts", "greater-coverts", "secondaries", "speculum"].includes(p.id)).map((p) => p.d) : coverts.d;
        expect(coveredShare(bars.d, under), `${d.id}/${v.id}`).toBeGreaterThan(0.97);
      }
    }
  });

  it("gives 'rectrices' the whole tail where a bird's tail stands in for them (CODEX1, td-d32fd3)", () => {
    // The raptor's and grouse's subterminal bands, the woodpecker's outer tail feathers and a drake's curled central
    // feathers are drawn over the tail as their own parts, but the tail path must still cover them.
    const tailFor = TERMS.find((t) => t.part === "rectrices")!.sameAs!;
    for (const [id, part] of Object.entries(tailFor)) {
      const d = DIAGRAMS.find((x) => x.id === id)!;
      for (const v of d.views) {
        const tail = v.parts.find((p) => p.id === part);
        if (!tail) continue;
        for (const p of v.parts.filter((q) => q.group === "Tail" && !["tail", "uppertail-coverts"].includes(q.id))) {
          expect(coveredShare(p.d, tail.d), `${id}/${v.id}/${p.id}`).toBeGreaterThan(0.97);
        }
      }
    }
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
    expect(parseHash("#raptor-patagial-bar")).toEqual({ diagram: "raptor", part: "patagial-bar" });
    expect(parseHash("songbird-median-coverts")).toEqual({ diagram: "songbird", part: "median-coverts" });
  });

  it("ignores unknown, malformed and injection-looking hashes", () => {
    for (const h of ["", "#", "#egret", "#gull-wattle", "#gull-", "#Gull", "#gull mirrors", "#%E0%A4%A", "#gull-mirrors\"><img src=x>", "#songbird-wing-bars;alert(1)", "#gull-above"]) {
      expect(parseHash(h), h).toBeNull();
    }
  });
});

import { VIEWS, type BirdDiagram, type BirdPart, type DiagramGeometry, type DiagramText, type DiagramView, type Layer, type View } from "./types";
import songbirdGeometry from "./geometry/songbird.json";
import songbirdAbove from "./geometry/songbird-above.json";
import songbirdBelow from "./geometry/songbird-below.json";
import shorebirdGeometry from "./geometry/shorebird.json";
import shorebirdAbove from "./geometry/shorebird-above.json";
import shorebirdBelow from "./geometry/shorebird-below.json";
import duckGeometry from "./geometry/duck.json";
import duckAbove from "./geometry/duck-above.json";
import duckBelow from "./geometry/duck-below.json";
import gullGeometry from "./geometry/gull.json";
import gullAbove from "./geometry/gull-above.json";
import gullBelow from "./geometry/gull-below.json";
import raptorGeometry from "./geometry/raptor.json";
import raptorAbove from "./geometry/raptor-above.json";
import raptorBelow from "./geometry/raptor-below.json";
import heronGeometry from "./geometry/heron.json";
import heronAbove from "./geometry/heron-above.json";
import heronBelow from "./geometry/heron-below.json";
import cormorantGeometry from "./geometry/cormorant.json";
import cormorantAbove from "./geometry/cormorant-above.json";
import cormorantBelow from "./geometry/cormorant-below.json";
import { songbird } from "./songbird";
import { shorebird } from "./shorebird";
import { duck } from "./duck";
import { gull } from "./gull";
import { raptor } from "./raptor";
import { heron } from "./heron";
import { cormorant } from "./cormorant";

export type ViewGeometries = Record<View, DiagramGeometry>;

/**
 * Joins a bird's text to its generated drawings, in draw order. Throws on any mismatch: every
 * drawn part needs text, and every part in the text must be drawn in at least one view.
 */
export function joinDiagram(text: DiagramText, geometries: ViewGeometries): BirdDiagram {
  const texts = new Map(text.parts.map((p) => [p.id, p]));
  const drawn = new Set<string>();
  const views: DiagramView[] = VIEWS.map(({ id, label }) => {
    const geometry = geometries[id];
    const expected = id === "standing" ? text.id : `${text.id}-${id}`;
    if (geometry.id !== expected) throw new Error(`bird-parts: ${expected} drawing is ${geometry.id}`);
    if (geometry.viewBox.length !== 4) throw new Error(`bird-parts: ${expected} viewBox`);
    const shapes = new Map(geometry.parts.map((p) => [p.id, p]));
    for (const pid of shapes.keys()) {
      if (!texts.has(pid)) throw new Error(`bird-parts: ${expected}/${pid} has no text`);
      drawn.add(pid);
    }
    const parts: BirdPart[] = geometry.drawOrder.map((pid) => ({ ...texts.get(pid)!, ...shapes.get(pid)! }));
    return {
      id,
      label,
      viewBox: geometry.viewBox.join(" "),
      wingViewBox: geometry.wingViewBox ? geometry.wingViewBox.join(" ") : null,
      parts,
      under: geometry.under,
      over: geometry.over,
      outline: geometry.outline,
      insets: geometry.insets,
    };
  });
  for (const pid of texts.keys()) if (!drawn.has(pid)) throw new Error(`bird-parts: ${text.id}/${pid} has no drawing`);
  const { parts, ...rest } = text;
  return { ...rest, glossary: parts, views };
}

const g = (x: unknown) => x as DiagramGeometry;

export const DIAGRAMS: BirdDiagram[] = [
  joinDiagram(songbird, { standing: g(songbirdGeometry), above: g(songbirdAbove), below: g(songbirdBelow) }),
  joinDiagram(shorebird, { standing: g(shorebirdGeometry), above: g(shorebirdAbove), below: g(shorebirdBelow) }),
  joinDiagram(duck, { standing: g(duckGeometry), above: g(duckAbove), below: g(duckBelow) }),
  joinDiagram(gull, { standing: g(gullGeometry), above: g(gullAbove), below: g(gullBelow) }),
  joinDiagram(raptor, { standing: g(raptorGeometry), above: g(raptorAbove), below: g(raptorBelow) }),
  joinDiagram(heron, { standing: g(heronGeometry), above: g(heronAbove), below: g(heronBelow) }),
  joinDiagram(cormorant, { standing: g(cormorantGeometry), above: g(cormorantAbove), below: g(cormorantBelow) }),
];

export function getView(diagram: BirdDiagram, view: View): DiagramView {
  return diagram.views.find((v) => v.id === view)!;
}

export function visibleParts(view: DiagramView, layer: Layer): BirdPart[] {
  return view.parts.filter((p) => p.layers.includes(layer));
}

/** False when every part is already in the main view (the swimming duck): no layer switch. */
export function hasFeatherLayer(view: DiagramView): boolean {
  return view.parts.some((p) => !p.layers.includes("main"));
}

/** The selection after a layer change: kept if the part is still drawn, else cleared. */
export function selectionAfterLayerChange(view: DiagramView, selected: string | null, layer: Layer): string | null {
  if (selected == null) return null;
  return view.parts.some((p) => p.id === selected && p.layers.includes(layer)) ? selected : null;
}

/**
 * Where a part should be shown: the current view and layer if it's drawn there; otherwise a layer
 * of the current view that draws it; otherwise the first view (standing, above, below) that does.
 * A selection is never dropped on a view change: the caption says where else it's drawn.
 */
export function placePart(diagram: BirdDiagram, part: string, view: View, layer: Layer): { view: View; layer: Layer } {
  const inView = (v: DiagramView) => v.parts.find((p) => p.id === part);
  const here = inView(getView(diagram, view));
  if (here) return { view, layer: here.layers.includes(layer) ? layer : here.layers[0] };
  for (const v of diagram.views) {
    const p = inView(v);
    if (p) return { view: v.id, layer: p.layers.includes(layer) ? layer : p.layers[0] };
  }
  return { view, layer };
}

/** The layer to show after a view change, so a selected part that the new view draws stays visible. */
export function layerAfterViewChange(diagram: BirdDiagram, selected: string | null, view: View, layer: Layer): Layer {
  const v = getView(diagram, view);
  if (!hasFeatherLayer(v)) return "main";
  const p = selected == null ? null : v.parts.find((q) => q.id === selected);
  return p && !p.layers.includes(layer) ? p.layers[0] : layer;
}

/** The views (labels) that draw a part, for the caption when the current view doesn't. */
export function viewsDrawing(diagram: BirdDiagram, part: string): DiagramView[] {
  return diagram.views.filter((v) => v.parts.some((p) => p.id === part));
}

export interface HashTarget {
  diagram: string;
  part: string | null;
}

/**
 * Parses "#gull" or "#gull-mirrors" against the data (never as a DOM selector).
 * Anything unknown or malformed returns null.
 */
export function parseHash(hash: string, diagrams: BirdDiagram[] = DIAGRAMS): HashTarget | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^[a-z]+(-[a-z]+)*$/.test(value)) return null;
  for (const d of diagrams) {
    if (value === d.id) return { diagram: d.id, part: null };
    if (value.startsWith(`${d.id}-`)) {
      const part = value.slice(d.id.length + 1);
      return d.glossary.some((p) => p.id === part) ? { diagram: d.id, part } : null;
    }
  }
  return null;
}

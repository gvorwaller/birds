import type { BirdDiagram, BirdPart, DiagramGeometry, DiagramText, Layer } from "./types";
import songbirdGeometry from "./geometry/songbird.json";
import shorebirdGeometry from "./geometry/shorebird.json";
import duckGeometry from "./geometry/duck.json";
import gullGeometry from "./geometry/gull.json";
import { songbird } from "./songbird";
import { shorebird } from "./shorebird";
import { duck } from "./duck";
import { gull } from "./gull";

/** Joins a bird's text to its generated geometry, in draw order. Throws on any mismatch. */
export function joinDiagram(text: DiagramText, geometry: DiagramGeometry): BirdDiagram {
  if (text.id !== geometry.id) throw new Error(`bird-parts: ${text.id} text vs ${geometry.id} geometry`);
  if (geometry.viewBox.length !== 4) throw new Error(`bird-parts: ${text.id} viewBox`);
  const texts = new Map(text.parts.map((p) => [p.id, p]));
  const shapes = new Map(geometry.parts.map((p) => [p.id, p]));
  for (const id of texts.keys()) if (!shapes.has(id)) throw new Error(`bird-parts: ${text.id}/${id} has no drawing`);
  for (const id of shapes.keys()) if (!texts.has(id)) throw new Error(`bird-parts: ${text.id}/${id} has no text`);
  const parts: BirdPart[] = geometry.drawOrder.map((id) => ({ ...texts.get(id)!, ...shapes.get(id)! }));
  const { parts: _texts, ...rest } = text;
  return {
    ...rest,
    viewBox: geometry.viewBox.join(" "),
    parts,
    listOrder: text.parts.map((p) => p.id),
    under: geometry.under,
    over: geometry.over,
    outline: geometry.outline,
    insets: geometry.insets,
  };
}

export const DIAGRAMS: BirdDiagram[] = [
  joinDiagram(songbird, songbirdGeometry as DiagramGeometry),
  joinDiagram(shorebird, shorebirdGeometry as DiagramGeometry),
  joinDiagram(duck, duckGeometry as DiagramGeometry),
  joinDiagram(gull, gullGeometry as DiagramGeometry),
];

export function visibleParts(diagram: BirdDiagram, layer: Layer): BirdPart[] {
  return diagram.parts.filter((p) => p.layers.includes(layer));
}

/** False when every part is already in the main view (the swimming duck): no layer switch. */
export function hasFeatherLayer(diagram: BirdDiagram): boolean {
  return diagram.parts.some((p) => !p.layers.includes("main"));
}

/** The selection after a layer change: kept if the part is still drawn, else cleared. */
export function selectionAfterLayerChange(diagram: BirdDiagram, selected: string | null, layer: Layer): string | null {
  if (selected == null) return null;
  return diagram.parts.some((p) => p.id === selected && p.layers.includes(layer)) ? selected : null;
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
      return d.parts.some((p) => p.id === part) ? { diagram: d.id, part } : null;
    }
  }
  return null;
}

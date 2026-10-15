"""Write one diagram's geometry to src/lib/bird-parts/geometry/{name}.json.

The app reads these files as-is; names and ID text live in src/lib/bird-parts/{name}.ts.
"""
import json, sys
from pathlib import Path
from shapely import affinity
from geom import to_d

OUT = Path(__file__).resolve().parents[2] / "src" / "lib" / "bird-parts" / "geometry"


def build(name, final, meta, order, viewBox, dx, dy, base_under=(), base_over=(), outline=None, flip_x=None,
          raw=(), raw_base=(), insets=()):
    """final: part id -> shapely geometry in tracing (photo) coordinates.
    meta: (id, tone, layers) where layers is "m", "f" or "mf".
    flip_x: mirror about this x before translating, so every bird faces right.
    raw / raw_base: parts and base shapes already in output coordinates (the gull's inset)."""
    def T(g):
        if flip_x is not None: g = affinity.scale(g, xfact=-1, yfact=1, origin=(flip_x, 0))
        return g
    parts = []
    for pid, tone, ly in meta:
        g = final[pid]
        if g.is_empty: sys.exit(f"{name}: empty part {pid}")
        g, ox, oy = (g, 0, 0) if pid in raw else (T(g), dx, dy)
        parts.append({"id": pid, "tone": tone,
                      "layers": [x for x, c in (("main", "m"), ("feathers", "f")) if c in ly],
                      "d": to_d(g, ox, oy)})
    ids = {p["id"] for p in parts}
    assert set(order) == ids and len(order) == len(ids), set(order) ^ ids
    d = {"id": name, "viewBox": viewBox, "drawOrder": order, "parts": parts,
         "under": [{"d": to_d(g, 0, 0), "tone": t} for g, t in raw_base]
                  + [{"d": to_d(T(g), dx, dy), "tone": t} for g, t in base_under],
         "over": [{"d": to_d(T(g), dx, dy), "tone": t} for g, t in base_over],
         "outline": to_d(T(outline), dx, dy) if outline is not None else None,
         "insets": list(insets)}
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.json"
    path.write_text(json.dumps(d, indent=1) + "\n")
    print(f"wrote {path.relative_to(OUT.parents[3])} ({len(parts)} parts)")

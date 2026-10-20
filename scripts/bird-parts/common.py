"""Write one diagram's geometry to src/lib/bird-parts/geometry/{name}.json.

The app reads these files as-is; names and ID text live in src/lib/bird-parts/{name}.ts.
"""
import json, re, sys
from pathlib import Path
from shapely import affinity
from shapely.geometry import Polygon
from shapely.ops import unary_union
from geom import to_d

# A part must show at least this share of its own area in every layer that lists it; otherwise
# it is a tap target hidden under other parts, and selecting it outlines a different part
# (CODEX1, td-46e6e3: the heron's tibia behind the tail from above showed 2%).
MIN_VISIBLE = 0.25


def _shape(d):
    """A path from to_d (absolute M/L/Z rings, even-odd fill) back to a polygon."""
    out = Polygon()
    for ring in re.findall(r"M([^Z]+)Z", d):
        pts = [tuple(map(float, xy.split(","))) for xy in ring.replace("L", " ").split()]
        if len(pts) >= 3: out = out.symmetric_difference(Polygon(pts).buffer(0))
    return out


def check_visible(name, parts, order):
    rank = {pid: i for i, pid in enumerate(order)}
    for layer in ("main", "feathers"):
        shown = sorted((p for p in parts if layer in p["layers"]), key=lambda p: rank[p["id"]])
        shapes = [_shape(p["d"]) for p in shown]
        for i, p in enumerate(shown):
            area = shapes[i].area
            if area <= 0: continue
            share = shapes[i].difference(unary_union(shapes[i + 1:])).area / area if i + 1 < len(shapes) else 1.0
            if share < MIN_VISIBLE:
                sys.exit(f"{name}: {p['id']} is only {share:.0%} visible in the {layer} layer")

# An eye painted over the bird must sit inside its outline. Base shapes are not tap targets, so
# check_visible never sees them (CODEX1, td-af7c6b: the perched cormorant's eye stuck out of its forehead).
MAX_EYE_OUTSIDE = 0.02


def check_eyes(name, base_over, outline):
    if outline is None: return
    for g, tone in base_over:
        if tone != "eye" or g.area <= 0: continue
        out = g.difference(outline).area / g.area
        if out > MAX_EYE_OUTSIDE:
            sys.exit(f"{name}: an eye is {out:.0%} outside the outline")

OUT = Path(__file__).resolve().parents[2] / "src" / "lib" / "bird-parts" / "geometry"


def build(name, final, meta, order, viewBox, dx, dy, base_under=(), base_over=(), outline=None, flip_x=None,
          raw=(), raw_base=(), insets=(), extra_raw=None, marks=None, wing_view_box=None):
    """final: part id -> shapely geometry in tracing (photo) coordinates.
    meta: (id, tone, layers) where layers is "m", "f" or "mf".
    flip_x: mirror about this x before translating, so every bird faces right.
    raw / raw_base: parts and base shapes already in output coordinates (the gull's inset).
    extra_raw: part id -> geometry in output coordinates added to a traced part, so one part can
    be drawn in two places (the gull's wingtip on the bird and in the open-wingtip inset).
    marks: part id -> [(geometry, tone)] in tracing coordinates, drawn over the part in another
    tone (the black tip of a gull's primaries); the part's own path stays the tap target.
    wing_view_box: flight views only, the body and right wing for the "One wing, larger" size."""
    def T(g):
        if flip_x is not None: g = affinity.scale(g, xfact=-1, yfact=1, origin=(flip_x, 0))
        return g
    parts = []
    for pid, tone, ly in meta:
        g = final[pid]
        if g.is_empty: sys.exit(f"{name}: empty part {pid}")
        g, ox, oy = (g, 0, 0) if pid in raw else (T(g), dx, dy)
        if extra_raw and pid in extra_raw:
            g, ox, oy = affinity.translate(g, -ox, -oy).union(extra_raw[pid]), 0, 0
        parts.append({"id": pid, "tone": tone,
                      "layers": [x for x, c in (("main", "m"), ("feathers", "f")) if c in ly],
                      "d": to_d(g, ox, oy)})
        if marks and pid in marks:
            parts[-1]["marks"] = [{"d": to_d(T(m.intersection(final[pid])), dx, dy), "tone": t}
                                  for m, t in marks[pid]]
    ids = {p["id"] for p in parts}
    assert set(order) == ids and len(order) == len(ids), set(order) ^ ids
    check_visible(name, parts, order)
    check_eyes(name, base_over, outline)
    d = {"id": name, "viewBox": viewBox, "drawOrder": order, "parts": parts,
         "under": [{"d": to_d(g, 0, 0), "tone": t} for g, t in raw_base]
                  + [{"d": to_d(T(g), dx, dy), "tone": t} for g, t in base_under],
         "over": [{"d": to_d(T(g), dx, dy), "tone": t} for g, t in base_over],
         "outline": to_d(T(outline), dx, dy) if outline is not None else None,
         "insets": list(insets)}
    if wing_view_box: d["wingViewBox"] = wing_view_box
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.json"
    path.write_text(json.dumps(d, indent=1) + "\n")
    print(f"wrote {path.relative_to(OUT.parents[3])} ({len(parts)} parts)")

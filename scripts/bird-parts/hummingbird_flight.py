"""Adult male Ruby-throated Hummingbird in flight, from above and from below (td-725e4c).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A hummingbird's wing is
nearly all hand: a short arm with short secondaries, and long primaries out to a pointed tip. The
male's tail is forked; from below, the red gorget shows on the throat above the white collar.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M412,214 C432,210 452,208 472,206", "M418,292 C436,292 454,290 472,288"),
         ("M472,206 C560,200 660,200 744,216", "M472,288 C560,282 660,258 744,216"),
         rows=(0.42, 0.62, 0.78), tips=10, tip_amp=0.02, tertials=(0.10, 0.50), pc=(0.26, 0.50, 1.2), alula=(0.10, 0.84))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 150).buffer(1), 30, 34)
BODY = mirror(poly("M380,150 L408,166 C426,196 432,240 432,282 C432,330 420,380 404,418 L380,424 Z")).union(HEAD)
BILL = mirror(poly("M380,12 Q381,14 382,30 L385,124 L380,124 Z"))
# the male's forked tail
TAIL = mirror(poly("M380,404 L404,404 C412,440 418,490 422,532 Q400,520 380,498 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 21, 140).buffer(3.2))
VB = [0, 0, 760, 550]


def merged(t):
    """A hummingbird's wing has no alula (Wikipedia, Hummingbird), and this drawing shows no separate
    tertials: fold those bands into the primary coverts and the secondaries."""
    t = dict(t)
    t["secondaries"] = t["secondaries"].union(t.pop("tertials"))
    if "alula" in t: t["primary-coverts"] = t["primary-coverts"].union(t.pop("alula"))
    return t


def one_piece(final, ids):
    """Each head and body part is one piece on each side of the midline (the tubenose and auk gate),
    after dropping zero-area specks; a stray piece would be selected with the part far from it."""
    for k in ids:
        g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
        right = g.intersection(box(CX, -999, 9999, 9999))
        n = len(getattr(right, "geoms", [right])) if not right.is_empty else 0
        if n != 1: raise SystemExit(f"hummingbird flight: {k} is in {n} pieces on the right side")
        final[k] = g


# ---------- from above ----------
def above():
    raw = W.upper()
    up = merged(raw)
    crown = HEAD.intersection(box(0, 0, 999, 152))
    nape = BODY.intersection(box(0, 152, 999, 214)).difference(crown)
    back = BODY.intersection(box(0, 214, 999, 360))
    rump = BODY.intersection(box(0, 360, 999, 394))
    # the uppertail coverts lie over the base of the tail, below the rump (td-93f86b)
    utc = BODY.union(TAIL).intersection(box(0, 394, 999, 446))
    tail = TAIL.difference(rump).difference(utc)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape, "back": back, "rump": rump, "uppertail-coverts": utc, "tail": tail, "bill": BILL})
    one_piece(final, ("crown", "nape", "back", "rump", "uppertail-coverts", "tail"))
    for k in ("lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts")])
    meta = [("tail", "darker", "mf"), ("rump", "mallardgreen", "mf"), ("uppertail-coverts", "mallardgreen", "mf"),
            ("secondaries", "dark", "mf"), ("primaries", "dark", "mf"),
            ("wing-coverts", "mallardgreen", "m"), ("lesser-coverts", "mallardgreen", "f"), ("median-coverts", "mallardgreen", "f"),
            ("greater-coverts", "mallardgreen", "f"), ("primary-coverts", "mallardgreen", "f"),
            ("back", "mallardgreen", "mf"), ("nape", "mallardgreen", "mf"), ("crown", "mallardgreen", "mf"), ("bill", "eye", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(n_sec=6, n_prim=10).difference(W.pc_shape()).difference(raw["alula"]))
    build("hummingbird-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "darker"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.46, ax=(0.60, 0.12, 0.60))
    face = HEAD.intersection(box(0, 0, 999, 136))
    gorget = HEAD.union(BODY.intersection(box(0, 0, 999, 214))).difference(face)
    body = BODY.difference(HEAD).difference(gorget)
    breast = body.intersection(mirror(poly("M380,0 L440,0 L440,252 Q410,262 380,264 Z")))
    utc = mirror(poly("M380,370 L414,370 C410,390 406,406 402,418 Q392,426 380,426 Z")).intersection(BODY)
    # the belly is the centre of the underside; the flanks take both sides all the way down beside the
    # undertail coverts, so no corner of the body is left over (CODEX1: belly had stray pieces there)
    belly = body.intersection(mirror(poly("M380,240 L410,240 C414,290 414,340 410,370 L380,370 Z"))).difference(breast).difference(utc)
    flanks = body.difference(breast).difference(utc).difference(belly)
    # the body (undertail coverts and flanks) lies over the base of the tail
    tail = TAIL.difference(BODY)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"face": face, "gorget": gorget, "breast": breast, "flanks": flanks, "belly": belly,
                  "undertail-coverts": utc, "tail": tail, "bill": BILL})
    one_piece(final, ("face", "gorget", "breast", "flanks", "belly", "undertail-coverts", "tail"))
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "darker", "m"), ("secondaries", "dark", "m"), ("primaries", "dark", "m"),
            ("underwing-coverts", "darker", "m"), ("axillaries", "darker", "m"),
            ("belly", "light", "m"), ("flanks", "mallardgreen", "m"), ("undertail-coverts", "pale", "m"), ("breast", "pale", "m"),
            ("gorget", "accent", "m"), ("face", "darker", "m"), ("bill", "eye", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(n_sec=6, n_prim=10, sec_to=0.46).difference(un["underwing-coverts"]))
    build("hummingbird-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "darker"), (EYES, "eye")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

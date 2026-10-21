"""Adult male Ruffed Grouse in flight, from above and from below (td-71be07).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A grouse flies on
short, broad, rounded wings with its tail spread into a fan; the wingspan is only a little more
than the bird's length (Wikipedia: 40-50 cm long, 50-64 cm across the wings). The wing shape
follows a ptarmigan photographed from above (listed in src/lib/bird-parts/gamebird.ts); the tail's
dark band and pale tip follow the standing reference.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box, LineString
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M424,152 C466,140 512,134 556,136", "M424,262 C466,268 512,270 556,268"),
         ("M556,136 C610,138 662,154 698,190", "M556,268 C612,274 668,262 700,230"),
         rows=(0.42, 0.60, 0.74), tips=10, tip_amp=0.04, tertials=(0.22, 0.58), pc=(0.42, 0.50, 1.0))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 74).buffer(1), 27, 33)
NECK = mirror(poly("M380,90 L404,90 C410,108 416,124 420,140 L380,140 Z"))
BODY = mirror(poly("M380,120 L420,132 C434,170 438,220 434,270 C430,300 422,322 410,338 L380,344 Z")).union(NECK).union(HEAD)
BILL = mirror(poly("M380,26 Q383,30 387,44 L380,46 Z"))
# the tail spread into a fan, with the dark band near its rounded tip
TAIL = mirror(poly("M380,322 L414,322 C440,370 462,420 474,468 Q440,500 380,506 Z"))
FAN_EDGE = LineString(pts("M380,506 Q440,500 474,468"))
EDGE_OUT = mirror(FAN_EDGE.buffer(9, cap_style=2))          # the pale tip
EDGE_IN = mirror(FAN_EDGE.buffer(34, cap_style=2))          # inner edge of the band
BAND = TAIL.intersection(EDGE_IN).difference(EDGE_OUT)
TIP = TAIL.intersection(EDGE_OUT)
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 15, 66).buffer(3))
VB = [0, 0, 760, 520]
# the bars across the fan (never tap targets)
TAIL_BARS = mirror(unary_union([affinity.scale(FAN_EDGE, f, f, origin=(380, 330)).buffer(1.6) for f in (0.86, 0.74, 0.62, 0.5)]))


# ---------- from above ----------
def above():
    up = W.upper()
    crest = HEAD.intersection(box(0, 0, 999, 78))
    nape = HEAD.difference(crest).union(NECK.difference(HEAD))
    scap = mirror(poly("M398,142 C414,156 426,182 428,212 C430,238 424,258 414,272 L402,268 C402,230 400,186 398,142 Z"))
    back = BODY.intersection(box(0, 120, 999, 280)).difference(HEAD).difference(nape).difference(scap)
    rump = BODY.intersection(box(0, 280, 999, 318)).difference(back).difference(scap)
    # the uppertail coverts lie over the base of the fan, below the rump (td-93f86b)
    utc = BODY.union(TAIL).intersection(box(0, 318, 999, 372)).difference(back).difference(scap)
    tail = TAIL.difference(rump).difference(utc)   # the band is drawn over the whole tail (td-d32fd3)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crest": crest, "nape": nape, "back": back, "scapulars": scap, "rump": rump, "uppertail-coverts": utc,
                  "tail": tail, "subterminal-band": BAND.difference(rump), "bill": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY).difference(scap)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tail", "chestnut", "mf"), ("subterminal-band", "eye", "mf"), ("rump", "dark", "mf"), ("uppertail-coverts", "dark", "mf"),
            ("secondaries", "darker", "mf"), ("primaries", "dark", "mf"),
            ("wing-coverts", "dark", "m"), ("lesser-coverts", "dark", "f"), ("median-coverts", "dark", "f"),
            ("greater-coverts", "dark", "f"), ("primary-coverts", "dark", "f"), ("alula", "dark", "f"),
            ("tertials", "wing", "mf"), ("back", "dark", "mf"), ("scapulars", "dark", "mf"),
            ("nape", "dark", "mf"), ("crest", "dark", "mf"), ("bill", "eye", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(n_prim=10).difference(W.pc_shape()).difference(up["alula"]))
    dots = mirror(unary_union([Point(x, y).buffer(2.6) for x, y in ((386, 292), (398, 300), (410, 290), (390, 314), (404, 322), (416, 308), (396, 336))]))
    build("gamebird-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"tail": [(TAIL_BARS, "eye"), (TIP, "pale")], "rump": [(dots, "pale")]},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.44, ax=(0.24, 0.10, 0.60))
    face = HEAD.intersection(box(0, 0, 999, 70))
    throat = HEAD.union(NECK).difference(face).union(BODY.intersection(box(0, 0, 999, 128)).difference(face))
    body = BODY.difference(HEAD).difference(throat)
    breast = body.intersection(mirror(poly("M380,0 L440,0 L440,214 Q412,226 380,228 Z")))
    flanks = body.difference(breast).intersection(mirror(poly("M414,214 L444,214 L444,320 L408,320 C416,290 418,250 414,214 Z")))
    utc = mirror(poly("M380,300 L410,300 C408,316 404,330 398,340 Q390,346 380,346 Z"))
    belly = body.difference(breast).difference(utc).difference(flanks)
    tail = TAIL.difference(utc)   # the band is drawn over the whole tail (td-d32fd3)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"face": face, "throat": throat, "breast": breast, "flanks": flanks, "belly": belly,
                  "undertail-coverts": utc, "tail": tail, "subterminal-band": BAND.difference(utc), "bill": BILL})
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "chestnut", "m"), ("subterminal-band", "eye", "m"), ("secondaries", "mid", "m"), ("primaries", "mid", "m"),
            ("underwing-coverts", "light", "m"), ("axillaries", "light", "m"),
            ("belly", "light", "m"), ("flanks", "light", "m"), ("undertail-coverts", "light", "m"), ("breast", "mid", "m"),
            ("throat", "light", "m"), ("face", "mid", "m"), ("bill", "eye", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(n_prim=10, sec_to=0.44).difference(un["underwing-coverts"]))
    flank_bars = mirror(unary_union([stroke(f"M{x},{y} L{x + 20},{y + 6}", 6) for x, y in ((410, 226), (412, 252), (412, 278), (408, 302))]))
    build("gamebird-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"tail": [(TAIL_BARS, "eye"), (TIP, "pale")], "flanks": [(flank_bars, "darker")]},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

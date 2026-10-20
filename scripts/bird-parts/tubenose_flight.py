"""Adult Sooty Shearwater in flight, from above and from below (td-315613).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A shearwater glides
on long, narrow, stiff wings; the body is slim, the bill thin, and the tail short. From below,
a Sooty Shearwater is dark with a silvery stripe along the centre of the underwing.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M410,150 C460,146 510,146 556,150", "M410,212 C460,212 510,208 556,202"),
         ("M556,150 C612,158 664,178 708,206", "M556,202 C612,200 662,202 704,208"),
         rows=(0.40, 0.60, 0.74), tips=10, tip_amp=0.02, tertials=(0.12, 0.56), pc=(0.42, 0.50, 1.0))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 58).buffer(1), 17, 23)
BODY = mirror(poly("M380,72 L396,78 C406,108 412,146 413,186 C413,226 405,258 395,280 L380,284 Z")).union(HEAD)
BILL = mirror(poly("M380,4 Q382,6 383,18 L385,38 L380,38 Z"))
TAIL = mirror(poly("M380,272 L398,272 L403,308 Q393,320 380,322 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 10, 50).buffer(2.3))
VB = [0, 0, 760, 340]


# ---------- from above ----------
def above():
    up = W.upper()
    crown = HEAD.intersection(box(0, 0, 999, 56))
    nape = BODY.intersection(box(0, 56, 999, 120)).difference(crown)
    scap = mirror(poly("M394,128 C406,140 414,164 415,190 C416,212 411,230 404,242 L397,240 C397,206 397,164 394,128 Z"))
    back = BODY.intersection(box(0, 120, 999, 236)).difference(scap)
    rump = BODY.intersection(box(0, 236, 999, 290)).difference(back).difference(scap)
    tail = TAIL.difference(rump)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape, "back": back, "scapulars": scap, "rump": rump, "tail": tail, "bill": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY).difference(scap)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tail", "eye", "mf"), ("rump", "darker", "mf"),
            ("secondaries", "eye", "mf"), ("primaries", "eye", "mf"),
            ("wing-coverts", "darker", "m"), ("lesser-coverts", "darker", "f"), ("median-coverts", "darker", "f"),
            ("greater-coverts", "darker", "f"), ("primary-coverts", "darker", "f"), ("alula", "darker", "f"),
            ("tertials", "darker", "mf"), ("back", "darker", "mf"), ("scapulars", "darker", "mf"),
            ("nape", "darker", "mf"), ("crown", "darker", "mf"), ("bill", "linegray", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines().difference(W.pc_shape()).difference(up["alula"]))
    build("tubenose-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.42, ax=(0.24, 0.10, 0.58))
    face = HEAD.intersection(box(0, 0, 999, 56))
    throat = BODY.intersection(box(0, 56, 999, 110)).difference(face)
    body = BODY.difference(HEAD).difference(throat)
    breast = body.intersection(mirror(poly("M380,0 L440,0 L440,176 Q410,184 380,186 Z")))
    utc = mirror(poly("M380,248 L404,248 C402,262 398,274 392,282 Q386,286 380,286 Z"))
    belly = body.difference(breast).difference(utc)
    tail = TAIL.difference(utc)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"face": face, "throat": throat, "breast": breast, "belly": belly,
                  "undertail-coverts": utc, "tail": tail, "bill": BILL})
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    # the dark leading edge in front of the silvery stripe (never a tap target)
    edge = mirror(unary_union([W.arm.band(0, 1, 0.86, 1.0), W.hand.band(0, 0.44, 0.86, 1.0)]))
    meta = [("tail", "darker", "m"), ("secondaries", "linegray", "m"), ("primaries", "linegray", "m"),
            ("underwing-coverts", "gullpale", "m"), ("axillaries", "darker", "m"),
            ("belly", "darker", "m"), ("undertail-coverts", "darker", "m"), ("breast", "darker", "m"),
            ("throat", "dark", "m"), ("face", "darker", "m"), ("bill", "linegray", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(sec_to=0.42).difference(un["underwing-coverts"]))
    build("tubenose-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"underwing-coverts": [(edge, "darker")]},
          base_over=[(lines, "pale"), (EYES, "eye")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

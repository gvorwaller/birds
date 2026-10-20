"""Adult male Mallard in flight, from above and from below (td-a1bfd9).

Right half drawn in output coordinates, then mirrored (see flight.py). Long neck stretched
forward, pointed wings set at mid-body. From above, the speculum (the coloured patch on the
secondaries) is bordered white in front (greater covert tips) and behind (secondary tips).
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M420,176 C460,162 504,152 540,150", "M424,262 C470,268 514,268 552,264"),
         ("M540,150 C600,150 664,182 702,236", "M552,264 C612,264 666,254 702,236"),
         rows=(0.36, 0.54, 0.68), tips=10, tip_amp=0.012, tertials=(0.18, 0.56), pc=(0.42, 0.50, 1.15))
ARM, HAND = W.arm, W.hand
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 64).buffer(1), 19, 23)
NECK = mirror(poly("M380,74 L396,74 C398,96 400,116 406,134 L380,138 Z"))
BODY = mirror(poly("M380,124 L404,124 C418,146 428,180 430,214 C432,258 422,300 404,332 L380,336 Z"))
BILL = mirror(poly("M380,6 Q392,6 395,16 L392,48 L380,48 Z"))
NAIL = mirror(poly("M380,4 Q386,4 388,9 L386,13 L380,13 Z"))
TAIL = mirror(poly("M380,318 L402,318 L414,392 Q398,404 380,406 Z"))
COLLAR = NECK.intersection(box(0, 118, 999, 124))
SIL = BODY.union(TAIL).union(WING).union(NECK).union(HEAD)
EYES = mirror(Point(CX + 15.5, 58).buffer(2.4))
VB = [40, 0, 680, 420]


def above():
    up = W.upper()
    r0 = W.rows[0]
    gc = up["greater-coverts"]
    gc_white = ARM.band(0, 1, r0 + 0.035, r0 + 0.10).intersection(gc)
    gc_black = ARM.band(0, 1, r0 - 0.03, r0 + 0.035).intersection(gc)
    spec = up["secondaries"]
    spec_white = ARM.band(0, 1, -0.01, 0.07).intersection(spec)
    spec_black = ARM.band(0, 1, 0.07, 0.11).intersection(spec)
    crown = HEAD.intersection(mirror(poly("M380,40 L392,40 L394,70 Q388,76 380,78 Z")))
    cheek = HEAD.difference(crown).intersection(box(0, 0, 999, 72))
    nape = HEAD.difference(crown).difference(cheek)
    neck = NECK.difference(HEAD)
    scap = poly("M394,140 C412,156 428,184 432,214 C434,240 428,258 418,272 L398,272 C398,226 398,180 394,140 Z")
    back = BODY.intersection(box(0, 130, 999, 272)).difference(mirror(scap))
    rump = BODY.intersection(box(0, 272, 999, 330))
    # two black central feathers curled up over the rump
    curl = mirror(Point(388, 330).buffer(6.5).difference(Point(386.5, 331.5).buffer(3.6))
                  .union(poly("M380,316 L386,316 L388,324 L382,324 Z")))
    tail = TAIL.difference(rump).union(curl)   # the curled central feathers are rectrices too (td-d32fd3)
    R = mirror
    final = {k: R(v) for k, v in up.items() if k != "secondaries"}
    final.update({"speculum": R(spec), "crown": crown, "cheek": cheek, "nape": nape, "neck": neck,
                  "scapulars": R(scap), "back": back, "rump": rump, "drake-curl": curl, "tail": tail,
                  "bill": BILL.difference(NAIL), "nail": NAIL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts"):
        final[k] = final[k].difference(final["scapulars"])
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "primary-coverts", "alula")])
    meta = [("tail", "pale", "mf"), ("rump", "darker", "mf"), ("drake-curl", "darker", "mf"),
            ("speculum", "accent2", "mf"), ("primaries", "dark", "mf"),
            ("wing-coverts", "mid", "m"), ("lesser-coverts", "mid", "f"), ("median-coverts", "mid", "f"),
            ("primary-coverts", "mid", "f"), ("alula", "mid", "f"), ("greater-coverts", "mid", "mf"),
            ("tertials", "wing", "mf"), ("back", "mid", "mf"), ("scapulars", "light", "mf"),
            ("neck", "mallardgreen", "mf"), ("nape", "mallardgreen", "mf"), ("cheek", "mallardgreen", "mf"),
            ("crown", "mallardgreen", "mf"), ("bill", "billyellow", "mf"), ("nail", "darker", "mf")]
    lines = R(W.lines(n_sec=11, n_prim=10, sec_to=r0).difference(W.pc_shape()).difference(up["alula"]))
    build("duck-above", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"greater-coverts": [(R(gc_white), "pale"), (R(gc_black), "darker")],
                 "speculum": [(R(spec_white), "pale"), (R(spec_black), "darker")]},
          base_over=[(lines, "linegray"), (COLLAR, "pale"), (EYES, "eye")], outline=SIL.union(BILL))


def below():
    un = W.under(coverts=0.40)
    chin = HEAD.intersection(mirror(poly("M380,42 L390,42 L390,64 L380,66 Z")))
    cheek = HEAD.difference(chin)
    neck = NECK.difference(HEAD)
    breast = BODY.intersection(box(0, 0, 999, 196)).difference(NECK)
    utc = BODY.intersection(mirror(poly("M380,282 Q404,276 440,270 L440,400 L380,400 Z")))
    belly = BODY.intersection(mirror(poly("M380,190 Q400,188 414,184 L414,286 L380,286 Z"))).difference(breast).difference(utc)
    sides = BODY.difference(NECK).difference(breast).difference(belly).difference(utc)
    # orange feet tucked back under the tail
    legs = mirror(poly("M386,300 L392,300 L398,334 L408,350 Q398,356 390,350 L386,334 Z"))
    tail = TAIL.difference(utc)
    R = mirror
    final = {k: R(v) for k, v in un.items()}
    final.update({"chin": chin, "cheek": cheek, "neck": neck, "breast": breast, "belly": belly, "sides": sides,
                  "undertail-coverts": utc, "tail": tail, "legs": legs, "bill": BILL})
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "pale", "m"), ("secondaries", "gullpale", "m"), ("primaries", "gullpale", "m"),
            ("underwing-coverts", "pale", "m"), ("axillaries", "pale", "m"), ("sides", "light", "m"),
            ("belly", "light", "m"), ("breast", "chestnut", "m"), ("undertail-coverts", "darker", "m"),
            ("legs", "orange", "m"), ("neck", "mallardgreen", "m"), ("cheek", "mallardgreen", "m"),
            ("chin", "mallardgreen", "m"), ("bill", "billyellow", "m")]
    lines = R(W.lines(n_sec=11, n_prim=10, sec_to=0.42).difference(un["underwing-coverts"]))
    build("duck-below", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "linegray"), (COLLAR, "pale"), (EYES, "eye")], outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

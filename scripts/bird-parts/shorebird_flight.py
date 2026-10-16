"""Adult Lesser Yellowlegs in flight, from above and from below (td-a1bfd9).

Right half drawn in output coordinates, then mirrored (see flight.py). Long, narrow, pointed
wings; a slim body; legs trailing well past the tail. From above: dark wings without a wing
stripe, a white patch of uppertail coverts, and a barred tail.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M400,140 C446,124 500,114 540,112", "M404,212 C460,224 516,226 560,222"),
         ("M540,112 C610,112 690,140 752,190", "M560,222 C636,220 708,206 752,190"),
         rows=(0.38, 0.58, 0.72), tips=10, tip_amp=0.012, tertials=(0.16, 0.56), pc=(0.42, 0.50, 1.15))
ARM, HAND = W.arm, W.hand
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 74).buffer(1), 15, 19)
BODY = mirror(poly("M380,88 L392,90 C398,104 404,116 406,132 C410,160 410,196 404,226 C400,244 396,256 392,264 L380,266 Z")).union(HEAD)
BILL = mirror(poly("M380,6 Q382,6 382,10 L384,58 L380,58 Z"))
TAIL = mirror(poly("M380,252 L394,252 L404,304 Q394,310 380,310 Z"))
# legs trail past the tail; feet together
LEGS = mirror(poly("M383,262 L387,262 L388,330 L392,352 L389,356 L384,340 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 13, 70).buffer(2.4))
VB = [0, 0, 760, 370]


def tail_bars():
    return unary_union([box(0, y, 999, y + 3.2) for y in range(266, 306, 8)]).intersection(TAIL)


def above():
    up = W.upper()
    crown = HEAD.intersection(mirror(poly("M380,52 L398,52 L398,80 Q390,84 380,86 Z")))
    nape = HEAD.union(BODY.intersection(box(0, 60, 999, 118))).difference(crown)
    scap = poly("M390,114 C402,126 416,148 418,176 C420,200 414,218 406,230 L392,230 C392,192 392,150 390,114 Z")
    back = BODY.intersection(box(0, 112, 999, 230)).difference(mirror(scap))
    rump = BODY.intersection(box(0, 230, 999, 246))
    utc = mirror(poly("M380,242 L398,242 C400,256 400,268 396,278 Q388,282 380,282 Z"))
    tail = TAIL.difference(utc).difference(rump)
    R = mirror
    final = {k: R(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape, "scapulars": R(scap), "back": back, "rump": rump,
                  "uppertail-coverts": utc, "tail": tail, "legs": LEGS.difference(TAIL).difference(utc), "bill": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts"):
        final[k] = final[k].difference(final["scapulars"])
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                         "primary-coverts", "alula")])
    meta = [("legs", "legyellow", "mf"), ("tail", "light", "mf"), ("uppertail-coverts", "pale", "mf"), ("rump", "mid", "mf"),
            ("secondaries", "dark", "mf"), ("primaries", "darker", "mf"),
            ("wing-coverts", "wing", "m"), ("lesser-coverts", "wing", "f"), ("median-coverts", "wing", "f"),
            ("greater-coverts", "dark", "f"), ("primary-coverts", "dark", "f"), ("alula", "dark", "f"),
            ("tertials", "dark", "mf"), ("back", "mid", "mf"), ("scapulars", "mid", "mf"),
            ("nape", "light", "mf"), ("crown", "mid", "mf"), ("bill", "darker", "mf")]
    lines = R(W.lines(n_sec=11, n_prim=10).difference(W.pc_shape()).difference(up["alula"]))
    build("shorebird-above", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"tail": [(tail_bars(), "mid")]},
          base_over=[(lines, "linegray"), (EYES, "eye")], outline=SIL.union(BILL).union(LEGS))


def below():
    un = W.under(coverts=0.40)
    chin = HEAD.intersection(mirror(poly("M380,54 L392,54 L392,70 L380,72 Z")))
    throat = HEAD.union(BODY.intersection(box(0, 60, 999, 110))).difference(chin)
    breast = BODY.intersection(mirror(poly("M380,104 L420,104 L420,150 Q400,160 380,162 Z"))).difference(throat)
    utc = BODY.intersection(mirror(poly("M380,224 Q396,220 420,216 L420,320 L380,320 Z"))).union(
        mirror(poly("M380,242 L398,242 C400,258 398,270 394,280 Q388,284 380,284 Z")))
    belly = BODY.intersection(mirror(poly("M380,158 Q392,156 398,152 L398,232 L380,232 Z"))).difference(breast).difference(utc)
    flanks = BODY.difference(throat).difference(chin).difference(breast).difference(belly).difference(utc)
    tail = TAIL.difference(utc)
    R = mirror
    final = {k: R(v) for k, v in un.items()}
    final.update({"chin": chin, "throat": throat, "breast": breast, "belly": belly, "flanks": flanks,
                  "undertail-coverts": utc, "tail": tail, "legs": LEGS, "bill": BILL})
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "light", "m"), ("secondaries", "mid", "m"), ("primaries", "mid", "m"),
            ("underwing-coverts", "light", "m"), ("axillaries", "light", "m"), ("flanks", "pale", "m"),
            ("belly", "pale", "m"), ("breast", "light", "m"), ("undertail-coverts", "pale", "m"),
            ("legs", "legyellow", "m"), ("throat", "pale", "m"), ("chin", "pale", "m"), ("bill", "darker", "m")]
    lines = R(W.lines(n_sec=11, n_prim=10, sec_to=0.42).difference(un["underwing-coverts"]))
    build("shorebird-below", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"tail": [(tail_bars(), "mid")]},
          base_over=[(lines, "linegray"), (EYES, "eye")], outline=SIL.union(BILL).union(LEGS))


if __name__ == "__main__":
    above()
    below()

"""Adult Song Sparrow in flight, from above and from below (td-a1bfd9).

Right half drawn in output coordinates, then mirrored (see flight.py). A songbird's wing is
short and rounded, with the primaries' tips spread; the tail is long and rounded. Same plain
tones as the perched drawing; part ids match it, so a selection carries across views.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M414,140 C460,122 516,110 560,110", "M424,250 C480,262 532,266 574,262"),
         ("M560,110 C626,108 692,134 720,190", "M574,262 C640,262 698,240 720,190"),
         rows=(0.42, 0.62, 0.76), tips=9, tip_amp=0.03, tertials=(0.16, 0.58), pc=(0.42, 0.52, 1.1))
ARM, HAND = W.arm, W.hand
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 76).buffer(1), 30, 32)
BODY = mirror(poly("M380,96 L404,98 C420,116 430,140 432,172 C434,214 424,262 406,300 L380,304 Z")).union(HEAD)
BILL = mirror(poly("M380,18 Q386,22 390,36 L392,50 L380,50 Z"))
TAIL = mirror(poly("M380,290 L404,290 L432,424 Q410,444 380,446 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 26, 70).buffer(3))
VB = [0, 0, 760, 460]


def wing_bars(gc, mc):
    r0, r1, _ = W.rows
    lower = ARM.band(0, 1, r0, r0 + 0.06, n=60, scallops=12, amp=0.025).intersection(gc)
    upper = ARM.band(0, 1, r1, r1 + 0.05, n=60, scallops=16, amp=0.02).intersection(mc)
    return lower.union(upper)


def tail_lines(w=0.9):
    """Six pairs of rectrices fanning from the tail base."""
    ls = []
    for i in range(1, 6):
        x0, x1 = CX + 4 * i, CX + 9.6 * i
        ls.append(LineString([(x0, 300), (x1, 446)]).buffer(w / 2, cap_style=2))
    return mirror(unary_union(ls)).intersection(TAIL)


def above():
    up = W.upper()
    wb = wing_bars(up["greater-coverts"], up["median-coverts"])
    crown = HEAD.intersection(mirror(poly("M380,40 L392,40 Q396,70 394,106 L380,106 Z")))
    supercilium = HEAD.intersection(mirror(poly("M392,50 Q398,56 401,68 Q402,86 398,104 L393,104 Q396,86 395,70 Q394,58 390,52 Z")))
    nape = HEAD.union(BODY.intersection(box(0, 60, 999, 128))).difference(crown).difference(supercilium)
    scap = poly("M398,126 C416,140 432,164 436,192 C438,218 432,240 422,256 L404,256 C402,214 402,166 398,126 Z")
    back = BODY.intersection(box(0, 120, 999, 256)).difference(mirror(scap))
    rump = BODY.intersection(box(0, 256, 999, 286))
    utc = mirror(poly("M380,280 L406,280 C408,298 404,314 398,324 Q390,330 380,330 Z"))
    rect = TAIL.difference(utc).difference(rump)
    R = mirror
    final = {k: R(v) for k, v in up.items()}
    final.update({"wing-bars": R(wb), "crown": crown, "supercilium": supercilium, "nape": nape,
                  "scapulars": R(scap), "back": back, "rump": rump, "uppertail-coverts": utc,
                  "rectrices": rect, "tail": rect.union(utc), "upper-mandible": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "wing-bars"):
        final[k] = final[k].difference(final["scapulars"])
    final["wing"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                 "primary-coverts", "alula", "secondaries")]).difference(final["wing-bars"])
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                         "primary-coverts", "alula")]).difference(final["wing-bars"])
    meta = [("tail", "mid", "m"), ("rectrices", "mid", "f"), ("uppertail-coverts", "mid", "f"), ("rump", "mid", "mf"),
            ("wing", "wing", "m"), ("wing-coverts", "wing", "m"), ("secondaries", "wing", "f"), ("lesser-coverts", "wing", "f"),
            ("median-coverts", "dark", "f"), ("greater-coverts", "dark", "f"), ("primary-coverts", "darker", "f"),
            ("alula", "dark", "f"), ("primaries", "darker", "mf"), ("wing-bars", "pale", "mf"),
            ("tertials", "dark", "mf"), ("back", "mid", "mf"), ("scapulars", "mid", "mf"),
            ("nape", "mid", "mf"), ("crown", "mid", "mf"), ("supercilium", "pale", "mf"), ("upper-mandible", "bill", "mf")]
    lines = R(W.lines(n_sec=9, n_prim=9).difference(W.pc_shape()).difference(up["alula"])).union(tail_lines())
    build("songbird-above", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "linegray"), (EYES, "eye")], outline=SIL.union(BILL))


def below():
    un = W.under(coverts=0.44)
    chin = HEAD.intersection(mirror(poly("M380,44 L394,44 L396,64 L380,66 Z")))
    malar = HEAD.intersection(mirror(poly("M392,52 Q399,66 401,96 L395,98 Q393,72 388,54 Z")))
    throat = HEAD.union(BODY.intersection(box(0, 60, 999, 120))).difference(chin).difference(malar)
    breast = BODY.intersection(mirror(poly("M380,112 L450,112 L450,176 Q414,192 380,196 Z"))).difference(throat)
    utc = BODY.intersection(mirror(poly("M380,262 Q404,256 450,250 L450,350 L380,350 Z"))).union(
        mirror(poly("M380,282 L406,282 C408,300 404,318 398,328 Q390,334 380,334 Z")))
    belly = BODY.intersection(mirror(poly("M380,190 Q400,188 412,182 L412,268 L380,268 Z"))).difference(breast).difference(utc)
    flanks = BODY.difference(throat).difference(chin).difference(malar).difference(breast).difference(belly).difference(utc)
    tail = TAIL.difference(utc)
    R = mirror
    final = {k: R(v) for k, v in un.items()}
    final.update({"chin": chin, "malar": malar, "throat": throat, "breast": breast, "belly": belly,
                  "flanks": flanks, "undertail-coverts": utc, "tail": tail, "lower-mandible": BILL})
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "mid", "m"), ("secondaries", "mid", "m"), ("primaries", "mid", "m"),
            ("underwing-coverts", "light", "m"), ("axillaries", "light", "m"), ("flanks", "light", "m"),
            ("belly", "pale", "m"), ("breast", "light", "m"), ("undertail-coverts", "light", "m"),
            ("throat", "pale", "m"), ("malar", "dark", "m"), ("chin", "pale", "m"), ("lower-mandible", "bill", "m")]
    lines = R(W.lines(n_sec=9, n_prim=9, sec_to=0.46).difference(un["underwing-coverts"])).union(tail_lines())
    build("songbird-below", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "linegray"), (EYES, "eye")], outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

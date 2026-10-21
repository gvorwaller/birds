"""Adult American Herring Gull in flight, from above and from below (td-a1bfd9).

Drawn in output coordinates, right half only, then mirrored (see flight.py). Proportions:
wingspan about 2.3x the bill-to-tail length, a broad arm and a swept, pointed hand.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M402,152 C450,136 510,124 560,122", "M408,238 C470,244 530,242 590,236"),
         ("M560,122 C622,122 694,150 754,204", "M590,236 C652,236 712,224 754,204"))
ARM, HAND = W.arm, W.hand
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 66).buffer(1), 19, 25)
BODY = mirror(poly("M380,80 L394,84 C398,98 404,108 412,124 C424,148 428,176 426,206 C424,238 414,262 404,276 L380,278 Z")).union(HEAD)
BILL = mirror(poly("M380,14 Q385,15 386,24 L388,46 L380,46 Z"))
TAIL = mirror(poly("M380,262 L408,262 L420,328 Q402,334 380,334 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 16, 60).buffer(2.4))
VB = [0, 0, 760, 350]


# ---------- from above ----------
def above():
    up = W.upper()
    te = W.trailing_edge()
    cres = ARM.band(0, 0.14, -0.02, 0.09)
    pc, alula = up["primary-coverts"], up["alula"]
    # adult Herring: black outer primaries, reaching further in along the leading edge
    black = W.tip_region(0.70, 0.40).difference(W.pc_shape())
    mirrors_ = unary_union([affinity.scale(Point(*HAND.at(0.86, 0.78)).buffer(1), 9, 5.5),
                            affinity.scale(Point(*HAND.at(0.80, 0.58)).buffer(1), 5, 3.5)])
    apical = unary_union([Point(*HAND.at(s, 0.035)).buffer(3.4) for s in (0.58, 0.68, 0.78, 0.88)]).intersection(WING_R)
    # body
    crown = HEAD.intersection(mirror(poly("M380,30 L410,30 L410,62 Q396,72 380,74 Z")))
    nape = HEAD.union(BODY.intersection(box(0, 60, 999, 112))).difference(crown)
    scap = poly("M392,116 C406,128 422,150 428,180 C432,206 428,226 418,240 L400,240 C398,200 398,150 392,116 Z")
    back = BODY.intersection(box(0, 108, 999, 242)).difference(mirror(scap))
    rump = BODY.intersection(box(0, 242, 999, 262))
    utc = mirror(poly("M380,258 L404,258 C406,272 402,284 396,292 Q388,298 380,298 Z"))
    tail = TAIL.difference(utc).difference(rump)

    R = lambda g: mirror(g)   # right half -> both wings
    final = {k: R(v) for k, v in up.items()}
    final.update({"trailing-edge": R(te).difference(final["tertials"]), "tertial-crescent": R(cres),
                  "mirrors": R(mirrors_), "apical-spots": R(apical)})
    final.update({"crown": crown, "nape": nape, "scapulars": mirror(scap), "back": back,
                  "rump": rump, "uppertail-coverts": utc, "tail": tail, "bill": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts"):
        final[k] = final[k].difference(final["scapulars"])
    final["mantle"] = unary_union([final[k] for k in ("back", "scapulars", "lesser-coverts", "median-coverts",
                                   "greater-coverts", "tertials", "primary-coverts", "alula")])
    # Main parts: the coverts as one area over the mantle, as on the other birds (td-93f86b)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                         "primary-coverts", "alula")])
    # td-2a2f94: the carpal bar of young gulls and kittiwakes, from the wrist diagonally back across the inner wing's
    # coverts; plain grey on this adult
    bar = ARM.band(0.1, 1.0, lambda s: 0.42 + 0.36 * s, lambda s: min(0.58 + 0.36 * s, 0.99))
    final["wing-bars"] = R(bar).difference(final["tertials"]).difference(final["scapulars"]).difference(BODY)
    meta = [("tail", "pale", "mf"), ("uppertail-coverts", "pale", "mf"), ("rump", "pale", "mf"),
            ("secondaries", "gullgray", "mf"),
            # after the primaries: the band runs on across the inner primaries' tips
            ("primaries", "gullgray", "mf"), ("trailing-edge", "pale", "mf"), ("apical-spots", "pale", "mf"), ("mirrors", "pale", "mf"),
            ("mantle", "gullgray", "m"), ("wing-coverts", "gullgray", "m"), ("back", "gullgray", "f"), ("lesser-coverts", "gullgray", "f"),
            ("median-coverts", "gullgray", "f"), ("greater-coverts", "gullgray", "f"), ("primary-coverts", "gullgray", "f"),
            ("alula", "gullgray", "f"), ("wing-bars", "gullgray", "mf"), ("tertials", "gullgray", "f"), ("tertial-crescent", "pale", "mf"),
            ("scapulars", "gullgray", "f"), ("nape", "pale", "mf"), ("crown", "pale", "mf"), ("bill", "billyellow", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines().difference(W.pc_shape()).difference(alula))
    build("gull-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"primaries": [(mirror(black).difference(final["mirrors"]).difference(final["apical-spots"]), "darker")]},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under()
    te = W.trailing_edge()
    black = W.tip_region(0.76, 0.50)
    mirrors_ = unary_union([affinity.scale(Point(*HAND.at(0.86, 0.78)).buffer(1), 9, 5.5),
                            affinity.scale(Point(*HAND.at(0.80, 0.58)).buffer(1), 5, 3.5)])
    apical = unary_union([Point(*HAND.at(s, 0.035)).buffer(3.4) for s in (0.58, 0.68, 0.78, 0.88)]).intersection(WING_R)
    throat = HEAD.union(BODY.intersection(box(0, 60, 999, 112)))
    breast = BODY.intersection(mirror(poly("M380,100 L440,100 L440,160 Q410,172 380,176 Z"))).difference(throat)
    utc = BODY.intersection(mirror(poly("M380,244 Q404,238 440,232 L440,330 L380,330 Z"))).union(
        mirror(poly("M380,258 L404,258 C406,274 402,288 396,296 Q388,302 380,302 Z")))
    belly = BODY.intersection(mirror(poly("M380,170 Q398,168 408,164 L408,250 L380,250 Z"))).difference(breast).difference(utc)
    sides = BODY.difference(throat).difference(breast).difference(belly).difference(utc)
    # feet tucked back under the tail, the webs just showing
    legs = mirror(poly("M386,262 L392,262 L396,290 L404,306 Q396,310 388,306 L384,292 Z"))
    tail = TAIL.difference(utc)
    R = mirror
    final = {k: R(v) for k, v in un.items()}
    final.update({"trailing-edge": R(te), "mirrors": R(mirrors_),
             "apical-spots": R(apical), "throat": throat, "breast": breast, "belly": belly, "sides": sides,
             "undertail-coverts": utc, "legs": legs, "tail": tail, "bill": BILL})
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "trailing-edge", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "pale", "m"), ("secondaries", "gullpale", "m"),
            ("primaries", "gullpale", "m"), ("trailing-edge", "pale", "m"), ("apical-spots", "pale", "m"), ("mirrors", "pale", "m"),
            ("underwing-coverts", "pale", "m"), ("axillaries", "pale", "m"), ("sides", "pale", "m"),
            ("belly", "pale", "m"), ("breast", "pale", "m"), ("undertail-coverts", "pale", "m"),
            ("legs", "legpink", "m"), ("throat", "pale", "m"), ("bill", "billyellow", "m")]
    order = [m[0] for m in meta]
    lines = R(W.lines(sec_to=0.42).difference(un["underwing-coverts"]))
    build("gull-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"primaries": [(R(black).difference(final["mirrors"]).difference(final["apical-spots"]), "darker")]},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

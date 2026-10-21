"""Adult Common Murre in flight, from above and from below (td-5076e6).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A murre flies with
fast wingbeats on short, narrow, pointed wings set midway along a long body; the head is held
forward, the tail is short and rounded, and the dark feet show beside the tail from below.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M418,170 C450,164 490,162 528,166", "M418,242 C450,242 490,238 528,232"),
         ("M528,166 C574,172 620,190 664,220", "M528,232 C572,232 616,228 660,224"),
         rows=(0.40, 0.60, 0.74), tips=9, tip_amp=0.02, tertials=(0.14, 0.56), pc=(0.42, 0.50, 1.0))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 74).buffer(1), 22, 30)
NECK = mirror(poly("M380,84 L400,84 C408,104 414,122 420,140 L380,140 Z"))
BODY = mirror(poly("M380,120 L416,136 C428,168 432,210 428,256 C424,290 414,316 400,334 L380,338 Z")).union(NECK).union(HEAD)
BILL = mirror(poly("M380,8 Q382,10 384,24 L388,50 L380,50 Z"))
TAIL = mirror(poly("M380,326 L400,326 L404,354 Q394,366 380,368 Z"))
# each dark webbed foot held out beside the tail
FOOT_R = poly("M398,328 L408,330 L426,370 L418,382 L404,384 L400,360 Z")
FEET = mirror(FOOT_R)
TOE_LINES = mirror(unary_union([stroke(d, 1.4) for d in ("M403,334 L408,382", "M404,334 L420,378")]))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 12, 66).buffer(2.6))
VB = [0, 0, 760, 400]


# ---------- from above ----------
def above():
    up = W.upper()
    crown = HEAD.intersection(box(0, 0, 999, 70))
    nape = HEAD.difference(crown)
    neck = NECK.difference(HEAD)
    scap = mirror(poly("M396,150 C410,162 420,186 422,214 C424,236 418,256 410,268 L400,264 C400,228 398,186 396,150 Z"))
    back = BODY.intersection(box(0, 120, 999, 290)).difference(HEAD).difference(neck).difference(scap)
    rump = BODY.intersection(box(0, 290, 999, 340)).difference(back).difference(scap)
    # the feathers over the base of the tail (td-93f86b)
    utc = mirror(poly("M380,318 L398,318 C400,332 396,342 390,348 Q385,351 380,351 Z")).intersection(rump.union(TAIL))
    rump = rump.difference(utc)
    tail = TAIL.difference(rump).difference(utc)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape.union(neck), "back": back, "scapulars": scap, "rump": rump,
                  "uppertail-coverts": utc, "tail": tail, "bill": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY).difference(scap)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tail", "darker", "mf"), ("rump", "darker", "mf"), ("uppertail-coverts", "darker", "mf"),
            ("secondaries", "darker", "mf"), ("primaries", "darker", "mf"),
            ("wing-coverts", "darker", "m"), ("lesser-coverts", "darker", "f"), ("median-coverts", "darker", "f"),
            ("greater-coverts", "darker", "f"), ("primary-coverts", "darker", "f"), ("alula", "darker", "f"),
            ("tertials", "darker", "mf"), ("back", "darker", "mf"), ("scapulars", "darker", "mf"),
            ("nape", "darker", "mf"), ("crown", "darker", "mf"), ("bill", "eye", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines().difference(W.pc_shape()).difference(up["alula"]))
    build("auk-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.42, ax=(0.30, 0.10, 0.58))
    # the dark head and neck end in a rounded edge across the upper breast
    dark = HEAD.union(NECK).union(BODY.intersection(mirror(poly("M380,100 L440,100 L440,148 C418,154 398,156 380,156 Z"))))
    face = HEAD.intersection(box(0, 0, 999, 74))
    throat = dark.difference(face)
    body = BODY.difference(dark)
    breast = body.intersection(mirror(poly("M380,0 L440,0 L440,226 Q412,236 380,238 Z")))
    flanks = body.difference(breast).intersection(mirror(poly("M412,230 L440,230 L440,320 L404,320 C410,290 414,260 412,230 Z")))
    utc = mirror(poly("M380,300 L408,300 C406,314 402,326 396,334 Q388,338 380,338 Z"))
    belly = body.difference(breast).difference(utc).difference(flanks)
    tail = TAIL.difference(utc)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"face": face, "throat": throat, "breast": breast, "flanks": flanks, "belly": belly,
                  "undertail-coverts": utc, "tail": tail, "bill": BILL, "toes": FEET.difference(TAIL)})
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "darker", "m"), ("secondaries", "linegray", "m"), ("primaries", "linegray", "m"),
            ("underwing-coverts", "pale", "m"), ("axillaries", "pale", "m"),
            ("belly", "pale", "m"), ("flanks", "pale", "m"), ("undertail-coverts", "pale", "m"), ("breast", "pale", "m"),
            ("toes", "eye", "m"),
            ("throat", "darker", "m"), ("face", "darker", "m"), ("bill", "eye", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(sec_to=0.42).difference(un["underwing-coverts"]))
    build("auk-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"toes": [(TOE_LINES, "linegray")]},
          base_over=[(lines, "pale"), (EYES, "eye")],
          outline=SIL.union(BILL).union(FEET))


if __name__ == "__main__":
    above()
    below()

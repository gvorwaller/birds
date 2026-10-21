"""Adult Great Blue Heron in flight, from above and from below (td-46e6e3).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A heron flies with
its neck folded back into an S, so the head sits close in front of the wings with the neck
bulging below it, and its long legs trail well past the short tail. The wings are broad with
rounded tips; the slaty flight feathers are darker than the coverts.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M404,112 C460,104 520,100 568,100", "M404,282 C470,290 530,284 576,270"),
         ("M568,100 C630,100 696,116 744,166", "M576,270 C636,264 694,240 730,206"),
         rows=(0.40, 0.58, 0.72), tips=10, tip_amp=0.025, tertials=(0.14, 0.56), pc=(0.42, 0.50, 1.0))
ARM, HAND = W.arm, W.hand
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 62).buffer(1), 15, 18)
NECK = mirror(poly("M380,70 L396,74 C404,92 404,124 398,148 L380,152 Z"))   # the folded neck, bulging below the head
BODY = mirror(poly("M380,104 L402,108 C414,140 418,180 414,220 C410,256 402,284 394,300 L380,302 Z")).union(NECK).union(HEAD)
BILL = mirror(poly("M380,4 Q383,6 384,20 L386,50 L380,50 Z"))
TAIL = mirror(poly("M380,282 L398,282 L404,320 Q394,330 380,331 Z"))
LEGS_R = {"tibia": poly("M384,296 L392,296 L392,330 L386,330 Z"),
          "tarsus": poly("M386,330 L392,330 L392,420 L387,420 Z")}
TOES_R = unary_union([stroke("M389,420 L384,452", 3.2), stroke("M389,420 L392,454", 3.2), stroke("M389,420 L398,448", 3)])
LEGS = {k: mirror(v) for k, v in LEGS_R.items()}
TOES = mirror(TOES_R).difference(LEGS["tarsus"])
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 10, 56).buffer(2.4))
VB = [0, 0, 760, 470]


# ---------- from above ----------
def above():
    up = W.upper()
    crown = HEAD.intersection(mirror(poly("M380,40 L400,40 L400,62 Q390,70 380,72 Z")))
    # the black stripes from above each eye back to the nape plumes
    plumes = mirror(stroke("M388,50 Q392,64 388,84", 4)).intersection(HEAD.union(NECK))
    hindneck = NECK.union(HEAD).difference(crown).difference(plumes)
    # the shoulder feathers lying over each wing root, beside the back
    scap = mirror(poly("M394,112 C408,124 420,148 422,178 C424,202 418,222 410,236 L398,234 C398,196 398,150 394,112 Z"))
    back = BODY.intersection(box(0, 100, 999, 250)).difference(hindneck).difference(crown).difference(plumes).difference(scap)
    rump = BODY.intersection(box(0, 250, 999, 310)).difference(back)
    # the feathers over the base of the tail (td-93f86b)
    utc = mirror(poly("M380,288 L398,288 C401,302 398,314 391,320 Q385,323 380,323 Z")).intersection(rump.union(TAIL))
    rump = rump.difference(utc)
    tail = TAIL.difference(rump).difference(utc)
    R = mirror
    final = {k: R(v) for k, v in up.items()}
    # From above, the tibiae lie hidden behind the rump and tail; only the tarsi and toes trail past it.
    final.update({"crown": crown, "head-plumes": plumes, "hindneck": hindneck, "back": back, "scapulars": scap, "rump": rump,
                  "uppertail-coverts": utc, "tail": tail, "bill": BILL, "toes": TOES, "tarsus": LEGS["tarsus"].difference(TAIL)})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY).difference(scap)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tarsus", "linegray", "mf"), ("toes", "linegray", "mf"),
            ("tail", "linegray", "mf"), ("rump", "gullgray", "mf"), ("uppertail-coverts", "gullgray", "mf"),
            ("secondaries", "linegray", "mf"), ("primaries", "darker", "mf"),
            ("wing-coverts", "gullgray", "m"), ("lesser-coverts", "gullgray", "f"), ("median-coverts", "gullgray", "f"),
            ("greater-coverts", "gullgray", "f"), ("primary-coverts", "linegray", "f"), ("alula", "linegray", "f"),
            ("tertials", "gullgray", "mf"), ("back", "gullgray", "mf"), ("scapulars", "gullgray", "mf"), ("hindneck", "gullgray", "mf"),
            ("crown", "pale", "mf"), ("head-plumes", "darker", "mf"), ("bill", "billyellow", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines().difference(W.pc_shape()).difference(up["alula"]))
    build("heron-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "pale"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.42, ax=(0.15, 0.10, 0.58))
    face = HEAD.intersection(box(0, 0, 999, 66))
    throat = HEAD.difference(face)
    foreneck = NECK.difference(HEAD)
    belly = BODY.difference(HEAD).difference(NECK)
    thighs = mirror(affinity.scale(Point(392, 286).buffer(1), 9, 12)).intersection(belly.union(TAIL))
    utc = mirror(poly("M380,270 L398,270 C400,288 396,300 390,306 Q385,310 380,310 Z")).difference(thighs)
    belly = belly.difference(thighs).difference(utc)
    tail = TAIL.difference(utc).difference(thighs)
    R = mirror
    final = {k: R(v) for k, v in un.items()}
    final.update({"face": face, "throat": throat, "foreneck": foreneck, "belly": belly, "thighs": thighs,
                  "undertail-coverts": utc, "tail": tail, "bill": BILL, "toes": TOES})
    final.update(LEGS)
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    streaks = mirror(unary_union([stroke(f"M{x},{y} L{x},{y + 14}", 2) for x, y in
                                  [(384, 84), (390, 96), (384, 112), (392, 120), (386, 130)]])).intersection(foreneck)
    meta = [("tail", "linegray", "m"), ("secondaries", "linegray", "m"), ("primaries", "darker", "m"),
            ("underwing-coverts", "gullgray", "m"), ("axillaries", "gullgray", "m"),
            ("belly", "linegray", "m"), ("undertail-coverts", "pale", "m"), ("thighs", "chestnut", "m"),
            ("tibia", "linegray", "m"), ("tarsus", "linegray", "m"), ("toes", "linegray", "m"),
            ("foreneck", "pale", "m"), ("throat", "pale", "m"), ("face", "pale", "m"), ("bill", "billyellow", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(sec_to=0.42).difference(un["underwing-coverts"]))
    build("heron-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"foreneck": [(streaks, "darker")]},
          base_over=[(lines, "pale"), (EYES, "eye")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

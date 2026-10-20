"""Adult Horned (Slavonian) Grebe in flight, from above and from below (td-7adea3).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A grebe flies with its
neck stretched out and its feet trailing behind, on small, narrow wings; it has almost no tail.
From above the inner wing shows a white patch on the secondaries and a small white mark on the
shoulder; from below the wing linings are white.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M404,152 C446,146 492,144 532,148", "M404,204 C446,208 492,206 532,202"),
         ("M532,148 C576,154 618,170 654,194", "M532,202 C574,204 614,206 650,206"),
         rows=(0.40, 0.60, 0.74), tips=10, tip_amp=0.02, tertials=(0.24, 0.58), pc=(0.42, 0.50, 1.0))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 60).buffer(1), 15, 19)
NECK = mirror(poly("M380,70 L392,72 C395,92 397,112 400,130 L380,130 Z"))
BODY = mirror(poly("M380,118 L402,126 C416,152 422,190 420,232 C418,264 410,288 398,304 L380,308 Z")).union(NECK).union(HEAD)
BILL = mirror(poly("M380,18 Q382,20 384,32 L386,44 L380,44 Z"))
# the golden ear tufts: small points at the back of the head
TUFTS = mirror(poly("M386,58 C391,62 395,70 397,86 C393,83 389,78 386,72 C385,67 385,62 386,58 Z"))
# each foot trails behind the body, its toes folded together
FOOT_R = poly("M386,298 L394,298 C399,318 403,338 401,360 C397,368 389,368 386,358 C385,338 385,318 386,298 Z")
FEET = mirror(FOOT_R)
TOE_LINES = mirror(unary_union([stroke(d, 1.2) for d in ("M390,304 L389,362", "M391,304 L397,360")]))
SIL = BODY.union(WING).union(TUFTS)
EYES = mirror(Point(CX + 9, 52).buffer(2.4))
VB = [0, 0, 760, 380]


# ---------- from above ----------
def above():
    up = W.upper()
    crown = HEAD.intersection(box(0, 0, 999, 66)).difference(TUFTS)
    nape = HEAD.difference(crown).difference(TUFTS)
    # the tufts cut slivers off the back of the head; the crown takes them, so the nape is one piece
    crown, nape = crown.union(nape.difference(largest(nape))).buffer(0), largest(nape)
    neck = NECK.difference(HEAD)
    scap = mirror(poly("M396,150 C408,162 416,186 417,210 C418,232 413,250 406,262 L398,260 C398,226 398,186 396,150 Z"))
    back = BODY.intersection(box(0, 128, 999, 262)).difference(HEAD).difference(neck).difference(scap)
    rump = BODY.intersection(box(0, 262, 999, 320)).difference(back).difference(scap)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "ear-tufts": TUFTS, "nape": nape, "neck": neck, "back": back, "scapulars": scap,
                  "rump": rump.difference(FEET), "bill": BILL, "toes": FEET})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY).difference(scap)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    # the small white mark on the shoulder, at the front of the inner wing (never a tap target)
    shoulder = mirror(W.arm.band(0, 0.22, 0.80, 1.0))
    meta = [("toes", "gullgray", "mf"), ("rump", "darker", "mf"),
            ("secondaries", "pale", "mf"), ("primaries", "dark", "mf"),
            ("wing-coverts", "darker", "m"), ("lesser-coverts", "darker", "f"), ("median-coverts", "darker", "f"),
            ("greater-coverts", "darker", "f"), ("primary-coverts", "darker", "f"), ("alula", "darker", "f"),
            ("tertials", "darker", "mf"), ("back", "darker", "mf"), ("scapulars", "dark", "mf"),
            ("neck", "chestnut", "mf"), ("nape", "eye", "mf"), ("crown", "eye", "mf"), ("ear-tufts", "orange", "mf"),
            ("bill", "eye", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines().difference(W.pc_shape()).difference(up["alula"]))
    build("grebe-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"wing-coverts": [(shoulder, "pale")], "lesser-coverts": [(shoulder, "pale")],
                 "toes": [(TOE_LINES, "linegray")]},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL).union(FEET))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.42, ax=(0.24, 0.10, 0.58))
    face = HEAD.intersection(box(0, 0, 999, 66))
    throat = HEAD.difference(face).union(NECK.intersection(box(0, 0, 999, 84))).difference(face)
    neck = NECK.difference(HEAD).difference(throat)
    body = BODY.difference(HEAD).difference(NECK)
    breast = body.intersection(mirror(poly("M380,0 L440,0 L440,160 Q410,168 380,170 Z")))
    flanks = body.difference(breast).intersection(mirror(poly("M408,150 L440,150 L440,300 L398,300 C410,260 414,200 408,150 Z")))
    utc = mirror(poly("M380,274 L404,274 C402,288 398,298 392,304 Q386,308 380,308 Z")).difference(FEET)
    belly = body.difference(breast).difference(flanks).difference(utc)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"face": face, "throat": throat, "neck": neck, "breast": breast, "flanks": flanks,
                  "belly": belly.difference(FEET), "undertail-coverts": utc, "bill": BILL, "toes": FEET})
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("toes", "gullgray", "m"), ("secondaries", "pale", "m"), ("primaries", "linegray", "m"),
            ("underwing-coverts", "pale", "m"), ("axillaries", "pale", "m"),
            ("belly", "pale", "m"), ("undertail-coverts", "pale", "m"), ("flanks", "chestnut", "m"), ("breast", "chestnut", "m"), ("neck", "chestnut", "m"),
            ("throat", "eye", "m"), ("face", "eye", "m"), ("bill", "eye", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(sec_to=0.42).difference(un["underwing-coverts"]))
    build("grebe-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"toes": [(TOE_LINES, "linegray")]},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.difference(TUFTS).union(HEAD).union(BILL).union(FEET))


if __name__ == "__main__":
    above()
    below()

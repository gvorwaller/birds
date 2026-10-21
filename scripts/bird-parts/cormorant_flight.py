"""Adult Double-crested Cormorant in flight, from above and from below (td-af7c6b).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A cormorant flies
with its long neck stretched out in front; the wings are fairly long and broad-handed, the tail
is long and rounded, and the big webbed feet show beside the tail from below.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M416,186 C470,182 520,182 556,184", "M416,300 C470,300 520,296 556,290"),
         ("M556,184 C620,184 690,186 740,192", "M556,290 C620,282 690,250 736,204"),
         rows=(0.40, 0.58, 0.72), tips=10, tip_amp=0.025, tertials=(0.14, 0.56), pc=(0.42, 0.50, 1.0))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 60).buffer(1), 13, 20)
NECK = mirror(poly("M380,64 L392,64 C391,100 392,140 400,160 C406,172 414,180 420,190 L380,190 Z"))
BODY = mirror(poly("M380,160 L420,188 C426,230 424,280 414,312 L404,330 L380,332 Z")).union(NECK).union(HEAD)
BILL = mirror(poly("M380,6 Q383,8 384,22 L386,44 L380,44 Z"))
TAIL = mirror(poly("M380,320 L402,320 L414,410 Q398,426 380,428 Z"))
TARSUS = mirror(stroke("M404,302 L420,318", 7))
# each webbed foot spread beside the tail: all four toes joined by webs
FOOT_R = poly("M416,312 L426,318 L456,334 L448,348 L432,354 L418,344 Z")
FEET = mirror(FOOT_R).difference(TARSUS)
TOE_LINES = mirror(unary_union([stroke(d, 1.4) for d in ("M420,318 L432,352", "M421,318 L446,346", "M422,317 L454,336")]))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 9, 54).buffer(2.4))
VB = [0, 0, 760, 440]


def scaly(g, tone="darker"):
    """Dark feather edges over the bronze-brown back and coverts (never tap targets)."""
    lines = [stroke(f"M{x},{y} Q{x + 8},{y + 6} {x + 16},{y}", 1.4)
             for x in range(10, 750, 18) for y in range(170, 320, 14)]
    return [(unary_union(lines).intersection(g), tone)]


# ---------- from above ----------
def above():
    up = W.upper()
    # the median coverts' tips, where a frigatebird's pale wing bar runs (td-2a2f94); plain on this cormorant
    r1 = W.rows[1]
    wb = W.arm.band(0, 1, r1, r1 + 0.06, n=60, scallops=10, amp=0.02).intersection(up["median-coverts"])
    crown = HEAD.intersection(box(0, 0, 999, 60))
    nape = HEAD.difference(crown)
    neck = NECK.difference(HEAD)
    scap = mirror(poly("M392,184 C408,196 420,220 424,250 C426,272 420,292 412,304 L400,300 C400,262 398,220 392,184 Z"))
    back = BODY.intersection(box(0, 160, 999, 290)).difference(HEAD).difference(neck).difference(scap)
    rump = BODY.intersection(box(0, 290, 999, 340)).difference(back).difference(scap)
    # the feathers over the base of the tail (td-93f86b)
    utc = mirror(poly("M380,322 L402,322 C404,340 400,354 392,362 Q386,366 380,366 Z")).intersection(rump.union(TAIL))
    rump = rump.difference(utc)
    tail = TAIL.difference(rump).difference(utc)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape, "neck": neck, "back": back, "scapulars": scap, "rump": rump,
                  "uppertail-coverts": utc, "tail": tail, "bill": BILL, "wing-bars": mirror(wb)})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "wing-bars"):
        final[k] = final[k].difference(BODY).difference(scap)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tail", "darker", "mf"), ("rump", "darker", "mf"), ("uppertail-coverts", "darker", "mf"),
            ("secondaries", "darker", "mf"), ("primaries", "darker", "mf"),
            ("wing-coverts", "dark", "m"), ("lesser-coverts", "dark", "f"), ("median-coverts", "dark", "f"),
            ("greater-coverts", "dark", "f"), ("primary-coverts", "darker", "f"), ("alula", "darker", "f"),
            ("wing-bars", "dark", "mf"),
            ("tertials", "dark", "mf"), ("back", "dark", "mf"), ("scapulars", "dark", "mf"), ("neck", "darker", "mf"),
            ("nape", "darker", "mf"), ("crown", "darker", "mf"), ("bill", "bill", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines().difference(W.pc_shape()).difference(up["alula"]))
    build("cormorant-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={k: scaly(final[k]) for k in ("wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts",
                                              "back", "scapulars", "wing-bars")},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.42, ax=(0.15, 0.10, 0.58))
    # the bare orange skin under the base of the bill
    gular = HEAD.intersection(mirror(poly("M380,40 L388,42 Q391,50 387,58 L380,60 Z")))
    face = HEAD.difference(gular)
    neck = NECK.difference(HEAD)
    body = BODY.difference(HEAD).difference(NECK)
    breast = body.intersection(box(0, 0, 999, 250))
    utc = mirror(poly("M380,290 L404,290 C404,306 400,320 392,328 Q386,332 380,332 Z"))
    belly = body.difference(breast).difference(utc)
    # a band across the belly just behind the breast (td-2a2f94); a juvenile frigatebird's is dark
    belly_band = belly.intersection(box(0, 250, 999, 272))
    belly = belly.difference(belly_band)
    tail = TAIL.difference(utc)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"gular-skin": gular, "face": face, "neck": neck, "breast": breast, "belly": belly, "belly-band": belly_band,
                  "undertail-coverts": utc, "tail": tail, "bill": BILL, "tarsus": TARSUS.difference(BODY), "toes": FEET})
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "darker", "m"), ("secondaries", "darker", "m"), ("primaries", "darker", "m"),
            ("underwing-coverts", "dark", "m"), ("axillaries", "dark", "m"),
            ("belly", "darker", "m"), ("belly-band", "darker", "m"), ("undertail-coverts", "darker", "m"), ("breast", "darker", "m"),
            ("tarsus", "eye", "m"), ("toes", "eye", "m"),
            ("neck", "darker", "m"), ("face", "darker", "m"), ("gular-skin", "orange", "m"), ("bill", "bill", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(sec_to=0.42).difference(un["underwing-coverts"]))
    build("cormorant-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"toes": [(TOE_LINES, "linegray")]},
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL).union(FEET))


if __name__ == "__main__":
    above()
    below()

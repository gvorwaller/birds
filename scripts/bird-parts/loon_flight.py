"""Adult Common Loon in flight, from above and from below (td-a3a17d).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A loon flies with its
neck stretched out and its head held a little low, on narrow pointed wings that look small for the
heavy body, with the big feet trailing past the short tail. From above it is black with a checkered
back and small white spots on the wing coverts; from below, white with dark flight feathers.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M410,178 C460,174 510,174 560,180", "M410,262 C460,260 510,256 560,250"),
         ("M560,180 C620,190 680,208 738,238", "M560,250 C620,250 680,248 734,242"),
         rows=(0.40, 0.60, 0.74), tips=10, tip_amp=0.02, tertials=(0.12, 0.56), pc=(0.42, 0.50, 1.0))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 70).buffer(1), 15, 23)
NECK = mirror(poly("M380,82 L394,82 C396,104 398,128 402,152 L380,152 Z"))
BODY = mirror(poly("M380,136 L398,140 C408,164 413,200 413,240 C413,286 407,326 396,352 L380,358 Z")).union(NECK).union(HEAD)
BILL = mirror(poly("M380,8 Q382,10 383,22 L386,50 L380,50 Z"))
TAIL = mirror(poly("M380,346 L396,346 L400,374 Q392,382 380,384 Z"))
# the legs run back under the tail and the big webbed feet trail past it
FOOT_R = poly("M383,368 L395,366 C399,384 403,404 406,428 L408,452 Q400,460 390,454 L386,428 C385,404 384,384 383,368 Z")
FEET = mirror(FOOT_R)
TARSI = mirror(poly("M385,322 L391,322 L394,392 L386,392 Z"))
TOE_LINES = mirror(unary_union([stroke(d, 1.2) for d in ("M392,388 L389,452", "M393,388 L399,456", "M394,388 L406,448")]))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 10, 64).buffer(2.4))
VB = [0, 0, 760, 470]


def spots(region, dx, dy, r, offset=0.5, square=False):
    """Small white spots in staggered rows over a region (a pattern, never a tap target)."""
    x0, y0, x1, y1 = region.bounds
    out, j, y = [], 0, y0 + dy / 2
    while y < y1:
        x = x0 + dx / 2 + (offset * dx if j % 2 else 0)
        while x < x1:
            out.append(box(x - r, y - r * 0.7, x + r, y + r * 0.7) if square else Point(x, y).buffer(r))
            x += dx
        y += dy; j += 1
    return unary_union(out).intersection(region.buffer(-1))


# ---------- from above ----------
def above():
    up = W.upper()
    crown = HEAD.intersection(box(0, 0, 999, 66))
    nape = BODY.intersection(box(0, 66, 999, 150)).difference(crown)
    scap = mirror(poly("M394,150 C404,162 411,186 412,212 C413,236 409,258 403,272 L396,270 C396,232 396,190 394,150 Z"))
    back = BODY.intersection(box(0, 150, 999, 300)).difference(scap)
    rump = BODY.intersection(box(0, 300, 999, 360)).difference(back).difference(scap)
    tail = TAIL.difference(rump)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape, "back": back, "scapulars": scap, "rump": rump,
                  "tail": tail, "bill": BILL, "toes": FEET.difference(TAIL)})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY).difference(scap)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("toes", "darker", "mf"), ("tail", "eye", "mf"), ("rump", "eye", "mf"),
            ("secondaries", "eye", "mf"), ("primaries", "eye", "mf"),
            ("wing-coverts", "eye", "m"), ("lesser-coverts", "eye", "f"), ("median-coverts", "eye", "f"),
            ("greater-coverts", "eye", "f"), ("primary-coverts", "eye", "f"), ("alula", "eye", "f"),
            ("tertials", "eye", "mf"), ("back", "eye", "mf"), ("scapulars", "eye", "mf"),
            ("nape", "eye", "mf"), ("crown", "eye", "mf"), ("bill", "linegray", "mf")]
    order = [m[0] for m in meta]
    # white spots on the coverts (not the primary coverts), checks on the back and shoulders
    cov = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")])
    cov_spots = spots(cov, 9, 7, 1.5)
    checks = unary_union([spots(scap, 8, 7, 2.4, square=True), spots(back, 7, 6, 1.8, square=True)])
    marks = {k: [(cov_spots, "pale")] for k in ("wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts")}
    marks.update({"scapulars": [(checks, "pale")], "back": [(checks, "pale")], "toes": [(TOE_LINES, "linegray")]})
    lines = mirror(W.lines().difference(W.pc_shape()).difference(up["alula"]))
    build("loon-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks=marks,
          base_over=[(lines, "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL).union(FEET))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.42, ax=(0.24, 0.10, 0.58))
    face = HEAD.intersection(box(0, 0, 999, 60))
    throat = HEAD.union(NECK).difference(face)
    streaks = mirror(poly("M380,96 L392,94 L393,104 L380,106 Z")).intersection(throat)
    throat = throat.difference(streaks)
    body = BODY.difference(HEAD).difference(NECK)
    breast = body.intersection(mirror(poly("M380,0 L440,0 L440,212 Q410,222 380,224 Z")))
    utc = mirror(poly("M380,310 L404,310 C402,326 398,340 392,350 Q386,356 380,356 Z"))
    belly = body.difference(breast).difference(utc)
    tail = TAIL.difference(utc)
    tarsus = TARSI
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"face": face, "throat": throat, "throat-streaks": streaks, "breast": breast, "belly": belly,
                  "undertail-coverts": utc.difference(TARSI), "tail": tail, "bill": BILL,
                  "tarsus": tarsus, "toes": FEET.difference(TARSI)})
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "eye", "m"), ("secondaries", "linegray", "m"), ("primaries", "linegray", "m"),
            ("underwing-coverts", "pale", "m"), ("axillaries", "pale", "m"),
            ("belly", "pale", "m"), ("undertail-coverts", "pale", "m"), ("breast", "pale", "m"),
            ("tarsus", "darker", "m"), ("toes", "darker", "m"),
            ("throat", "eye", "m"), ("throat-streaks", "pale", "m"), ("face", "eye", "m"), ("bill", "linegray", "m")]
    order = [m[0] for m in meta]
    # black shaft streaks on the white axillaries; dark marks under the tail; the chin streaks
    ax = final["axillaries"]
    x0, y0, x1, y1 = ax.bounds
    shafts = unary_union([stroke(f"M{x:.1f},{y0} L{x + 2:.1f},{y1}", 1.0) for x in range(int(x0) + 3, int(x1), 6)])
    chin = mirror(unary_union([stroke(f"M{x},{93} L{x},{108}", 1.1) for x in (382, 385, 388, 391)]))
    lines = mirror(W.lines(sec_to=0.42).difference(un["underwing-coverts"]))
    build("loon-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"axillaries": [(shafts, "darker")],
                 "throat-streaks": [(chin, "eye")], "toes": [(TOE_LINES, "linegray")]},
          base_over=[(lines, "pale"), (EYES, "eye")],
          outline=SIL.union(BILL).union(FEET))


if __name__ == "__main__":
    above()
    below()

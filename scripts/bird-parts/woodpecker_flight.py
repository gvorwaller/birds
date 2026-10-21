"""Adult male Downy Woodpecker in flight, from above and from below (td-71bf41).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A woodpecker flies on
short, broad, rounded wings, in bounds: a few quick flaps, then a glide with the wings closed. From
above, the white back stripe runs down the black back, and white spots on every flight feather
make bars across the black wing; the stiff tail is black in the middle with white outer feathers.
From below, the wing linings are white and the flight feathers grey with white spots.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M408,118 C440,112 480,110 520,114", "M408,204 C440,208 480,210 520,210"),
         ("M520,114 C566,120 612,136 648,164", "M520,210 C568,212 616,206 654,190"),
         rows=(0.42, 0.62, 0.76), tips=10, tip_amp=0.022, tertials=(0.22, 0.58), pc=(0.42, 0.50, 1.0))
WING = mirror(W.outline())

HEAD = affinity.scale(Point(CX, 70).buffer(1), 20, 26)
BODY = mirror(poly("M380,88 L404,96 C414,130 418,170 416,210 C414,240 406,262 396,276 L380,280 Z")).union(HEAD)
BILL = mirror(poly("M380,12 Q382,14 384,26 L387,48 L380,48 Z"))
# the stiff, pointed tail; its outer feathers are white
TAIL = mirror(poly("M380,266 L398,266 L405,318 Q396,340 380,350 Z"))
OTF = TAIL.intersection(mirror(poly("M392,266 L420,266 L420,340 L398,334 Z")))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 15, 60).buffer(2.4))
VB = [0, 0, 760, 370]


def spots(rx=4.2, ry=3.0):
    """White spots on each flight feather (bars across the wing) and at the tips of the median and
    greater coverts (right wing; mirror them)."""
    A, H = W.arm, W.hand
    r0, r1, _ = W.rows
    s_arm = [i / 12 + 1 / 24 for i in range(12)]
    s_hand = [i / 10 + 1 / 20 for i in range(10)]
    pts_ = [A.at(s, f) for s in s_arm for f in (0.10, 0.25)]
    pts_ += [A.at(s, f) for s in s_arm[1:] for f in (r0 + 0.045, r1 + 0.04)]
    pts_ += [H.at(s, f) for s in s_hand for f in (0.18, 0.40, 0.62) if s < 0.95]
    return unary_union([affinity.scale(Point(x, y).buffer(1), rx, ry) for x, y in pts_])


SPOTS = mirror(spots())
# the black bars across the white outer tail feathers
TAIL_BARS = mirror(unary_union([box(390, y, 420, y + 4) for y in (290, 304, 318)]))


def check_body(name, parts):
    """The head and body parts must cover BODY (the wing parts have BODY cut out, so a gap would be an
    unpainted hole; CODEX1 found two beside the white back), and each must be one piece on each side."""
    for k, g in parts.items():
        parts[k] = g = unary_union([q for q in getattr(g, "geoms", [g]) if q.area >= 1])   # drop zero-area specks
        half = g.intersection(box(CX, -1, 999, 999))
        if half.geom_type != "Polygon": raise SystemExit(f"{name}: {k} is in {len(half.geoms)} pieces on one side")
    gap = BODY.difference(unary_union(list(parts.values()))).area
    if gap > 1: raise SystemExit(f"{name}: the body parts leave {gap:.0f} units² of BODY uncovered")


# ---------- from above ----------
def above():
    up = W.upper()
    # the white bar over each eye, out to the side of the head (a stroke left loose chips beside it)
    sup = HEAD.intersection(mirror(poly(f"M{CX + 9},52 L{CX + 40},52 L{CX + 40},86 L{CX + 15},86 Z")))
    patch = HEAD.intersection(box(CX - 13, 78, CX + 13, 99)).difference(sup)
    crown = HEAD.difference(sup).difference(patch)
    nape = BODY.intersection(box(0, 0, 999, 124)).difference(HEAD)
    # the white stripe runs down the middle of the back; the black scapulars cover the rest of the body's sides
    back = BODY.intersection(mirror(poly("M380,122 L394,126 L392,236 L380,240 Z")))
    scap = BODY.intersection(box(0, 122, 999, 236)).difference(back).difference(nape)
    lower = BODY.difference(HEAD).difference(nape).difference(back).difference(scap)
    # the uppertail coverts over the base of the tail, the rump above them (td-93f86b)
    utc = lower.intersection(box(0, 258, 999, 999))
    rump = lower.difference(utc)
    body_parts = {"crown": crown, "nape-patch": patch, "supercilium": sup, "nape": nape, "back": back,
                  "scapulars": scap, "rump": rump, "uppertail-coverts": utc}
    check_body("woodpecker-above", body_parts)
    final = {k: mirror(v) for k, v in up.items()}
    final.update(body_parts)
    final.update({ "tail": TAIL.difference(rump).difference(utc),   # the outer feathers are drawn over the whole tail (td-d32fd3)
                  "outer-tail-feathers": OTF.difference(rump).difference(utc), "bill": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
        final[k] = final[k].difference(BODY).difference(scap)
    # the white-spotted tips of the greater and median coverts, two rows that read as wing bars, drawn over them (td-2a2f94)
    r0, r1, _ = W.rows
    final["wing-bars"] = unary_union([mirror(W.arm.band(0, 1, r0 - 0.01, r0 + 0.08)).intersection(final["greater-coverts"]),
                                      mirror(W.arm.band(0, 1, r1 - 0.01, r1 + 0.07)).intersection(final["median-coverts"])])
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tail", "eye", "mf"), ("outer-tail-feathers", "pale", "mf"), ("uppertail-coverts", "eye", "mf"), ("rump", "eye", "mf"),
            ("secondaries", "eye", "mf"), ("primaries", "eye", "mf"),
            ("wing-coverts", "eye", "m"), ("lesser-coverts", "eye", "f"), ("median-coverts", "eye", "f"),
            ("greater-coverts", "eye", "f"), ("primary-coverts", "eye", "f"), ("alula", "eye", "f"),
            ("wing-bars", "eye", "mf"), ("tertials", "eye", "mf"), ("back", "pale", "mf"), ("scapulars", "eye", "mf"),
            ("nape", "eye", "mf"), ("crown", "eye", "mf"), ("nape-patch", "accent", "mf"), ("supercilium", "pale", "mf"),
            ("bill", "linegray", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines().difference(W.pc_shape()).difference(up["alula"]))
    wing_spots = [(SPOTS, "pale")]
    marks = {k: wing_spots for k in ("secondaries", "primaries", "wing-coverts", "median-coverts", "greater-coverts", "wing-bars", "tertials")}
    marks["outer-tail-feathers"] = [(TAIL_BARS, "eye")]
    build("woodpecker-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks=marks,
          base_over=[(lines, "linegray"), (EYES, "linegray")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.44, ax=(0.20, 0.10, 0.60))
    head = HEAD.intersection(box(0, 44, 999, 999))
    ear = head.difference(box(CX - 17, 0, CX + 17, 999))
    sub = head.intersection(box(CX - 17, 0, CX + 17, 999)).difference(box(CX - 13, 0, CX + 13, 999))
    malar = mirror(poly(f"M{CX + 8},48 L{CX + 13},48 L{CX + 15},104 L{CX + 10},106 Z")).intersection(BODY).difference(ear).difference(sub)
    throat = BODY.intersection(box(0, 0, 999, 112)).difference(ear).difference(sub).difference(malar)
    rest = BODY.difference(HEAD).difference(throat).difference(malar)
    breast = rest.intersection(box(0, 0, 999, 172))
    utc = rest.intersection(mirror(poly("M380,244 L410,244 C406,258 400,270 394,278 L380,282 Z")))
    flanks = rest.difference(breast).difference(utc).difference(box(CX - 13, 0, CX + 13, 999))
    belly = rest.difference(breast).difference(utc).difference(flanks)
    body_parts = {"ear-coverts": ear, "submoustachial": sub, "malar": malar, "throat": throat, "breast": breast,
                  "flanks": flanks, "belly": belly, "undertail-coverts": utc}
    check_body("woodpecker-below", body_parts)
    final = {k: mirror(v) for k, v in un.items()}
    final.update(body_parts)
    final.update({"tail": TAIL.difference(utc), "outer-tail-feathers": OTF.difference(utc), "bill": BILL})
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "eye", "m"), ("outer-tail-feathers", "pale", "m"),
            ("secondaries", "linegray", "m"), ("primaries", "linegray", "m"),
            ("underwing-coverts", "pale", "m"), ("axillaries", "pale", "m"),
            ("belly", "pale", "m"), ("flanks", "pale", "m"), ("undertail-coverts", "pale", "m"), ("breast", "pale", "m"),
            ("throat", "pale", "m"), ("malar", "eye", "m"), ("submoustachial", "pale", "m"), ("ear-coverts", "eye", "m"),
            ("bill", "linegray", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(sec_to=0.44).difference(un["underwing-coverts"]))
    under_spots = [(SPOTS, "pale")]
    build("woodpecker-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"secondaries": under_spots, "primaries": under_spots, "outer-tail-feathers": [(TAIL_BARS, "eye")]},
          base_over=[(lines, "pale"), (EYES, "linegray")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

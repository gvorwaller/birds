"""Adult male Rose-ringed Parakeet in flight, from above and from below (td-72fe55).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A parakeet's wings are long, narrow
and pointed, and the long, graduated tail tapers to a point. From above the coverts are green, the flight feathers
darker green, and the rose band of the male's ring crosses the nape; from below the bib and ring show under the red
bill, the underwing coverts are green, the flight feathers grey, and the undertail yellowish.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M408,192 C440,184 480,180 520,180", "M410,292 C440,294 480,292 520,286"),
         ("M520,180 C600,184 680,206 748,258", "M520,286 C600,288 680,276 748,258"),
         rows=(0.40, 0.60, 0.75), tips=10, tip_amp=0.02, tertials=(0.24, 0.52), pc=(0.40, 0.50, 1.1), alula=(0.12, 0.84))
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 138).buffer(1), 34, 38)
BODY = mirror(poly("M380,140 L406,160 C418,196 422,240 421,282 C419,316 412,346 400,368 L380,374 Z")).union(HEAD)
# the deep red bill points forward, its hooked tip curving down under the head
BILL = mirror(poly("M380,78 Q392,80 396,92 L398,108 L380,112 Z"))
# the long, graduated tail, tapering to a point
TAIL = mirror(poly("M380,350 L404,350 C406,420 401,500 394,580 C389,640 384,680 380,708 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 25, 124).buffer(3.4))
VB = [0, 0, 760, 720]


def one_piece(final, ids):
    """Each head and body part is one piece on each side of the midline (the tubenose and auk gate),
    after dropping zero-area specks; a stray piece would be selected with the part far from it."""
    for k in ids:
        g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
        right = g.intersection(box(CX, -999, 9999, 9999))
        n = len(getattr(right, "geoms", [right])) if not right.is_empty else 0
        if n != 1: raise SystemExit(f"parrot flight: {k} is in {n} pieces on the right side: {[(round(q.area), [round(v) for v in q.bounds]) for q in getattr(right, 'geoms', [right])]}")
        final[k] = g


def wing_bars(up):
    """Where wing bars would be (a Rose-ringed Parakeet has none): the tips of the median and greater coverts."""
    a = W.arm
    r0, r1, r2 = W.rows
    # rows run from the trailing edge (f=0) to the leading edge (f=1), so a row's tips are its rear edge
    return unary_union([a.band(0, 1, r0 - 0.03, r0 + 0.05).intersection(up["greater-coverts"]),
                        a.band(0, 1, r1 - 0.03, r1 + 0.04).intersection(up["median-coverts"])])


# ---------- from above ----------
def above():
    up = W.upper()
    wb = wing_bars(up)
    # where a speculum would be: the middle of the secondaries' exposed band (an amazon's red patch)
    spec = W.arm.band(0.22, 0.92, 0.10, 0.30).intersection(up["secondaries"])
    crown = HEAD.intersection(box(0, 0, 999, 146))
    # the rose band of the male's ring across the nape, the bluish nape above it
    ring = BODY.intersection(mirror(poly("M380,160 L404,154 L414,166 L380,174 Z")))
    above_ring = mirror(poly("M380,0 L760,0 L760,166 L414,166 L380,174 Z"))
    nape = HEAD.union(BODY).intersection(above_ring).difference(crown).difference(ring)
    scap = mirror(poly("M404,192 C420,212 428,240 428,266 C428,286 424,302 418,314 L410,312 C410,280 410,240 404,192 Z")).intersection(BODY)
    back = BODY.intersection(box(0, 0, 999, 320)).difference(above_ring).difference(scap)
    rump = BODY.intersection(box(0, 320, 999, 348)).difference(scap)
    # the uppertail coverts lie over the base of the tail, below the rump
    utc = BODY.union(TAIL).intersection(box(0, 348, 999, 392))
    tail = TAIL.difference(rump).difference(utc)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape, "neck-ring": ring, "back": back, "scapulars": scap, "rump": rump,
                  "uppertail-coverts": utc, "tail": tail, "bill": BILL, "wing-bars": mirror(wb), "speculum": mirror(spec)})
    one_piece(final, ("crown", "nape", "neck-ring", "back", "scapulars", "rump", "uppertail-coverts", "tail"))
    for k in ("lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "tertials", "alula", "primary-coverts"):
        final[k] = final[k].difference(BODY)
    final["wing-bars"] = final["wing-bars"].difference(BODY)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tail", "parakeet", "mf"), ("rump", "parakeet", "mf"), ("uppertail-coverts", "parakeet", "mf"),
            ("secondaries", "mallardgreen", "mf"), ("speculum", "mallardgreen", "f"), ("primaries", "mallardgreen", "mf"),
            ("wing-coverts", "parakeet", "m"), ("lesser-coverts", "parakeet", "f"), ("median-coverts", "parakeet", "f"),
            ("greater-coverts", "parakeet", "f"), ("primary-coverts", "parakeet", "f"), ("alula", "parakeet", "f"),
            ("wing-bars", "parakeet", "mf"), ("tertials", "parakeet", "mf"),
            ("back", "parakeet", "mf"), ("scapulars", "parakeet", "mf"), ("nape", "gullgray", "mf"), ("neck-ring", "legpink", "mf"),
            ("crown", "parakeet", "mf"), ("bill", "accent", "mf")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(n_sec=9, n_prim=10).difference(W.pc_shape()).difference(up["alula"]))
    # the long central tail feathers are bluish above
    central = mirror(poly("M380,392 L392,392 C392,470 389,570 385,660 L380,708 Z")).intersection(tail)
    build("parrot-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"tail": [(central, "water")]},
          base_over=[(lines, "darker"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.46, ax=(0.32, 0.10, 0.62))
    # the black bib under the bill, and the black ring round the neck below it
    throat = BODY.intersection(mirror(poly("M380,112 L398,112 L394,150 L380,160 Z")))
    ring = HEAD.union(BODY).intersection(mirror(poly("M380,160 L394,150 L414,150 L418,166 L380,176 Z"))).difference(throat)
    face = HEAD.difference(throat).difference(ring)
    breast = BODY.difference(HEAD).difference(throat).difference(ring).intersection(box(0, 0, 999, 250))
    utc = mirror(poly("M380,322 L414,322 C410,344 404,360 398,372 Q390,378 380,378 Z")).intersection(BODY)
    belly = BODY.intersection(mirror(poly("M380,250 L404,250 C406,280 404,306 400,322 L380,322 Z"))).difference(utc)
    flanks = BODY.difference(HEAD).difference(throat).difference(ring).difference(breast).difference(utc).difference(belly)
    # the body (undertail coverts and flanks) lies over the base of the tail
    tail = TAIL.difference(BODY)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"face": face, "throat": throat, "neck-ring": ring, "breast": breast, "flanks": flanks, "belly": belly,
                  "undertail-coverts": utc, "tail": tail, "bill": BILL})
    one_piece(final, ("throat", "neck-ring", "breast", "flanks", "belly", "undertail-coverts", "tail"))
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "billyellow", "m"), ("secondaries", "linegray", "m"), ("primaries", "linegray", "m"),
            ("underwing-coverts", "parakeet", "m"), ("axillaries", "parakeet", "m"),
            ("belly", "parakeet", "m"), ("flanks", "parakeet", "m"), ("undertail-coverts", "parakeet", "m"), ("breast", "parakeet", "m"),
            ("face", "parakeet", "m"), ("neck-ring", "eye", "m"), ("throat", "eye", "m"), ("bill", "accent", "m")]
    order = [m[0] for m in meta]
    lines = mirror(W.lines(n_sec=9, n_prim=10, sec_to=0.46).difference(un["underwing-coverts"]))
    build("parrot-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "darker"), (EYES, "eye")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

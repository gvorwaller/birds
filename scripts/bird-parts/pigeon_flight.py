"""Adult Rock Pigeon (wild-type, blue-bar) in flight, from above and from below (td-72fe55).

Drawn in output coordinates, right half only, then mirrored (see flight.py). A pigeon's wings are long, broad
at the base and pointed; the head is small and the tail broad and rounded. From above the two black bars cross the
inner wing and the white lower back shows between the wings; from below the underwing is white. The black band at
the tip of the tail shows from both sides.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, LineString, box
from shapely.ops import unary_union
from shapely import affinity

W = Wing(("M410,118 C460,108 512,104 560,104", "M418,222 C470,232 530,236 580,234"),
         ("M560,104 C640,104 708,124 746,164", "M580,234 C640,230 700,212 746,164"),
         rows=(0.40, 0.60, 0.76), tips=10, tip_amp=0.012, tertials=(0.14, 0.56), pc=(0.40, 0.50, 1.1))
ARM = W.arm
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 62).buffer(1), 22, 24)
BODY = mirror(poly("M380,80 L398,84 C414,100 422,128 424,158 C426,198 418,238 404,266 L380,270 Z")).union(HEAD)
# the whole bill, joined to the head; from above the cere is drawn over its base, from below it is not seen
BILL_FULL = mirror(poly("M380,20 Q384,24 386,32 L387,44 L380,44 Z"))
CERE = mirror(poly("M380,33 L386,34 Q389,38 388,45 L380,46 Z"))
BILL = BILL_FULL.difference(CERE)
TAIL = mirror(poly("M380,256 L402,256 L430,368 Q406,386 380,388 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 15, 56).buffer(2.6))
# the black band at the tip of the tail, drawn over the whole tail
TAIL_BAND = TAIL.intersection(mirror(poly("M380,346 L440,346 L440,400 L380,400 Z")))
VB = [0, 0, 760, 420]


def one_piece(final, ids):
    """Each head and body part is one piece on each side of the midline (the tubenose and auk gate)."""
    for k in ids:
        g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
        right = g.intersection(box(CX, -999, 9999, 9999))
        n = len(getattr(right, "geoms", [right])) if not right.is_empty else 0
        if n != 1: raise SystemExit(f"pigeon flight: {k} is in {n} pieces on the right side")
        final[k] = g


def joined(view, bill, outline):
    """The bill touches the head and the outline is one shape (CODEX1: from below, the bill without its cere floated
    ahead of the head)."""
    if bill.distance(HEAD) > 0.01: raise SystemExit(f"pigeon {view}: the bill is {bill.distance(HEAD):.1f} units from the head")
    if outline.geom_type != "Polygon": raise SystemExit(f"pigeon {view}: the outline is in {len(outline.geoms)} pieces")


def tail_lines(w=0.9):
    """Six pairs of tail feathers fanning from the tail base."""
    ls = [LineString([(CX + 3.6 * i, 262), (CX + 8.4 * i, 388)]).buffer(w / 2, cap_style=2) for i in range(1, 6)]
    return mirror(unary_union(ls)).intersection(TAIL)


# ---------- from above ----------
def above():
    up = W.upper()
    r0 = W.rows[0]
    # the two black bars across the inner wing (National Geographic): the black tips of the greater coverts, and behind
    # them the black ends of the inner secondaries, each drawn over the feathers that carry it
    bars = unary_union([ARM.band(0, 0.66, r0, r0 + 0.065).intersection(up["greater-coverts"]),
                        ARM.band(0, 0.60, r0 - 0.13, r0 - 0.065).intersection(up["secondaries"])])
    crown = HEAD.intersection(box(0, 0, 999, 64))
    nape = HEAD.union(BODY.intersection(box(0, 0, 999, 104))).difference(crown)
    # the iridescent sides of the neck, seen from above as a band on each side behind the head
    neck = BODY.intersection(mirror(poly("M388,82 C400,88 410,100 414,114 L398,116 C394,102 390,92 384,86 Z")))
    nape = nape.difference(neck)
    # the scapulars: the outer strip of the back along each side, over the base of the wing
    scap = mirror(poly("M398,104 L470,104 L470,226 L402,226 C400,186 400,140 398,104 Z")).intersection(BODY).difference(HEAD)
    back = BODY.intersection(box(0, 104, 999, 226)).difference(scap).difference(neck)
    # the white lower back between the wings, then the uppertail coverts over the base of the tail
    rump = BODY.intersection(box(0, 226, 999, 254)).difference(scap)
    utc = BODY.union(TAIL).intersection(box(0, 254, 999, 282))
    tail = TAIL.difference(utc)
    final = {k: mirror(v) for k, v in up.items()}
    final.update({"crown": crown, "nape": nape, "neck-patch": neck, "back": back, "scapulars": scap, "rump": rump.difference(utc),
                  "uppertail-coverts": utc, "tail": tail, "tail-band": TAIL_BAND.difference(utc), "bill": BILL, "cere": CERE,
                  "wing-bars": mirror(bars)})
    one_piece(final, ("crown", "nape", "neck-patch", "back", "scapulars", "rump", "uppertail-coverts", "tail", "tail-band"))
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "wing-bars"):
        final[k] = final[k].difference(BODY)
    # the bars are covert tips drawn over these areas, never holes in them (CODEX1, td-2a2f94)
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    meta = [("tail", "gullgray", "mf"), ("tail-band", "eye", "mf"), ("uppertail-coverts", "gullgray", "mf"), ("rump", "pale", "mf"),
            ("secondaries", "gullgray", "mf"), ("primaries", "linegray", "mf"),
            ("wing-coverts", "gullpale", "m"), ("lesser-coverts", "gullpale", "f"), ("median-coverts", "gullpale", "f"),
            ("greater-coverts", "gullpale", "f"), ("primary-coverts", "gullgray", "f"), ("alula", "gullgray", "f"),
            ("wing-bars", "eye", "mf"), ("tertials", "gullgray", "mf"),
            ("back", "gullgray", "mf"), ("scapulars", "gullgray", "mf"), ("neck-patch", "mallardgreen", "mf"), ("nape", "linegray", "mf"),
            ("crown", "linegray", "mf"), ("bill", "eye", "mf"), ("cere", "pale", "mf")]
    lines = mirror(W.lines(n_sec=10, n_prim=10).difference(W.pc_shape()).difference(up["alula"])).union(tail_lines())
    joined("above", final["bill"].union(CERE), SIL.union(BILL).union(CERE))
    build("pigeon-above", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "linegray"), (EYES, "eye")], outline=SIL.union(BILL).union(CERE))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.44, ax=(0.18, 0.10, 0.62))
    chin = HEAD.intersection(box(0, 0, 999, 60))
    throat = HEAD.union(BODY.intersection(box(0, 0, 999, 100))).difference(chin)
    breast = BODY.intersection(mirror(poly("M380,96 L450,96 L450,160 Q414,174 380,178 Z"))).difference(throat)
    utc = BODY.intersection(mirror(poly("M380,232 Q404,226 450,220 L450,320 L380,320 Z")))
    belly = BODY.intersection(mirror(poly("M380,170 Q396,168 406,164 L406,236 L380,236 Z"))).difference(breast).difference(utc)
    flanks = BODY.difference(throat).difference(chin).difference(breast).difference(belly).difference(utc)
    # the red feet tucked under the body, beside the undertail coverts
    feet = mirror(affinity.rotate(affinity.scale(Point(394, 238).buffer(1), 4.5, 11), -12, origin=(394, 238)))
    tail = TAIL.difference(utc)
    final = {k: mirror(v) for k, v in un.items()}
    final.update({"chin": chin, "throat": throat, "breast": breast, "belly": belly.difference(feet), "flanks": flanks.difference(feet),
                  "undertail-coverts": utc.difference(feet), "toes": feet, "tail": tail, "tail-band": TAIL_BAND.difference(utc),
                  "bill": BILL_FULL})
    one_piece(final, ("chin", "throat", "breast", "belly", "flanks", "undertail-coverts", "tail", "tail-band"))
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "underwing-coverts", "axillaries"):
        final[k] = final[k].difference(BODY)
    meta = [("tail", "gullgray", "m"), ("tail-band", "eye", "m"), ("secondaries", "gullgray", "m"), ("primaries", "gullgray", "m"),
            ("underwing-coverts", "pale", "m"), ("axillaries", "pale", "m"),
            ("belly", "gullgray", "m"), ("flanks", "gullgray", "m"), ("breast", "linegray", "m"), ("undertail-coverts", "gullgray", "m"),
            ("throat", "linegray", "m"), ("chin", "linegray", "m"), ("toes", "accent", "m"), ("bill", "eye", "m")]
    lines = mirror(W.lines(n_sec=10, n_prim=10, sec_to=0.46).difference(un["underwing-coverts"])).union(tail_lines())
    joined("below", final["bill"], SIL.union(BILL_FULL))
    build("pigeon-below", final, meta, [m[0] for m in meta], VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          base_over=[(lines, "linegray"), (EYES, "eye")], outline=SIL.union(BILL_FULL))


if __name__ == "__main__":
    above()
    below()

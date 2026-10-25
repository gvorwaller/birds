"""Adult Rock Pigeon (wild-type, blue-bar) standing on a rock, side view (td-72fe55).

Traced from a left-facing reference photo (proportions only; listed in src/lib/bird-parts/pigeon.ts),
scaled and mirrored to face right. A pigeon has a small head on a large, compact body, a short bill with a
fleshy cere at its base, short red legs, and on the Rock Pigeon an iridescent green-and-purple neck, two
black bars across the pale grey folded wing, a white lower back and a black band at the tail tip.
"""
from geom import *
from common import build
from shapely import affinity
from shapely.geometry import Point
from shapely.ops import unary_union

K, X0, Y0 = 0.85, 959, -125


def F(g):
    """Photo coordinates -> output: scale and mirror to face right."""
    return affinity.translate(affinity.scale(g, -K, K, origin=(0, 0)), X0, Y0).buffer(0)


# head, body and tail (the bill and cere are separate); the feathered thigh bulges below the belly
SIL = poly("M452,214 C450,200 455,188 465,180 C478,170 495,166 512,167 C535,168 553,177 562,190 "
           "C572,203 580,222 592,242 C605,260 625,272 648,282 C690,300 745,335 795,375 "
           "C840,415 880,460 915,505 C950,545 985,585 1020,622 C1050,652 1080,680 1105,702 "
           "C1090,712 1065,722 1040,724 C1000,712 960,690 925,668 C880,650 830,630 780,618 "
           "C750,614 728,612 714,616 C708,624 700,632 688,634 C672,636 658,630 648,620 "
           "C642,614 638,606 632,598 C600,572 560,540 528,505 C495,470 470,430 458,385 "
           "C450,350 452,315 458,285 C463,265 462,248 456,236 C455,232 454,229 455,226 Z")
EYE = (507, 197)
BILL = poly("M414,241 C420,229 432,219 450,212 L458,213 L458,228 C446,230 430,235 414,241 Z")
# the small off-white cere, a fleshy saddle over the base of the upper bill
CERE = affinity.rotate(affinity.scale(Point(450, 211).buffer(1), 11, 6), -22, origin=(450, 211))
BILL = BILL.difference(CERE)
# the folded wing, from the bend of the wing back to the primary tips, just short of the tail tip; its upper
# edge drops below the back near the tail, where the white lower back shows
WOUT = SIL.intersection(poly("M560,292 C600,288 650,300 700,322 C760,352 820,400 862,448 "
                             "C898,490 925,530 955,572 C985,612 1025,655 1075,692 "
                             "C1040,692 1000,676 960,656 C905,630 855,606 805,591 "
                             "C760,579 715,568 670,553 C625,538 592,515 572,480 "
                             "C548,440 540,380 545,335 C548,312 552,298 560,292 Z"))
LEG = unary_union([stroke("M674,628 L662,700", 12),
                   stroke("M660,700 Q620,702 574,699", 8), stroke("M660,701 Q630,707 598,714", 8),
                   stroke("M662,700 L704,701", 7)])
TARSUS = stroke("M674,628 L662,700", 12).difference(SIL)
TOES = LEG.difference(SIL).difference(TARSUS)
ROCK = stroke("M520,716 Q640,708 770,718", 16)

eye_disk = Point(*EYE).buffer(7.5)
body_rough = [
    ("belly", poly("M440,380 L600,380 L700,560 L720,660 L620,660 L460,460 Z")),
    ("flanks", poly("M590,500 L700,550 L800,580 L900,620 L930,672 L780,622 L700,612 L640,590 L600,560 Z")),
    ("undertail-coverts", poly("M760,600 L930,640 L940,700 L770,640 Z")),
    ("breast", poly("M440,310 L540,318 L580,420 L560,470 L520,480 L440,450 Z")),
    ("back", poly("M600,250 L690,284 L790,362 L870,440 L880,470 L800,400 L700,330 L610,300 Z")),
    ("rump", poly("M900,470 L960,540 L1000,585 L1030,625 L1000,630 L955,585 L905,520 Z")),
    ("tail", poly("M1012,612 L1120,690 L1120,760 L1030,760 L900,676 L925,650 L980,640 Z")),
    ("neck-patch", poly("M532,220 C560,212 590,222 606,248 C620,270 636,284 646,296 C630,318 600,338 560,342 "
                        "C520,344 490,334 468,320 C462,300 466,284 480,272 C500,258 515,236 532,220 Z")),
    ("nape", poly("M550,150 L600,165 L625,262 L596,258 L570,236 L554,200 Z")),
    ("throat", poly("M440,238 L486,240 C478,258 474,280 480,302 L440,302 Z")),
    ("chin", poly("M440,224 L472,226 L474,244 L440,244 Z")),
    ("crown", poly("M440,150 L560,150 L556,184 L540,181 L500,180 L478,182 L470,178 Z")),
    ("forehead", poly("M440,160 L476,174 L486,186 L474,200 L458,212 L440,212 Z")),
    ("ear-coverts", poly("M512,203 L560,201 L574,236 L512,240 Z")),
    ("malar", poly("M456,222 L500,212 L518,204 L518,240 L470,244 Z")),
    ("supercilium", poly("M476,180 L548,178 L550,189 L476,190 Z")),
    ("eye-line", poly("M516,189 L556,187 L560,203 L516,206 Z")),
    ("lores", poly("M460,188 L500,186 L500,216 L462,224 Z")),
    ("eye-ring", Point(*EYE).buffer(13.5).difference(Point(*EYE).buffer(10.5))),
    ("orbital-ring", Point(*EYE).buffer(10.5).difference(eye_disk)),
]
final = {}
claimed = WOUT.union(BILL).union(CERE).union(eye_disk)
for pid, rough in reversed(body_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
# what no rough shape reached (thin gaps between the head areas, a corner of the belly) goes to the part it shares
# the longest edge with, so the parts tile the bird with no unpainted strips
names = [k for k, _ in body_rough]
left = SIL.difference(claimed)
for q in [q for q in getattr(left, "geoms", [left]) if q.area > 0]:
    ring = q.buffer(0.8)
    best = max(names, key=lambda n: ring.intersection(final[n]).area)
    final[best] = final[best].union(q).buffer(0.01).buffer(-0.01)
final["bill"] = BILL
final["cere"] = CERE
final["tarsus"] = TARSUS
final["toes"] = TOES

# every head and body part is one piece (the tubenose's lesson: a remainder part soaks up stray slivers)
def one_piece(ids):
    for k in ids:
        g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 3])   # drop sub-unit specks
        if g.geom_type != "Polygon":
            raise SystemExit(f"pigeon: {k} is in {len(g.geoms)} pieces: {[(round(q.area), [round(v) for v in q.bounds]) for q in g.geoms]}")
        final[k] = g


one_piece([k for k, _ in body_rough] + ["bill", "cere", "tarsus"])

# the black band at the tip of the tail, drawn over the whole tail (the tail stays the whole tail for "rectrices")
final["tail-band"] = final["tail"].intersection(poly("M1046,600 L1160,600 L1160,780 L1000,780 L1010,712 Z"))
# the uppertail coverts lie over the base of the tail, across the line where the white rump meets it
utc = poly("M980,594 L1042,626 L1015,664 L966,642 Z")
final["uppertail-coverts"] = utc.intersection(final["rump"].union(final["tail"]))
for k in ("rump", "tail"):
    final[k] = final[k].difference(utc)
one_piece(["tail-band", "uppertail-coverts", "rump", "tail"])

# wing: the scapulars along the back, the covert rows (lesser at the front, then median, then greater, which carry
# both black bars), the dark tertials over the rear, the secondaries showing along the lower edge, the alula and
# primary coverts at the bend, and the long primaries out to the tip
W = {}
W["primaries"] = WOUT.intersection(poly("M760,575 L860,548 L925,528 L965,575 L1110,705 L760,650 Z"))
W["tertials"] = WOUT.intersection(poly("M848,438 L900,482 L945,540 L925,556 L882,548 L860,520 L838,478 Z")).difference(W["primaries"])
W["scapulars"] = WOUT.intersection(poly("M540,280 L700,306 L800,368 L862,428 L846,444 L780,398 L690,346 L600,326 L540,322 Z")).difference(W["tertials"])
taken = unary_union(list(W.values()))
# the exposed inner secondaries: everything below the line between the two bars, back to the tertials and primaries,
# so the rear bar (their black tips) lies on them
W["secondaries"] = WOUT.intersection(poly("M600,552 L884,484 L960,560 L860,592 L770,606 L600,592 Z")).difference(taken)
taken = taken.union(W["secondaries"])
W["alula"] = WOUT.intersection(poly("M556,452 L598,466 L612,518 L572,498 Z")).difference(taken)
taken = taken.union(W["alula"])
W["primary-coverts"] = WOUT.intersection(poly("M598,476 L662,512 L684,558 L622,544 L600,516 Z")).difference(taken)
taken = taken.union(W["primary-coverts"])
# the rows run parallel to the bars: lesser along the front and top, then median, then greater, whose tips make the bars
W["lesser-coverts"] = WOUT.intersection(poly("M520,270 L820,330 L780,366 L540,424 L520,424 Z")).difference(taken)
taken = taken.union(W["lesser-coverts"])
W["median-coverts"] = WOUT.intersection(poly("M520,424 L540,424 L780,366 L850,430 L600,494 L520,494 Z")).difference(taken)
taken = taken.union(W["median-coverts"])
rest = WOUT.difference(taken)
W["greater-coverts"] = largest(rest)
# the slivers the rough rows leave between them go to the row they share the longest edge with
for q in [q for q in getattr(rest, "geoms", [rest]) if q.area > 0 and not q.equals(W["greater-coverts"])]:
    ring = q.buffer(0.8)
    best = max(W, key=lambda n: ring.intersection(W[n]).area)
    W[best] = W[best].union(q).buffer(0.01).buffer(-0.01)
for k, v in W.items():
    final[k] = v
one_piece(list(W))
# the covert rows as one area in the main layer, as on the other birds; closed up so the rows show no seams
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)
# the two black bars (National Geographic): the black tips of the greater coverts, and behind them the black tips of the
# inner secondaries, each drawn over the feathers that carry it (never cut out of them)
BAR_GC = poly("M850,446 L858,466 C810,480 760,494 700,508 C670,515 640,522 616,526 L610,508 C636,503 668,497 698,490 C756,476 806,462 850,446 Z")
BAR_SEC = poly("M888,508 L896,528 C850,540 800,552 750,562 C726,567 706,570 690,573 L686,556 C706,552 724,549 746,544 C796,533 846,521 888,508 Z")
final["wing-bars"] = BAR_GC.intersection(final["greater-coverts"]).union(BAR_SEC.intersection(final["secondaries"]))

# the head parts the close-up draws again, kept in photo coordinates before the bird is placed
INSET_PARTS = ("forehead", "crown", "nape", "lores", "supercilium", "eye-line", "eye-ring", "orbital-ring", "ear-coverts",
               "malar", "chin", "throat", "neck-patch", "bill", "cere")
photo = {k: final[k] for k in INSET_PARTS}
final = {k: F(v) for k, v in final.items()}

# The inset: the head again, larger, in the empty top left of the plate (the tubenose's close-up machinery). The small
# head parts are the same parts as on the bird, so a tap on either selects them.
IC, IR, SI = (148, 128), 112, 1.3
def FI(g):
    """Photo coordinates -> the close-up: mirrored to face right, the eye at the circle's centre."""
    return affinity.translate(affinity.scale(g, -SI, SI, origin=EYE), IC[0] - 36 - EYE[0], IC[1] - 24 - EYE[1]).buffer(0)
clip_i = Point(*IC).buffer(IR - 4)
HEAD_PHOTO = unary_union([SIL.intersection(poly("M380,120 L660,120 L660,340 L380,340 Z")), BILL, CERE])
HEAD_I = FI(HEAD_PHOTO).intersection(clip_i)
inset = {k: FI(v).intersection(clip_i) for k, v in photo.items()}
inset = {k: v for k, v in inset.items() if v.area >= 3}
BIRD_OUTLINE = F(unary_union([SIL, BILL, CERE]))
gap = BIRD_OUTLINE.distance(Point(*IC).buffer(IR))
if gap < 6: raise SystemExit(f"pigeon: the close-up is {gap:.1f} units from the bird")
for k in ("bill", "cere", "orbital-ring", "eye-ring", "lores"):
    if k not in inset: raise SystemExit(f"pigeon: the close-up lacks {k}")

META = [
    ("tail", "gullgray", "mf"), ("tail-band", "eye", "mf"), ("rump", "pale", "mf"), ("uppertail-coverts", "gullgray", "mf"),
    ("undertail-coverts", "gullgray", "mf"), ("belly", "gullgray", "mf"), ("flanks", "gullgray", "mf"), ("breast", "linegray", "mf"),
    ("back", "gullgray", "mf"), ("neck-patch", "mallardgreen", "mf"), ("nape", "linegray", "mf"),
    ("throat", "linegray", "mf"), ("chin", "linegray", "mf"), ("crown", "linegray", "mf"), ("forehead", "linegray", "mf"),
    ("ear-coverts", "linegray", "mf"), ("malar", "linegray", "mf"), ("supercilium", "linegray", "mf"), ("eye-line", "linegray", "mf"),
    ("lores", "linegray", "mf"), ("eye-ring", "linegray", "mf"), ("orbital-ring", "gullpale", "mf"),
    ("wing-coverts", "gullpale", "m"), ("lesser-coverts", "gullpale", "f"), ("median-coverts", "gullpale", "f"),
    ("greater-coverts", "gullpale", "f"), ("alula", "gullgray", "f"), ("primary-coverts", "gullgray", "f"),
    ("scapulars", "gullgray", "mf"), ("secondaries", "gullgray", "mf"), ("tertials", "linegray", "mf"), ("primaries", "linegray", "mf"),
    ("wing-bars", "eye", "mf"),
    ("bill", "eye", "mf"), ("cere", "pale", "mf"), ("tarsus", "accent", "mf"), ("toes", "accent", "mf"),
]
order = [m[0] for m in META]
# the purple sheen on the lower neck, under the green (a mark, never a tap target)
PURPLE = poly("M460,296 C520,304 590,302 650,294 L650,350 L460,350 Z")
build("pigeon", final, META, order, [0, 0, 640, 530], dx=0, dy=0,
      base_under=[(F(ROCK), "perch"), (F(WOUT), "gullgray")],
      raw_base=[(HEAD_I, "linegray")],
      extra_raw=inset,
      insets=[{"cx": IC[0], "cy": IC[1], "r": IR, "label": "Head, close up"}],
      base_over=[(F(Point(*EYE).buffer(7.5)), "orange"), (F(Point(*EYE).buffer(3.6)), "eye"), (F(Point(EYE[0] - 2.5, EYE[1] - 2.5).buffer(1.4)), "pale"),
                 (FI(Point(*EYE).buffer(7.5)), "orange"), (FI(Point(*EYE).buffer(3.6)), "eye"), (FI(Point(EYE[0] - 2.5, EYE[1] - 2.5).buffer(1.4)), "pale")],
      outline=BIRD_OUTLINE.union(HEAD_I),
      marks={"neck-patch": [(F(PURPLE), "accent2")]})

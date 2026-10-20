"""Adult male Downy Woodpecker clinging to a trunk, side view, with a close-up of a foot (td-71bf41).

Traced from a reference photo of a Downy Woodpecker on a trunk, mirrored to face right (proportions
only; listed in src/lib/bird-parts/woodpecker.ts). The bird clings upright, propped on its stiff
tail, with its feet on the bark: two toes forward and two back. Black and white, with a white
stripe above and below the eye, a black malar stripe, white spots on the black wing, and the
male's red patch on the back of the head. The white back shows as a thin strip along the back edge.
"""
import math
from geom import *
from common import build
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely import affinity

# head, body and folded wing (bill, tail and feet are separate)
SIL = poly("M700,288 C690,280 668,270 640,264 C600,256 560,253 520,256 C486,259 462,272 450,290 "
           "C440,308 438,340 436,370 C434,395 422,418 412,448 C402,480 398,540 398,600 "
           "C398,680 410,750 428,800 C440,832 452,860 468,885 C500,935 530,960 560,990 C590,1025 615,1065 642,1112 L652,1060 "
           "C648,1010 642,970 645,945 C680,955 740,960 792,950 L792,860 C793,760 792,650 788,560 "
           "C782,490 768,440 750,405 C738,375 724,346 708,322 L704,318 Z")
EYE = (604, 313)
BILL = poly("M698,287 L772,279 L770,284 C750,294 728,306 706,319 C702,308 699,298 698,287 Z")
# the bristly feathers over the nostrils, at the base of the bill
TUFTS = poly("M642,302 C646,288 668,280 700,286 C703,296 705,306 706,316 C694,322 676,326 660,324 C650,320 644,312 642,302 Z")
# the stiff tail, its tip against the bark below the feet
TAIL = poly("M648,925 C665,918 690,916 714,924 C742,960 772,1010 792,1060 L801,1160 L794,1167 "
            "C770,1122 735,1062 700,1012 C680,982 662,952 648,925 Z")
OTF = TAIL.intersection(poly("M688,936 L760,936 L800,1050 L800,1094 Q772,1066 742,1036 Q716,1006 700,980 Z"))
TRUNK = poly("M800,150 C806,380 794,620 801,860 C804,980 798,1100 803,1250 L1000,1250 L1000,150 Z")
CRACKS = unary_union([stroke(d, 3) for d in ("M860,220 C852,300 866,380 858,470", "M900,520 C888,610 904,700 892,790",
                                              "M846,860 C856,940 842,1020 852,1110", "M930,300 L940,420")])

# the wing: the white back shows as a strip between the back edge and the folded wing
WOUT = SIL.intersection(poly("M470,404 L548,418 C562,500 567,600 564,700 C561,780 600,880 645,945 L668,1000 "
                             "L668,1130 L600,1130 L380,900 L478,834 C466,790 462,740 462,680 C462,600 462,520 470,446 L470,404 Z"))

# legs on the bird: the tarsus from the belly feathers to the foot on the bark
TARSUS = stroke("M750,556 L782,490", 11)
TOES = unary_union([stroke("M782,490 L787,458 L791,440", 8), stroke("M791,442 Q793,430 801,428", 4.5),
                    stroke("M783,489 L794,464 L799,452", 7.5), stroke("M799,454 Q802,446 808,446", 4),
                    stroke("M782,494 L790,528 L795,556", 8), stroke("M795,554 Q797,566 805,568", 4.5),
                    stroke("M780,496 L788,520 L796,538", 7.5), stroke("M796,536 Q800,544 807,544", 4)])

head_rough = [
    ("belly", SIL),
    ("undertail-coverts", poly("M600,872 Q700,880 800,868 L800,1000 L600,1000 Z")),
    ("flanks", poly("M552,560 L636,560 Q644,720 690,880 L600,900 L552,800 Z")),
    ("breast", poly("M540,412 L800,412 L800,650 Q700,636 600,646 L540,646 Z")),
    ("throat", poly("M694,316 L712,312 L800,300 L800,440 L720,436 L640,428 L540,420 L466,420 L466,404 L500,398 L540,392 L600,384 L650,370 L690,352 L712,326 Z")),
    ("back", poly("M380,446 L470,446 C462,520 462,600 462,680 C462,740 466,790 478,834 L380,900 Z")),
    ("nape", poly("M380,345 L440,340 L466,330 L466,404 L472,404 L472,446 L380,446 Z")),
    ("malar", poly("M712,318 L690,328 L672,334 L650,346 L600,358 L540,368 L500,374 L466,378 L466,404 L500,398 L540,392 "
                   "L600,384 L650,370 L690,352 L712,326 Z").union(box(696,314, 716, 330))),
    ("submoustachial", poly("M690,328 L660,334 L640,334 L600,336 L550,341 L510,344 L466,342 L466,378 L500,374 L540,368 "
                            "L600,358 L650,346 L672,334 Z")),
    ("ear-coverts", poly("M700,286 L660,288 L632,288 L600,296 L560,298 L520,300 L490,310 L466,330 L466,342 L510,344 "
                         "L550,341 L600,336 L640,334 L660,334 L700,330 Z")),
    ("supercilium", poly("M632,288 L600,284 L560,278 L530,274 L505,272 L500,286 L478,294 L456,304 L440,312 L380,326 L380,345 "
                         "L440,340 L466,330 L490,310 L520,300 L560,298 L600,296 Z")),
    ("nape-patch", poly("M380,200 L505,200 L505,272 L500,286 L478,294 L456,304 L440,312 L380,326 Z")),
    ("crown", poly("M505,200 L760,200 L760,286 L700,286 L660,288 L632,288 L600,284 L560,278 L530,274 L505,272 Z")),
]
final = {}
claimed = WOUT.union(TUFTS).union(BILL)
for pid, rough in reversed(head_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
# every head and body part is one piece (the tubenose's lesson: a remainder part soaks up stray slivers)
for k, _ in head_rough:
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"woodpecker: {k} is in {len(g.geoms)} pieces")
    final[k] = g
final["nasal-tufts"] = TUFTS.intersection(SIL).difference(BILL)
final["bill"] = BILL
final["tail"] = TAIL.difference(SIL).difference(OTF)
final["outer-tail-feathers"] = OTF.difference(SIL)
final["tarsus"] = TARSUS
final["toes"] = TOES.difference(TARSUS)


# wing: rows across the folded wing, square to its long axis (which leans about 11 degrees)
def band(y0, y1):
    return poly(f"M300,{y0 + 40} L700,{y0 - 40} L700,{y1 - 40} L300,{y1 + 40} Z")


WROWS = {
    "scapulars": poly("M466,400 L498,400 C488,470 484,540 484,600 C484,650 486,690 490,720 L380,720 L380,400 Z"),
    "tertials": poly("M380,640 L496,620 C494,710 500,790 522,868 L440,900 L380,860 Z"),
    "lesser-coverts": band(380, 470),
    "median-coverts": band(470, 530),
    "greater-coverts": band(530, 602),
    "primaries": band(838, 1200),
}
claimed_w = Point(0, 0).buffer(0)
for k, rough in WROWS.items():
    final[k] = rough.intersection(WOUT).difference(claimed_w)
    claimed_w = claimed_w.union(final[k])
final["secondaries"] = WOUT.difference(claimed_w)
for k in ("scapulars", "tertials", "lesser-coverts", "median-coverts", "greater-coverts", "primaries", "secondaries"):
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1]).buffer(0)
    if g.geom_type != "Polygon": raise SystemExit(f"woodpecker: {k} is in {len(g.geoms)} pieces")
    final[k] = g
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)


# the white spots on the black wing: a row at the tips of the median and greater coverts, and rows
# across the flight feathers that read as bars (marks, never tap targets)
def spot(x, y, rx=7.5, ry=5.0):
    return affinity.rotate(affinity.scale(Point(x, y).buffer(1), rx, ry), -11)


def spot_row(y500, x0, x1, step, rx=7.5, ry=5.0):
    return [spot(x, y500 - 0.2 * (x - 500), rx, ry) for x in range(x0, x1 + 1, step)]


SPOTS = unary_union(spot_row(518, 478, 548, 26, 9, 6) + spot_row(590, 476, 556, 26, 9, 6)
                    + [g for y in (640, 690, 740, 790) for g in spot_row(y, 452, 572, 24)]
                    + [g for y in (870, 920, 970, 1020, 1068) for g in spot_row(y, 470, 660, 22, 6.5, 4.5)])
# the black bars across the white outer tail feathers
def tail_bar(t):
    (ax, ay), (bx, by) = (680, 930), (790, 1140)
    cx, cy = ax + (bx - ax) * t, ay + (by - ay) * t
    nx, ny = (by - ay), -(bx - ax)
    L = math.hypot(nx, ny); nx, ny = nx / L * 40, ny / L * 40
    return stroke(f"M{cx - nx:.1f},{cy - ny:.1f} L{cx + nx:.1f},{cy + ny:.1f}", 7)
TAIL_BARS = unary_union([tail_bar(t) for t in (0.3, 0.45, 0.6, 0.74)])

# The close-up: a foot on the bark, two toes forward (up the trunk) and two back, in output coordinates.
IC, IR = (150, 826), 110
clip_i = Point(*IC).buffer(IR - 4)
BARK_I = poly("M190,700 C196,760 186,820 194,880 C198,920 192,950 194,980 L300,980 L300,700 Z").intersection(clip_i)
BARK_I_LINES = unary_union([stroke(d, 2.2) for d in ("M222,736 C216,780 228,820 218,868", "M246,770 C240,830 252,880 244,930")]).intersection(clip_i)
J = (166, 826)
TARSUS_I = stroke(f"M52,890 L{J[0]},{J[1]}", 24).intersection(clip_i)
TOES_I = unary_union([stroke(f"M{J[0]},{J[1]} L176,780 L182,740", 14), stroke("M182,746 Q183,726 198,718", 7),
                      stroke(f"M{J[0]},{J[1]} L182,796 L190,770", 13), stroke("M189,774 Q192,758 204,754", 6.5),
                      stroke(f"M{J[0]},{J[1]} L178,872 L182,914", 14), stroke("M182,908 Q183,928 198,934", 7),
                      stroke(f"M{J[0]},{J[1]} L181,852 L190,878", 13), stroke("M189,874 Q193,890 205,893", 6.5)]
                     ).difference(TARSUS_I).intersection(clip_i)

META = [
    ("tail", "eye", "mf"), ("outer-tail-feathers", "pale", "mf"), ("undertail-coverts", "pale", "mf"), ("belly", "pale", "mf"),
    ("flanks", "pale", "mf"), ("breast", "pale", "mf"), ("throat", "pale", "mf"), ("back", "pale", "mf"),
    ("nape", "eye", "mf"), ("malar", "eye", "mf"), ("submoustachial", "pale", "mf"), ("ear-coverts", "eye", "mf"),
    ("supercilium", "pale", "mf"), ("nape-patch", "accent", "mf"), ("crown", "eye", "mf"), ("nasal-tufts", "light", "mf"),
    ("bill", "linegray", "mf"),
    ("wing-coverts", "eye", "m"), ("lesser-coverts", "eye", "f"), ("median-coverts", "eye", "f"), ("greater-coverts", "eye", "f"),
    ("secondaries", "eye", "mf"), ("scapulars", "eye", "mf"), ("tertials", "eye", "mf"), ("primaries", "eye", "mf"),
    ("tarsus", "linegray", "mf"), ("toes", "linegray", "mf"),
]
order = [m[0] for m in META]
wing_marks = [(SPOTS, "pale")]
marks = {k: wing_marks for k in ("wing-coverts", "median-coverts", "greater-coverts", "secondaries", "tertials", "primaries")}
marks["outer-tail-feathers"] = [(TAIL_BARS, "eye")]
DX, DY = 150, 210
eye = Point(*EYE).buffer(10.5)
build("woodpecker", final, META, order, [0, 0, 760, 980], dx=DX, dy=DY,
      base_under=[(TRUNK.intersection(box(0, DY, DX + 760, DY + 980)), "perch"),
                  (CRACKS.intersection(TRUNK).intersection(box(0, DY, DX + 760, DY + 980)), "dark")],
      raw_base=[(BARK_I, "perch"), (BARK_I_LINES, "dark")],
      extra_raw={"toes": TOES_I, "tarsus": TARSUS_I},
      insets=[{"cx": IC[0], "cy": IC[1], "r": IR, "label": "Foot, close up"}],
      base_over=[(eye, "linegray"), (Point(*EYE).buffer(8), "eye")],
      marks=marks,
      outline=unary_union([SIL, BILL, TAIL]))

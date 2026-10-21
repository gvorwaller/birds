"""Adult Common Murre in breeding plumage, standing on a rock, side view (td-5076e6).

Traced from a right-facing reference photo (proportions only; listed in src/lib/bird-parts/auk.ts).
A murre stands upright like a penguin, propped on its short tail, with its feet set far back: a
dark head and neck with a thin pointed bill, the dark folded wing along the back, white
underparts with dark streaks on the flanks, and dark webbed feet.
"""
from geom import *
from common import build
from shapely.geometry import Point
from shapely.ops import unary_union
from shapely import affinity

# head, neck and body, the folded wing along the back down to its tip (bill, tail and feet are separate)
SIL = poly("M518,433 C548,433 570,438 590,446 C620,458 648,470 666,478 L660,533 "
           "C640,540 610,548 590,556 C568,566 558,590 560,608 C562,628 576,646 592,664 "
           "C622,700 652,760 658,830 C662,900 652,990 632,1060 C612,1120 582,1180 552,1226 "
           "C532,1258 516,1296 508,1328 C484,1350 452,1372 420,1384 C384,1396 344,1384 318,1352 L300,1320 "
           "L250,1300 L222,1306 L188,1324 C196,1290 204,1250 210,1210 C214,1170 216,1130 220,1090 "
           "C226,1030 246,960 280,906 C310,858 352,800 400,752 C416,736 428,716 432,692 "
           "C428,660 418,620 416,580 C414,540 418,500 432,470 C450,446 484,433 518,433 Z")
EYE = (552, 487)
BILL = poly("M664,477 C700,484 760,496 806,509 C770,515 712,522 660,533 C664,514 666,494 664,477 Z")
# propped on the rock behind the feet
TAIL = poly("M244,1300 L300,1318 C312,1350 318,1390 314,1420 C310,1440 302,1456 288,1464 "
            "C270,1440 256,1400 248,1360 C244,1340 242,1320 244,1300 Z")

# The folded wing runs from the shoulder down the back to its tip beside the tail. The frame (u 0 at
# the shoulder -> 1 at the tip; v -1 the back side, +1 the belly side) places the flank streaks.
LOWER = "C397,830 366,886 335,942 C310,1005 285,1067 276,1130 C268,1180 250,1250 222,1300"
WOUT = SIL.intersection(poly(f"M440,690 L414,811 {LOWER} L160,1340 L150,880 L320,690 Z"))
WING = Frame(s=(420, 790), c=(290, 960), t=(188, 1324), width=40, taper=0.7, tip=3)
BODY = SIL.union(TAIL)

# the legs; each foot is one webbed fan
TARSUS = unary_union([poly("M506,1318 L522,1328 L562,1288 L548,1278 Z"),
                      poly("M440,1338 L458,1346 L414,1426 L398,1418 Z")])
TOES = unary_union([poly("M548,1276 C580,1278 640,1290 672,1312 L664,1336 L654,1350 C630,1344 600,1330 562,1300 Z"),
                    poly("M398,1404 C450,1384 530,1378 598,1386 L600,1398 L590,1404 C520,1408 450,1418 412,1430 Z")])
ROCK = poly("M150,1592 L330,1452 L420,1424 L470,1384 L560,1300 L640,1210 L740,1190 L850,1200 L850,1520 L150,1520 Z")

THROATLINE = "C640,540 610,548 590,556 C560,566 520,574 478,572"   # the jaw, from the chin back
BIB = "M600,652 C590,690 562,720 543,733 C520,750 493,769 443,797 L414,811"   # where the dark neck meets the white breast
body_rough = [
    ("belly", SIL),
    ("undertail-coverts", poly("M200,1290 L290,1300 C330,1320 370,1336 400,1340 C410,1360 410,1384 400,1400 L200,1400 Z")),
    ("breast", poly(f"{BIB} L300,840 L300,1010 Q520,990 700,1000 L700,600 Z")),
    # a band along the wing's lower edge, where the streaks are
    ("flanks", poly("M330,860 C400,900 440,1000 444,1100 C446,1200 410,1290 340,1336 L200,1336 L200,860 Z")),
    ("throat", poly(f"M660,533 {THROATLINE} L470,600 L400,820 L414,811 C443,797 493,769 520,750 C540,736 560,724 575,708 "
                    "C590,690 600,670 600,652 L700,652 L700,533 Z")),
    ("nape", poly("M380,420 L470,440 C482,500 482,580 476,640 C470,690 456,740 440,790 L380,800 Z")),
    ("face", poly(f"M430,400 L700,400 L700,478 L660,533 {THROATLINE} L470,580 Z")),
    ("crown", poly("M420,400 L700,400 L700,476 Q640,462 600,462 Q540,460 500,468 Q460,476 430,500 Z")),
]
final = {}
claimed = WOUT.union(BILL)
for pid, rough in reversed(body_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
final["tail"] = TAIL.difference(SIL)

# The small head areas field guides name, so an auk's species-page links stay on this drawing (td-93f86b). Each is
# cut from the face, crown and throat around it and keeps the dark head's tone.
def O(g):
    """Plate coordinates (where the head was laid out) -> tracing coordinates."""
    return affinity.translate(g, 150, 400)
HEAD_AREAS = [
    # the bare skin right around the eye (td-2a2f94), then the feathered eye-ring just outside it
    ("orbital-ring", Point(*EYE).buffer(10.5).difference(Point(*EYE).buffer(8))),
    ("eye-ring", Point(*EYE).buffer(13.5).difference(Point(*EYE).buffer(10.5))),
    ("lores", O(poly("M412,82 Q460,76 512,78 L512,104 Q460,100 412,94 Z"))),
    ("supercilium", O(poly("M512,70 Q470,64 420,66 Q385,68 355,76 L356,84 Q385,77 404,75 Q460,72 512,76 Z"))),
    ("eye-line", O(poly("M391,82 L350,84 L350,94 L391,93 Z"))),
    ("ear-coverts", O(poly("M392,96 L345,96 L340,130 Q370,136 395,128 Z"))),
    # along the lower edge of the face, from the base of the lower mandible back
    ("malar", O(poly("M508,126 Q470,139 432,151 L431,162 Q470,149 511,134 Z"))),
]
_taken = Point(0, 0).buffer(0)
for pid, rough in HEAD_AREAS:
    g = rough.intersection(unary_union([final[k] for k in ("face", "crown", "throat")])).difference(_taken)
    g = unary_union([q for q in getattr(g, "geoms", [g]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"auk: {pid} is in {len(g.geoms)} pieces")
    final[pid] = g
    _taken = _taken.union(g)
for k in ("face", "crown", "throat"):
    final[k] = final[k].difference(_taken)
final["bill"] = BILL
final["tarsus"] = TARSUS
final["toes"] = TOES.difference(TARSUS)

# wing: the scapulars along the back, the covert rows one below the other in front of them, the
# tertials over the rear of the wing, the secondaries below the greater coverts, and the primaries
# to the tip. Each row is a band across the wing, and every part must stay one piece.
WROWS = {
    "scapulars": poly("M440,690 L430,740 C404,792 360,846 312,906 C290,934 268,962 246,992 L150,992 L150,690 Z"),
    "primaries": poly("M150,1150 Q210,1146 300,1168 L300,1400 L150,1400 Z"),
    "tertials": poly("M150,992 L254,992 C262,1040 258,1100 244,1150 L150,1150 Z"),
    "lesser-coverts": poly("M150,600 L500,600 L500,892 Q420,882 300,862 L150,842 Z"),
    "median-coverts": poly("M150,842 L300,862 Q420,882 500,892 L500,952 Q420,942 300,924 L150,904 Z"),
    "greater-coverts": poly("M150,904 L300,924 Q420,942 500,952 L500,1020 Q420,1010 250,990 L150,990 Z"),
}
claimed_w = Point(0, 0).buffer(0)
for k, rough in WROWS.items():
    final[k] = rough.intersection(WOUT).difference(claimed_w)
    claimed_w = claimed_w.union(final[k])
final["secondaries"] = WOUT.difference(claimed_w)
for k in ("scapulars", "primaries", "tertials", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
    g = final[k].buffer(0)
    if g.geom_type != "Polygon": raise SystemExit(f"auk: {k} is in {len(g.geoms)} pieces")
    final[k] = g
# closed up so the rows show as one area with no seams
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)

META = [
    ("tail", "darker", "mf"), ("undertail-coverts", "pale", "mf"), ("belly", "pale", "mf"), ("flanks", "pale", "mf"),
    ("breast", "pale", "mf"), ("throat", "darker", "mf"), ("nape", "darker", "mf"), ("face", "darker", "mf"),
    ("crown", "darker", "mf"), ("lores", "darker", "mf"), ("supercilium", "darker", "mf"), ("eye-line", "darker", "mf"),
    ("ear-coverts", "darker", "mf"), ("malar", "darker", "mf"), ("eye-ring", "darker", "mf"), ("orbital-ring", "darker", "mf"), ("bill", "eye", "mf"),
    ("scapulars", "darker", "mf"), ("wing-coverts", "darker", "m"), ("lesser-coverts", "darker", "f"), ("median-coverts", "darker", "f"),
    ("greater-coverts", "darker", "f"), ("secondaries", "darker", "mf"), ("tertials", "darker", "mf"), ("primaries", "darker", "mf"),
    ("tarsus", "eye", "mf"), ("toes", "eye", "mf"),
]
order = ["tail", "undertail-coverts", "belly", "flanks", "breast", "throat", "nape", "face", "crown",
         "lores", "supercilium", "eye-line", "ear-coverts", "malar", "eye-ring", "orbital-ring", "bill",
         "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "scapulars", "tertials", "primaries",
         "tarsus", "toes"]
# the dark streaks along the white flanks, next to the wing (never tap targets)
def streak(u, v):
    (x0, y0), (x1, y1) = WING.at(u, v), WING.at(u + 0.035, v)
    return stroke(f"M{x0:.1f},{y0:.1f} L{x1:.1f},{y1:.1f}", 3.4)
STREAKS = unary_union([streak(0.16 + 0.055 * i + 0.02 * (j % 2), 1.25 + 0.5 * j) for i in range(15) for j in range(4)])
marks = {"flanks": [(STREAKS, "darker")],
         # the toes inside each webbed foot
         "toes": [(unary_union([stroke(d, 1.6) for d in ("M556,1284 L668,1316", "M556,1286 L652,1342", "M556,1284 L640,1334",
                                                           "M410,1414 L596,1392", "M410,1416 L560,1402")]), "linegray")]}
build("auk", final, META, order, [0, 0, 700, 1120], dx=150, dy=400,
      base_under=[(ROCK, "perch")],
      base_over=[(Point(*EYE).buffer(8), "eye")],
      marks=marks,
      outline=unary_union([BODY, BILL]))

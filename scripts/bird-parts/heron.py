"""Adult Great Blue Heron in breeding plumage, standing, side view (td-46e6e3).

Traced from a standing, right-facing reference photo (proportions only; listed in
src/lib/bird-parts/heron.ts). A heron is mostly neck and legs: the S-curved neck carries the
streaked foreneck and the breast plumes, the folded wing covers the side, and the legs are
bare from below the feathered thighs.
"""
from geom import *
from common import build
from shapely.geometry import Point, LineString
from shapely import affinity
from shapely.ops import unary_union

# head, neck, body and tail with the folded wing (bill and legs are separate)
SIL = poly("M645,174 C630,156 604,148 578,148 C556,148 538,156 528,170 C516,186 504,206 498,232 "
           "C492,262 496,298 508,326 C514,342 516,358 506,372 C486,370 456,370 430,374 "
           "C372,388 306,428 250,490 C204,546 166,610 132,676 C108,724 88,776 76,820 L86,862 "
           "C120,840 160,806 206,776 C254,748 300,724 336,704 L392,700 C420,676 452,652 486,630 "
           "C510,612 528,600 548,584 C570,560 596,528 616,488 C632,450 642,404 642,358 "
           "C642,318 632,290 612,270 C600,258 594,244 600,228 C612,218 632,214 652,214 Z")
EYE = (620, 187)
BILL = poly("M641,176 C700,196 780,226 851,248 C780,242 706,230 652,216 C650,204 646,190 641,176 Z")
LORES = poly("M624,182 C634,178 642,178 648,182 L652,214 C640,208 630,200 626,194 Z")

# The folded wing fills the side from the back edge down to its lower edge. The frame (u 0 at the
# shoulder -> 1 at the tip; v -1 the back side, +1 the belly side) lays out the feather rows.
LOWER = "C474,470 450,548 404,628 C350,704 262,766 180,820 L86,860"
WOUT = SIL.intersection(poly(f"M484,372 {LOWER} L20,880 L20,372 Z"))
WING = Frame(s=(452, 420), c=(330, 560), t=(86, 860), width=82, taper=0.55, tip=3)
BODY = SIL.union(WOUT)

LEGS = {
    "tibia": unary_union([poly("M332,702 L348,702 L320,860 L305,858 Z"), poly("M368,700 L386,700 L360,842 L346,840 Z")]),
    "tarsus": unary_union([poly("M305,858 L320,860 L328,1140 L313,1141 Z"), poly("M346,840 L360,842 L388,1110 L373,1112 Z")]),
}
TOES = unary_union([stroke("M320,1140 Q372,1144 424,1152", 7), stroke("M318,1141 Q348,1150 372,1166", 6),
                    stroke("M316,1140 Q292,1140 270,1144", 6), stroke("M380,1110 Q424,1114 466,1122", 7),
                    stroke("M378,1112 Q402,1122 420,1136", 6), stroke("M376,1110 Q356,1110 338,1114", 6)])
ROCK = poly("M220,1150 Q330,1120 440,1126 Q520,1130 560,1176 L220,1176 Z")

# the line down the side of the neck between the gray hindneck and the streaked white foreneck
NECK_MID = "548,200 C538,250 548,300 572,340 C592,376 594,420 572,470"
body_rough = [
    ("belly", SIL),
    ("thighs", poly("M316,672 Q352,654 398,664 L404,700 L326,708 Z")),
    ("flank-stripe", poly("M512,420 L536,424 Q520,520 480,600 Q450,640 404,676 L392,664 Q440,624 466,580 Q500,510 512,420 Z")),
    # long plumes hanging from the base of the neck over the breast, ending in points
    ("breast-plumes", poly("M572,470 Q610,446 656,404 L650,470 Q630,530 600,574 L588,612 L572,586 L556,628 "
                           "L542,598 L524,640 L512,608 L494,648 L486,612 Q520,540 572,470 Z")),
    ("foreneck", poly(f"M{NECK_MID} Q612,448 656,404 L700,200 Z")),
    ("hindneck", poly(f"M{NECK_MID} L440,470 L440,200 Z")),
    ("throat", poly("M596,214 L660,214 L660,292 Q620,292 590,280 Z")),
    ("face", poly("M520,150 Q580,140 650,156 L640,214 L600,226 Q560,232 530,224 Z")),
    ("crown", poly("M500,120 L680,120 L650,176 Q620,168 596,166 Q560,168 530,180 Z")),
]
final = {}
claimed = WOUT.union(Point(*EYE).buffer(6)).union(BILL).union(LORES)
for pid, rough in reversed(body_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
# the black stripe from above the eye to the back of the head, ending in long plumes off the nape
PLUMES = unary_union([stroke("M612,172 Q580,160 548,160 Q526,164 518,180", 9),
                      stroke("M524,176 Q500,214 482,272", 4), stroke("M528,176 Q510,206 494,250", 3)])
# the belly's crumbs among the head parts belong to the face
_head = final["belly"].intersection(poly("M480,100 L700,100 L700,240 L480,240 Z"))
final["face"] = final["face"].union(_head)
final["belly"] = final["belly"].difference(_head)
final["head-plumes"] = PLUMES.difference(Point(*EYE).buffer(6))
final["crown"] = final["crown"].difference(PLUMES)
final["face"] = final["face"].difference(PLUMES)
final["lores"] = LORES
final["bill"] = BILL.difference(LORES)
final.update(LEGS)

# The small head areas field guides name, so a heron's species-page links stay on this drawing (td-93f86b). Each is
# cut from the face, crown and throat around it; on this adult they are all plain, so they keep the face's tone.
def O(g):
    """Plate coordinates (where the head was laid out) -> tracing coordinates."""
    return affinity.translate(g, 40, 125)
HEAD_AREAS = [
    # the bare skin right around the eye (td-2a2f94), then the feathered eye-ring just outside it
    ("orbital-ring", Point(*EYE).buffer(8.5).difference(Point(*EYE).buffer(6))),
    ("eye-ring", Point(*EYE).buffer(11).difference(Point(*EYE).buffer(8.5))),
    ("supercilium", O(poly("M601,50 Q586,44 562,45 L545,48 L546,56 Q566,53 584,55 L600,57 Z"))),
    ("eye-line", O(poly("M572,57 L544,57 L544,66 L572,67 Z"))),
    ("ear-coverts", O(poly("M572,67 L540,66 L537,86 Q556,90 574,86 L578,72 Z"))),
    # along the lower edge of the face, from the base of the lower mandible back
    ("malar", O(poly("M608,89 L604,82 Q582,86 556,91 L556,100 Q580,95 608,90 Z"))),
]
_taken = Point(0, 0).buffer(0)
for pid, rough in HEAD_AREAS:
    g = rough.intersection(unary_union([final[k] for k in ("face", "crown", "throat")])).difference(_taken)
    g = unary_union([q for q in getattr(g, "geoms", [g]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"heron: {pid} is in {len(g.geoms)} pieces")
    final[pid] = g
    _taken = _taken.union(g)
for k in ("face", "crown", "throat"):
    final[k] = final[k].difference(_taken)

final["toes"] = TOES.difference(LEGS["tarsus"])

# wing: Main parts shows the coverts as one area; the feather view splits the rows
final["back-plumes"] = fband(WING, -0.2, 0.62, -1.9, -0.45, scallops=6, amp=0.03).intersection(WOUT)
final["primaries"] = fband(WING, 0.74, 1.0, -1.9, 1.9, scallops=1, amp=0.03, skew=-0.04).intersection(WOUT).difference(final["back-plumes"])
final["tertials"] = unary_union([fband(WING, 0.50 + 0.04*k, 0.70 + 0.04*k, -1.9, -0.25 - 0.12*k, scallops=1, amp=0.04, skew=-0.05)
                                 for k in range(2)]).intersection(WOUT).difference(final["back-plumes"]).difference(final["primaries"])
cov = WOUT.difference(final["back-plumes"]).difference(final["tertials"]).difference(final["primaries"])
final["lesser-coverts"] = fband(WING, -0.4, 0.18, -1.9, 1.9, scallops=3, amp=0.012, skew=-0.06).intersection(cov)
final["median-coverts"] = fband(WING, 0.18, 0.32, -1.9, 1.9, scallops=4, amp=0.012, skew=-0.06).intersection(cov).difference(final["lesser-coverts"])
final["greater-coverts"] = fband(WING, 0.32, 0.50, -1.9, 1.9, scallops=5, amp=0.012, skew=-0.06).intersection(cov).difference(final["median-coverts"]).difference(final["lesser-coverts"])
final["secondaries"] = cov.difference(final["lesser-coverts"]).difference(final["median-coverts"]).difference(final["greater-coverts"])
# the crumbs left where a covert row meets the tertials' edge belong to the tertials
for k in ("lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
    main = largest(final[k])
    final["tertials"] = final["tertials"].union(final[k].difference(main))
    final[k] = main
# a sliver of belly left under the wingtip belongs to the primaries
_tip = final["belly"].intersection(poly("M0,780 L200,780 L200,900 L0,900 Z"))
final["primaries"] = final["primaries"].union(_tip)
final["belly"] = final["belly"].difference(_tip)
_crumbs = unary_union([g for g in getattr(final["belly"], "geoms", []) if g.area < 60])
final["flank-stripe"] = final["flank-stripe"].union(_crumbs)
final["belly"] = final["belly"].difference(_crumbs)
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")])
# the tips of the greater coverts, where a stork's or crane's wing bar runs (td-2a2f94); plain on this heron, drawn over the coverts
final["wing-bars"] = fband(WING, 0.44, 0.50, -1.9, 1.9, scallops=5, amp=0.012, skew=-0.06).intersection(final["greater-coverts"])


META = [
    ("belly", "linegray", "mf"), ("thighs", "chestnut", "mf"),
    ("flank-stripe", "darker", "mf"), ("breast-plumes", "light", "mf"), ("foreneck", "pale", "mf"),
    ("hindneck", "gullgray", "mf"), ("throat", "pale", "mf"), ("face", "pale", "mf"), ("crown", "pale", "mf"),
    ("supercilium", "pale", "mf"), ("eye-line", "pale", "mf"), ("ear-coverts", "pale", "mf"), ("malar", "pale", "mf"),
    ("eye-ring", "pale", "mf"), ("orbital-ring", "pale", "mf"), ("head-plumes", "darker", "mf"), ("lores", "bill", "mf"), ("bill", "billyellow", "mf"),
    ("wing-coverts", "gullgray", "m"), ("lesser-coverts", "gullgray", "f"), ("median-coverts", "gullgray", "f"),
    ("greater-coverts", "gullgray", "f"), ("wing-bars", "gullgray", "mf"), ("secondaries", "linegray", "mf"), ("back-plumes", "gullpale", "mf"),
    ("tertials", "gullgray", "mf"), ("primaries", "darker", "mf"),
    ("tibia", "linegray", "mf"), ("tarsus", "linegray", "mf"), ("toes", "linegray", "mf"),
]
order = ["tibia", "tarsus", "toes", "belly", "thighs", "flank-stripe", "breast-plumes",
         "hindneck", "foreneck", "throat", "face", "crown",
         "supercilium", "eye-line", "ear-coverts", "malar", "eye-ring", "orbital-ring", "head-plumes", "lores", "bill",
         "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "wing-bars", "secondaries", "tertials",
         "primaries", "back-plumes"]
# the black-and-white streaks down the foreneck, drawn over it (never tap targets)
STREAKS = unary_union([stroke(f"M{x},{y} L{x + 4},{y + 34}", 3) for x, y in
                       [(604, 280), (614, 300), (622, 330), (626, 362), (624, 396), (612, 428), (596, 300), (606, 340), (612, 376)]])
build("heron", final, META, order, [0, 0, 820, 1060], dx=40, dy=125,
      base_under=[(ROCK, "perch")],
      base_over=[(Point(*EYE).buffer(6), "billyellow"), (Point(*EYE).buffer(2.8), "eye")],
      marks={"foreneck": [(STREAKS, "darker")]},
      outline=BODY.union(BILL))

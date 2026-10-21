"""Adult Common Loon in breeding plumage, swimming, side view (td-a3a17d).

Traced from a right-facing reference photo of a loon on a lake and checked against a head close-up
(proportions only; listed in src/lib/bird-parts/loon.ts). A loon swims low, its folded wings
usually covered by the body feathers: a black head with a dagger bill and red eye, a short bar of
white streaks under the chin, the striped necklace, a checkered back, white lines on the lower
sides of the neck running into the white breast, and rows of small white spots along the side.
"""
from geom import *
from common import build
from shapely import affinity
from shapely.geometry import Point, box
from shapely.ops import unary_union

K, X0, Y0 = 0.9, -366, -320


def F(g):
    """Photo coordinates -> output (the photo bird already faces right)."""
    return affinity.translate(affinity.scale(g, K, K, origin=(0, 0)), X0, Y0).buffer(0)


WATER = 603
# head, neck and body down to the waterline (bill and tail are separate)
SIL = poly("M1124,434 C1109,426 1100,415 1092,409 C1085,400 1072,389 1045,387 C1015,387 990,394 975,404 "
           "C958,418 948,436 944,451 C936,470 930,490 928,509 C927,525 926,535 926,542 "
           "C900,533 870,528 840,524 C800,520 770,516 740,516 C700,520 660,532 620,545 C596,552 578,558 566,562 "
           "C545,567 515,576 492,585 C478,591 466,597 458,603 L1072,603 "
           "C1071,592 1067,578 1059,568 C1051,560 1040,555 1031,548 C1022,538 1019,526 1019,515 "
           "C1019,506 1020,500 1021,497 C1029,490 1040,485 1049,483 C1062,480 1076,474 1090,469 L1104,466 "
           "L1112,452 L1124,434 Z").intersection(box(0, 0, 2000, WATER))
EYE = (1045, 425)
BILL = poly("M1122,433 C1150,438 1180,444 1208,451 C1188,457 1160,463 1124,465 L1104,467 "
            "C1096,462 1088,455 1082,450 C1095,444 1108,438 1122,433 Z")
# a short, blunt wedge at the rear, just above the water
TAIL = poly("M532,573 C508,575 482,578 463,581 L460,589 C470,591 480,593 490,595 Z")

# the necklace across the side of the neck, and the short bar of streaks under the chin
NECKLACE = SIL.intersection(poly("M933,518 L1012,519 L1012,530 L933,540 Z"))
STREAKS = SIL.intersection(poly("M1004,494 L1040,490 L1040,503 L1004,504 Z"))
# the black neck, down to where it meets the back and the breast
NECK = poly("M915,380 L1140,380 L1140,548 L1036,548 C1005,562 975,571 957,576 C945,566 935,556 922,546 L915,546 Z")

rough = [
    ("flanks", SIL),
    ("breast", poly("M948,566 L1036,538 L1110,535 L1110,610 L978,610 C973,596 966,585 957,576 Z")),
    ("scapulars", poly("M590,520 L930,520 L930,548 C915,560 900,568 880,572 C800,578 700,580 620,577 C605,575 595,572 590,568 Z")),
    ("back", poly("M560,500 L926,500 L926,548 C890,542 840,538 780,537 C720,538 660,550 600,566 L560,566 Z")),
    ("nape", NECK.intersection(box(0, 0, 973, 999))),
    ("throat", NECK.intersection(box(973, 0, 2000, 999))),
    ("face", poly("M950,432 Q1000,413 1050,414 Q1090,418 1122,433 L1104,467 Q1080,474 1050,480 "
                  "Q1012,487 985,486 Q968,470 958,452 Z")),
    ("crown", poly("M930,370 L1140,370 L1140,433 L1122,433 Q1090,418 1050,414 Q1000,413 950,432 L930,440 Z")),
    # the head areas field guides name, all black on a breeding Common Loon (td-93f86b): cut from the face and crown
    ("malar", poly("M1106,468 Q1080,477 1052,484 L1052,470 Q1076,463 1096,455 Z")),
    ("ear-coverts", poly("M1040,429 Q1000,429 950,436 L958,462 Q985,477 1010,479 Q1032,471 1042,452 Z")),
    ("supercilium", poly("M1124,436 Q1085,418 1045,418 Q1000,418 952,424 L950,413 Q1000,399 1045,399 Q1088,401 1126,428 Z")),
    ("eye-line", poly("M1040,409 Q1000,410 950,421 L950,438 Q1000,430 1040,433 Z")),
    ("lores", poly("M1050,416 L1126,430 L1100,449 L1050,434 Z")),
    ("eye-ring", Point(*EYE).buffer(9).difference(Point(*EYE).buffer(5.5))),
]
final = {}
claimed = BILL.union(NECKLACE).union(STREAKS).union(Point(*EYE).buffer(5.5))
for pid, r in reversed(rough):
    final[pid] = r.intersection(SIL).difference(claimed)
    claimed = claimed.union(r.intersection(SIL))
final["necklace"] = NECKLACE
final["throat-streaks"] = STREAKS
final["bill"] = BILL
final["tail"] = TAIL.difference(SIL)
# every part is one piece: a leftover sliver would join a far part (the tubenose's flanks reached its forehead)
for k in final:
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"loon: {k} is in {len(g.geoms)} pieces")
    final[k] = g

# patterns drawn over their parts (never tap targets)
def spots(region, dx, dy, w, h, stagger=0.5, tilt=0.0, round_=False):
    x0, y0, x1, y1 = region.bounds
    out, j, y = [], 0, y0
    while y < y1:
        x = x0 + (stagger * dx if j % 2 else 0)
        while x < x1:
            s = Point(x, y + tilt * (x - x0)).buffer(1) if round_ else box(x - w / 2, y - h / 2 + tilt * (x - x0), x + w / 2, y + h / 2 + tilt * (x - x0))
            if round_: s = affinity.scale(s, w / 2, h / 2)
            out.append(s)
            x += dx
        y += dy; j += 1
    return unary_union(out).intersection(region.buffer(-1.2))

def lines(x0, x1, step, y0, y1, w, lean=0.0):
    return unary_union([stroke(f"M{x:.1f},{y0} L{x + lean:.1f},{y1}", w) for x in frange(x0, x1, step)])

def frange(a, b, s):
    while a < b:
        yield a; a += s

CHECKS = unary_union([spots(final["scapulars"], 14, 10, 7.5, 4.6, tilt=0.06), spots(final["back"], 10, 7, 4.5, 3, tilt=0.05)])
SIDE_SPOTS = spots(final["flanks"].difference(box(0, 0, 540, 999)), 9, 6, 2.6, 2.2, round_=True)
NECK_STRIPES = lines(898, 1040, 6.2, 510, 548, 2.6, lean=-1)
CHIN_STRIPES = lines(1002, 1040, 4.6, 486, 512, 1.8)
BREAST_LINES = unary_union([stroke(f"M{962 + 9 * i:.1f},{580 - 3 * i:.1f} C{975 + 9 * i:.1f},{586 - 2 * i:.1f} "
                                   f"{985 + 8 * i:.1f},{595 - i:.1f} {990 + 8 * i:.1f},{606:.1f}", 2.2) for i in range(7)])

marks = {"scapulars": [(F(CHECKS.intersection(final["scapulars"])), "pale")],
         "back": [(F(CHECKS.intersection(final["back"])), "pale")],
         "flanks": [(F(SIDE_SPOTS), "pale")],
         "necklace": [(F(NECK_STRIPES), "eye")],
         "throat-streaks": [(F(CHIN_STRIPES), "eye")],
         "breast": [(F(BREAST_LINES), "eye")]}

W_OUT = F(Point(0, WATER).buffer(1)).centroid.y
above = box(-50, -400, 900, W_OUT)
final = {k: F(v).intersection(above) for k, v in final.items()}
OUTLINE = F(unary_union([SIL, BILL, TAIL])).intersection(above)
EYE_O = F(Point(*EYE).buffer(5.5))
PUPIL = F(Point(*EYE).buffer(2.2))

META = [
    ("flanks", "eye", "mf"), ("breast", "pale", "mf"),
    ("back", "eye", "mf"), ("scapulars", "eye", "mf"), ("tail", "eye", "mf"),
    ("nape", "eye", "mf"), ("throat", "eye", "mf"), ("face", "eye", "mf"), ("crown", "eye", "mf"),
    ("malar", "eye", "mf"), ("ear-coverts", "eye", "mf"), ("eye-line", "eye", "mf"), ("supercilium", "eye", "mf"),
    ("lores", "eye", "mf"), ("eye-ring", "eye", "mf"),
    ("necklace", "pale", "mf"), ("throat-streaks", "pale", "mf"), ("bill", "linegray", "mf"),
]
order = [m[0] for m in META]
build("loon", final, META, order, [0, 0, 760, 250], dx=0, dy=0,
      marks=marks,
      base_over=[(EYE_O, "accent"), (PUPIL, "eye"), (box(0, W_OUT - 1, 760, W_OUT + 1.5), "water")],
      outline=OUTLINE)
print("water at", round(W_OUT, 1), "bounds", [round(v) for v in OUTLINE.bounds])

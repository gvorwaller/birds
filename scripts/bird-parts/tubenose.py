"""Adult Sooty Shearwater swimming, side view, with a close-up of the bill (td-315613).

Traced from a left-facing reference photo of a shearwater on the water and a close-up of the head
(proportions only; listed in src/lib/bird-parts/tubenose.ts). The swimming photo is tilted, so the
tracing is turned until the waterline is level, scaled down and mirrored to face right. The bill
is made of separate horny plates: the nostril tubes on top and the hooked tip are their own parts,
and the inset shows them larger.
"""
import math
from geom import *
from common import build
from shapely import affinity
from shapely.geometry import Point, box, LineString
from shapely.ops import unary_union

TILT, K, X0, Y0 = 11.07, 0.62, 764, 62


def F(g):
    """Photo coordinates -> output: level the waterline, scale, mirror to face right."""
    g = affinity.rotate(g, TILT, origin=(560, 570))
    return affinity.translate(affinity.scale(g, -K, K, origin=(0, 0)), X0, Y0).buffer(0)


SIL = poly("M186,268 C190,230 205,195 240,172 C265,160 300,160 330,170 C360,182 382,210 388,250 "
           "C392,290 390,330 395,355 C420,345 470,320 520,302 C580,288 660,282 740,282 C800,282 840,284 870,288 "
           "L900,500 C860,520 800,548 720,578 C620,612 480,636 330,642 C280,644 240,642 225,636 "
           "C205,610 196,560 195,500 C194,450 200,410 208,380 C212,360 212,340 210,322 C200,300 192,286 186,268 Z")
EYE = (268, 251)
BILL = poly("M186,268 C178,270 168,276 160,280 L147,287 C130,300 112,316 96,330 C86,338 78,350 77,360 "
            "C78,368 82,370 86,364 C92,356 100,352 110,350 C140,342 175,330 210,320 C204,300 196,282 186,268 Z")
TUBES = poly("M145,292 C148,282 158,275 170,272 L188,265 L194,284 C180,288 162,293 148,298 Z")
UNGUIS = BILL.intersection(poly("M60,310 L106,318 C102,332 104,344 112,352 L60,390 Z"))
# the crossed wingtips rise behind the body; the tail sticks out below them
PRIM = poly("M780,300 C830,290 860,284 880,282 C960,240 1050,170 1120,125 C1090,170 1050,220 1010,262 "
            "C970,310 935,380 910,450 C895,480 880,500 860,508 Z")
TAIL = poly("M905,330 C960,300 1040,262 1100,232 L1160,258 C1100,270 1040,295 995,325 C960,355 935,400 915,450 Z")
LOWER = "C415,480 440,540 520,562 C600,572 700,556 760,540 C810,526 850,512 900,500"
WOUT = SIL.intersection(poly(f"M395,330 L400,420 {LOWER} L900,250 L395,250 Z"))
EDGE = LineString(pts("M400,420 C415,480 440,540 520,562 C600,572 700,556 760,540 C810,526 850,512 900,500"))

head_rough = [
    ("flanks", SIL),
    ("breast", poly("M150,400 L320,400 Q296,520 330,660 L150,660 Z")),
    ("throat", poly("M150,290 L370,290 L400,350 L400,410 Q330,404 320,400 L150,400 Z")),
    ("nape", poly("M330,200 L440,200 L440,420 L380,420 Q352,330 330,236 Z")),
    ("face", poly("M150,200 L336,200 L336,236 Q348,290 350,334 Q300,336 240,328 Q200,322 150,318 Z")),
    ("crown", poly("M150,120 L420,120 L420,240 Q330,226 270,234 Q230,240 150,256 Z")),
]
final = {}
claimed = WOUT.union(BILL).union(TUBES)
for pid, rough in reversed(head_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
final["bill"] = BILL.difference(UNGUIS).difference(TUBES)
# the areas around the eye, cut from the face, crown, throat and nape (td-93f86b). The bill points left here, so
# the lores lie at smaller x than the eye. Highest priority first; the eye itself is not a part.
EYE_AREAS = [
    # the bare orbital ring right around the eye, then the feathered eye-ring outside it (td-2a2f94)
    ("orbital-ring", Point(*EYE).buffer(10.5).difference(Point(*EYE).buffer(8.5))),
    ("eye-ring", Point(*EYE).buffer(13).difference(Point(*EYE).buffer(8.5))),
    # a band from the bill base back past the eye, over the eye-line; its top takes a strip of the crown
    ("supercilium", poly("M176,260 L176,250 L192,240 L230,230 L270,224 L350,226 L350,246 L330,244 L262,243 L240,249 L196,266 L180,262 Z")),
    ("eye-line", poly("M262,243 L330,244 L350,246 L350,258 L262,259 Z")),
    ("lores", poly("M176,260 L180,262 L196,266 L240,249 L262,243 L262,262 L240,276 L205,294 L176,300 Z")),
    ("ear-coverts", poly("M262,259 L350,258 L353,320 L300,316 L276,306 L262,262 Z")),
    # from the base of the lower bill back along the side of the throat; its bottom takes a strip of the throat
    ("malar", poly("M196,306 L276,306 L300,316 L353,320 L355,344 L300,340 L214,326 L196,318 Z")),
]
taken = Point(*EYE).buffer(8.5).union(BILL).union(TUBES).union(WOUT)
for pid, rough in EYE_AREAS:
    final[pid] = rough.intersection(SIL).difference(taken)
    taken = taken.union(final[pid])
for k in ("crown", "face", "throat", "nape"):
    final[k] = final[k].difference(taken)
# every head and body part is one piece: a leftover sliver would join a far part (CODEX1: flanks reached the forehead)
for k in [k for k, _ in head_rough] + [k for k, _ in EYE_AREAS]:
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])   # drop zero-area specks
    if g.geom_type != "Polygon": raise SystemExit(f"tubenose: {k} is in {len(g.geoms)} pieces")
    final[k] = g
final["unguis"] = UNGUIS
final["nostril-tubes"] = TUBES

# wing: rows parallel to the folded wing's lower edge (secondaries, greater and median coverts), the
# scapulars along the back, the lesser coverts at the front, the tertials at the rear
def row(d0, d1):
    return EDGE.buffer(d1, cap_style=2).difference(EDGE.buffer(d0, cap_style=2))
w = WOUT.difference(PRIM)
final["tertials"] = w.intersection(poly("M690,250 L940,250 L940,540 Q820,500 700,440 Z"))
w = w.difference(final["tertials"])
final["scapulars"] = w.intersection(poly("M395,250 L900,250 L900,330 Q700,320 560,340 Q470,356 410,380 Z"))
w = w.difference(final["scapulars"])
final["secondaries"] = EDGE.buffer(28, cap_style=2).intersection(w)
final["greater-coverts"] = row(28, 62).intersection(w)
final["median-coverts"] = row(62, 94).intersection(w)
final["lesser-coverts"] = w.difference(EDGE.buffer(94, cap_style=2))
final["primaries"] = PRIM
final["tail"] = TAIL.difference(PRIM).difference(SIL)
for k in ("tertials", "scapulars", "secondaries", "greater-coverts", "median-coverts", "lesser-coverts", "primaries", "tail"):
    g = final[k].buffer(0)
    if g.geom_type != "Polygon": raise SystemExit(f"tubenose: {k} is in {len(g.geoms)} pieces")
    final[k] = g
# where a pale wing bar shows on birds that have one: the tips of the greater coverts (td-2a2f94)
final["wing-bars"] = row(28, 40).intersection(final["greater-coverts"])
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)

# level, scale and mirror everything; then clip at the waterline
WATER = F(Point(560, 606).buffer(1)).centroid.y
above = box(-50, -400, 900, WATER)
final = {k: F(v).intersection(above) for k, v in final.items()}
OUTLINE = F(unary_union([SIL, BILL, TUBES, PRIM, TAIL])).intersection(above)
EYE_O = F(Point(*EYE).buffer(8.5))

# The inset: the head and bill close up, traced from the head photo (bill pointing left there) and
# mirrored into a circle above the back. The bill's plates are the same parts as on the bird.
IC, IR = (300, 106), 102
def FI(g):
    return affinity.translate(affinity.scale(g, -0.7, 0.7, origin=(540, 410)), IC[0] - 72 - 540, IC[1] - 6 - 410).buffer(0)
clip_i = Point(*IC).buffer(IR - 4)
HEAD_I = FI(poly("M520,350 C530,320 560,290 610,280 C660,272 720,280 800,290 L800,620 L560,620 "
                 "C552,560 552,480 561,443 L548,386 C540,370 530,356 520,350 Z")).intersection(clip_i)
BILL_I = FI(poly("M520,350 C530,356 540,370 548,386 L561,443 C530,442 500,444 470,446 C440,448 400,452 362,455 "
                 "C352,456 346,462 342,471 C336,462 332,448 334,430 C340,412 355,402 374,399 C400,394 430,384 466,372 "
                 "C480,364 500,356 520,350 Z"))
# the tube along the top of the bill, from the forehead to its open front end
TUBES_I = FI(poly("M466,372 C468,362 478,356 492,354 L520,349 C530,352 538,362 544,376 C520,378 490,378 466,376 Z"))
UNGUIS_I = BILL_I.intersection(FI(poly("M320,380 L376,396 C368,420 368,445 374,460 L320,490 Z")))

META = [
    ("flanks", "darker", "mf"), ("breast", "dark", "mf"), ("throat", "dark", "mf"), ("nape", "darker", "mf"),
    ("face", "darker", "mf"), ("crown", "darker", "mf"),
    ("malar", "darker", "mf"), ("ear-coverts", "darker", "mf"), ("supercilium", "darker", "mf"), ("eye-line", "darker", "mf"),
    ("lores", "darker", "mf"), ("eye-ring", "darker", "mf"), ("orbital-ring", "darker", "mf"), ("wing-bars", "darker", "mf"),
    ("tail", "eye", "mf"), ("scapulars", "darker", "mf"), ("wing-coverts", "darker", "m"), ("lesser-coverts", "darker", "f"),
    ("median-coverts", "darker", "f"), ("greater-coverts", "darker", "f"), ("secondaries", "darker", "mf"),
    ("tertials", "darker", "mf"), ("primaries", "eye", "mf"),
    ("bill", "linegray", "mf"), ("unguis", "linegray", "mf"), ("nostril-tubes", "linegray", "mf"),
]
order = ["tail", "flanks", "breast", "throat", "nape", "face", "crown",
         "malar", "ear-coverts", "supercilium", "eye-line", "lores", "eye-ring", "orbital-ring",
         "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "wing-bars", "secondaries", "scapulars", "tertials", "primaries",
         "bill", "unguis", "nostril-tubes"]
build("tubenose", final, META, order, [0, 0, 760, 452], dx=0, dy=0,
      raw_base=[(HEAD_I, "darker")],
      extra_raw={"bill": BILL_I.difference(UNGUIS_I).difference(TUBES_I), "unguis": UNGUIS_I, "nostril-tubes": TUBES_I},
      insets=[{"cx": IC[0], "cy": IC[1], "r": IR, "label": "Bill, close up"}],
      base_over=[(EYE_O, "eye"), (box(0, WATER - 1, 760, WATER + 1.5), "water")],
      outline=OUTLINE)
print("water at", round(WATER, 1), "bounds", [round(v) for v in OUTLINE.bounds])

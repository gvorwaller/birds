"""Adult Horned (Slavonian) Grebe in breeding plumage, swimming, side view, with a close-up of a
lobed foot (td-7adea3).

Traced from a right-facing reference photo of a grebe on the water and an old engraving of a grebe's
foot (proportions only; listed in src/lib/bird-parts/grebe.ts). The bird sits low, with no tail to
speak of: a black head with golden ear tufts ("horns"), a red eye, a chestnut neck and flanks and a
dark back. Its feet are under the water, so the inset shows one larger: three front toes, each with
its own broad lobe, and a small lobed hind toe.
"""
from geom import *
from common import build
from shapely import affinity
from shapely.geometry import Point, box, LineString
from shapely.ops import unary_union

K, X0, Y0 = 0.8, -10, -64


def F(g):
    """Photo coordinates -> output (the photo already faces right)."""
    return affinity.translate(affinity.scale(g, K, K, origin=(0, 0)), X0, Y0).buffer(0)


# head, neck and body down past the waterline (the bill is separate)
# the golden "horns": a broad band from the eye back and up the side of the head, ending in tufts that stick
# out behind and above the back of the head
TUFTS = poly("M776,214 C748,194 712,172 676,152 C660,143 646,134 634,124 Q620,108 600,100 Q610,114 614,124 "
             "Q598,118 582,124 Q598,132 606,138 Q590,142 580,154 Q598,154 610,158 Q600,166 594,178 Q610,174 620,172 "
             "C652,186 690,204 728,222 C742,229 752,234 762,238 Q774,234 776,214 Z")
SIL = poly("M815,248 C810,228 800,200 785,182 C770,164 752,146 730,132 C712,122 690,118 668,120 "
           "C648,124 632,136 624,150 C618,164 615,178 615,190 C614,208 611,224 607,240 "
           "C603,262 604,292 618,316 C628,332 642,346 652,356 L652,368 "
           "C600,360 520,357 470,363 C420,369 380,380 350,392 C300,412 250,438 200,464 "
           "C160,484 125,504 100,518 C110,526 124,532 140,537 L140,560 L790,560 L795,540 "
           "C806,515 808,476 802,446 C795,414 780,384 765,360 C756,346 749,336 746,326 "
           "C754,306 774,290 795,277 Z").union(TUFTS)
BILL = poly("M815,248 C840,262 862,276 880,291 C866,291 850,288 830,285 C815,282 803,279 795,277 Z")
BILL_TIP = poly("M866,270 L900,270 L900,300 L862,300 Z")   # the whitish tip, a mark on the bill
EYE = (760, 227)
IRIS = Point(*EYE).buffer(7.5)
WATER = 540

head_rough = [
    ("flanks", SIL),
    ("breast", poly("M640,430 Q760,424 840,432 L840,600 L640,600 Z")),
    ("neck", poly("M560,296 L840,296 L840,444 Q760,436 670,442 L648,386 L560,386 Z")),
    ("back", poly("M40,300 L600,300 L600,356 L662,356 L662,378 L640,378 C610,377 540,378 480,390 L470,414 C420,414 360,422 300,440 "
                  "C240,462 180,500 130,540 L40,540 Z")),
    # the mottled feathers over the folded wing, below the back and in front of the flank line
    ("scapulars", poly("M640,378 C610,377 540,378 480,390 L470,414 C510,418 540,428 570,442 "
                       "C610,460 650,478 700,494 L684,430 L668,382 Z")),
    ("throat", poly("M845,256 L805,262 C780,274 760,292 744,312 L730,350 L800,350 L845,300 Z")),
    ("nape", poly("M560,150 L644,150 L644,190 C634,240 636,300 655,340 L662,356 L560,356 Z")),
    ("face", poly("M644,150 L840,150 L840,256 L805,262 C780,274 760,292 744,312 C720,330 690,338 655,340 C636,300 634,240 644,190 L644,150 Z")),
    # the black cheek behind and below the eye, under the golden band (td-93f86b)
    ("ear-coverts", poly("M756,236 L628,160 L628,292 C690,302 726,294 748,282 C758,268 760,250 756,236 Z")),
    # from the base of the lower bill back along the side of the throat
    ("malar", poly("M798,272 C780,282 764,296 750,310 L742,302 C756,288 774,274 792,264 Z")),
    # black from the forehead over the top of the head, down to the lores in front of the eye
    ("crown", poly("M560,60 L850,60 L850,262 L812,262 C796,256 780,248 766,236 C740,206 700,184 660,170 "
                   "C640,166 625,150 600,140 L560,140 Z")),
    # the black strip above the golden band, from the bill back over the eye
    ("supercilium", TUFTS.buffer(11).difference(TUFTS).intersection(
        poly("M600,60 L850,60 L850,244 L776,220 L676,158 L600,118 Z")).intersection(box(672, 0, 818, 999))
        .union(poly("M772,204 L824,236 L816,262 L806,252 C792,248 778,240 764,233 Z"))),
    ("ear-tufts", TUFTS),
    # the golden band starts at the eye: its first stretch, through and just behind the eye, is the eye-line
    ("eye-line", TUFTS.intersection(box(728, 0, 790, 999))),
    # bare skin from the eye to the bill
    ("lores", poly("M764,233 C778,240 792,248 806,252 L812,262 C796,262 780,252 762,240 Z")),
    ("eye-ring", Point(*EYE).buffer(12).difference(IRIS)),
    # the bare skin right around the eye, inside the feathered eye-ring (td-2a2f94)
    ("orbital-ring", Point(*EYE).buffer(10).difference(IRIS)),
]
final = {}
claimed = BILL.union(IRIS)
for pid, rough in reversed(head_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
final["bill"] = BILL
final["iris"] = IRIS
# every part is one piece: a leftover sliver would join a far part (the tubenose's lesson)
for k, _ in head_rough:
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 5])   # drop specks (a few square pixels of the photo)
    if g.geom_type != "Polygon": raise SystemExit(f"grebe: {k} is in {len(g.geoms)} pieces")
    final[k] = g

# into output coordinates, then cut at the waterline
WATER_O = WATER * K + Y0
above = box(-50, -400, 900, WATER_O)
final = {k: F(v).intersection(above) for k, v in final.items()}
OUTLINE = F(unary_union([SIL, BILL])).intersection(above)
PUPIL = F(Point(*EYE).buffer(2.6))

# The inset: one foot, traced from an engraving of a Great Crested Grebe's foot seen from below
# (tarsus to the left, toes spread to the right) and placed in a circle above the back.
IC, IR = (210, 128), 104
FS, FC = 0.64, (180, 140)


def FI(g):
    return affinity.translate(affinity.scale(g, FS, FS, origin=FC), IC[0] - FC[0], IC[1] - FC[1]).buffer(0)


TARSUS_I = FI(poly("M42,72 C70,80 100,88 124,96 L124,110 C100,104 70,92 44,80 Z"))
# bottom to top, as the toes overlap in the engraving
TOE_SHAPES = [
    # the small hind toe, with its own lobe
    poly("M92,98 C98,112 102,126 108,138 C112,144 118,142 119,134 C120,122 116,110 110,100 Z"),
    # the outer toe, longest, with its lobe
    poly("M120,98 C150,104 180,112 208,116 C224,114 236,110 248,109 C268,108 290,116 306,126 "
         "C316,134 316,144 306,154 C296,162 270,164 248,160 C220,156 190,146 160,132 C140,124 128,118 120,112 Z"),
    # the inner toe
    poly("M120,112 C126,140 134,168 150,192 C164,212 180,226 194,230 C204,230 208,220 204,206 "
         "C200,190 190,172 178,158 C164,140 148,124 132,112 Z"),
    # the middle toe
    poly("M124,104 C150,114 180,126 210,136 C236,144 256,154 268,168 C278,180 278,196 266,206 "
         "C254,214 236,214 222,210 C200,204 176,190 150,166 C136,150 126,132 122,114 Z"),
]
TOES_I = FI(unary_union(TOE_SHAPES)).difference(TARSUS_I)
# each toe's own edge where no toe above hides it, so the separate lobes show (never a tap target)
TOE_EDGES = unary_union([s.exterior.difference(unary_union(TOE_SHAPES[i + 1:])).buffer(0.9) if i + 1 < len(TOE_SHAPES)
                         else s.exterior.buffer(0.9) for i, s in enumerate(TOE_SHAPES)])
TOE_LINES = FI(unary_union([stroke(d, 1.6) for d in ("M122,104 L306,140", "M124,108 L262,196",
                                                     "M124,112 L196,222", "M98,102 L113,136")]
                           + [TOE_EDGES])).intersection(TOES_I)
final["tarsus"] = TARSUS_I
final["toes"] = TOES_I

META = [
    ("flanks", "chestnut", "m"), ("breast", "chestnut", "m"), ("neck", "chestnut", "m"),
    ("back", "darker", "m"), ("scapulars", "dark", "m"),
    ("throat", "eye", "m"), ("nape", "eye", "m"), ("face", "eye", "m"), ("ear-tufts", "orange", "m"),
    ("ear-coverts", "eye", "m"), ("malar", "eye", "m"), ("supercilium", "eye", "m"), ("eye-line", "orange", "m"),
    ("crown", "eye", "m"), ("lores", "chestnut", "m"), ("eye-ring", "eye", "m"), ("orbital-ring", "eye", "m"), ("iris", "accent", "m"), ("bill", "eye", "m"),
    ("tarsus", "linegray", "m"), ("toes", "gullgray", "m"),
]
order = [m[0] for m in META]
build("grebe", final, META, order, [0, 0, 760, 384], dx=0, dy=0,
      raw=("tarsus", "toes"),
      marks={"bill": [(F(BILL_TIP), "pale")]},
      insets=[{"cx": IC[0], "cy": IC[1], "r": IR, "label": "Foot, close up"}],
      base_over=[(PUPIL, "eye"), (TOE_LINES, "linegray"), (box(0, WATER_O - 1, 760, WATER_O + 1.5), "water")],
      outline=OUTLINE)
print("water at", round(WATER_O, 1), "bounds", [round(v) for v in OUTLINE.bounds])

"""Adult male Ruffed Grouse, standing, side view (td-71be07).

Traced from a left-facing reference photo of a red-morph bird walking with its crest raised and its
tail spread (proportions only; listed in src/lib/bird-parts/gamebird.ts), scaled down and mirrored
to face right. A grouse is round-bodied and short-legged, with feathered legs, a short hooked bill
and a short crest; the black ruff lies on each side of the neck, and the fanned tail ends in a
broad dark band with a pale tip.
"""
from geom import *
from common import build
from shapely import affinity
from shapely.geometry import Point, LineString
from shapely.ops import unary_union

K, X0, Y0 = 0.58, 817, -75


def F(g):
    """Photo coordinates -> output: scale and mirror to face right."""
    return affinity.translate(affinity.scale(g, -K, K, origin=(0, 0)), X0, Y0).buffer(0)


# head, neck and body (bill, crest, tail and legs are separate); the thigh feathers hang below the belly
SIL = poly("M180,293 C184,280 188,270 192,262 C215,232 240,220 262,218 C300,216 332,224 350,240 "
           "C362,256 368,276 370,295 C380,320 405,350 440,380 C465,405 495,430 520,445 "
           "C600,456 700,462 800,470 C860,476 920,480 985,470 C990,520 990,600 985,650 "
           "C1000,668 1030,700 1032,735 C1020,752 980,752 927,746 C880,752 843,757 800,762 "
           "L770,772 C770,798 758,822 742,838 L700,840 C694,818 690,796 686,776 C640,780 600,788 535,787 C490,782 440,766 385,737 "
           "C350,712 318,668 302,612 C288,570 280,528 280,480 C278,440 276,400 272,375 "
           "C250,352 225,335 185,322 C183,312 181,302 180,293 Z")
CREST = poly("M192,262 C189,240 186,212 181,152 C190,164 195,172 199,174 L204,156 C207,166 210,174 214,180 "
             "L224,166 C226,176 229,182 233,186 L246,180 C246,186 245,190 244,192 C248,192 250,196 262,204 C292,208 322,216 346,236 "
             "C356,250 362,262 362,270 C330,262 292,258 262,262 C240,266 214,268 192,262 Z")
EYE = (262, 290)
BILL = poly("M180,293 C165,298 150,308 142,327 C155,322 170,320 186,322 C184,312 182,302 180,293 Z")
# the small bare comb over the eye, which a male can show or hide
COMB = poly("M244,282 C250,269 270,264 292,270 L295,279 C278,275 260,277 248,287 Z")
# the black ruff lies along the side of the neck
RUFF = poly("M368,388 C394,394 420,412 440,432 C454,448 460,464 458,478 C436,474 410,458 392,440 C378,424 368,406 368,388 Z")

TAIL = poly("M983,473 C1000,452 1030,416 1063,387 C1090,362 1117,340 1143,313 L1163,310 C1190,322 1205,336 1223,340 "
            "C1250,342 1265,344 1277,347 C1300,358 1312,366 1317,373 C1330,390 1340,400 1343,407 C1355,428 1360,440 1363,447 "
            "C1362,470 1360,490 1357,500 C1352,530 1348,546 1343,560 C1336,585 1330,600 1323,613 C1315,630 1310,646 1303,660 "
            "C1290,676 1280,690 1270,700 C1255,718 1245,730 1233,740 L1203,747 L1190,740 C1160,734 1140,730 1117,727 "
            "C1090,720 1070,714 1050,707 C1030,698 1015,690 1003,680 L983,653 Z").difference(SIL)
# the inner edge of the dark band near the tip; a pale line runs along it
BAND_EDGE = "M1130,330 L1137,347 C1170,352 1220,368 1250,380 C1278,390 1300,410 1308,440 C1310,458 1308,470 1303,480 C1295,500 1290,512 1283,527 L1263,573 L1243,627 L1223,673 L1203,713 L1190,740"
INSIDE = poly(BAND_EDGE + " L1150,800 L900,800 L900,280 L1125,280 Z")
BAND = TAIL.difference(INSIDE)

# The folded wing over the side; its lower edge runs from the bend of the wing back to the tips.
LOWER = "M466,600 C480,640 520,670 600,688 C680,698 760,694 820,684 C860,678 890,672 912,662"
WOUT = SIL.intersection(poly("M470,470 C520,466 600,468 730,485 C780,495 830,515 870,545 C900,570 918,600 925,640 "
                             "C922,655 916,660 912,662 C890,672 860,678 820,684 C760,694 680,698 600,688 "
                             "C520,670 480,640 466,600 C458,560 458,520 462,500 C464,486 466,478 470,470 Z"))
EDGE = LineString(pts(LOWER))

# the legs: the near leg standing on its feathered tarsus, the far one lifted mid-step
# the far leg starts under the belly, so the body covers its top and it visibly joins the body
TARSUS = unary_union([poly("M700,834 L742,834 L734,885 L728,940 L703,942 L700,890 Z"),
                      poly("M606,752 L640,756 L638,800 L634,840 L616,842 L610,800 Z")])
TOES = unary_union([stroke("M708,946 L520,956", 9), stroke("M708,948 L566,980", 8), stroke("M724,944 L766,954", 7),
                    stroke("M626,836 L508,808", 8), stroke("M626,838 L598,872", 7)]).difference(TARSUS)

body_rough = [
    ("belly", SIL),
    # the barred side below the folded wing
    ("flanks", poly("M455,560 C520,620 600,650 700,660 C800,660 880,640 940,620 L1000,700 L1000,760 C900,766 760,770 640,770 "
                    "C560,766 500,740 455,700 Z")),
    ("undertail-coverts", poly("M940,700 C960,690 975,680 990,672 L1040,672 L1040,780 L930,780 C932,750 935,720 940,700 Z")),
    ("breast", poly("M150,370 L300,370 L310,330 L490,330 L490,640 C470,660 466,690 470,710 L380,800 L150,800 Z")),
    ("rump", poly("M860,420 L1010,420 L1010,690 L905,690 C915,650 900,600 880,560 C866,530 860,480 860,420 Z")),
    ("back", poly("M466,380 L900,380 L900,580 L520,580 L520,500 L462,470 Z")),
    ("nape", poly("M330,200 L478,200 L478,478 L470,470 C440,440 410,410 380,390 C352,360 336,320 330,290 Z")),
    ("throat", poly("M150,322 L230,332 C260,332 290,330 312,326 C320,350 318,380 300,400 C290,404 280,402 270,396 L150,396 Z")),
    ("face", poly("M150,240 L338,240 C360,266 362,306 336,338 C300,334 260,332 230,332 L150,322 Z")),
]
final = {}
claimed = WOUT.union(BILL).union(CREST).union(COMB).union(RUFF)
for pid, rough in reversed(body_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
final["crest"] = CREST.difference(COMB)
final["comb"] = COMB
final["ruff"] = RUFF.intersection(SIL).difference(WOUT)
final["bill"] = BILL
final["tarsus"] = TARSUS
final["toes"] = TOES
final["subterminal-band"] = BAND
final["tail"] = TAIL.difference(BAND)


def one_piece(final, keys, speck=60):
    """Every listed part must be one piece (the tubenose's lesson: a remainder part soaks up every gap).
    A speck smaller than `speck` square units where three regions meet goes to the neighbour it
    shares the longest edge with; anything bigger stops the script."""
    for k in keys:
        pieces = sorted(getattr(final[k], "geoms", [final[k]]), key=lambda q: -q.area)
        for q in pieces[1:]:
            if q.area >= speck: raise SystemExit(f"gamebird: {k} is in {len(pieces)} pieces")
            if q.area < 0.5: continue
            ring = q.buffer(0.6)
            best = max((n for n in keys if n != k), key=lambda n: ring.intersection(final[n]).area)
            final[best] = final[best].union(q).buffer(0.01).buffer(-0.01)
        final[k] = pieces[0]
    for k in keys:
        if final[k].geom_type != "Polygon": raise SystemExit(f"gamebird: {k} is in {len(final[k].geoms)} pieces")


one_piece(final, [k for k, _ in body_rough])

# wing: the scapulars along the top, the tertials and the primary tips at the rear, and the covert rows
# parallel to the lower edge, the secondaries along it
def row(d0, d1):
    return EDGE.buffer(d1, cap_style=2).difference(EDGE.buffer(d0, cap_style=2))
w = WOUT
final["primaries"] = w.intersection(poly("M850,640 C870,620 900,610 940,606 L940,720 L850,720 Z"))
w = w.difference(final["primaries"])
final["tertials"] = w.intersection(poly("M800,500 C850,510 900,540 940,560 L940,610 C900,614 870,624 850,645 C830,600 815,560 800,500 Z"))
w = w.difference(final["tertials"])
final["scapulars"] = w.intersection(poly("M440,440 L900,440 L900,540 C820,524 740,512 660,510 C580,510 520,516 450,530 Z"))
w = w.difference(final["scapulars"])
final["secondaries"] = EDGE.buffer(24, cap_style=2).intersection(w)
final["greater-coverts"] = row(24, 52).intersection(w)
final["median-coverts"] = row(52, 80).intersection(w)
final["lesser-coverts"] = w.difference(EDGE.buffer(80, cap_style=2))
one_piece(final, ["primaries", "tertials", "scapulars", "secondaries", "greater-coverts", "median-coverts", "lesser-coverts"])
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)

# marks (never tap targets): the wide dark bars on the flanks, the white streaks on the scapulars, the
# white dots on the rump, the bars across the tail, the pale line inside the band and the pale tip
FLANK_BARS = unary_union([stroke(f"M{x},{650 + (x - 470) * 0.05:.0f} L{x + 26},{776}", 12) for x in range(486, 980, 46)])
SCAP_STREAKS = unary_union([stroke(f"M{x},{478 + (x - 470) * 0.05:.0f} L{x + 70},{486 + (x - 470) * 0.07:.0f}", 5) for x in range(500, 840, 60)])
RUMP_DOTS = unary_union([Point(x + (13 if (y // 30) % 2 else 0) + (7 * x * y) % 9 - 4, y + (5 * x) % 7 - 3).buffer(4.2)
                        for x in range(884, 1000, 27) for y in range(468, 660, 30)])
band_line = LineString(pts(BAND_EDGE))
# the bars run across the fan, each a smaller copy of the band's edge about the base of the tail
bar_line = LineString(pts(BAND_EDGE.replace("M1130,330", "M1080,268 L1130,330") + " L1160,820"))   # run past the tail's edges
TAIL_BARS = unary_union([affinity.scale(bar_line, f, f, origin=(985, 560)).buffer(2.0) for f in (0.88, 0.77, 0.66, 0.55, 0.44, 0.33)])
PALE_LINE = band_line.buffer(4)
TIP = TAIL.difference(TAIL.buffer(-8)).intersection(poly("M1180,300 L1400,300 L1400,800 L1215,800 Z"))
marks = {"flanks": [(FLANK_BARS, "darker")],
         "scapulars": [(SCAP_STREAKS, "pale")],
         "rump": [(RUMP_DOTS, "pale")],
         "tail": [(TAIL_BARS, "eye"), (PALE_LINE, "pale")],
         "subterminal-band": [(TIP, "pale")]}

# level, scale and mirror everything
final = {k: F(v) for k, v in final.items()}
marks = {k: [(F(g), t) for g, t in v] for k, v in marks.items()}
OUTLINE = F(unary_union([SIL, CREST, BILL, TAIL]))
EYE_O = F(Point(*EYE).buffer(13))

META = [
    ("tarsus", "light", "mf"), ("toes", "linegray", "mf"),
    ("tail", "chestnut", "mf"), ("subterminal-band", "eye", "mf"),
    ("undertail-coverts", "light", "mf"), ("belly", "light", "mf"), ("flanks", "light", "mf"), ("breast", "mid", "mf"),
    ("rump", "dark", "mf"), ("back", "dark", "mf"), ("nape", "dark", "mf"), ("throat", "light", "mf"), ("face", "mid", "mf"),
    ("crest", "dark", "mf"), ("ruff", "eye", "mf"), ("comb", "orange", "mf"), ("bill", "eye", "mf"),
    ("wing-coverts", "dark", "m"), ("lesser-coverts", "dark", "f"), ("median-coverts", "dark", "f"), ("greater-coverts", "dark", "f"),
    ("secondaries", "darker", "mf"), ("scapulars", "dark", "mf"), ("tertials", "wing", "mf"), ("primaries", "darker", "mf"),
]
order = [m[0] for m in META]
build("gamebird", final, META, order, [0, 0, 760, 510], dx=0, dy=0,
      marks=marks,
      base_over=[(EYE_O, "eye")],
      outline=OUTLINE)
print("bounds", [round(v) for v in OUTLINE.bounds])

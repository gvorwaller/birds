"""Adult male Ruby-throated Hummingbird perched on a wire, side view (td-725e4c).

Traced from a left-facing reference photo (proportions only; listed in src/lib/bird-parts/hummingbird.ts),
scaled down and mirrored to face right. A hummingbird is tiny, with a long, straight, needle-like bill,
an iridescent throat patch (the gorget), a small white spot behind the eye, very short legs, and long
wings that are nearly all hand: the long primaries reach the tail, and the secondaries are short.
"""
from geom import *
from common import build
from shapely import affinity
from shapely.geometry import Point
from shapely.ops import unary_union

K, X0, Y0 = 0.75, 1165, -205


def F(g):
    """Photo coordinates -> output: scale and mirror to face right."""
    return affinity.translate(affinity.scale(g, -K, K, origin=(0, 0)), X0, Y0).buffer(0)


# head and body to the tail tip (the bill is separate)
SIL = poly("M795,357 C810,340 835,318 870,310 C910,304 950,312 980,332 C1000,352 1012,392 1015,425 "
           "C1060,452 1120,490 1180,545 C1240,606 1300,668 1360,725 C1420,782 1480,842 1520,880 "
           "C1490,880 1450,868 1390,850 C1330,838 1270,824 1220,812 C1180,804 1150,802 1120,800 "
           "C1090,795 1060,784 1040,775 C1020,766 1006,756 994,742 C978,722 960,690 940,655 "
           "C920,620 900,592 885,570 C874,550 866,532 860,515 C850,496 836,478 825,460 "
           "C814,440 806,418 800,392 Z")
EYE = (893, 361)
BILL = poly("M598,362 C650,362 730,361 795,356 C799,368 801,380 800,391 C740,385 660,381 600,378 C594,374 594,366 598,362 Z")
# the folded wing, from the bend of the wing down to the primary tips, which stop short of the tail tip
WOUT = SIL.intersection(poly("M1012,500 C1060,498 1120,520 1160,560 C1180,600 1200,660 1240,700 "
                             "C1290,740 1350,782 1390,848 C1340,880 1270,860 1210,815 C1150,785 1090,750 1050,705 "
                             "C1012,660 996,600 998,550 C1000,525 1004,510 1012,500 Z"))
FEET = unary_union([poly("M988,752 L1012,754 L1026,792 L1018,814 L996,816 L984,800 L1000,792 L992,772 Z"),
                    poly("M1056,780 L1078,782 L1094,800 L1088,814 L1062,814 L1052,800 Z")])
PERCH = stroke("M560,798 L1580,804", 18)

head_rough = [
    ("flanks", SIL),
    ("belly", poly("M900,690 L1000,690 Q1040,736 1076,752 L1076,860 L900,860 Z")),
    ("undertail-coverts", poly("M1070,730 L1260,730 L1260,860 L1070,860 Z")),
    ("breast", poly("M830,470 L962,462 Q976,540 966,600 Q960,660 976,712 L960,760 L820,760 Z")),
    ("back", poly("M990,380 L1320,560 L1250,760 L1150,620 L1060,520 L1012,500 L990,480 Z")),
    ("rump", poly("M1240,560 L1380,660 L1386,668 L1291,771 L1240,705 Z")),
    ("tail", poly("M1386,668 L1291,771 L1400,950 L1650,950 L1650,600 Z")),
    ("gorget", poly("M790,384 Q850,397 900,404 Q960,410 1014,418 L1016,442 Q992,466 960,488 Q920,506 866,520 L840,520 L790,440 Z")),
    ("nape", poly("M975,280 L1100,280 L1100,470 L1018,444 L1012,420 L975,420 Z")),
    ("face", poly("M790,330 L985,330 L990,416 Q960,410 900,404 Q850,397 790,388 Z")),
    ("crown", poly("M780,270 L1000,270 L1000,330 Q975,336 958,342 Q920,342 900,341 Q860,341 830,346 Q808,351 792,360 Z")),
    ("post-ocular-spot", affinity.scale(Point(917, 354).buffer(1), 5.5, 8.5)),
]
final = {}
claimed = WOUT.union(BILL)
for pid, rough in reversed(head_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
final["bill"] = BILL
final["toes"] = FEET

# wing: the coverts along the front edge (lesser, median, then greater next to the secondaries), the
# short secondaries behind them, and the long primaries below and out to the tip
COV = poly("M980,480 L1086,500 L1034,720 L980,720 Z")
WROWS = {
    "lesser-coverts": poly("M980,480 L1028,488 L998,720 L960,720 Z"),
    "median-coverts": poly("M1028,488 L1058,494 L1018,720 L998,720 Z"),
    "greater-coverts": poly("M1058,494 L1090,500 L1036,720 L1018,720 Z"),
}
claimed_w = Point(0, 0).buffer(0)
for k, rough in WROWS.items():
    final[k] = rough.intersection(WOUT).difference(claimed_w)
    claimed_w = claimed_w.union(final[k])
final["secondaries"] = poly("M1086,480 L1210,560 L1192,664 Q1110,684 1036,712 Z").intersection(WOUT).difference(claimed_w)
claimed_w = claimed_w.union(final["secondaries"])
final["primaries"] = WOUT.difference(claimed_w)
for k in ("lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "primaries"):
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"hummingbird: {k} is in {len(g.geoms)} pieces")
    final[k] = g
# closed up so the rows show as one area with no seams
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)

# every head and body part is one piece (the tubenose's lesson: a remainder part soaks up stray slivers)
for k, _ in head_rough:
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])   # drop zero-area specks
    if g.geom_type != "Polygon": raise SystemExit(f"hummingbird: {k} is in {len(g.geoms)} pieces")
    final[k] = g

final = {k: F(v) for k, v in final.items()}

# The face areas field guides name, so a species page's "lores" or "supercilium" opens this bird (td-93f86b).
# Drawn in output coordinates (the bird faces right) and carved from the face and crown, nearest the eye first;
# the post-ocular spot stays on top, and nothing is left under the eye.
EYE_C, EYE_R = (495.25, 65.75), 11.25
eye_disk = Point(*EYE_C).buffer(EYE_R)
HEAD_AREAS = [
    ("eye-ring", Point(*EYE_C).buffer(14.5).difference(eye_disk)),
    ("lores", poly("M506,56 L568,60 L568,80 L506,76 Z")),
    ("eye-line", poly("M418,56 L490,57 L490,74 L418,74 Z")),   # its front edge follows the eye-ring
    # the next two reach into the areas already taken, so no strip of face is left between them
    ("supercilium", poly("M418,44 L500,42 L548,47 L570,62 L418,62 Z")),
    ("ear-coverts", poly("M418,68 L500,70 L505,97 L418,108 Z")),
    ("malar", poly("M568,80 L568,92 L505,101 L505,92 Z")),
]
head = final["face"].union(final["crown"])
claimed_h = final["post-ocular-spot"].union(eye_disk)
for pid, rough in HEAD_AREAS:
    final[pid] = rough.intersection(head).difference(claimed_h)
    claimed_h = claimed_h.union(final[pid])
for k in ("face", "crown"):
    final[k] = final[k].difference(claimed_h)
# the post-ocular spot nearly touches the eye-ring, cutting a crumb off the eye-line: the ring takes it
for k in ("eye-line", "supercilium"):
    crumbs = [q for q in getattr(final[k], "geoms", [final[k]]) if q.area < 20 and q.distance(final["eye-ring"]) < 0.5]
    for q in crumbs:
        final[k] = final[k].difference(q.buffer(0.01))
        final["eye-ring"] = final["eye-ring"].union(q)
# What is left of the face is a scrap under the eye (CODEX1): each piece goes to the head area it shares the
# longest edge with, and the face is drawn only from below, where it is the whole front of the head.
names = [pid for pid, _ in HEAD_AREAS]
for q in [q for q in getattr(final["face"], "geoms", [final["face"]]) if q.area > 0]:
    ring = q.buffer(0.6)
    best = max(names, key=lambda n: ring.intersection(final[n]).area)
    final[best] = final[best].union(q).buffer(0.01).buffer(-0.01)
del final["face"]
# the uppertail coverts lie over the base of the tail, across the line where the rump meets it
utc = poly("M147,328 L184,368 L203,347 L166,308 Z")
final["uppertail-coverts"] = utc.intersection(final["rump"].union(final["tail"]))
for k in ("rump", "tail"):
    final[k] = final[k].difference(utc)
for k in [pid for pid, _ in HEAD_AREAS] + ["crown", "rump", "tail", "uppertail-coverts"]:
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"hummingbird: {k} is in {len(g.geoms)} pieces: {[(round(q.area), [round(v) for v in q.bounds]) for q in g.geoms]}")
    final[k] = g
META = [
    ("tail", "darker", "mf"), ("rump", "mallardgreen", "mf"), ("undertail-coverts", "pale", "mf"), ("belly", "light", "mf"),
    ("flanks", "mallardgreen", "mf"), ("breast", "pale", "mf"), ("back", "mallardgreen", "mf"), ("nape", "mallardgreen", "mf"),
    ("gorget", "accent", "mf"), ("crown", "mallardgreen", "mf"),
    ("ear-coverts", "darker", "mf"), ("malar", "darker", "mf"), ("supercilium", "mallardgreen", "mf"), ("eye-line", "darker", "mf"),
    ("lores", "darker", "mf"), ("eye-ring", "darker", "mf"), ("post-ocular-spot", "pale", "mf"),
    ("uppertail-coverts", "mallardgreen", "mf"),
    ("wing-coverts", "mallardgreen", "m"), ("lesser-coverts", "mallardgreen", "f"), ("median-coverts", "mallardgreen", "f"),
    ("greater-coverts", "mallardgreen", "f"), ("secondaries", "dark", "mf"), ("primaries", "dark", "mf"),
    ("bill", "eye", "mf"), ("toes", "eye", "mf"),
]
order = ["tail", "rump", "uppertail-coverts", "undertail-coverts", "belly", "flanks", "breast", "back", "nape", "gorget", "crown",
         "ear-coverts", "malar", "supercilium", "eye-line", "lores", "eye-ring", "post-ocular-spot", "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "primaries",
         "bill", "toes"]
# feather edges on the folded primaries (never tap targets)
PLINES = unary_union([stroke(d, 1.6) for d in ("M1100,742 L1384,846", "M1140,722 L1386,842", "M1180,706 L1388,838")]).intersection(WOUT)
build("hummingbird", final, META, order, [0, 0, 740, 470], dx=0, dy=0,
      base_under=[(F(PERCH), "perch")],
      base_over=[(F(PLINES), "darker"), (F(Point(*EYE).buffer(15)), "eye"), (F(Point(EYE[0] - 5, EYE[1] - 5).buffer(3.6)), "pale")],
      outline=F(unary_union([SIL, BILL])))

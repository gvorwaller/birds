"""Adult male Rose-ringed Parakeet, perched, side view, with a close-up of a foot (td-72fe55).

Traced from a perched, right-facing reference photo of the northern Indian subspecies, P. k. borealis
(proportions only; listed in src/lib/bird-parts/parrot.ts).
A parakeet perches upright: a large head with a deep, hooked bill, the folded wing along the back with its dark
primaries reaching past the base of the long, graduated tail, and short legs. The male wears a black bib and a
narrow black-and-rose ring round the neck. Its feet are zygodactyl, two toes forward and two back, which the
"Foot, close up" inset shows; the "Head, close up" inset draws the head again, larger, for the small face parts.
"""
import math
from geom import *
from common import build
from shapely.geometry import Point, box
from shapely import affinity
from shapely.ops import unary_union

# head and body to the base of the tail (the bill, the folded wing and the tail are separate)
SIL = poly("M668,240 C664,214 640,194 610,188 C575,182 535,190 508,208 C490,222 482,245 482,270 "
           "C480,292 470,310 455,325 C430,348 400,380 375,415 C345,460 322,520 308,580 "
           "C298,630 294,690 300,742 L330,760 C380,784 430,800 462,796 C472,780 486,762 506,744 "
           "C534,724 562,706 590,694 C615,672 632,634 642,590 C652,540 658,480 658,420 "
           "C658,380 655,350 648,334 L646,314 L638,309 L626,304 L606,284 L620,262 L630,234 Z")
EYE = (568, 240)
# the deep, hooked bill: the red upper mandible curving down over the lower one, which is reddish on borealis
# (the dark area under the bill in the reference photo is the black bib)
UPPER = poly("M620,236 C640,226 664,230 674,246 C682,264 678,292 662,310 C656,316 650,318 646,314 "
             "C650,298 646,284 636,276 C628,272 620,270 613,268 Z")
LOWER = poly("M612,262 C626,268 642,276 648,292 C650,304 647,316 640,316 C626,312 612,302 606,284 Z")
# the cere: the band at the base of the upper bill, under the forehead feathers
CERE = poly("M617,238 C630,226 652,224 668,234 L670,242 C652,236 632,236 621,244 Z")
# closed up, so no sliver of background shows between the mandibles
BILL = UPPER.union(LOWER).buffer(3, join_style=2).buffer(-3, join_style=2).difference(CERE)
# the line where the upper mandible closes over the lower (a mark, never a tap target)
GAPE = stroke("M613,268 C620,270 628,272 636,276 C646,284 650,298 646,314", 1.8)
PERCH = stroke("M150,708 C330,704 520,710 760,706", 34)

# The folded wing: from the shoulder at the back of the neck, along the back, to the dark primaries
# that reach past the tail's base.
WOUT = poly("M478,318 C468,400 452,470 430,530 C405,600 375,660 345,712 C315,762 270,822 230,860 L192,888 "
            "C200,850 222,800 244,758 C262,700 274,640 284,580 C300,500 332,440 366,400 C400,362 440,334 478,318 Z")
WING = Frame(s=(470, 330), c=(372, 560), t=(196, 884), width=62, taper=0.7, tip=4)
BODY = SIL.union(WOUT)

# the long, graduated tail, hanging below the perch (its yellowish underside shows along the front)
TAIL = poly("M300,742 C330,740 380,748 420,770 C412,850 392,950 362,1050 C340,1130 312,1230 270,1362 "
            "C266,1300 268,1200 272,1100 C276,1000 284,900 292,820 C294,790 296,766 300,742 Z")
TAIL_UNDER = poly("M330,740 L430,760 L420,860 L380,1000 L330,1160 L290,1300 L300,1100 L320,900 Z")

# legs: the short grey tarsus and the four toes gripping the perch, two over the front, two round the back
TARSUS = poly("M586,686 L600,686 L601,697 L588,698 Z")
TOES = unary_union([stroke("M598,700 Q616,694 628,700 L634,716", 7), stroke("M600,702 Q612,704 620,712 L622,724", 6),
                    stroke("M590,702 Q574,706 566,716 L564,728", 7), stroke("M592,704 Q584,712 580,722 L580,732", 6)])

body_rough = [
    ("belly", SIL),
    ("undertail-coverts", poly("M300,700 L520,700 L520,820 L300,820 Z")),
    ("flanks", poly("M380,480 L500,470 C520,560 540,630 560,700 L420,760 L340,740 Z")),
    ("breast", poly("M456,316 L500,280 L670,280 L670,520 Q600,510 540,530 L440,500 L440,380 Z")),
    ("back", poly("M472,296 L506,296 L504,344 L472,352 Z")),
    ("nape", poly("M436,206 L520,206 L540,232 L530,262 L512,292 L500,300 L472,300 L472,322 L436,346 Z")),
    # the head below the crown, down to the neck ring (the breast starts under the ring)
    ("face", poly("M496,222 L690,222 L690,300 L664,360 L640,360 L612,292 L580,302 L546,304 L512,292 L488,272 Z")),
    ("crown", poly("M500,170 L690,170 L690,232 L668,232 L640,222 L600,222 L560,222 L530,226 L515,236 L500,236 Z")),
]
final = {}
claimed = WOUT.union(UPPER).union(LOWER).union(CERE)
for pid, rough in reversed(body_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))

# The head areas, nearest the eye first, carved from what the crown, nape and belly left of the head. The
# throat is the male's black bib under the bill; the neck ring runs from it back under the cheek to the nape.
eye_disk = Point(*EYE).buffer(7)
RING = poly("M612,296 C596,310 572,318 546,314 C522,310 502,298 490,282 C484,272 482,262 482,252 "
            "L492,252 C494,264 498,274 506,284 C520,298 540,306 562,306 C584,306 600,298 612,288 Z")
PINK = poly("M490,282 C502,298 522,310 546,314 L544,322 C518,320 498,306 484,290 C480,280 478,270 478,258 L482,252 C482,262 484,272 490,282 Z")
HEAD = [
    ("orbital-ring", Point(*EYE).buffer(11).difference(eye_disk)),
    ("eye-ring", Point(*EYE).buffer(14).difference(eye_disk)),
    # the male's thin black line from the eye to the cere
    ("lores", poly("M579,233 L618,230 L620,237 L580,241 Z")),
    ("supercilium", poly("M512,222 L540,218 L600,212 L640,218 L620,226 L580,228 L560,226 L540,230 L512,234 Z")),
    # the eye-line and the supercilium run back to the bluish nape, so the cheek below them stays one compact patch
    ("eye-line", poly("M512,232 L556,232 L556,250 L512,254 Z")),
    ("throat", poly("M606,292 L612,262 L640,300 L660,330 L662,356 L640,358 L612,320 L600,300 Z")),
    ("neck-ring", RING.union(PINK)),
    ("malar", poly("M582,243 L612,240 L612,292 L596,302 L586,290 L580,262 Z")),
    ("ear-coverts", poly("M528,250 L556,250 L580,250 L590,262 L586,292 L560,304 L536,300 L526,290 Z")),
]
head = unary_union([final[k] for k in ("face", "crown", "nape", "breast")])
claimed_h = eye_disk
for pid, rough in HEAD:
    final[pid] = rough.intersection(head).difference(claimed_h)
    claimed_h = claimed_h.union(final[pid])
for k in ("face", "crown", "nape", "breast"):
    final[k] = final[k].difference(claimed_h)
# What is left of the face goes, piece by piece, to the head area it shares the longest edge with.
names = [pid for pid, _ in HEAD if pid not in ("orbital-ring", "eye-ring")] + ["crown", "nape"]
for q in [q for q in getattr(final["face"], "geoms", [final["face"]]) if q.area > 0]:
    ring = q.buffer(0.6)
    best = max(names, key=lambda n: ring.intersection(final[n]).area)
    final[best] = unary_union([final[best], q.buffer(0.01)]).intersection(head)
del final["face"]
# behind the eye-line and supercilium the head is the bluish nape, not the cheek
_strip = final["ear-coverts"].intersection(box(470, 200, 512, 252))
final["ear-coverts"] = final["ear-coverts"].difference(_strip)
final["nape"] = unary_union([final["nape"], _strip])
# so do slivers the head areas cut off the crown and the breast
for k in ("crown", "breast"):
    pieces = sorted(getattr(final[k], "geoms", [final[k]]), key=lambda q: -q.area)
    final[k] = pieces[0]
    for q in [q for q in pieces[1:] if q.area > 0]:
        ring = q.buffer(0.6)
        best = max(names, key=lambda n: ring.intersection(final[n]).area)
        final[best] = unary_union([final[best], q.buffer(0.01)]).intersection(SIL)
# The ring cuts the nape: the hindneck below the ring is the back's (green), the nape is above it.
pieces = [q for q in getattr(final["nape"], "geoms", [final["nape"]]) if q.area > 0]
final["nape"] = unary_union([q for q in pieces if q.centroid.y < 268])
for q in [q for q in pieces if q.centroid.y >= 268]:
    final["back"] = unary_union([final["back"], q.buffer(0.01)]).intersection(SIL)

final["bill"] = BILL
final["cere"] = CERE
final["tarsus"] = TARSUS
# the four toes meet at the foot, just below the tarsus, so on the bird they are one piece
final["toes"] = TOES.union(Point(595, 702).buffer(5)).difference(TARSUS)
# the tail is the whole tail; the undertail coverts and the body lie over its base
final["tail"] = TAIL.difference(BODY)

# The wing is split by explicit bands of the folded-wing frame (the auk's lesson: a generic layout crushes the rows
# on a narrow wing), front to tip: the scapulars along the back over the upper wing, the three covert rows one
# below the other, the tertials over the rear and the secondaries in front of them, then the long primaries.
def wband(u0, u1, v0, v1, scallops=0):
    return fband(WING, u0, u1, v0, v1, scallops=scallops, amp=0.012 if scallops else 0.0, skew=-0.05)


WROWS = [
    ("scapulars", wband(-0.4, 0.30, -2.0, -0.85, 4)),
    ("lesser-coverts", wband(-0.5, 0.10, -0.85, 3.0, 3)),
    ("median-coverts", wband(0.10, 0.20, -0.85, 3.0, 4)),
    ("greater-coverts", wband(0.20, 0.34, -0.85, 3.0, 5)),
    ("tertials", wband(0.30, 0.62, -2.0, -0.15, 1)),
    ("secondaries", wband(0.34, 0.60, -0.15, 3.0)),
]
claimed_w = Point(0, 0).buffer(0)
for k, rough in WROWS:
    final[k] = rough.intersection(WOUT).difference(claimed_w)
    claimed_w = claimed_w.union(final[k])
final["primaries"] = WOUT.difference(claimed_w)
# the frame's bands stop short of the back edge near the shoulder; that strip is scapulars
_p = sorted(getattr(final["primaries"], "geoms", [final["primaries"]]), key=lambda q: -q.area)
final["primaries"] = _p[0]
for q in [q for q in _p[1:] if q.area >= 1]:
    final["scapulars"] = final["scapulars"].union(q)
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)
# Where wing bars and a speculum would be (a Rose-ringed Parakeet has neither, so the surrounding tone): the tips of
# the median and greater coverts, and the middle of the exposed secondaries.
final["wing-bars"] = unary_union([final["median-coverts"].intersection(wband(0.17, 0.21, -0.85, 3.0)),
                                  final["greater-coverts"].intersection(wband(0.30, 0.35, -0.85, 3.0))])
final["speculum"] = final["secondaries"].intersection(wband(0.40, 0.52, -0.15, 2.0))

# every head and body part, and every wing part, is one piece
for k in [pid for pid, _ in body_rough if pid != "face"] + [pid for pid, _ in HEAD] + ["scapulars", "tertials", "primaries", "lesser-coverts",
                                                                        "median-coverts", "greater-coverts", "secondaries", "speculum"]:
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon":
        raise SystemExit(f"parrot: {k} is in {len(g.geoms)} pieces: {[(round(q.area), [round(v) for v in q.bounds]) for q in g.geoms]}")
    final[k] = g

DX, DY = 150, 160
# The close-up: a foot round a perch, two toes forward and two back, in output coordinates.
IC, IR = (470, 830), 108
clip_i = Point(*IC).buffer(IR - 4)
PERCH_I = Point(IC[0], IC[1] + 30).buffer(34).intersection(clip_i)
J = (IC[0] + 2, IC[1] - 6)
TARSUS_I = stroke(f"M{IC[0] - 34},{IC[1] - 96} L{J[0]},{J[1]}", 20).intersection(clip_i)
TOES_I = unary_union([
    # two toes forward, over the front of the perch
    stroke(f"M{J[0]},{J[1]} Q{IC[0] + 34},{IC[1] - 8} {IC[0] + 40},{IC[1] + 22}", 11), stroke(f"M{IC[0] + 40},{IC[1] + 18} Q{IC[0] + 44},{IC[1] + 34} {IC[0] + 32},{IC[1] + 40}", 5),
    stroke(f"M{J[0]},{J[1]} Q{IC[0] + 26},{IC[1] + 4} {IC[0] + 28},{IC[1] + 34}", 10), stroke(f"M{IC[0] + 28},{IC[1] + 30} Q{IC[0] + 30},{IC[1] + 46} {IC[0] + 18},{IC[1] + 50}", 5),
    # two toes back, round the rear of the perch
    stroke(f"M{J[0]},{J[1]} Q{IC[0] - 32},{IC[1] - 6} {IC[0] - 40},{IC[1] + 22}", 11), stroke(f"M{IC[0] - 40},{IC[1] + 18} Q{IC[0] - 44},{IC[1] + 34} {IC[0] - 32},{IC[1] + 40}", 5),
    stroke(f"M{J[0]},{J[1]} Q{IC[0] - 22},{IC[1] + 4} {IC[0] - 26},{IC[1] + 34}", 10), stroke(f"M{IC[0] - 26},{IC[1] + 30} Q{IC[0] - 28},{IC[1] + 46} {IC[0] - 16},{IC[1] + 50}", 5),
]).difference(TARSUS_I).intersection(clip_i)

# The "Head, close up": the head drawn again, larger, in output coordinates, in the lower right of the plate. Each
# area is the same part as on the bird, so a tap on either selects it.
HC, HK = (616, 264), 1.75
IC2, IR2 = (470, 1088), 128
clip_h = Point(*IC2).buffer(IR2 - 4)


def FH(g):
    return affinity.translate(affinity.scale(g, HK, HK, origin=HC), IC2[0] - HC[0], IC2[1] - HC[1]).intersection(clip_h)


HEAD_PARTS = ["crown", "nape", "supercilium", "eye-line", "ear-coverts", "malar", "throat", "neck-ring", "lores",
              "eye-ring", "orbital-ring", "bill", "cere", "breast"]
head_raw = {k: FH(final[k]) for k in HEAD_PARTS}
head_raw = {k: g for k, g in head_raw.items() if g.area >= 1}
HEAD_BASE = FH(SIL.union(BILL).union(CERE))


def pieces(g):
    return [q for q in getattr(g, "geoms", [g]) if q.area >= 1]


# Every part copied into a close-up is one piece there, and still one piece on the bird (CODEX1: clipping the
# enlarged head left an island of the ear coverts behind the eye, selected with the cheek far from it).
for k, g in {**head_raw, "toes": TOES_I, "tarsus": TARSUS_I}.items():
    if k != "toes" and len(pieces(g)) != 1:
        raise SystemExit(f"parrot: {k} is in {len(pieces(g))} pieces in its close-up")
    if len(pieces(final[k])) != 1:
        raise SystemExit(f"parrot: {k} is in {len(pieces(final[k]))} pieces on the bird")
# the toes are two pieces in the foot close-up: the forward pair and the back pair, each joined at the foot
if len(pieces(TOES_I)) != 2:
    raise SystemExit(f"parrot: the close-up's toes are in {len(pieces(TOES_I))} pieces, not two pairs")
# The close-up's eye is drawn under the parts (raw_base), which common.check_eyes does not see: it must sit inside
# the close-up's head, wholly in the hole the orbital ring leaves for it.
EYE_I = FH(Point(*EYE).buffer(7))
if EYE_I.difference(HEAD_BASE).area > 0.02 * EYE_I.area or EYE_I.area < 0.98 * (math.pi * (7 * HK) ** 2):
    raise SystemExit("parrot: the head close-up's eye is not inside the close-up's head")
# marks on the close-up, given in tracing coordinates (build moves base_over by DX, DY)
FHT = lambda g: affinity.translate(FH(g), DX, DY)

META = [
    ("tail", "parakeet", "mf"), ("undertail-coverts", "parakeet", "mf"), ("belly", "parakeet", "mf"), ("flanks", "parakeet", "mf"),
    ("breast", "parakeet", "mf"), ("back", "parakeet", "mf"), ("nape", "gullgray", "mf"), ("crown", "parakeet", "mf"),
    ("ear-coverts", "parakeet", "mf"), ("malar", "parakeet", "mf"), ("throat", "eye", "mf"), ("neck-ring", "eye", "mf"),
    ("eye-line", "parakeet", "mf"), ("supercilium", "parakeet", "mf"), ("lores", "eye", "mf"),
    ("eye-ring", "parakeet", "mf"), ("orbital-ring", "orbital", "mf"),
    ("wing-coverts", "parakeet", "m"), ("lesser-coverts", "parakeet", "f"), ("median-coverts", "parakeet", "f"),
    ("greater-coverts", "parakeet", "f"), ("wing-bars", "parakeet", "mf"), ("secondaries", "mallardgreen", "mf"),
    ("speculum", "mallardgreen", "f"), ("scapulars", "parakeet", "mf"), ("tertials", "parakeet", "mf"),
    ("primaries", "mallardgreen", "mf"),
    ("bill", "accent", "mf"), ("cere", "legpink", "mf"), ("tarsus", "linegray", "mf"), ("toes", "linegray", "mf"),
]
order = ["tail", "undertail-coverts", "belly", "flanks", "breast", "back", "nape", "crown", "ear-coverts", "malar", "throat",
         "neck-ring", "eye-line", "supercilium", "lores", "eye-ring", "orbital-ring",
         "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "wing-bars", "secondaries", "speculum",
         "scapulars", "tertials", "primaries", "bill", "cere", "tarsus", "toes"]
marks = {
    "neck-ring": [(PINK, "legpink")],
    "bill": [(GAPE, "darker")],
    # the yellowish underside of the long tail
    "tail": [(TAIL_UNDER, "billyellow")],
}
build("parrot", final, META, order, [0, 0, 620, 1220], dx=DX, dy=DY,
      base_under=[(PERCH.intersection(box(DX, DY, DX + 620, DY + 1220)), "perch")],
      raw_base=[(PERCH_I, "perch"), (HEAD_BASE, "parakeet"), (EYE_I, "pale"), (FH(Point(*EYE).buffer(3.6)), "eye")],
      extra_raw={"toes": TOES_I, "tarsus": TARSUS_I, **head_raw},
      insets=[{"cx": IC[0], "cy": IC[1], "r": IR, "label": "Foot, close up"},
              {"cx": IC2[0], "cy": IC2[1], "r": IR2, "label": "Head, close up"}],
      # the close-up's window stops short of the ring's rose band, so only the bill's gape line is repeated there
      base_over=[(Point(*EYE).buffer(7), "pale"), (Point(*EYE).buffer(3.6), "eye"), (FHT(GAPE.intersection(BILL)), "darker")],
      marks=marks,
      outline=unary_union([BODY, BILL, CERE, TAIL]))

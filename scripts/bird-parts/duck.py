from geom import *
from common import build
from shapely.geometry import Point, box

WATER = 352
SIL = poly("M742,152 C738,136 728,118 712,108 C696,99 676,97 658,101 C636,106 618,120 610,140 "
           "C602,160 598,190 596,212 C594,226 588,234 572,238 C520,244 450,240 390,240 "
           "C340,240 300,244 272,244 C262,244 254,242 246,240 L154,222 Q136,222 138,236 "
           "L210,262 C222,296 248,324 290,342 C330,358 420,368 520,368 C620,368 700,362 745,345 "
           "C778,330 792,306 790,284 C788,262 774,248 752,240 C738,234 728,222 726,206 "
           "C726,200 730,196 736,193 Z")
SIL = SIL.intersection(box(0, 0, 1000, WATER))
EYE = (695, 136)
BILL = poly("M741,150 C770,156 805,166 832,172 Q846,176 846,184 Q842,191 828,190 C800,190 770,192 736,194 C734,180 736,164 741,150 Z")
# the base of the upper bill where it meets the forehead: where a Cape Barren Goose's big cere sits (td-2a2f94)
CERE = BILL.intersection(poly("M734,140 L766,148 L764,163 L734,168 Z"))
NAIL = poly("M830,172 Q846,176 846,184 Q842,191 829,190 Q834,181 830,172 Z")
CURL = stroke("M262,246 C250,232 236,232 238,242 C240,250 250,248 248,240", 4)

# the sloping front of the head down to the bill, kept whole: the eyebrow and lores stay behind it (CODEX1, td-93f86b)
FOREHEAD = SIL.difference(SIL.buffer(-12)).intersection(poly("M700,92 L790,92 L790,148 L736,148 L700,108 Z"))

body = [
    ("sides", SIL),
    ("breast", poly("M590,232 L700,232 Q760,228 820,240 L820,360 L690,360 Q650,300 640,250 Z")),
    ("flanks", poly("M240,270 L380,262 Q400,310 392,360 L240,360 Z")),
    # the drake's black stern, under the tail down to the water
    ("undertail-coverts", poly("M196,262 L256,252 Q280,300 312,352 L196,352 Z")),
    ("back", poly("M560,200 L600,230 L590,255 Q480,262 380,262 L360,236 Z")),
    ("rump", poly("M248,240 L340,236 L342,268 L262,268 Z")),
    # drawn longer than a real Mallard's short tail, so it's easy to find
    ("tail", poly("M100,215 L252,236 L254,254 L212,264 L100,250 Z")),
    ("nape", poly("M560,90 L640,90 Q624,130 624,170 Q624,214 616,250 L560,250 Z")),
    ("crown", poly("M600,80 L760,80 L738,132 Q712,120 684,120 Q652,124 628,146 L606,140 Z")),
    ("cheek", poly("M612,140 Q650,112 700,114 Q736,124 748,160 L744,200 Q730,226 712,240 Q680,248 618,248 Q606,200 612,140 Z")),
    ("neck", poly("M604,188 Q650,200 700,196 Q728,194 744,200 L770,252 L596,256 Z")),
    ("chin", poly("M716,190 L742,190 L752,244 L712,246 Z")),
    ("forehead", FOREHEAD),
    # the head areas field guides name, all glossy green on a drake (td-93f86b): cut from the cheek, crown and chin
    ("malar", poly("M741,194 Q720,196 704,208 L697,200 Q716,184 746,170 L746,194 Z")),
    ("supercilium", poly("M740,149 Q722,142 703,134 Q680,132 660,134 Q648,134 637,135 L636,124 Q666,108 693,108 Q720,111 745,140 Z").difference(FOREHEAD)),
    ("eye-line", poly("M690,130 Q664,130 638,135 L640,149 Q665,143 690,142 Z")),
    ("lores", poly("M702,130 Q722,138 741,147 L746,147 L746,171 L739,168 Q720,151 702,142 Z").difference(FOREHEAD)),
    ("eye-ring", Point(*EYE).buffer(9.5).difference(Point(*EYE).buffer(7.3))),
    # the bare skin right around the eye, inside the feathered eye-ring (td-2a2f94)
    ("orbital-ring", Point(*EYE).buffer(7.3).difference(Point(*EYE).buffer(5.5))),
]
final = {}
claimed = Point(*EYE).buffer(5.5)
for pid, rough in reversed(body):
    final[pid] = rough.intersection(SIL).difference(claimed); claimed = claimed.union(rough.intersection(SIL))

# wing feathers lying on the side, painted over the body regions
scap = poly("M600,232 Q560,232 520,236 Q470,240 430,244 Q440,262 470,268 Q530,270 590,256 Z")
tert = unary_union([poly(f"M{470-14*k},{248+3*k} Q{400-10*k},{250+4*k} {318-8*k},{262+3*k} Q{330-8*k},{274+3*k} {360-8*k},{276+3*k} Q{430-10*k},{278+3*k} {478-14*k},{266+3*k} Z") for k in range(3)])
prim = poly("M440,252 Q360,250 300,252 Q268,254 246,260 Q270,266 300,266 Q370,268 440,268 Z")
spec = poly("M540,266 Q500,272 452,276 L446,288 Q500,286 546,278 Z")
gcov = poly("M552,258 Q505,266 456,270 L452,277 Q502,273 548,266 Z")
trailing = poly("M546,278 Q500,286 446,288 L444,292 Q500,291 548,282 Z")
final["scapulars"] = scap.intersection(SIL)
final["tertials"] = tert.intersection(SIL).difference(final["scapulars"])
final["primaries"] = prim.intersection(SIL.union(prim)).difference(final["tertials"]).difference(final["scapulars"])
final["speculum"] = spec
final["greater-coverts"] = gcov
final["drake-curl"] = CURL.union(poly("M238,246 L270,244 L268,258 L240,262 Z"))
final["bill"] = BILL.difference(NAIL).difference(CERE)
final["cere"] = CERE
# the white bar behind the speculum (the secondaries' tips); the one in front is the greater coverts' white tips (td-2a2f94)
final["wing-bars"] = trailing.difference(final["tertials"]).difference(final["primaries"]).difference(spec)
final["nail"] = NAIL
for k in ("sides", "flanks", "back", "breast"):
    final[k] = final[k].difference(final["scapulars"]).difference(final["tertials"]).difference(final["primaries"]).difference(spec).difference(gcov).difference(trailing)
for k in ("rump", "tail", "undertail-coverts"):
    final[k] = final[k].difference(final["primaries"]).difference(final["drake-curl"])
HEAD_PARTS = ("nape", "crown", "forehead", "cheek", "neck", "chin", "malar", "eye-line", "supercilium", "lores", "eye-ring", "orbital-ring")
# no strip thinner than 1.6 units is left where the head areas meet, so a selected part's outline is a clean shape
# (CODEX1: the cheek kept a tail between the lores and the bill)
def thin_strips(g):
    return g.difference(g.buffer(-0.8).buffer(0.8))
for k in HEAD_PARTS:
    left = sum(q.area for q in getattr(thin_strips(final[k]), "geoms", [thin_strips(final[k])]))
    if left > 3: raise SystemExit(f"duck: {k} keeps {left:.1f} units² of strips thinner than 1.6")
# the head parts and the new areas are one piece each (a leftover sliver would select a far part)
for k in HEAD_PARTS:
    g = final[k].buffer(-0.1).buffer(0.1)   # drop zero-width spikes left along a neighbour's edge
    g = unary_union([q for q in getattr(g, "geoms", [g]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"duck: {k} is in {len(g.geoms)} pieces")
    final[k] = g
# the curled central feathers are rectrices too: the tail takes them in, drawn over as their own part, so "rectrices"
# opens the whole tail (CODEX1, td-d32fd3)
final["tail"] = final["tail"].union(final["drake-curl"])

meta = [("sides", "light", "mf"), ("breast", "chestnut", "mf"), ("flanks", "light", "mf"),
        ("undertail-coverts", "darker", "mf"), ("back", "mid", "mf"), ("rump", "darker", "mf"),
        ("tail", "pale", "mf"), ("nape", "mallardgreen", "mf"), ("crown", "mallardgreen", "mf"),
        ("forehead", "mallardgreen", "mf"), ("cheek", "mallardgreen", "mf"), ("neck", "mallardgreen", "mf"), ("chin", "mallardgreen", "mf"),
        ("malar", "mallardgreen", "mf"), ("eye-line", "mallardgreen", "mf"), ("supercilium", "mallardgreen", "mf"),
        ("lores", "mallardgreen", "mf"), ("eye-ring", "mallardgreen", "mf"), ("orbital-ring", "mallardgreen", "mf"),
        ("scapulars", "mid", "mf"), ("tertials", "wing", "mf"), ("primaries", "darker", "mf"),
        ("speculum", "accent2", "mf"), ("greater-coverts", "pale", "mf"), ("wing-bars", "pale", "mf"),
        ("drake-curl", "darker", "mf"), ("bill", "billyellow", "mf"), ("cere", "billyellow", "mf"), ("nail", "darker", "mf")]
order = ["sides", "breast", "flanks", "undertail-coverts", "back", "rump", "tail", "nape", "crown", "forehead", "cheek", "neck", "chin",
         "malar", "eye-line", "supercilium", "lores", "eye-ring", "orbital-ring",
         "scapulars", "tertials", "primaries", "greater-coverts", "speculum", "wing-bars", "drake-curl", "bill", "cere", "nail"]
WATERLINE = box(100, WATER-1, 860, WATER+1.5)
# the drake's thin white neck ring, on the neck/breast boundary (not tappable: taps reach the neck)
COLLAR = stroke("M598,253.5 L774,249.5", 4.5).intersection(SIL)
build("duck", final, meta, order, [0, 0, 730, 300], dx=120, dy=70,
      base_over=[(Point(*EYE).buffer(5.5), "eye"), (Point(EYE[0]+1.5, EYE[1]-1.5).buffer(1.4), "pale"), (WATERLINE, "water"),
                 (COLLAR, "pale")],
      outline=SIL.union(BILL).union(final["primaries"]).union(CURL))

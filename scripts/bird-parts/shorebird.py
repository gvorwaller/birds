from geom import *
from common import build
from shapely.geometry import Point
from shapely import affinity
import math

SIL = poly("M336,181 C334,165 342,128 364,113 C390,108 402,116 410,124 C420,132 430,140 440,146 "
           "C452,154 466,152 480,138 C500,118 540,106 600,106 C660,106 700,114 760,118 L860,108 L888,111 "
           "Q884,120 870,124 C830,150 790,190 740,220 C700,248 660,265 630,272 C600,280 560,276 520,262 "
           "C480,248 440,232 410,222 C385,212 365,204 352,196 C346,193 342,192 340,191 Z")
EYE = (369, 156)
WING = Frame(s=(528, 180), c=(700, 182), t=(894, 90), width=24, taper=0.8, tip=1.5)
_c = WING.center(0.0); _n = WING.normal(0.0); _ang = math.degrees(math.atan2(_n[1], _n[0]))
WOUT = WING.outline().union(affinity.rotate(affinity.scale(Point(*_c).buffer(1), 24, 12), _ang, origin=_c)).buffer(0)
BODY = SIL.union(WOUT)
BILL = poly("M337,180 C312,200 282,228 254,253 C290,232 320,210 345,192 Z")
LEGS = unary_union([stroke("M596,272 L604,365 L590,468", 5.5), stroke("M590,468 L552,476", 3.5), stroke("M590,468 L560,486", 3.5),
                    stroke("M590,468 L606,474", 3), stroke("M650,266 L662,362 L676,466", 5.5), stroke("M676,466 L640,472", 3.5),
                    stroke("M676,466 L652,484", 3.5), stroke("M676,466 L692,471", 3)])
GROUND = stroke("M500,486 L760,486", 4)

body = [
    ("belly", SIL),
    ("breast", poly("M320,175 L505,170 Q530,215 508,264 L320,264 Z")),
    ("flanks", poly("M540,205 L770,150 L775,232 Q690,276 600,280 Q560,250 540,205 Z")),
    ("undertail-coverts", poly("M705,205 L880,112 L890,140 Q800,205 725,255 Z")),
    ("back", poly("M440,85 L790,85 L790,150 Q650,170 520,182 Q470,170 445,155 Z")),
    ("tail", poly("M772,95 L905,95 L905,135 L790,165 Z")),
    ("nape", poly("M402,100 L482,96 L500,150 L470,172 L428,164 Z")),
    ("crown", poly("M325,92 L425,92 L418,128 Q395,140 372,141 Q352,143 336,152 Z")),
    ("forehead", poly("M330,152 Q340,140 352,137 L351,166 L334,184 Z")),
    ("ear-coverts", poly("M360,162 Q388,158 414,166 L416,192 Q392,204 368,198 Z")),
    ("throat", poly("M344,190 L384,198 L400,226 L362,214 Z")),
    ("chin", poly("M338,186 L354,188 L354,200 L340,196 Z")),
    # td-93f86b: the eye-line behind the eye, and the malar from the base of the lower mandible back along the throat
    ("eye-line", poly("M377,149 L414,152 L418,168 L377,164 Z")),
    ("malar", poly("M353,188 L386,196 L404,208 L401,214 L383,204 L353,197 Z")),
    ("supercilium", poly("M337,170 Q350,149 372,144 Q393,142 406,149 L404,156 Q389,151 372,151 Q357,155 345,176 Z")),
    ("lores", poly("M341,178 L361,156 L367,166 L349,187 Z")),
    ("eye-ring", Point(*EYE).buffer(12).difference(Point(*EYE).buffer(8.5))),
]
final = {}
claimed = WOUT.union(Point(*EYE).buffer(8.5))
for pid, rough in reversed(body):
    final[pid] = rough.intersection(SIL).difference(claimed); claimed = claimed.union(rough.intersection(SIL))

# the new eye-line and malar, and the parts they are cut from, are one piece each (td-93f86b); the supercilium was
# drawn in two pieces, either side of the eye
for k in ("crown", "ear-coverts", "throat", "chin", "lores", "eye-ring", "eye-line", "malar"):
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"shorebird: {k} is in {len(g.geoms)} pieces")
    final[k] = g

final["wing-coverts"] = WOUT
final["scapulars"] = unary_union([fband(WING, -0.1+0.11*k, 0.22+0.11*k, -1.9+0.1*k, -0.05, scallops=1, amp=0.03) for k in range(4)]).intersection(BODY)
final["tertials"] = unary_union([fband(WING, 0.42+0.06*k, 0.66+0.05*k, -1.4, 0.55-0.2*k, scallops=1, amp=0.04, skew=-0.05) for k in range(3)]).intersection(WOUT)
prim = WING.band(0.6, 1.0, -1, 1).intersection(WOUT).difference(final["tertials"])
final["primaries"] = prim
final["primary-projection"] = WING.band(0.80, 1.0, -1, 1).intersection(WOUT).difference(final["tertials"])
final["wingtip-vs-tail"] = WING.band(0.955, 1.0, -1, 1).intersection(WOUT)
cov = WOUT.difference(final["scapulars"]).difference(final["tertials"]).difference(prim)
final["lesser-coverts"] = fband(WING, -0.6, 0.12, -1, 1.2, scallops=3, amp=0.012, skew=-0.06).intersection(cov)
final["median-coverts"] = fband(WING, 0.12, 0.26, -1, 1.2, scallops=4, amp=0.012, skew=-0.06).intersection(cov).difference(final["lesser-coverts"])
final["greater-coverts"] = cov.difference(final["lesser-coverts"]).difference(final["median-coverts"])
final["bill"] = BILL
final["legs"] = LEGS

meta = [("belly", "pale", "mf"), ("breast", "light", "mf"), ("flanks", "pale", "mf"),
        ("undertail-coverts", "pale", "mf"), ("back", "mid", "mf"), ("tail", "mid", "mf"),
        ("nape", "light", "mf"), ("crown", "mid", "mf"), ("forehead", "mid", "mf"),
        ("ear-coverts", "light", "mf"), ("throat", "pale", "mf"), ("chin", "pale", "mf"),
        ("eye-line", "light", "mf"), ("malar", "light", "mf"),
        ("supercilium", "pale", "mf"), ("lores", "dark", "mf"), ("eye-ring", "pale", "mf"),
        ("wing-coverts", "wing", "m"), ("scapulars", "mid", "mf"), ("tertials", "dark", "mf"),
        ("primaries", "darker", "f"), ("primary-projection", "darker", "m"),
        ("wingtip-vs-tail", "darker", "m"),
        ("lesser-coverts", "wing", "f"), ("median-coverts", "wing", "f"),
        ("greater-coverts", "dark", "f"), ("bill", "darker", "mf"), ("legs", "legyellow", "mf")]
order = ["legs", "belly", "breast", "flanks", "undertail-coverts", "back", "tail", "nape", "crown", "forehead", "ear-coverts",
         "throat", "chin", "malar", "eye-line", "supercilium", "lores", "eye-ring", "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts",
         "scapulars", "tertials", "primaries", "primary-projection", "wingtip-vs-tail", "bill"]
FX = 580  # mirror so the bird faces right
build("shorebird", final, meta, order, [0, 0, 700, 420], dx=FX*2-910, dy=75,
      base_under=[(GROUND, "perch")], base_over=[(Point(*EYE).buffer(8.5), "eye"), (Point(EYE[0]-2.5, EYE[1]-2.5).buffer(2), "pale")],
      outline=BODY.union(BILL), flip_x=FX)

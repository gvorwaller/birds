from geom import *
from common import build
from shapely.geometry import Point, box
DX, DY = 110, 140

SIL = poly("M603,190 C600,178 596,170 590,164 C580,152 565,147 548,148 C532,149 518,154 508,162 "
           "C500,170 494,180 488,192 C470,205 445,222 425,236 C400,254 370,280 345,312 "
           "C330,332 318,348 302,360 L124,479 Q122,486 128,489 L290,402 "
           "C315,408 345,414 375,416 C395,417 415,416 435,413 C470,410 505,402 535,386 "
           "C565,368 590,345 603,315 C612,295 614,268 611,245 C609,228 606,218 600,212 L603,210 Z")
EYE = (562, 183)
WING = Frame(s=(492, 262), c=(405, 318), t=(298, 372), width=36, taper=0.9, tip=2)
from shapely import affinity
import math as _m
_c = WING.center(0.0); _n = WING.normal(0.0); _ang = _m.degrees(_m.atan2(_n[1], _n[0]))
_cap = affinity.rotate(affinity.scale(Point(*_c).buffer(1), 36, 17), _ang, origin=_c)
WOUT = WING.outline().union(_cap).intersection(SIL.buffer(4)).buffer(0)
BODY = SIL.union(WOUT)

UPPER = poly("M603,189.5 Q620,192 637,201 L597,202 Z")
LOWER = poly("M597,202 L636,202.5 Q620,208 603,211 Z")
LEGS = unary_union([poly("M437,408 L448,407 L459,436 L452,441 Z"),
                    stroke("M455,438 Q478,440 500,449", 4.5), stroke("M455,438 Q472,452 488,466", 4),
                    stroke("M454,439 Q440,446 432,457", 4)])
PERCH = stroke("M360,462 Q470,452 600,440", 10)

# painter order for the body partition (bottom -> top); rough shapes are clipped to SIL
body_rough = [
    ("belly",      SIL),
    # a band across the belly just below the breast; it takes only what the breast and flanks leave (td-2a2f94)
    ("belly-band", poly("M495,280 L630,280 L630,336 Q600,352 560,354 Q515,350 490,326 Z")),
    ("breast",     poly("M500,200 L630,200 L630,300 Q600,318 560,322 Q530,320 515,300 Q498,250 500,200 Z")),
    ("flanks",     poly("M300,360 Q420,300 520,282 Q545,318 530,348 Q505,378 450,398 Q380,402 300,396 Z")),
    ("undertail-coverts", poly("M282,392 L330,388 Q375,394 418,404 Q428,414 424,428 L282,428 Z")),
    ("back",       poly("M462,168 L512,205 L522,236 Q480,266 410,304 Q350,344 300,376 L270,340 L420,190 Z")),
    ("rump",       poly("M298,356 L322,334 L344,326 L350,344 Q330,356 312,368 L298,370 Z")),
    ("tail",       poly("M100,470 L303,352 L300,399 L110,505 Z")),
    ("nape",       poly("M466,150 L522,150 Q518,176 528,200 Q516,216 502,224 L466,214 Z")),
    ("crown",      poly("M500,138 L600,138 L598,180 Q575,175 552,175 Q530,177 516,188 L505,180 Z")),
    ("forehead",   poly("M583,140 L612,140 L607,188 L594,180 Q587,170 584,163 Z")),
    ("ear-coverts",  poly("M516,186 Q552,184 576,190 L579,205 Q567,219 550,228 Q530,226 518,212 Z")),
    ("throat",     poly("M588,216 Q600,214 614,214 L616,250 Q598,252 580,244 Q584,230 588,216 Z")),
    ("submoustachial", poly("M603,190 L603,213 Q582,228 556,240 L540,238 Q560,224 575,206 L578,190 Z")),
    ("chin",       poly("M592,206 L607,206 L607,219 Q598,221 590,218 Z")),
    ("malar",      poly("M598,210 Q588,222 572,232 Q560,240 552,250 Q566,252 578,244 Q594,232 603,216 Z")),
    ("supercilium", poly("M600,183 Q585,173 556,171 Q533,172 518,180 L520,186 Q540,178 556,177 Q578,178 597,190 Z")),
    ("eye-line",   poly("M562,177 L520,182 L522,195 L562,192 Z")),
    ("lores",      poly("M566,174 Q590,178 608,184 L604,200 Q585,195 566,192 Z")),
]
eye_ring = Point(*EYE).buffer(11).difference(Point(*EYE).buffer(8.5))
body_rough.append(("eye-ring", eye_ring))
# Marks other birds show, outlined where they sit, so species-page links stay on this drawing (td-2a2f94):
# the bare orbital ring just inside the feathered eye-ring, the tufts of feathers over the nostrils at the base
# of the bill, and the feathered tibia ("thigh") at the top of the leg.
body_rough += [
    ("orbital-ring", Point(*EYE).buffer(8.5).difference(Point(*EYE).buffer(7))),
    ("nasal-tufts", poly("M592,181 L602,184 L606,188 L604,195 L596,192 L590,186 Z")),
    ("tibia", affinity.scale(Point(443, 403).buffer(1), 12, 8)),
]

final = {}
claimed = WOUT.union(Point(*EYE).buffer(7))  # wing sits on top of the body; the eye is not a part
for pid, rough in reversed(body_rough):
    g = rough.intersection(SIL).difference(claimed)
    final[pid] = g
    claimed = claimed.union(rough.intersection(SIL))

# wing: main = whole wing; overlays on top
final["wing"] = WOUT
final["tertials"] = unary_union([fband(WING, 0.44+0.07*k, 0.66+0.07*k, -1, -0.05-0.12*k, scallops=1, amp=0.05, skew=-0.06) for k in range(3)]).intersection(WOUT)
# Folded wing, lower edge front to back: alula, primary coverts, the exposed outer edges of the
# primaries (tucked beneath the secondaries), then the primary tips past the tertials.
PLOW = 0.55  # v below which the lower edge belongs to the primary tract
final["primaries"] = unary_union([fband(WING, 0.62+0.045*k, 0.80+0.05*k, -0.2+0.15*k, 1, scallops=1, amp=0.04, skew=-0.04) for k in range(4)]
                                 + [WING.band(0.82, 1.0, -1, 1), WING.band(0.30, 0.82, PLOW, 1.05)]).intersection(WOUT).difference(final["tertials"])
bars = unary_union([fband(WING, 0.225, 0.255, -0.6, 0.95, skew=-0.07),
                    fband(WING, 0.395, 0.43, -0.6, 0.97, skew=-0.07)])
final["wing-bars"] = bars.intersection(WOUT).difference(WING.band(0.0, 0.6, PLOW, 1.3))  # secondary coverts only
# feathers layer (partition of the wing below tertials/primaries; coverts include their pale tips)
fl = WOUT.difference(final["tertials"]).difference(final["primaries"])
final["scapulars"] = fband(WING, -0.6, 0.44, -1.3, -0.6, scallops=4, amp=0.015, skew=0).intersection(fl)
rest = fl.difference(final["scapulars"])
final["lesser-coverts"] = fband(WING, -0.6, 0.13, -0.62, 0.62, scallops=3, amp=0.012, skew=-0.07).intersection(rest)
final["alula"] = fband(WING, -0.6, 0.10, 0.62, 1.3, scallops=1, amp=0.03, skew=0).intersection(rest).difference(final["lesser-coverts"])
# primary coverts: behind the alula on the lower edge, covering the bases of the primaries
final["primary-coverts"] = fband(WING, 0.10, 0.30, PLOW, 1.3, scallops=2, amp=0.015, skew=0).intersection(rest).difference(final["alula"])
sec = rest.difference(final["primary-coverts"]).difference(final["alula"])
final["median-coverts"] = fband(WING, 0.13, 0.255, -0.62, 0.95, scallops=4, amp=0.012, skew=-0.07).intersection(sec).difference(final["lesser-coverts"])
final["greater-coverts"] = fband(WING, 0.255, 0.43, -0.62, 0.97, scallops=5, amp=0.012, skew=-0.07).intersection(sec).difference(final["median-coverts"])
used = unary_union([final[k] for k in ("lesser-coverts", "alula", "primary-coverts", "median-coverts", "greater-coverts")])
final["secondaries"] = rest.difference(used)
# the covert rows as one area in the main layer, as on the other birds, so "wing coverts" on a songbird's page opens
# the songbird (td-d32fd3); closed up so the rows show no seams
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(WOUT)
# the primary tips past the tertials (primary projection, a main-layer area over the primaries as on the shorebird)
# and the speculum's place: the exposed secondaries behind the greater coverts (td-2a2f94)
final["primary-projection"] = WING.band(0.80, 1.0, -1, 1).intersection(WOUT).difference(final["tertials"])
final["speculum"] = largest(final["secondaries"]).intersection(WING.band(0.47, 0.62, -1, PLOW))
# tail feathers layer
tail = final["tail"]
final["uppertail-coverts"] = poly("M278,352 L322,326 L334,348 L318,374 L282,386 Z").intersection(tail.union(final["rump"])).difference(WOUT)
final["rectrices"] = tail.difference(final["uppertail-coverts"])
# the cere's place (a pigeon's, parrot's or raptor's bare saddle at the base of the upper bill) and the gonys,
# the ridge under the lower mandible towards the tip (td-2a2f94)
CERE = UPPER.intersection(box(590, 180, 608, 199))
GONYS = LOWER.intersection(poly("M610,206.2 L632,203.2 L636,206 L612,214 Z"))
final["cere"] = CERE
final["gonys"] = GONYS
final["upper-mandible"] = UPPER.difference(CERE)
final["lower-mandible"] = LOWER.difference(GONYS)
final["legs"] = LEGS

# each new area is one piece; a leftover sliver would be a second, far-off tap target
for k in ("belly-band", "orbital-ring", "nasal-tufts", "tibia", "cere", "gonys", "primary-projection", "speculum"):
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"songbird: {k} is in {len(g.geoms)} pieces")
    final[k] = g

META = [  # id, name, tone, layers
    ("belly", "light", "mf"), ("breast", "light", "mf"), ("flanks", "light", "mf"),
    ("undertail-coverts", "light", "mf"), ("back", "mid", "mf"),
    ("rump", "mid", "mf"), ("tail", "mid", "m"), ("nape", "mid", "mf"),
    ("crown", "mid", "mf"), ("forehead", "mid", "mf"), ("ear-coverts", "mid", "mf"),
    ("throat", "pale", "mf"), ("chin", "pale", "mf"), ("malar", "dark", "mf"), ("submoustachial", "pale", "mf"),
    ("supercilium", "pale", "mf"), ("eye-line", "dark", "mf"),
    ("lores", "mid", "mf"), ("eye-ring", "pale", "mf"),
    ("wing", "wing", "m"), ("wing-coverts", "wing", "m"), ("scapulars", "mid", "f"), ("lesser-coverts", "wing", "f"),
    ("alula", "dark", "f"), ("median-coverts", "dark", "f"),
    ("greater-coverts", "dark", "f"), ("primary-coverts", "darker", "f"), ("secondaries", "wing", "f"),
    ("tertials", "dark", "mf"), ("primaries", "darker", "mf"), ("wing-bars", "pale", "mf"),
    ("uppertail-coverts", "mid", "f"), ("rectrices", "mid", "f"),
    ("upper-mandible", "bill", "mf"), ("lower-mandible", "bill", "mf"),
    ("legs", "leg", "mf"),
    ("belly-band", "light", "mf"), ("orbital-ring", "pale", "mf"), ("nasal-tufts", "mid", "mf"), ("tibia", "light", "mf"),
    ("cere", "bill", "mf"), ("gonys", "bill", "mf"), ("primary-projection", "darker", "m"), ("speculum", "wing", "f"),
]
order = ["legs", "belly", "belly-band", "breast", "flanks", "undertail-coverts", "back", "rump", "tail", "rectrices", "uppertail-coverts",
         "nape", "crown", "forehead", "ear-coverts", "throat", "chin", "submoustachial", "malar", "supercilium", "eye-line", "lores", "eye-ring", "orbital-ring", "nasal-tufts", "tibia",
         "wing", "wing-coverts", "scapulars", "lesser-coverts", "alula", "primary-coverts", "median-coverts", "greater-coverts", "secondaries", "speculum",
         "tertials", "primaries", "primary-projection", "wing-bars", "upper-mandible", "lower-mandible", "cere", "gonys"]
build("songbird", final, META, order, [0, 0, 540, 360], dx=DX, dy=DY,
      base_under=[(PERCH, "perch")],
      base_over=[(Point(*EYE).buffer(7), "eye"), (Point(EYE[0]+2.2, EYE[1]-2.2).buffer(1.8), "pale")],
      outline=BODY.union(UPPER).union(LOWER))

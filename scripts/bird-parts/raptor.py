"""Adult Red-tailed Hawk, perched, side view (td-dd4f9c).

Traced from a perched, right-facing reference photo (proportions only; listed in
src/lib/bird-parts/raptor.ts). A hawk perches upright: the folded wing covers most of the
side, its tip falls short of the tail tip, and the bare tarsus and talons grip the perch.
"""
from geom import *
from common import build
from shapely.geometry import Point
from shapely import affinity

# body, head and tail (the folded wing is added below)
SIL = poly("M556,208 C548,195 532,186 512,185 C488,184 466,191 454,204 C444,216 440,234 436,252 "
           "C428,272 410,290 390,304 C350,332 300,374 268,426 C240,474 218,540 202,596 "
           "C190,640 176,690 166,730 L118,880 Q160,896 210,874 L236,792 C244,764 254,742 266,724 "
           "C292,704 322,686 350,670 L372,656 L404,654 L420,632 C440,600 462,566 480,530 "
           "C498,496 510,462 516,426 C522,390 524,352 524,318 C525,294 530,276 538,262 "
           "C544,252 552,244 558,238 Z")
EYE = (512, 222)
# hooked upper mandible, and the cere over its base
BILL = poly("M548,220 C560,216 572,222 577,234 C582,247 581,260 574,271 C571,262 566,254 560,251 L549,247 Z")
CERE = poly("M545,214 C552,211 560,213 564,220 L562,237 L553,242 L545,238 Z")

# The folded wing fills the side from the back edge to its lower edge, which runs from the wrist at
# the shoulder down to the tip. The frame (u 0 at the wrist -> 1 at the tip; v -1 the back side,
# +1 the belly side) only lays out the feather rows inside it.
LOWER = "C448,292 444,334 432,376 C414,436 376,494 326,546 C276,598 226,652 192,702 L142,792"
WOUT = SIL.buffer(2).intersection(poly(f"M432,246 {LOWER} L40,800 L40,246 Z"))
WING = Frame(s=(410, 300), c=(318, 476), t=(142, 792), width=78, taper=0.6, tip=3)
BODY = SIL.union(WOUT)

TARSUS = poly("M382,628 L400,628 L404,692 L386,694 Z")
FEET = unary_union([stroke("M392,690 Q412,692 430,700", 9), stroke("M392,692 Q406,700 418,710", 8),
                    stroke("M388,692 Q370,696 356,704", 8)])
TALONS = unary_union([poly("M428,694 Q442,700 440,716 Q436,706 426,704 Z"),
                      poly("M414,704 Q428,712 422,728 Q420,716 410,712 Z"),
                      poly("M360,698 Q344,702 340,720 Q348,712 358,710 Z")])
PERCH = stroke("M290,716 Q470,704 660,712", 22)

body_rough = [
    ("belly", SIL),
    ("undertail-coverts", poly("M230,640 L360,640 L380,664 Q330,690 290,706 L240,740 L222,700 Z")),
    ("leg-feathers", poly("M360,560 Q420,560 440,590 Q432,630 412,656 L372,660 Q352,620 360,560 Z")),
    ("belly-band", poly("M340,452 Q400,440 440,446 Q480,436 530,440 L530,500 Q500,520 470,540 Q440,560 400,570 Q370,574 340,570 Z")),
    ("breast", poly("M400,250 Q470,250 540,250 L540,450 Q480,440 440,450 Q400,444 400,450 Z")),
    ("nape", poly("M410,180 L480,180 Q470,228 486,262 Q462,286 420,300 L400,260 Z")),
    ("ear-coverts", poly("M462,194 Q512,186 562,204 L548,216 L536,236 L540,244 Q532,262 516,276 Q492,286 470,272 Q462,240 470,214 Z")),
    ("throat", poly("M530,228 L566,228 L560,300 Q536,306 506,292 Q526,272 532,240 Z")),
    ("crown", poly("M450,170 L570,170 L566,216 Q536,206 512,210 Q488,212 466,222 Z")),
    ("malar", poly("M540,240 Q528,256 516,268 Q508,278 504,290 Q516,286 526,274 Q538,260 546,246 Z")),
    # td-93f86b: the eye-line behind the eye, the supercilium over the eye, the lores between the eye and the cere,
    # and the eye-ring
    ("eye-line", poly("M503,216 L476,218 L478,231 L503,229 Z")),
    ("supercilium", poly("M547,213 Q530,202 510,202 Q492,203 481,210 L483,217 Q496,211 510,211 Q528,211 547,215 Z")),
    ("lores", poly("M520,214 Q536,206 556,207 L556,238 Q538,238 520,229 Z")),
    ("eye-ring", Point(*EYE).buffer(10).difference(Point(*EYE).buffer(7))),
]
final = {}
claimed = WOUT.union(Point(*EYE).buffer(7)).union(BILL).union(CERE)
for pid, rough in reversed(body_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
for k in ("nape", "ear-coverts", "throat", "crown", "malar", "eye-line", "supercilium", "lores", "eye-ring"):
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"raptor: {k} is in {len(g.geoms)} pieces: " + str([(round(q.area), [round(v) for v in q.bounds]) for q in g.geoms]))
    final[k] = g
final["iris"] = Point(*EYE).buffer(7).difference(Point(*EYE).buffer(3.4))
final["bill"] = BILL.difference(CERE)
final["cere"] = CERE
final["tarsus"] = TARSUS
final["talons"] = FEET.union(TALONS).difference(TARSUS)

# wing: main view = scapulars, coverts, tertials and primaries; feathers view splits the coverts
final["scapulars"] = fband(WING, -0.3, 0.40, -1.8, -0.5, scallops=4, amp=0.02).intersection(WOUT)
final["tertials"] = unary_union([fband(WING, 0.38 + 0.05*k, 0.62 + 0.05*k, -1.8, -0.2 - 0.12*k, scallops=1, amp=0.04, skew=-0.05)
                                 for k in range(3)]).intersection(WOUT).difference(final["scapulars"])
final["primaries"] = fband(WING, 0.60, 1.0, -1.6, 1.6, scallops=1, amp=0.03, skew=-0.04).intersection(WOUT).difference(final["tertials"]).difference(final["scapulars"])
final["wingtip-vs-tail"] = WING.band(0.92, 1.0, -1.6, 1.6).buffer(3).intersection(WOUT)
cov = WOUT.difference(final["scapulars"]).difference(final["tertials"]).difference(final["primaries"])
final["lesser-coverts"] = fband(WING, -0.4, 0.14, -1.8, 1.6, scallops=3, amp=0.012, skew=-0.06).intersection(cov)
final["median-coverts"] = fband(WING, 0.14, 0.26, -1.8, 1.6, scallops=4, amp=0.012, skew=-0.06).intersection(cov).difference(final["lesser-coverts"])
final["greater-coverts"] = fband(WING, 0.26, 0.44, -1.8, 1.6, scallops=5, amp=0.012, skew=-0.06).intersection(cov).difference(final["median-coverts"]).difference(final["lesser-coverts"])
final["secondaries"] = cov.difference(final["lesser-coverts"]).difference(final["median-coverts"]).difference(final["greater-coverts"])
# the crumbs left where a covert row meets the tertials' edge belong to the tertials
for k in ("lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
    main = largest(final[k])
    final["tertials"] = final["tertials"].union(final[k].difference(main))
    final[k] = main
# Main parts shows the covert rows as one area; the exposed secondaries below them stay their own part.
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")])

# tail: below the wingtips, with the dark band near its tip
TAIL = final["belly"].intersection(poly("M100,700 L270,700 L250,900 L100,900 Z"))
final["belly"] = final["belly"].difference(TAIL)
final["subterminal-band"] = TAIL.intersection(poly("M100,846 L260,830 L260,846 L100,866 Z"))
# the tail is the whole tail, the band drawn over it as its own part, so 'rectrices' opens all of it (CODEX1, td-d32fd3)
final["tail"] = TAIL

META = [
    ("belly", "pale", "mf"), ("undertail-coverts", "pale", "mf"), ("leg-feathers", "light", "mf"),
    ("belly-band", "mid", "mf"), ("breast", "pale", "mf"), ("throat", "light", "mf"), ("nape", "dark", "mf"),
    ("crown", "dark", "mf"), ("ear-coverts", "dark", "mf"), ("malar", "dark", "mf"),
    ("eye-line", "dark", "mf"), ("supercilium", "dark", "mf"), ("lores", "gullgray", "mf"), ("eye-ring", "dark", "mf"), ("iris", "chestnut", "mf"),
    ("tail", "chestnut", "mf"), ("subterminal-band", "darker", "mf"),
    ("wing-coverts", "dark", "m"), ("lesser-coverts", "dark", "f"), ("median-coverts", "dark", "f"),
    ("greater-coverts", "dark", "f"), ("secondaries", "wing", "mf"), ("scapulars", "wing", "mf"),
    ("tertials", "dark", "mf"), ("primaries", "darker", "mf"), ("wingtip-vs-tail", "darker", "m"),
    ("bill", "bill", "mf"), ("cere", "billyellow", "mf"), ("tarsus", "legyellow", "mf"), ("talons", "legyellow", "mf"),
]
order = ["tarsus", "talons", "belly", "undertail-coverts", "leg-feathers", "belly-band", "breast", "tail", "subterminal-band",
         "throat", "nape", "ear-coverts", "crown", "malar", "eye-line", "supercilium", "lores", "eye-ring", "iris",
         "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "scapulars", "tertials",
         "primaries", "wingtip-vs-tail", "bill", "cere"]
DX, DY = 100, 170
# dark streaks across the belly band, drawn over it (never tap targets)
STREAKS = unary_union([affinity.rotate(affinity.scale(Point(x, y).buffer(1), 3.2, 9), -18, origin=(x, y))
                       for x, y in [(352, 470), (372, 500), (392, 462), (410, 530), (428, 490), (446, 548), (462, 470),
                                    (480, 512), (498, 462), (516, 492), (380, 548), (430, 456), (468, 536), (360, 520)]])
build("raptor", final, META, order, [0, 0, 580, 740], dx=DX, dy=DY,
      base_under=[(PERCH, "perch")],
      base_over=[(Point(*EYE).buffer(3.4), "eye")],
      marks={"belly-band": [(STREAKS, "darker")], "talons": [(TALONS, "darker")]},
      outline=BODY.union(BILL))

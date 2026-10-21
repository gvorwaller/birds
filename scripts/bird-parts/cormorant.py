"""Adult Double-crested Cormorant in breeding plumage, perched, side view (td-af7c6b).

Traced from a perched, left-facing reference photo (proportions only; listed in
src/lib/bird-parts/cormorant.ts) and mirrored so it faces right. A cormorant perches upright on
short legs: a long neck, a hooked bill with bare orange skin at its base, the folded wing over
the side with scaly coverts, a stiff tail, and big webbed feet.
"""
from geom import *
from common import build
from shapely.geometry import Point
from shapely.ops import unary_union
from shapely import affinity

# head, neck, body and tail with the folded wing (bill and feet are separate)
SIL = poly("M516,228 C520,206 548,180 588,170 C616,163 646,172 664,196 C676,214 676,242 668,262 "
           "C662,274 656,284 656,294 C680,306 716,326 750,348 C800,380 846,426 888,480 "
           "C916,516 936,548 952,578 C990,588 1034,596 1080,606 L1082,616 C1040,622 1000,628 960,628 "
           "C930,630 900,632 870,634 C830,636 790,630 756,616 C716,600 684,580 656,552 "
           "C624,520 598,476 578,428 C560,388 546,348 538,308 C534,288 538,272 546,262 "
           "C552,250 554,238 548,230 Z")
EYE = (536, 213)
# the hooked bill; bare orange skin over the lores and along the base of the lower mandible
BILL = poly("M548,221 C522,229 486,240 452,251 C440,255 432,262 434,272 C439,266 445,264 452,265 "
            "C470,264 488,262 500,260 L548,236 Z")
LORES = poly("M524,220 C532,218 542,218 548,221 L548,236 L528,240 C524,232 522,226 524,220 Z")
GULAR = poly("M500,260 L548,236 L556,236 C566,240 570,250 566,260 C556,268 540,270 524,266 C512,264 504,262 500,260 Z")

# The folded wing fills the side from the back edge down to its lower edge. The frame (u 0 at the
# shoulder -> 1 at the tip; v -1 the back side, +1 the belly side) lays out the feather rows.
LOWER = "C604,370 632,430 680,482 C730,520 800,544 870,562 L952,580"
WOUT = SIL.intersection(poly(f"M598,330 {LOWER} L1100,560 L1100,250 L740,250 L700,318 Q650,312 598,330 Z"))
WING = Frame(s=(640, 340), c=(780, 440), t=(952, 580), width=62, taper=0.6, tip=3)
BODY = SIL.union(WOUT)

TARSUS = unary_union([poly("M702,596 L716,600 L708,672 L694,670 Z"), poly("M770,622 L784,624 L782,684 L768,684 Z")])
# all four toes joined by webs (totipalmate): each foot is one webbed fan
TOES = unary_union([poly("M700,668 L644,684 L652,692 L740,694 L748,686 Z"),
                    poly("M774,680 L744,690 L752,698 L812,700 L818,692 Z")])
PERCH = poly("M560,694 Q720,688 900,702 L900,760 L560,760 Z")

NECKLINE = "Q570,262 610,272 Q640,282 664,298"   # the head's lower edge, from the throat to the nape
body_rough = [
    ("belly", SIL),
    ("undertail-coverts", poly("M850,640 Q870,610 900,602 L962,600 L962,640 Z")),
    ("flanks", poly("M600,400 L960,400 L960,600 Q860,606 760,590 Q690,570 640,540 Z")),
    ("breast", poly("M500,300 L640,320 L660,440 Q640,500 640,540 L500,560 Z")),
    ("neck", poly(f"M500,262 {NECKLINE} L720,320 L720,340 L640,340 Q600,360 560,410 L500,410 Z")),
    ("face", poly(f"M500,262 {NECKLINE} L700,300 L700,180 L500,180 Z")),
    ("nape", poly("M652,196 Q646,244 656,296 L720,300 L720,190 Z")),
    ("crown", poly("M500,140 L700,140 L700,216 Q660,192 610,190 Q566,192 528,214 Z")),
]
final = {}
claimed = WOUT.union(Point(*EYE).buffer(6)).union(BILL).union(LORES).union(GULAR)
for pid, rough in reversed(body_rough):
    final[pid] = rough.intersection(SIL).difference(claimed)
    claimed = claimed.union(rough.intersection(SIL))
final["tail"] = final["belly"].intersection(poly("M952,560 L1100,560 L1100,640 L960,640 L952,620 Z")).difference(final["undertail-coverts"])
final["belly"] = final["belly"].difference(final["tail"])
# the curly breeding crests, one over each eye, black mixed with white
CURLS = ("M566,196 Q560,180 572,170 Q582,166 584,174", "M574,194 Q574,176 588,170 Q598,170 596,178",
         "M606,186 Q604,168 618,162 Q628,160 628,168", "M614,186 Q618,168 632,166 Q642,168 638,176")
# closed into one solid shape (two tuft lobes), so a tap between the curls still picks the crest; the curls are drawn over it
CRESTS = unary_union([stroke(d, 7) for d in CURLS]).buffer(5).buffer(-5)
final["crests"] = CRESTS
final["crown"] = final["crown"].difference(CRESTS)
final["face"] = final["face"].difference(CRESTS)
final["lores"] = LORES
final["gular-skin"] = GULAR.difference(LORES)
final["bill"] = BILL.difference(LORES).difference(GULAR)

# The small head areas field guides name, so a cormorant's species-page links stay on this drawing (td-93f86b; the
# owner's example was "ear coverts" on a Black-faced Cormorant page). Each is cut from the face and crown around it and
# keeps their dark tone; the malar is a narrow strip above and behind the bare throat skin.
def O(g):
    """Plate coordinates (where the head was laid out, facing right) -> tracing coordinates (facing left)."""
    return affinity.translate(affinity.scale(g, -1, 1, origin=(560, 0)), 0, 120)
HEAD_AREAS = [
    # the bare skin right around the eye (td-2a2f94), then the feathered eye-ring just outside it
    ("orbital-ring", Point(*EYE).buffer(8).difference(Point(*EYE).buffer(6))),
    ("eye-ring", Point(*EYE).buffer(9.8).difference(Point(*EYE).buffer(8))),   # wider, and the forehead's edge would cut it in two
    ("supercilium", O(poly("M594,91 Q588,82 570,80 L548,78 L548,86 Q566,88 579,89 Z"))),
    ("eye-line", O(poly("M578,90 L550,88 L550,97 L578,99 Z"))),
    ("ear-coverts", O(poly("M576,99 L548,97 L546,110 Q560,113 572,111 L572,102 Z"))),
    # a narrow strip hugging the throat skin's upper back edge
    ("malar", GULAR.buffer(6).difference(GULAR).intersection(O(poly("M572,106 L538,106 L538,146 L572,146 Z")))),
]
_taken = Point(0, 0).buffer(0)
for pid, rough in HEAD_AREAS:
    g = rough.intersection(unary_union([final[k] for k in ("face", "crown")])).difference(_taken)
    g = unary_union([q for q in getattr(g, "geoms", [g]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"cormorant: {pid} is in {len(g.geoms)} pieces")
    final[pid] = g
    _taken = _taken.union(g)
for k in ("face", "crown"):
    final[k] = final[k].difference(_taken)

final["tarsus"] = TARSUS
final["toes"] = TOES.difference(TARSUS)

# wing: the scaly scapulars and coverts; Main parts shows the coverts as one area
final["scapulars"] = fband(WING, -0.4, 0.42, -1.9, -0.35, scallops=6, amp=0.03).intersection(WOUT)
final["primaries"] = fband(WING, 0.70, 1.0, -1.9, 1.9, scallops=1, amp=0.03, skew=-0.04).intersection(WOUT).difference(final["scapulars"])
final["tertials"] = fband(WING, 0.42, 0.72, -1.9, -0.2, scallops=2, amp=0.04, skew=-0.05).intersection(WOUT).difference(final["primaries"])
cov = WOUT.difference(final["scapulars"]).difference(final["tertials"]).difference(final["primaries"])
final["lesser-coverts"] = fband(WING, -0.4, 0.16, -1.9, 1.9, scallops=3, amp=0.012, skew=-0.06).intersection(cov)
final["median-coverts"] = fband(WING, 0.16, 0.32, -1.9, 1.9, scallops=4, amp=0.012, skew=-0.06).intersection(cov).difference(final["lesser-coverts"])
final["greater-coverts"] = fband(WING, 0.32, 0.52, -1.9, 1.9, scallops=5, amp=0.012, skew=-0.06).intersection(cov).difference(final["median-coverts"]).difference(final["lesser-coverts"])
final["secondaries"] = cov.difference(final["lesser-coverts"]).difference(final["median-coverts"]).difference(final["greater-coverts"])
for k in ("lesser-coverts", "median-coverts", "greater-coverts", "secondaries"):
    main = largest(final[k])
    final["tertials"] = final["tertials"].union(final[k].difference(main))
    final[k] = main
final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")])
# marks this adult lacks but relatives sharing the drawing show (td-2a2f94), cut where they sit: a bar across the median
# coverts' tips (a frigatebird's pale wing bar; drawn over the coverts) and a band across the belly below the breast
final["wing-bars"] = fband(WING, 0.27, 0.32, -1.9, 1.9, scallops=4, amp=0.012, skew=-0.06).intersection(final["median-coverts"])
final["belly-band"] = final["belly"].intersection(poly("M640,500 L770,500 L770,700 L640,700 Z"))
final["belly"] = final["belly"].difference(final["belly-band"])
for k in ("wing-bars", "belly-band", "belly"):
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"cormorant: {k} is in {len(g.geoms)} pieces")
    final[k] = g

META = [
    ("belly", "darker", "mf"), ("belly-band", "darker", "mf"), ("flanks", "darker", "mf"), ("breast", "darker", "mf"), ("undertail-coverts", "darker", "mf"), ("tail", "darker", "mf"),
    ("neck", "darker", "mf"), ("nape", "darker", "mf"), ("face", "darker", "mf"),
    ("crown", "darker", "mf"), ("supercilium", "darker", "mf"), ("eye-line", "darker", "mf"), ("ear-coverts", "darker", "mf"),
    ("malar", "darker", "mf"), ("eye-ring", "darker", "mf"), ("orbital-ring", "darker", "mf"), ("crests", "linegray", "mf"),
    ("lores", "orange", "mf"), ("gular-skin", "orange", "mf"), ("bill", "bill", "mf"),
    ("scapulars", "dark", "mf"), ("wing-coverts", "dark", "m"), ("lesser-coverts", "dark", "f"), ("median-coverts", "dark", "f"),
    ("greater-coverts", "dark", "f"), ("wing-bars", "dark", "mf"), ("secondaries", "darker", "mf"), ("tertials", "dark", "mf"), ("primaries", "darker", "mf"),
    ("tarsus", "eye", "mf"), ("toes", "eye", "mf"),
]
order = ["tarsus", "toes", "tail", "undertail-coverts", "belly", "belly-band", "flanks", "breast", "neck", "nape", "face", "crown",
         "supercilium", "eye-line", "ear-coverts", "malar", "eye-ring", "orbital-ring", "crests",
         "lores", "gular-skin", "bill",
         "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "wing-bars", "secondaries", "scapulars", "tertials", "primaries"]
# the black edges that make the bronze-brown scapulars and coverts look scaly (never tap targets)
def edges(g, n=10, w=2.2):
    lines = [stroke(f"M{x},{y} Q{x + 14},{y + 10} {x + 30},{y + 6}", w) for x, y in
             [(620 + 26 * i + 13 * (j % 2), 320 + 22 * j + 6 * i) for i in range(n) for j in range(8)]]
    return unary_union(lines).intersection(g)
marks = {k: [(edges(final[k]), "darker")] for k in ("scapulars", "wing-coverts", "lesser-coverts", "median-coverts", "greater-coverts", "wing-bars")}
# the four toes inside each webbed foot (the webs join all four)
TOE_LINES = unary_union([stroke(d, 1.6) for d in ("M700,672 L648,686", "M702,674 L690,690", "M704,674 L742,690",
                                                   "M776,684 L748,694", "M778,686 L784,698", "M780,686 L814,696")])
marks["toes"] = [(TOE_LINES, "linegray")]
marks["crests"] = [(unary_union([stroke(d, 1.4) for d in CURLS]), "darker")]
build("cormorant", final, META, order, [0, 0, 760, 640], dx=160, dy=120, flip_x=640,
      base_under=[(PERCH, "perch")],
      base_over=[(Point(*EYE).buffer(6), "eye")],
      marks=marks,
      outline=unary_union([BODY, BILL, CRESTS, LORES, GULAR]))

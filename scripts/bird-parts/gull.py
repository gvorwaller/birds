from geom import *
from common import build
from shapely.geometry import Point, box
from shapely import affinity
import math

SIL = poly("M255,162 C262,150 275,128 300,114 C325,102 365,98 395,112 C415,122 430,140 440,158 "
           "C470,154 520,150 560,150 C620,148 680,146 720,150 C750,154 772,166 782,182 L800,203 L806,214 "
           "Q770,240 724,282 C694,316 664,346 636,360 C600,394 540,416 490,418 C430,418 370,398 335,360 "
           "C305,325 298,280 300,240 C301,215 302,195 302,180 L279,184 Z")
# the stern below the tail, so the white undertail coverts read as a wedge under the tail
LOBE = poly("M630,364 C700,376 770,330 802,272 L796,266 L712,326 L700,316 L630,330 Z")
SIL0, SIL = SIL, SIL.union(LOBE)
EYE = (321, 143)
# Bill points left here (mirrored later). The lower edge drops from the base to the
# gonydeal angle (~205,213), its lowest point, then rises to the lower mandible's tip.
BILL = poly("M255,161 C232,170 206,180 191,188 Q177,196 179,206 Q183,210 189,208 L205,213 C228,204 255,192 281,185 L301,174 Z")
# gonys: the ridge under the lower mandible, from its tip back to the gonydeal angle
GONYS = stroke("M188,208.5 L206,213.5", 7).intersection(BILL)  # tip back to the angle
SPOT = Point(209, 207).buffer(6.5).intersection(BILL).intersection(box(0, 201, 999, 999))  # on the angle
LEGS = unary_union([stroke("M455,412 L452,520 L447,548", 7), stroke("M565,400 L566,520 L570,542", 7),
                    poly("M447,544 L378,566 L394,575 L458,562 Z"), poly("M570,538 L503,560 L520,573 L592,568 L594,548 Z")])
ROCK = poly("M330,600 Q420,560 520,566 Q600,570 650,610 L330,610 Z")

GRAY = poly("M440,158 C470,154 520,150 560,150 C620,148 680,146 720,150 C750,154 772,166 782,182 L800,205 "
            "Q770,250 720,300 L706,307 Q670,325 635,338 Q610,320 588,307 Q520,250 440,170 Z").intersection(SIL0)

def feather(cx, cy, length, width, ang):
    e = affinity.scale(Point(0, 0).buffer(1), length/2, width/2)
    return affinity.translate(affinity.rotate(e, ang, origin=(0, 0)), cx, cy)
ters = [feather(705+8*k, 180+14*k, 150, 34, 14+3*k) for k in range(3)]
TERT = unary_union(ters).intersection(SIL.buffer(2))
# white tips: the rear end of each feather
def tip_of(f, ang, keep=16):
    a = math.radians(ang); c = f.centroid
    far = (c.x + 75*math.cos(a), c.y + 75*math.sin(a))
    cut = affinity.rotate(box(-keep, -60, 60, 60), ang, origin=(0, 0))
    return f.intersection(affinity.translate(cut, *far))
CRESC = unary_union([tip_of(f, 14+3*k) for k, f in enumerate(ters)]).intersection(TERT)
PRIM = poly("M704,306 Q735,275 768,240 Q788,216 798,200 Q840,200 880,208 Q852,222 816,246 Q770,280 718,313 Z")
APICAL = unary_union([feather(866-15*k, 211+6*k, 12, 5, 22) for k in range(5)]).intersection(PRIM)
# Drawn deeper and a little longer than life so it's easy to find; the wingtips still pass it.
TAIL = poly("M700,316 L842,222 Q858,224 851,236 L713,336 Z")

body = [
    ("belly", SIL),
    ("breast", poly("M290,170 L460,175 Q520,260 470,330 Q420,360 330,370 L290,370 Z")),
    ("sides", poly("M470,200 Q560,265 700,305 L760,262 L770,290 Q700,360 645,372 Q560,420 480,420 Q450,330 470,200 Z")),
    ("undertail-coverts", poly("M620,320 L760,240 L770,262 Q700,330 650,372 L630,372 Z").union(LOBE)),
    ("nape", poly("M380,100 L460,100 L470,170 Q440,190 410,200 L392,140 Z")),
    ("crown", poly("M270,90 L430,90 L432,156 Q380,148 350,148 Q320,146 295,150 L268,152 Z")),
    ("forehead", poly("M250,120 L300,110 L298,140 Q280,146 262,162 L250,165 Z")),
    ("ear-coverts", poly("M318,150 Q360,140 410,150 L430,175 Q400,196 360,196 Q330,190 318,176 Z")),
    ("lores", poly("M248,156 L318,136 L322,176 L284,190 Z")),
    ("throat", poly("M285,176 L320,172 L330,240 L290,240 Z")),
    # td-93f86b: the malar from the base of the lower mandible back along the throat, the eye-line behind the eye,
    # the supercilium over it, and the feathered eye-ring just outside the bare orbital ring
    ("malar", poly("M280,173 L322,168 Q336,184 352,196 L346,205 Q326,194 302,190 L285,190 Z")),
    ("eye-line", poly("M331,137 L380,141 L380,152 L331,150 Z")),
    ("supercilium", poly("M284,140 Q300,126 322,124 Q348,124 374,133 L380,141 L331,137 L322,134 L312,139 L292,145 L284,147 Z")),
    ("eye-ring", Point(*EYE).buffer(11.5).difference(Point(*EYE).buffer(8.5))),
]
final = {}
TAILV = TAIL.difference(PRIM).difference(GRAY)
claimed = GRAY.union(TERT).union(PRIM).union(TAILV).union(Point(*EYE).buffer(8.5))
for pid, rough in reversed(body):
    final[pid] = rough.intersection(SIL).difference(claimed); claimed = claimed.union(rough.intersection(SIL))
for k in ("nape", "crown", "forehead", "ear-coverts", "lores", "throat", "malar", "eye-line", "supercilium", "eye-ring"):
    g = unary_union([q for q in getattr(final[k], "geoms", [final[k]]) if q.area >= 1])
    if g.geom_type != "Polygon": raise SystemExit(f"gull: {k} is in {len(g.geoms)} pieces: " + str([(round(q.area), [round(v) for v in q.bounds]) for q in g.geoms]))
    final[k] = g
final["orbital-ring"] = Point(*EYE).buffer(8.5).difference(Point(*EYE).buffer(6))
final["iris"] = Point(*EYE).buffer(6).difference(Point(*EYE).buffer(2.6))
final["mantle"] = GRAY.union(TERT).difference(PRIM)
final["tertials"] = TERT.difference(PRIM)
final["tertial-crescent"] = CRESC.difference(PRIM)
final["primaries"] = PRIM
final["apical-spots"] = APICAL
final["tail"] = TAILV
final["bill"] = BILL.difference(GONYS).difference(SPOT)
final["gonys"] = GONYS.difference(SPOT)
final["gonydeal-spot"] = SPOT
final["legs"] = LEGS
# feathers layer: subdivide the mantle with rows parallel to the folded wing's lower edge
from shapely.geometry import LineString
m = final["mantle"].difference(TERT)
EDGE = LineString(pts("M556,298 C600,322 650,334 690,318 C730,300 770,262 804,208"))
def row(d0, d1): return EDGE.buffer(d1, cap_style=2).difference(EDGE.buffer(d0, cap_style=2))
final["secondaries"] = EDGE.buffer(10, cap_style=2).intersection(m)
final["greater-coverts"] = row(10, 30).intersection(m)
final["median-coverts"] = row(30, 46).intersection(m)
rest = m.difference(EDGE.buffer(46, cap_style=2))
final["back"] = rest.intersection(poly("M430,140 L740,140 L740,168 Q600,176 470,196 Z"))
rest = rest.difference(final["back"])
final["scapulars"] = rest.intersection(poly("M470,150 L760,150 L760,222 Q640,228 520,236 Z"))
final["lesser-coverts"] = rest.difference(final["scapulars"])
# Main parts: the covert rows as one area over the mantle, as on the other birds (td-93f86b)
# (one piece: the stray covert crumbs at the rear of the wing stay mantle)
final["wing-coverts"] = largest(unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts")]).buffer(0.5).buffer(-0.5).intersection(final["mantle"]))

# inset (open wingtip), built directly in output coordinates (upper left, behind the bird)
IC = (140, 430); IR = 98
def ifeather(i):
    ang = 180 - 30 + 15*i           # fan pointing left, spread like a hand
    L, W = 150, 16
    f = affinity.rotate(affinity.scale(Point(0, 0).buffer(1), L/2, W/2), ang, origin=(0, 0))
    base = (IC[0] + 70, IC[1] - 6 + 3*i)
    c = (base[0] + (L/2-8)*math.cos(math.radians(ang)), base[1] + (L/2-8)*math.sin(math.radians(ang)))
    return affinity.translate(f, *c), ang, c
fs = [ifeather(i) for i in range(5)]
clipc = Point(*IC).buffer(IR - 4)
wing_i = unary_union([f for f, _, _ in fs]).intersection(clipc)
def at(i, t, r):
    f, ang, c = fs[i]
    return Point(c[0] + t*math.cos(math.radians(ang)), c[1] + t*math.sin(math.radians(ang))).buffer(r)
black_i = unary_union([f.intersection(at(i, 40, 58)) for i, (f, _, _) in enumerate(fs)]).intersection(wing_i)
mirrors = unary_union([at(0, 44, 6.5), at(1, 50, 5)]).intersection(wing_i)
apical_i = unary_union([at(i, 70, 4) for i in range(1, 5)]).intersection(wing_i)
meta = [("belly", "pale", "mf"), ("breast", "pale", "mf"), ("sides", "pale", "mf"),
        ("undertail-coverts", "pale", "mf"), ("nape", "pale", "mf"), ("crown", "pale", "mf"),
        ("forehead", "pale", "mf"), ("throat", "pale", "mf"), ("lores", "pale", "mf"), ("ear-coverts", "pale", "mf"),
        ("malar", "pale", "mf"), ("eye-line", "pale", "mf"), ("supercilium", "pale", "mf"), ("eye-ring", "pale", "mf"), ("orbital-ring", "orbital", "mf"),
        ("iris", "billyellow", "mf"), ("mantle", "gullgray", "m"), ("wing-coverts", "gullgray", "m"), ("tertials", "gullgray", "f"),
        ("tertial-crescent", "pale", "mf"), ("primaries", "darker", "mf"),
        ("apical-spots", "pale", "mf"), ("tail", "pale", "mf"), ("bill", "billyellow", "mf"),
        ("gonys", "billyellow", "mf"), ("gonydeal-spot", "accent", "mf"), ("legs", "legpink", "mf"),
        ("secondaries", "pale", "f"), ("scapulars", "gullgray", "f"), ("back", "gullgray", "f"),
        ("lesser-coverts", "gullgray", "f"), ("median-coverts", "gullgray", "f"),
        ("greater-coverts", "gullgray", "f"), ("mirrors", "pale", "mf")]
final["mirrors"] = mirrors
order = ["legs", "belly", "breast", "sides", "undertail-coverts", "tail", "nape", "crown", "forehead", "ear-coverts", "lores", "throat", "malar", "eye-line", "supercilium", "eye-ring", "mantle", "wing-coverts",
         "back", "scapulars", "lesser-coverts", "median-coverts", "greater-coverts", "secondaries", "tertials", "tertial-crescent",
         "primaries", "apical-spots", "orbital-ring", "iris", "bill", "gonys", "gonydeal-spot", "mirrors"]
FX = 560
build("gull", final, meta, order, [0, 0, 760, 560], dx=FX*2-920, dy=20, raw={"mirrors"},
      raw_base=[(wing_i.difference(black_i), "gullgray")],
      # the inset's black tips and apical spots are the same parts as on the standing bird
      extra_raw={"primaries": black_i.difference(mirrors).difference(apical_i), "apical-spots": apical_i},
      insets=[{"cx": IC[0], "cy": IC[1], "r": IR, "label": "Open wingtip"}],
      base_under=[(ROCK, "perch")],
      base_over=[(Point(*EYE).buffer(2.6), "eye")],
      outline=SIL.union(BILL).union(PRIM).union(TERT).union(TAIL), flip_x=FX)

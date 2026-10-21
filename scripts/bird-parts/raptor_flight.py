"""Adult Red-tailed Hawk soaring, from above and from below (td-dd4f9c).

Drawn in output coordinates, right half only, then mirrored (see flight.py). Proportions follow
the flight reference photos: wingspan about 2.5x the bill-to-tail length, a broad arm whose
trailing edge bulges behind the body, a broad hand ending in five spread "fingers", and a short,
fanned tail.
"""
from geom import *
from common import build
from flight import CX, mirror, Wing, wing_view_box
from shapely.geometry import Point, Polygon, LineString, box
from shapely.ops import unary_union
from shapely import affinity
import math

# The five fingers, outermost (on the leading edge) first: where each leaves the hand (a fraction
# of the chord), its angle from straight out (degrees, + is toward the tail) and its free length.
SLOT = 0.70
FINGERS = [(0.92, -30, 40), (0.72, -13, 56), (0.52, 3, 60), (0.32, 19, 54), (0.13, 34, 42)]


class HawkWing(Wing):
    """A buteo's wing: the hand's outer primaries separate into fingers."""

    def finger_tips(self):
        out = []
        for f, a, L in FINGERS:
            bx, by = self.hand.at(SLOT, f)
            out.append((bx + L * math.cos(math.radians(a)), by + L * math.sin(math.radians(a))))
        return out

    def fingers(self):
        H = self.hand
        out = []
        for (f, a, L), tip in zip(FINGERS, self.finger_tips()):
            base = H.at(SLOT - 0.25, f)
            w0, w1 = 11.0, 4.6
            ang = math.atan2(tip[1] - base[1], tip[0] - base[0])
            nx, ny = -math.sin(ang), math.cos(ang)
            out.append(Polygon([(base[0] + nx * w0, base[1] + ny * w0), (tip[0] + nx * w1, tip[1] + ny * w1),
                                (tip[0] - nx * w1, tip[1] - ny * w1), (base[0] - nx * w0, base[1] - ny * w0)]
                               ).buffer(2.5).union(Point(*tip).buffer(w1 + 1.5)))
        return unary_union(out)

    def primaries_shape(self):
        return unary_union([self.hand.band(0, SLOT, 0, 1, n=60), self.fingers()])

    def finger_region(self):
        """The separated outer primaries beyond the slot bases."""
        H = self.hand
        cut = Polygon([H.at(SLOT - 0.03, f) for f in [i / 20 for i in range(21)]] + [(800, -60), (800, 240)]).buffer(0)
        return self.fingers().intersection(cut)


W = HawkWing(("M404,62 C460,48 520,38 586,32", "M404,194 C470,202 540,194 598,172"),
             ("M586,32 C620,28 650,30 676,40", "M598,172 C630,162 660,148 684,128"),
             rows=(0.38, 0.56, 0.70), tertials=(0.13, 0.52), pc=(0.40, 0.46, 1.0), alula=(0.12, 0.80))
ARM, HAND = W.arm, W.hand
WING_R = W.outline()
WING = mirror(WING_R)

HEAD = affinity.scale(Point(CX, 34).buffer(1), 19, 22)
BODY = mirror(poly("M380,48 L398,52 C412,64 420,86 422,112 C424,140 420,166 410,192 L380,196 Z")).union(HEAD)
BILL = mirror(poly("M380,2 Q385,3 387,10 L389,18 L380,18 Z"))
TAIL = mirror(poly("M380,186 L408,186 L446,288 Q420,308 380,311 Z"))
SIL = BODY.union(TAIL).union(WING)
EYES = mirror(Point(CX + 13, 30).buffer(2.6))
VB = [0, 0, 760, 330]
BAND = mirror(poly("M380,282 L436,268 L442,280 L380,296 Z")).intersection(TAIL)


def lines(sec_to, w=0.9):
    """Lines between the flight feathers (drawn over, never tappable)."""
    ls = [ARM.line(s, sec_to, s, 0.0, w) for s in [i / 16 for i in range(2, 16)]]
    ls += [HAND.line(s * 0.9, 0.9, s, 0.0, w) for s in [i / 10 for i in range(1, 8)]]
    return unary_union(ls).intersection(W.outline()).difference(W.finger_region())


# ---------- from above ----------
def above():
    up = W.upper()
    fing = W.finger_region()
    crown = HEAD.intersection(mirror(poly("M380,8 L404,8 L404,36 Q392,44 380,46 Z")))
    nape = HEAD.union(BODY.intersection(box(0, 40, 999, 70))).difference(crown)
    scap = poly("M394,66 C410,80 424,104 428,130 C430,150 424,166 414,174 L400,172 C398,136 398,100 394,66 Z")
    back = BODY.intersection(box(0, 62, 999, 168)).difference(mirror(scap)).difference(nape)
    rump = BODY.intersection(box(0, 160, 999, 182)).difference(mirror(scap))
    utc = mirror(poly("M380,178 L408,178 C410,190 406,200 398,206 Q390,210 380,210 Z"))
    tail = TAIL.difference(utc).difference(rump)   # the band is drawn over the whole tail (td-d32fd3)
    R = mirror
    final = {k: R(v) for k, v in up.items()}
    final["primaries"] = final["primaries"].difference(R(fing))
    final["fingers"] = R(fing)
    final.update({"crown": crown, "nape": nape, "scapulars": mirror(scap), "back": back, "rump": rump,
                  "uppertail-coverts": utc, "tail": tail, "subterminal-band": BAND, "bill": BILL})
    for k in ("tertials", "lesser-coverts", "median-coverts", "greater-coverts"):
        final[k] = final[k].difference(final["scapulars"])
    final["wing-coverts"] = unary_union([final[k] for k in ("lesser-coverts", "median-coverts", "greater-coverts",
                                                             "primary-coverts", "alula")])
    # td-2a2f94: where a wing bar runs, along the greater coverts' tips; none on an adult Red-tail, so the coverts' tone
    final["wing-bars"] = R(ARM.band(0, 1, 0.30, 0.46).intersection(up["greater-coverts"])).difference(final["tertials"]).difference(final["scapulars"]).difference(BODY)
    # the pale mottling on the scapulars that makes the "V" on an adult's back
    vmarks = mirror(unary_union([affinity.rotate(affinity.scale(Point(x, y).buffer(1), 2.6, 6), a, origin=(x, y))
                                 for x, y, a in [(404, 92, -20), (410, 112, -15), (416, 132, -10), (410, 150, 0),
                                                 (402, 120, -20), (420, 154, 5)]]))
    meta = [("tail", "chestnut", "mf"), ("subterminal-band", "darker", "mf"), ("uppertail-coverts", "dark", "mf"),
            ("rump", "dark", "mf"), ("secondaries", "wing", "mf"), ("primaries", "darker", "mf"), ("fingers", "darker", "mf"),
            ("wing-coverts", "dark", "m"), ("lesser-coverts", "dark", "f"), ("median-coverts", "dark", "f"),
            ("greater-coverts", "dark", "f"), ("primary-coverts", "dark", "f"), ("alula", "dark", "f"),
            ("wing-bars", "dark", "mf"), ("tertials", "wing", "mf"), ("back", "dark", "mf"), ("scapulars", "dark", "mf"),
            ("nape", "dark", "mf"), ("crown", "dark", "mf"), ("bill", "bill", "mf")]
    order = [m[0] for m in meta]
    build("raptor-above", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"scapulars": [(vmarks, "light")]},
          base_over=[(mirror(lines(W.rows[0]).difference(W.pc_shape()).difference(up["alula"])), "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


# ---------- from below ----------
def below():
    un = W.under(coverts=0.44, ax=(0.15, 0.12, 0.58))
    fing = W.finger_region()
    te = unary_union([ARM.band(0, 1, 0, 0.07), HAND.band(0, SLOT, 0, 0.07)])
    patagial = ARM.band(0.04, 1.0, lambda s: 0.86 - 0.06 * s, 1.0)
    c = HAND.at(0.07, 0.66)
    l, t = HAND.at(0.07, 0.66), HAND.at(0.12, 0.66)
    ang = math.degrees(math.atan2(t[1] - l[1], t[0] - l[0])) + 90
    carpal = affinity.rotate(affinity.scale(Point(*c).buffer(1), 7, 15), ang, origin=c).union(
        affinity.rotate(affinity.scale(Point(c[0] - 3, c[1] + 12).buffer(1), 4, 8), ang - 25, origin=c))
    throat = HEAD.union(BODY.intersection(box(0, 40, 999, 62)))
    breast = BODY.intersection(box(0, 60, 999, 96)).difference(throat)
    band = BODY.intersection(mirror(poly("M380,92 Q404,90 430,96 L430,140 Q404,134 380,138 Z"))).difference(breast)
    legs = mirror(affinity.scale(Point(398, 166).buffer(1), 12, 20))
    utc = mirror(poly("M380,176 L400,176 C404,190 400,204 392,210 Q386,214 380,214 Z"))
    belly = BODY.difference(throat).difference(breast).difference(band).difference(legs).difference(utc)
    tail = TAIL.difference(utc)   # the band is drawn over the whole tail (td-d32fd3)
    R = mirror
    final = {k: R(v) for k, v in un.items()}
    final["primaries"] = final["primaries"].difference(R(fing))
    final["fingers"] = R(fing)
    final.update({"trailing-edge": R(te.difference(un["underwing-coverts"])), "patagial-bar": R(patagial),
                  "carpal-patch": R(carpal), "throat": throat, "breast": breast, "belly-band": band, "belly": belly,
                  "leg-feathers": legs, "undertail-coverts": utc, "tail": tail, "subterminal-band": BAND, "bill": BILL})
    final["underwing-coverts"] = final["underwing-coverts"].difference(final["patagial-bar"]).difference(final["carpal-patch"])
    # the body is nearer the viewer than the wing roots
    for k in ("secondaries", "trailing-edge", "underwing-coverts", "axillaries", "patagial-bar"):
        final[k] = final[k].difference(BODY)
    streaks = unary_union([affinity.rotate(affinity.scale(Point(x, y).buffer(1), 2.2, 5.5), a, origin=(x, y))
                           for x, y, a in [(384, 104, 0), (396, 100, 10), (410, 106, 15), (390, 120, 5), (404, 122, 12),
                                           (418, 120, 18), (386, 132, 0), (412, 134, 15)]])
    streaks = mirror(streaks).intersection(band)
    meta = [("tail", "light", "m"), ("subterminal-band", "darker", "m"), ("secondaries", "light", "m"),
            ("primaries", "pale", "m"), ("fingers", "light", "m"), ("trailing-edge", "darker", "m"),
            ("underwing-coverts", "pale", "m"), ("patagial-bar", "darker", "m"), ("carpal-patch", "darker", "m"),
            ("axillaries", "pale", "m"), ("belly", "pale", "m"), ("belly-band", "mid", "m"), ("breast", "pale", "m"),
            ("leg-feathers", "light", "m"), ("undertail-coverts", "pale", "m"), ("throat", "light", "m"), ("bill", "bill", "m")]
    order = [m[0] for m in meta]
    tips = mirror(unary_union([Point(*t).buffer(12) for t in W.finger_tips()]).intersection(fing))
    build("raptor-below", final, meta, order, VB, dx=0, dy=0,
          wing_view_box=wing_view_box(VB),
          marks={"fingers": [(tips, "darker")], "belly-band": [(streaks, "darker")]},
          base_over=[(mirror(lines(0.44).difference(un["underwing-coverts"])), "linegray"), (EYES, "eye")],
          outline=SIL.union(BILL))


if __name__ == "__main__":
    above()
    below()

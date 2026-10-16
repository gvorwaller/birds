"""Shared helpers for the in-flight views (td-a1bfd9).

A flight view is drawn symmetric, head up the page and wings across, in output coordinates.
Only the right half (x >= CX) is drawn; mirror() adds the left wing, so a part is one id drawn
on both wings. A wing is parametrised by s (0 at the root, 1 at the end of that segment) along
its leading and trailing edges and by f, the fraction of the chord from the trailing edge (0)
to the leading edge (1), so feather tracts are bands of f, like the rows on a real wing.
"""
import math
from shapely import affinity
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
from geom import pts

CX = 380


def wing_view_box(vb, margin=28):
    """The body and the right wing only: about 1.8x larger on a phone."""
    x0 = CX - margin
    return [x0, vb[1], vb[0] + vb[2] - x0, vb[3]]


def mirror(g, cx=CX):
    return g.union(affinity.scale(g, xfact=-1, yfact=1, origin=(cx, 0))).buffer(0)


class Curve:
    """A polyline sampled from an absolute M/L/Q/C path, addressed by arc length 0..1."""
    def __init__(self, d):
        self.p = pts(d)
        self.cum = [0.0]
        for a, b in zip(self.p, self.p[1:]):
            self.cum.append(self.cum[-1] + math.dist(a, b))

    def at(self, s):
        L = self.cum[-1] * min(max(s, 0.0), 1.0)
        for i in range(1, len(self.cum)):
            if self.cum[i] >= L:
                a, b = self.p[i - 1], self.p[i]
                seg = self.cum[i] - self.cum[i - 1] or 1
                t = (L - self.cum[i - 1]) / seg
                return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        return self.p[-1]


class Segment:
    """One stretch of wing (the arm or the hand) between a leading and a trailing edge."""
    def __init__(self, le, te):
        self.le, self.te = Curve(le), Curve(te)

    def at(self, s, f):
        (lx, ly), (tx, ty) = self.le.at(s), self.te.at(s)
        return (tx + (lx - tx) * f, ty + (ly - ty) * f)

    def band(self, s0, s1, f0, f1, n=40, scallops=0, amp=0.0):
        """f0..f1 may be numbers or functions of s. With scallops, the rear edge (f0) bulges
        back into rounded feather tips, which overlap the row behind, as real feathers do."""
        F0 = f0 if callable(f0) else (lambda s, v=f0: v)
        F1 = f1 if callable(f1) else (lambda s, v=f1: v)
        rear, front = [], []
        for i in range(n + 1):
            s = s0 + (s1 - s0) * i / n
            dip = amp * abs(math.sin(math.pi * scallops * i / n)) if scallops else 0.0
            rear.append(self.at(s, F0(s) - dip))
            front.append(self.at(s, F1(s)))
        return Polygon(rear + front[::-1]).buffer(0)

    def line(self, s0, f0, s1, f1, w=1.0):
        return LineString([self.at(s0, f0), self.at(s1, f1)]).buffer(w / 2, cap_style=2)


class Wing:
    """The right wing: an arm (secondaries side) and a hand (primaries), with the feather tracts
    as bands of the chord. Every method returns right-half geometry; mirror() it for both wings.

    rows: fractions of the arm's chord from the trailing edge where the secondaries end and the
    greater, median and lesser covert rows begin. Each bird's numbers follow its reference
    photos; small birds have proportionally deeper covert rows."""
    def __init__(self, arm, hand, rows=(0.40, 0.60, 0.74), tips=9, tip_amp=0.018,
                 tertials=(0.14, 0.56), pc=(0.44, 0.50, 1.1), alula=(0.13, 0.84)):
        self.arm, self.hand = Segment(*arm), Segment(*hand)
        self.rows, self.tips, self.tip_amp = rows, tips, tip_amp
        self.ter, self.pc, self.al = tertials, pc, alula

    def primaries_shape(self):
        return self.hand.band(0, 1, 0, 1, n=80, scallops=self.tips, amp=self.tip_amp)

    def outline(self):
        return unary_union([self.arm.band(0, 1, 0, 1), self.primaries_shape()])

    def pc_shape(self):
        s1, f0, k = self.pc
        return self.hand.band(0, s1, lambda s: f0 + k * s, 1.0)

    def upper(self):
        """Upper-wing tracts, painter-subtracted so each row overlaps the one behind it."""
        A, H = self.arm, self.hand
        r0, r1, r2 = self.rows
        t = {"secondaries": A.band(0, 1, 0, r0),
             "greater-coverts": A.band(0, 1, r0, r1, n=60, scallops=12, amp=0.025),
             "median-coverts": A.band(0, 1, r1, r2, n=60, scallops=16, amp=0.02),
             "lesser-coverts": A.band(0, 1, r2, 1.0),
             "tertials": A.band(0, self.ter[0], -0.02, self.ter[1]),
             "primary-coverts": self.pc_shape(),
             "alula": unary_union([H.band(0, self.al[0], self.al[1], 1.0), A.band(0.94, 1, self.al[1], 1.0)]),
             "primaries": self.primaries_shape()}
        t["secondaries"] = t["secondaries"].difference(t["greater-coverts"])
        t["primaries"] = t["primaries"].difference(t["primary-coverts"]).difference(t["alula"])
        t["primary-coverts"] = t["primary-coverts"].difference(t["alula"])
        t["lesser-coverts"] = t["lesser-coverts"].difference(t["alula"])
        for k in ("secondaries", "greater-coverts", "median-coverts", "lesser-coverts"):
            t[k] = t[k].difference(t["tertials"])
        return t

    def under(self, coverts=0.40, ax=(0.16, 0.10, 0.62)):
        """Under-wing: the flight feathers' undersides, the underwing coverts (wing linings)
        over their bases, and the axillaries in the 'armpit'."""
        A, H = self.arm, self.hand
        s1, f0, k = self.pc
        uwc = unary_union([A.band(0, 1, coverts, 1.0), H.band(0, s1 + 0.02, lambda s: f0 - 0.04 + k * s, 1.0)])
        t = {"secondaries": A.band(0, 1, 0, coverts + 0.02).difference(uwc),
             "primaries": self.primaries_shape().difference(uwc),
             "axillaries": A.band(0, ax[0], ax[1], ax[2])}
        t["underwing-coverts"] = uwc.difference(t["axillaries"])
        return t

    def trailing_edge(self, depth=0.10, hand_to=0.42):
        return unary_union([self.arm.band(0, 1, 0, depth),
                            self.hand.band(0, hand_to, 0, lambda s: depth * 0.8 * (1 - s / hand_to) + 0.001)])

    def tip_region(self, at_te, at_le):
        """The outer hand beyond a line from s=at_te on the trailing edge to s=at_le on the
        leading edge (a dark wingtip)."""
        H = self.hand
        return Polygon([H.at(at_te + (at_le - at_te) * f, f) for f in [i / 20 for i in range(21)]]
                       + [H.at(1.05, 1), H.at(1.05, 0)]).buffer(0)

    def lines(self, n_sec=14, n_prim=9, sec_to=None, w=0.9):
        """Thin lines between individual flight feathers (drawn over, never tappable)."""
        sec_to = self.rows[0] if sec_to is None else sec_to
        ls = [self.arm.line(s, sec_to, s, 0.0, w) for s in [i / (n_sec + 2) for i in range(2, n_sec + 2)]]
        ls += [self.hand.line(s * 0.92, 0.95, s, 0.0, w) for s in [i / (n_prim + 1) for i in range(1, n_prim + 1)]]
        return unary_union(ls).intersection(self.outline())

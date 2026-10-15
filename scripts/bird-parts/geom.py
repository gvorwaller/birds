"""Shared helpers: tiny SVG-path sampler, wing frame, painter partition, output."""
import math, re, json
from shapely.geometry import Polygon, MultiPolygon, LineString, Point, GeometryCollection
from shapely.ops import unary_union

def _q(p0, c, p1, n=24):
    return [((1-t)**2*p0[0]+2*(1-t)*t*c[0]+t*t*p1[0], (1-t)**2*p0[1]+2*(1-t)*t*c[1]+t*t*p1[1]) for t in (i/n for i in range(1, n+1))]

def _c(p0, c1, c2, p1, n=28):
    out = []
    for i in range(1, n+1):
        t = i/n; a = (1-t)**3; b = 3*(1-t)**2*t; cc = 3*(1-t)*t*t; d = t**3
        out.append((a*p0[0]+b*c1[0]+cc*c2[0]+d*p1[0], a*p0[1]+b*c1[1]+cc*c2[1]+d*p1[1]))
    return out

def pts(d):
    """Absolute M/L/Q/C/Z only -> list of points."""
    toks = re.findall(r"[MLQCZ]|-?\d+(?:\.\d+)?", d)
    i = 0; cur = None; out = []; cmd = None
    def num():
        nonlocal i
        v = float(toks[i]); i += 1; return v
    while i < len(toks):
        if toks[i] in "MLQCZ":
            cmd = toks[i]; i += 1
            if cmd == "Z": continue
        if cmd == "M" or cmd == "L":
            cur = (num(), num()); out.append(cur)
        elif cmd == "Q":
            c = (num(), num()); p = (num(), num()); out += _q(cur, c, p); cur = p
        elif cmd == "C":
            c1 = (num(), num()); c2 = (num(), num()); p = (num(), num()); out += _c(cur, c1, c2, p); cur = p
    return out

def poly(d):
    return Polygon(pts(d)).buffer(0)

def stroke(d, w):
    return LineString(pts(d)).buffer(w/2, cap_style=1, join_style=1)

class Frame:
    """Folded-wing frame: u 0 (shoulder) -> 1 (tip) along a quadratic centreline,
    v -1 (upper edge) -> +1 (lower edge)."""
    def __init__(self, s, c, t, width, taper=0.8, tip=3):
        self.s, self.c, self.t, self.width, self.taper, self.tip = s, c, t, width, taper, tip
    def center(self, u):
        s, c, t = self.s, self.c, self.t
        return ((1-u)**2*s[0]+2*(1-u)*u*c[0]+u*u*t[0], (1-u)**2*s[1]+2*(1-u)*u*c[1]+u*u*t[1])
    def normal(self, u):
        s, c, t = self.s, self.c, self.t
        dx = 2*(1-u)*(c[0]-s[0])+2*u*(t[0]-c[0]); dy = 2*(1-u)*(c[1]-s[1])+2*u*(t[1]-c[1])
        L = math.hypot(dx, dy); nx, ny = -dy/L, dx/L
        if ny < 0: nx, ny = -nx, -ny   # +v points down
        return nx, ny
    def half(self, u):
        return self.tip + (self.width-self.tip)*(1-u)**self.taper
    def at(self, u, v):
        cx, cy = self.center(u); nx, ny = self.normal(u); h = self.half(u)
        return (cx+nx*v*h, cy+ny*v*h)
    def band(self, u0, u1, v0, v1, n=20):
        top = [self.at(u0+(u1-u0)*i/n, v0) for i in range(n+1)]
        bot = [self.at(u1-(u1-u0)*i/n, v1) for i in range(n+1)]
        return Polygon(top+bot).buffer(0)
    def outline(self):
        return self.band(0, 1, -1, 1, n=60)

def to_d(geom, dx, dy, tol=0.25):
    geom = geom.simplify(tol)
    polys = [geom] if isinstance(geom, Polygon) else [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
    parts = []
    for p in polys:
        if p.area < 0.5: continue
        for ring in [p.exterior, *p.interiors]:
            cs = list(ring.coords)[:-1]
            parts.append("M" + " L".join(f"{x-dx:.1f},{y-dy:.1f}" for x, y in cs) + "Z")
    return "".join(parts)

def largest(geom):
    if isinstance(geom, Polygon): return geom
    ps = [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
    return max(ps, key=lambda g: g.area) if ps else geom

def fband(frame, u0, u1, v0, v1, n=40, scallops=0, amp=0.0, skew=0.0, front_scallops=False):
    """Band in a wing frame whose rear edge (u1) can be scalloped like feather tips and
    whose edges slant by `skew` (u shifts by skew*v)."""
    import math
    def U(u, v): return min(max(u + skew*v, -1.0), 1.0)
    top = [frame.at(U(u0, v0 + 0*(v1-v0)), v0)]
    # rear edge from v0 to v1 (scalloped)
    rear = []
    for i in range(n+1):
        v = v0 + (v1-v0)*i/n
        bump = amp*abs(math.sin(math.pi*scallops*(i/n)))**0.5 if scallops else 0.0
        rear.append(frame.at(U(u1 + bump, v), v))
    front = []
    for i in range(n+1):
        v = v1 - (v1-v0)*i/n
        bump = amp*abs(math.sin(math.pi*scallops*(1-i/n))) if (scallops and front_scallops) else 0.0
        front.append(frame.at(U(u0 + bump, v), v))
    return Polygon(rear + front).buffer(0)

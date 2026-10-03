# Shared geometry for Permutation State terrain tiles (used by render_a.py and render_c.py).
# Every object carries: obj["roles"] = "role0,role1,..." (one material slot per role),
# face attribute "tone" (int, palette variety), point attribute "pat" (0..1 pattern),
# corner colour "col" (linear RGBA, used by style A).
import bpy, bmesh, math, random, os
from mathutils import Vector, Matrix, noise

SQ = 0.76
ELEV = math.asin(SQ)
APO = math.sqrt(3) / 2
PPU1 = 44                      # pixels per unit (hex radius) at 1x
TOP_U, BOT_U, W_U = 62 / 44, 42 / 44, 2.0
H_LAND, H_WATER = 0.24, 0.185
FRINGE = False
TERRAINS = ["grassland", "plains", "forest", "hills", "mountain", "water"]

# ------------------------------------------------------------------ colour
def hx(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

def lin(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c[:3])

def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

def ramp(stops, t):
    t = max(0.0, min(1.0, t)) * (len(stops) - 1)
    i = min(int(t), len(stops) - 2)
    return mix(stops[i], stops[i + 1], t - i)

def mul(c, k):
    return tuple(min(1.0, x * k) for x in c)

def smooth01(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

# ------------------------------------------------------------------ hex maths
def edge_dist(x, y, scale=1.0):
    return APO * scale - max(x * math.cos(math.radians(60 * k)) + y * math.sin(math.radians(60 * k)) for k in range(6))

def hex_corners(scale=1.0):
    return [(scale * math.cos(math.radians(90 + 60 * k)), scale * math.sin(math.radians(90 + 60 * k))) for k in range(6)]

class Field:
    """Height and colour of the ground for one tile."""
    def __init__(self, terrain, v, detail):
        self.terrain, self.v, self.detail = terrain, v, detail
        self.rng = random.Random(f"{terrain}-{v}")
        r = self.rng
        self.seed = Vector((r.random() * 200, r.random() * 200, r.random() * 200))
        self.h = H_WATER if terrain == "water" else H_LAND
        self.height_fn = lambda x, y: 0.0
        self.stops = [hx("#7d9a48"), hx("#8fad52"), hx("#a8bb60")]
        self.fade = 0.2
        self.river = None
        self.carve_fn = lambda x, y: 0.0
        self.flat_fn = lambda x, y: 1.0

    def n(self, x, y, f, o=0.0):
        return noise.noise(Vector((x * f, y * f, o)) + self.seed)

    def raw(self, x, y):
        return self.height_fn(x, y)

    def z(self, x, y):
        return self.h + self.raw(x, y) * smooth01(edge_dist(x, y) / self.fade) * self.flat_fn(x, y) - self.carve_fn(x, y)

    def patch(self, x, y):
        p = 0.5 + 0.75 * self.n(x, y, 1.9) + 0.25 * self.n(x, y, 6.0, 3.0)
        e = smooth01(edge_dist(x, y) / 0.16)
        return 0.5 + (p - 0.5) * e

    def color(self, x, y):
        c = ramp(self.stops, self.patch(x, y))
        if self.river:
            d = self.river.dist(x, y)
            c = mix(c, mul(c, 1.08), 1 - smooth01((d - RW) / (3.5 * RW)))
            c = mix(c, hx("#6e6a4c"), 1 - smooth01((d - 0.7 * RW) / (0.9 * RW)))
        return c

# ------------------------------------------------------------------ lanes, rivers, roads
RW = 0.066            # river half width
LANE = 0.08           # half width kept free of props on the six centre-edge lanes
EXCLUDE = [None]

def edge_mid(k, scale=1.0):
    cs = hex_corners(scale)
    (x0, y0), (x1, y1) = cs[k], cs[(k + 1) % 6]
    return Vector(((x0 + x1) / 2, (y0 + y1) / 2))

def seg_dist(x, y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)

def lane_dist(x, y):
    return min(seg_dist(x, y, 0, 0, m.x, m.y) for m in (edge_mid(k) for k in range(6)))

def bezier(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append(p0 * u ** 3 + p1 * 3 * u * u * t + p2 * 3 * u * t * t + p3 * t ** 3)
    return out

class RiverNet:
    """River channel through the centre to the edges in `mask` (bit k = edge k)."""
    def __init__(self, mask, rng):
        import numpy as np
        self.mask = mask
        arms = [k for k in range(6) if mask >> k & 1]
        curves, pools = [], []
        def meander(pts, amp):
            n = len(pts) - 1
            res = []
            for i, p in enumerate(pts):
                t = i / n
                if 0 < i < n:
                    d = pts[i + 1] - pts[i - 1]
                    nrm = Vector((-d.y, d.x)).normalized()
                    p = p + nrm * amp * math.sin(2 * math.pi * t) * math.sin(math.pi * t)
                res.append(p)
            return res
        if len(arms) == 2:
            a, b = arms
            pa, pb = edge_mid(a), edge_mid(b)
            ia, ib = -pa.normalized(), -pb.normalized()
            L = 0.42
            curves.append(meander(bezier(pa, pa + ia * L, pb + ib * L, pb, 80), rng.uniform(-0.05, 0.05)))
        else:
            for a in arms:
                pa = edge_mid(a)
                ia = -pa.normalized()
                curves.append(meander(bezier(pa, pa + ia * 0.34, ia * -0.12, Vector((0, 0)), 60), rng.uniform(-0.04, 0.04)))
            pools.append((0.0, 0.0, RW * (1.5 if len(arms) == 1 else 1.35)))
        pts = np.array([[p.x, p.y] for c in curves for p in c], dtype=np.float32)
        N = 300
        self.lo, self.hi, self.N = -1.1, 1.1, N
        g = np.linspace(self.lo, self.hi, N, dtype=np.float32)
        gx, gy = np.meshgrid(g, g)
        grid = np.stack([gx.ravel(), gy.ravel()], 1)
        best = np.full(grid.shape[0], 9.0, dtype=np.float32)
        for i in range(0, len(pts), 64):
            chunk = pts[i:i + 64]
            d = np.sqrt(((grid[:, None, :] - chunk[None]) ** 2).sum(-1)).min(1)
            best = np.minimum(best, d)
        for (px, py, r) in pools:
            best = np.minimum(best, np.maximum(0, np.sqrt((grid[:, 0] - px) ** 2 + (grid[:, 1] - py) ** 2) - (r - RW)))
        self.grid = best.reshape(N, N)

    def dist(self, x, y):
        f = (self.N - 1) / (self.hi - self.lo)
        gx, gy = (x - self.lo) * f, (y - self.lo) * f
        i, j = int(max(0, min(self.N - 2, gx))), int(max(0, min(self.N - 2, gy)))
        tx, ty = min(1.0, max(0.0, gx - i)), min(1.0, max(0.0, gy - j))
        g = self.grid
        a = g[j, i] * (1 - tx) + g[j, i + 1] * tx
        b = g[j + 1, i] * (1 - tx) + g[j + 1, i + 1] * tx
        return float(a * (1 - ty) + b * ty)

def free_spot(F, x, y):
    if lane_dist(x, y) < LANE:
        return False
    if F.river and F.river.dist(x, y) < 1.9 * RW:
        return False
    return True

# ------------------------------------------------------------------ mesh builder
class MB:
    """Thin wrapper over bmesh that paints colour/tone/pattern on everything it adds."""
    def __init__(self, name, roles, smooth=False):
        self.name, self.roles, self.smooth = name, roles, smooth
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("col")
        self.tone = self.bm.faces.layers.int.new("tone")
        self.pat = self.bm.verts.layers.float.new("pat")

    def new_faces_since(self, before):
        return [f for f in self.bm.faces if f not in before]

    def paint(self, faces, colfn, tone=0, slot=0, pat=0.5, smooth=None):
        for f in faces:
            f[self.tone] = tone
            f.material_index = slot
            f.smooth = self.smooth if smooth is None else smooth
            for l in f.loops:
                c = colfn(l.vert.co)
                l[self.col] = lin(c) + (1.0,)
                l.vert[self.pat] = pat if not callable(pat) else pat(l.vert.co)

    def link(self):
        me = bpy.data.meshes.new(self.name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        ob = bpy.data.objects.new(self.name, me)
        ob["roles"] = ",".join(self.roles)
        bpy.context.scene.collection.objects.link(ob)
        return ob

# ------------------------------------------------------------------ primitives
def blade(mb, p, ang, lean, hgt, w, cbase, ctip, tone=0, slot=0, droop=0.0):
    b = mb.bm
    d = Vector((math.cos(ang), math.sin(ang), 0))
    perp = Vector((-d.y, d.x, 0))
    lv = d * lean
    base = Vector(p)
    v0 = b.verts.new(base + perp * w)
    v1 = b.verts.new(base - perp * w)
    m = base + Vector((0, 0, hgt * 0.55)) + lv * 0.35
    v2 = b.verts.new(m - perp * w * 0.65)
    v3 = b.verts.new(m + perp * w * 0.65)
    v4 = b.verts.new(base + Vector((0, 0, hgt - droop)) + lv)
    f1 = b.faces.new((v0, v1, v2, v3))
    f2 = b.faces.new((v3, v2, v4))
    for f in (f1, f2):
        f[mb.tone] = tone
        f.material_index = slot
        f.smooth = True
        for l in f.loops:
            t = (l.vert.co.z - base.z) / max(hgt, 1e-4)
            l[mb.col] = lin(mix(cbase, ctip, t)) + (1.0,)
            l.vert[mb.pat] = t

def cone(mb, x, y, z, r1, r2, d, seg=6, rot=0.0, jit=0.0, rng=None, droop=0.0):
    before = set(mb.bm.faces)
    M = Matrix.Translation((x, y, z + d / 2)) @ Matrix.Rotation(rot, 4, "Z")
    res = bmesh.ops.create_cone(mb.bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=d, matrix=M)
    if jit and rng:
        for v in res["verts"]:
            if v.co.z < z + d * 0.1:
                k = 1 + rng.uniform(-jit, jit)
                v.co.x = x + (v.co.x - x) * k
                v.co.y = y + (v.co.y - y) * k
                v.co.z -= droop * rng.random()
    return mb.new_faces_since(before)

def blob(mb, x, y, z, r, rng, sub=2, sx=1.0, sy=1.0, sz=1.0, jit=0.2, freq=3.0):
    before = set(mb.bm.faces)
    res = bmesh.ops.create_icosphere(mb.bm, subdivisions=sub, radius=r)
    seed = Vector((rng.random() * 90, rng.random() * 90, rng.random() * 90))
    for v in res["verts"]:
        n = noise.noise(v.co / r * (freq / 3.0) + seed)
        v.co *= 1 + jit * n
        v.co.x *= sx; v.co.y *= sy; v.co.z *= sz
        v.co += Vector((x, y, z))
    return mb.new_faces_since(before)

def scatter(n, margin, min_d, rng, avoid=(), accept=None, tries=500):
    pts, t = [], 0
    while len(pts) < n and t < n * tries:
        t += 1
        x, y = rng.uniform(-1, 1), rng.uniform(-1, 1)
        if edge_dist(x, y) < margin:
            continue
        if accept and not accept(x, y):
            continue
        if EXCLUDE[0] and not EXCLUDE[0](x, y):
            continue
        if any((x - px) ** 2 + (y - py) ** 2 < min_d ** 2 for px, py in pts):
            continue
        if any((x - ax) ** 2 + (y - ay) ** 2 < ar ** 2 for ax, ay, ar in avoid):
            continue
        pts.append((x, y))
    return pts

def jitter_grid(spacing, rng, margin=0.0):
    pts = []
    n = int(2 / spacing) + 2
    for i in range(-n, n):
        for j in range(-n, n):
            x = (i + rng.random()) * spacing
            y = (j + rng.random()) * spacing
            if edge_dist(x, y) >= margin:
                pts.append((x, y))
    return pts

# ------------------------------------------------------------------ ground and walls
def ground(F, roles, cuts, face_role=None, scale=1.0, smooth=True):
    mb = MB("ground", roles, smooth=smooth)
    b = mb.bm
    cs = hex_corners(scale)
    t = [b.verts.new((x, y, F.h)) for x, y in cs]
    c = b.verts.new((0, 0, F.h))
    for i in range(6):
        b.faces.new((c, t[i], t[(i + 1) % 6]))
    bmesh.ops.subdivide_edges(b, edges=b.edges[:], cuts=cuts, use_grid_fill=True)
    for v in b.verts:
        if edge_dist(v.co.x, v.co.y, scale) > 1e-5:
            v.co.z = F.z(v.co.x, v.co.y)
        else:
            v.co.z = F.h - F.carve_fn(v.co.x, v.co.y)
    b.normal_update()
    for f in b.faces:
        slot, tone = (face_role(f) if face_role else (0, 0))
        f.material_index = slot
        f[mb.tone] = tone
        f.smooth = smooth
        for l in f.loops:
            co = l.vert.co
            l[mb.col] = lin(F.color(co.x, co.y)) + (smooth01(edge_dist(co.x, co.y, scale) / 0.16),)
            l.vert[mb.pat] = F.patch(co.x, co.y)
    return mb.link()

def walls(F, scale=1.0, nu=40, nv=6, rough=0.014):
    mb = MB("walls", ["wall"])
    b = mb.bm
    cs = hex_corners(scale)
    for i in (2, 3):
        (x0, y0), (x1, y1) = cs[i], cs[(i + 1) % 6]
        nrm = Vector(((x0 + x1) / 2, (y0 + y1) / 2, 0)).normalized()
        grid = []
        for vi in range(nv + 1):
            row = []
            for ui in range(nu + 1):
                u = ui / nu
                px, py = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
                ztop = F.h - F.carve_fn(px, py)
                p = Vector((px, py, ztop * (1 - vi / nv)))
                if 0 < vi and 0 < ui < nu:
                    p += nrm * rough * noise.noise(p * 9 + F.seed)
                row.append(b.verts.new(p))
            grid.append(row)
        for vi in range(nv):
            for ui in range(nu):
                b.faces.new((grid[vi][ui], grid[vi + 1][ui], grid[vi + 1][ui + 1], grid[vi][ui + 1]))
    bmesh.ops.recalc_face_normals(b, faces=b.faces[:])
    for f in b.faces:
        f.smooth = False
        for l in f.loops:
            l[mb.col] = lin(hx("#7a5f48")) + (1.0,)
            l.vert[mb.pat] = l.vert.co.z / F.h
    return mb.link()

def fringe(F, stops, rng, scale=1.0):
    """Grass hanging over the three front edges of the tile."""
    mb = MB("fringe", ["grass"])
    cs = hex_corners(scale)
    for i in (2, 3, 4):
        (x0, y0), (x1, y1) = cs[i], cs[(i + 1) % 6]
        out = Vector(((x0 + x1) / 2, (y0 + y1) / 2, 0)).normalized()
        n = 90
        for k in range(n):
            u = (k + rng.random()) / n
            p = Vector((x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, F.h - 0.004)) - out * 0.006
            base = ramp(stops, F.patch(p.x, p.y))
            ang = math.atan2(out.y, out.x) + rng.uniform(-0.6, 0.6)
            blade(mb, p, ang, rng.uniform(0.012, 0.022), rng.uniform(0.012, 0.022), 0.0032,
                  mul(base, 0.72), mul(base, 1.1), droop=rng.uniform(0.0, 0.01))
    return mb.link()

def grass_field(F, stops, rng, spacing, hgt, key="grass", density=None, per=5, tip=1.16, yellow=0.0):
    mb = MB(key, [key])
    for (x, y) in jitter_grid(spacing, rng, margin=0.004):
        if density and rng.random() > density(x, y):
            continue
        if rng.random() > 0.35 + 0.65 * smooth01(1.4 * F.patch(x, y) - 0.1):
            continue
        base = ramp(stops, F.patch(x, y))
        base = mul(base, rng.uniform(0.94, 1.05))
        z = F.z(x, y) - 0.003
        hh = hgt * rng.uniform(0.6, 1.25)
        tipc = mix(mul(base, tip), hx("#e3d27a"), yellow * rng.random())
        for k in range(per):
            a = rng.uniform(0, math.tau)
            p = (x + 0.006 * math.cos(a), y + 0.006 * math.sin(a), z)
            blade(mb, p, a, hh * rng.uniform(0.15, 0.45), hh * rng.uniform(0.7, 1.0), 0.0032,
                  mul(base, 0.97), tipc)
    return mb.link()


def grass_clumps(F, stops, rng, count, hgt, key="grass", accept=None, blades=(16, 24), rad=0.03, tip=1.32, yellow=0.3, min_d=0.045):
    mb = MB(key, [key])
    pts = scatter(count, 0.03, min_d, rng, accept=accept, tries=60)
    for (x, y) in pts:
        base = ramp(stops, F.patch(x, y))
        tipc = mix(mul(base, tip), hx("#e0d27c"), yellow * rng.random())
        hh = hgt * rng.uniform(0.7, 1.3)
        for k in range(rng.randint(*blades)):
            a = rng.uniform(0, math.tau)
            rr = rad * math.sqrt(rng.random())
            px, py = x + rr * math.cos(a), y + rr * math.sin(a)
            out = a + rng.uniform(-0.5, 0.5)
            h2 = hh * (1 - 0.5 * rr / rad) * rng.uniform(0.75, 1.1)
            blade(mb, (px, py, F.z(px, py) - 0.003), out, h2 * rng.uniform(0.3, 0.6), h2, 0.0062,
                  mul(base, 1.0), tipc, droop=h2 * 0.2)
    return mb.link()

# ------------------------------------------------------------------ props
def conifer(mb, x, y, z0, s, rng, pal, slot=0, tone=0):
    tr = mb["bark"]
    fs = cone(tr, x, y, z0 - 0.01, 0.018 * s, 0.013 * s, 0.07 * s, seg=6)
    tr.paint(fs, lambda co: hx("#5a4332"), smooth=False)
    base = pal[rng.randrange(len(pal))]
    fol = mb["conifer"]
    z = z0 + 0.035 * s
    tiers = rng.choice((3, 4, 4))
    for t in range(tiers):
        r = (0.125 - t * 0.024) * s
        d = (0.12 - t * 0.012) * s
        fs = cone(fol, x, y, z, r, r * 0.08, d, seg=9, rot=rng.random() * 6, jit=0.16, rng=rng, droop=0.012 * s)
        k0 = 0.62 + t * 0.1
        fol.paint(fs, lambda co, k0=k0, zz=z, dd=d: mul(base, k0 + 0.35 * max(0, (co.z - zz) / dd)), tone=tone, smooth=False)
        z += d * 0.52

def broadleaf(mb, x, y, z0, s, rng, pal, tone=0):
    base = pal[rng.randrange(len(pal))]
    fol = mb["foliage"]
    top = z0 + 0.15 * s
    lumps = [(0, 0, 0, 0.085)] + [(rng.uniform(-0.065, 0.065) * s, rng.uniform(-0.065, 0.065) * s, rng.uniform(-0.03, 0.06) * s, rng.uniform(0.045, 0.065)) for _ in range(rng.randint(4, 6))]
    for (dx, dy, dz, r) in lumps:
        fs = blob(fol, x + dx, y + dy, top + dz, r * s, rng, sub=2, sz=0.88, jit=0.28, freq=4.0)
        fol.paint(fs, lambda co: mul(base, 0.62 + 0.55 * smooth01((co.z - (top - 0.09 * s)) / (0.2 * s))), tone=tone)
    tr = mb["bark"]
    fs = cone(tr, x, y, z0 - 0.01, 0.02 * s, 0.014 * s, 0.13 * s, seg=6)
    tr.paint(fs, lambda co: hx("#5f4633"), smooth=False)

def rock(mb, x, y, z, r, rng, pal, flat=0.65, tone=0, moss=None):
    fs = blob(mb, x, y, z, r, rng, sub=1, sz=flat, jit=0.38, freq=2.2)
    base = pal[rng.randrange(len(pal))]
    def c(co):
        k = 0.78 + 0.35 * smooth01((co.z - z + r * flat) / (2 * r * flat))
        cc = mul(base, k)
        return mix(cc, moss, 0.55) if moss and co.z > z + r * flat * 0.45 else cc
    mb.paint(fs, c, tone=tone, smooth=False)

def bush(mb, x, y, z, s, rng, pal, tone=0):
    base = pal[rng.randrange(len(pal))]
    for k in range(rng.randint(2, 3)):
        dx, dy = rng.uniform(-0.025, 0.025) * s, rng.uniform(-0.025, 0.025) * s
        r = rng.uniform(0.03, 0.045) * s
        fs = blob(mb, x + dx, y + dy, z + r * 0.6, r, rng, sub=2, sz=0.8, jit=0.3, freq=4.5)
        mb.paint(fs, lambda co, zz=z: mul(base, 0.65 + 0.5 * smooth01((co.z - zz) / (0.08 * s))), tone=tone)

def flower(mb, x, y, z, rng, colors):
    ci = rng.randrange(len(colors))
    for k in range(rng.randint(3, 6)):
        dx, dy = rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02)
        fs = blob(mb, x + dx, y + dy, z + 0.02 + rng.uniform(0, 0.01), 0.011, rng, sub=1, sz=0.6, jit=0.1)
        mb.paint(fs, lambda co: colors[ci], tone=ci, smooth=True)

# ------------------------------------------------------------------ terrain builders
PAL = dict(
    grass=[hx("#557f45"), hx("#668f4b"), hx("#7c9b52")],
    plains=[hx("#96985a"), hx("#aca45f"), hx("#bfb068"), hx("#cdb974")],
    forest=[hx("#48683c"), hx("#547442"), hx("#62814a")],
    hills=[hx("#5f8444"), hx("#72904a"), hx("#879f55")],
    foliage=[hx("#557f3c"), hx("#5f8a3f"), hx("#6c9444"), hx("#7a9446")],
    conifer=[hx("#3a6444"), hx("#46704a"), hx("#3e6a50")],
    rock=[hx("#8f8a80"), hx("#9d978a"), hx("#85807a")],
    mrock=[hx("#5f5850"), hx("#7d7466"), hx("#9a8f7e")],
    flowers=[hx("#f4f1e6"), hx("#f0cf52"), hx("#d98ab0"), hx("#9bb4e8")],
    moss=hx("#7e9446"),
)

SITE_R = 0.64          # props are kept out of this radius on settlement tiles

def build(terrain, v, detail, river=0, site=False):
    """detail: 'A' (full) or 'C' (pixel: no blades, chunkier props). river: edge mask (0 = none)."""
    F = Field(terrain, v, detail)
    rng = F.rng
    EXCLUDE[0] = (lambda x, y: free_spot(F, x, y) and math.hypot(x, y) > SITE_R) if site else (lambda x, y: free_spot(F, x, y))
    A = detail == "A"
    scale = 1.02 if A else 1.0
    props = {k: MB(k, [k], smooth=(k == "foliage")) for k in ("foliage", "conifer", "bark", "rock", "flower", "bush")}
    objs = []

    if terrain == "water":
        F.stops = [hx("#2a6a7c"), hx("#2f7285"), hx("#357a8c")]
        F.height_fn = lambda x, y: 0.0035 * (F.n(x, y * 2.6, 9) + 0.5 * F.n(x, y * 3, 21))
        F.fade = 0.16
        objs.append(ground(F, ["water"], 24 if A else 8, scale=scale))
        objs.append(walls(F, scale))
        return F, objs

    if terrain == "grassland":
        F.stops = PAL["grass"]
        F.height_fn = lambda x, y: 0.02 * F.n(x, y, 3.2)
    elif terrain == "plains":
        F.stops = PAL["plains"]
        F.height_fn = lambda x, y: 0.012 * F.n(x, y, 2.8)
    elif terrain == "forest":
        F.stops = PAL["forest"]
        F.height_fn = lambda x, y: 0.03 * F.n(x, y, 3.0)
    elif terrain == "hills":
        F.stops = PAL["hills"]
        base = [(-0.3, 0.2, 0.3, 0.2), (0.33, 0.12, 0.25, 0.17), (0.0, -0.32, 0.22, 0.18)]
        if v == 2:
            base = [(-0.2, 0.3, 0.26, 0.19), (0.34, -0.05, 0.3, 0.2), (-0.3, -0.3, 0.2, 0.15)]
        if v == 3:
            base = [(0.0, 0.1, 0.34, 0.24), (-0.4, -0.2, 0.18, 0.14), (0.4, -0.3, 0.17, 0.13)]
        mounds = [(x + rng.uniform(-0.04, 0.04), y + rng.uniform(-0.04, 0.04), a, s) for x, y, a, s in base]
        F.hmounds = mounds
        F.height_fn = lambda x, y: 1.45 * sum(a * math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s)) for cx, cy, a, s in mounds) + 0.018 * F.n(x, y, 6)
        F.fade = 0.24
    elif terrain == "mountain":
        F.stops = PAL["hills"]
        peaks = {1: [(-0.06, 0.14, 1.0, 0.32), (0.38, -0.12, 0.62, 0.22), (-0.4, -0.28, 0.42, 0.18)],
                 2: [(0.08, 0.16, 0.95, 0.3), (-0.38, -0.08, 0.66, 0.22), (0.34, -0.34, 0.38, 0.16)],
                 3: [(0.0, 0.05, 1.08, 0.36), (0.42, 0.3, 0.45, 0.16), (-0.42, 0.28, 0.4, 0.16)]}[v]
        def mf(x, y):
            z = 0.0
            for cx, cy, a, s in peaks:
                d = math.hypot(x - cx, y - cy) / (s * 1.85)
                z = max(z, 1.12 * a * max(0.0, 1 - d) ** 1.2)
            r = 0.0
            amp, f = 1.0, 5.0
            for o in range(4):
                r += amp * (1 - abs(F.n(x, y, f, o * 7.0))) ** 2
                amp *= 0.5; f *= 2.1
            return z * (0.62 + 0.42 * r / 1.9) + 0.02 * F.n(x, y, 8)
        F.height_fn = mf
        F.fade = 0.2
    lip_stops = F.stops
    if site:
        F.flat_fn = lambda x, y: smooth01((math.hypot(x, y) - 0.45) / 0.3)
    if river:
        F.river = RiverNet(river, random.Random(f"river-{river}"))
        rd = F.river.dist
        F.carve_fn = lambda x, y: 0.046 * (1 - smooth01(rd(x, y) / (1.8 * RW)))
        span = 5.0 if terrain == "hills" else 3.0
        F.flat_fn = lambda x, y: smooth01((rd(x, y) - RW) / (span * RW))

    # ---- ground surface
    if terrain == "mountain":
        cuts = 30 if A else 22
        def role(f):
            c = f.calc_center_median()
            nz = f.normal.z
            snowline = F.h + 0.62 + 0.05 * F.n(c.x, c.y, 3)
            if c.z > snowline and nz > 0.2:
                return 2, 0
            if c.z > F.h + 0.12 or nz < 0.78:
                return 1, 0
            return 0, 0
        g = ground(F, ["ground", "mrock", "snow"], cuts, face_role=role, smooth=False, scale=scale)
        # rock and snow colours
        me = g.data
        col = me.attributes["col"].data
        for poly in me.polygons:
            if poly.material_index == 1:
                fk = rng.uniform(0.88, 1.1) * (1.06 if poly.normal.x < 0 else 0.97)
                for li in poly.loop_indices:
                    co = me.vertices[me.loops[li].vertex_index].co
                    band = 0.5 + 0.5 * math.sin(co.z * 30 + 2.5 * F.n(co.x, co.y, 3))
                    c = mix(PAL["mrock"][0], PAL["mrock"][2], band * 0.7 + 0.3 * (0.5 + 0.5 * F.n(co.x, co.y, 11)))
                    col[li].color = lin(mul(c, fk)) + (1.0,)
            elif poly.material_index == 2:
                for li in poly.loop_indices:
                    col[li].color = lin(hx("#eef1f4")) + (1.0,)
        objs.append(g)
    elif terrain == "hills":
        def role(f):
            c = f.calc_center_median()
            return (1, 0) if f.normal.z < (0.83 if A else 0.6) and c.z > F.h + (0.14 if A else 0.2) else (0, 0)
        objs.append(ground(F, ["ground", "grock"], (64 if river else 44) if A else 20, face_role=role, scale=scale))
    else:
        objs.append(ground(F, ["ground"], (64 if river else 44) if A else 16, scale=scale))
    objs.append(walls(F, scale))
    if river:
        objs.append(river_water(F, scale, 64 if A else 18))
        keep = EXCLUDE[0]
        EXCLUDE[0] = lambda x, y: lane_dist(x, y) >= LANE
        rd = F.river.dist
        for (x, y) in scatter(14, 0.02, 0.07, rng, accept=lambda x, y: 0.95 * RW < rd(x, y) < 1.35 * RW):
            rock(props["rock"], x, y, F.z(x, y), rng.uniform(0.01, 0.018), rng, PAL["rock"])
        if A and terrain != "forest":
            objs.append(grass_clumps(F, [hx("#4f7a3c"), hx("#5d8744")], rng, 26, 0.06, key="grass",
                                     accept=lambda x, y: 1.3 * RW < rd(x, y) < 2.1 * RW, blades=(12, 18), rad=0.02, yellow=0.15, min_d=0.05))
        EXCLUDE[0] = keep
    if A and FRINGE:
        objs.append(fringe(F, lip_stops, rng, scale))

    # ---- vegetation and props
    if terrain == "grassland":
        clear = []
        if A:
            objs.append(grass_clumps(F, PAL["grass"], rng, 90, 0.042))
        for (x, y) in scatter(rng.randint(2, 4), 0.14, 0.3, rng):
            bush(props["bush"], x, y, F.z(x, y), 1.0, rng, PAL["foliage"][:3])
            clear.append((x, y, 0.06))
        for (x, y) in scatter(rng.randint(2, 4), 0.12, 0.2, rng, avoid=clear):
            rock(props["rock"], x, y, F.z(x, y), rng.uniform(0.018, 0.03), rng, PAL["rock"], moss=PAL["moss"])
        for (x, y) in scatter(12 if A else 8, 0.08, 0.12, rng, avoid=clear):
            flower(props["flower"], x, y, F.z(x, y) + (0.018 if A else 0.0), rng, PAL["flowers"])
        if v == 3 and EXCLUDE[0](0.25, 0.2):
            x, y = 0.25, 0.2
            broadleaf(props, x, y, F.z(x, y), 1.15, rng, PAL["foliage"])
    elif terrain == "plains":
        if A:
            objs.append(grass_clumps(F, PAL["plains"], rng, 80, 0.062, key="wheat", blades=(18, 26), tip=1.35, yellow=0.85, min_d=0.05))
            objs.append(grass_clumps(F, [hx("#7f9650"), hx("#8c9d55")], rng, 30, 0.036, key="grass", yellow=0.2))
        for (x, y) in scatter(rng.randint(1, 3), 0.18, 0.4, rng):
            bush(props["bush"], x, y, F.z(x, y), 0.9, rng, [PAL["foliage"][3], PAL["foliage"][2]])
        for (x, y) in scatter(rng.randint(3, 5), 0.12, 0.2, rng):
            rock(props["rock"], x, y, F.z(x, y), rng.uniform(0.015, 0.025), rng, PAL["rock"])
        for (x, y) in scatter(5, 0.08, 0.14, rng):
            flower(props["flower"], x, y, F.z(x, y) + (0.03 if A else 0.0), rng, PAL["flowers"][:2])
    elif terrain == "forest":
        if A:
            objs.append(grass_clumps(F, PAL["forest"], rng, 45, 0.034, yellow=0.1))
        pts = scatter(38 if A else 26, 0.05, 0.13 if A else 0.16, rng)
        for i, (x, y) in enumerate(pts):
            s = rng.uniform(0.72, 1.12) * (0.85 if edge_dist(x, y) < 0.15 else 1.0)
            if rng.random() < (0.6 if v != 2 else 0.4):
                conifer(props, x, y, F.z(x, y), s, rng, PAL["conifer"], tone=rng.randrange(2))
            else:
                broadleaf(props, x, y, F.z(x, y), s, rng, PAL["foliage"], tone=rng.randrange(3))
        for (x, y) in scatter(8, 0.06, 0.06, rng, avoid=[(px, py, 0.05) for px, py in pts]):
            bush(props["bush"], x, y, F.z(x, y), 0.8, rng, PAL["foliage"][:2])
    elif terrain == "hills":
        if A:
            objs.append(grass_clumps(F, PAL["hills"], rng, 70, 0.038, accept=lambda x, y: F.raw(x, y) < 0.22 or rng.random() < 0.3))
        for (cx, cy, a, s) in F.hmounds:
            for k in range(rng.randint(2, 4)):
                x, y = cx + rng.uniform(-0.08, 0.08), cy + rng.uniform(-0.08, 0.08)
                if not EXCLUDE[0](x, y):
                    continue
                rock(props["rock"], x, y, F.z(x, y) - 0.004, rng.uniform(0.025, 0.05), rng, PAL["rock"], moss=PAL["moss"])
        for (x, y) in scatter(rng.randint(2, 3), 0.15, 0.25, rng, accept=lambda x, y: F.raw(x, y) < 0.08):
            bush(props["bush"], x, y, F.z(x, y), 0.9, rng, PAL["foliage"][:3])
    elif terrain == "mountain":
        if A:
            objs.append(grass_clumps(F, PAL["hills"], rng, 60, 0.032, accept=lambda x, y: F.raw(x, y) < 0.05))
        for (x, y) in scatter(16, 0.06, 0.07, rng, accept=lambda x, y: 0.02 < F.raw(x, y) < 0.16):
            rock(props["rock"], x, y, F.z(x, y), rng.uniform(0.016, 0.034), rng, PAL["mrock"])
        for (x, y) in scatter(rng.randint(2, 4), 0.06, 0.12, rng, accept=lambda x, y: F.raw(x, y) < 0.05):
            conifer(props, x, y, F.z(x, y), rng.uniform(0.55, 0.75), rng, PAL["conifer"])

    for k, mb in props.items():
        if len(mb.bm.faces):
            objs.append(mb.link())
        else:
            mb.bm.free()
    EXCLUDE[0] = None
    return F, objs

def river_water(F, scale, cuts):
    mb = MB("river", ["river"])
    b = mb.bm
    cs = hex_corners(scale)
    t = [b.verts.new((x, y, 0)) for x, y in cs]
    c = b.verts.new((0, 0, 0))
    for i in range(6):
        b.faces.new((c, t[i], t[(i + 1) % 6]))
    bmesh.ops.subdivide_edges(b, edges=b.edges[:], cuts=cuts, use_grid_fill=True)
    lim = 1.45 * RW
    dd = {}
    for v in b.verts:
        dd[v] = F.river.dist(v.co.x, v.co.y)
        v.co.z = F.h - 0.025 + 0.0015 * F.n(v.co.x, v.co.y, 25)
    kill = [f for f in b.faces if not all(dd[v] < lim for v in f.verts)]
    bmesh.ops.delete(b, geom=kill, context="FACES")
    for f in b.faces:
        f.smooth = True
        for l in f.loops:
            l[mb.col] = (dd[l.vert] / lim, 0.0, 0.0, 1.0)
    return mb.link()

def road_strip(F, pts, name, half=0.105, nv=10, lift=0.006):
    """Ribbon along pts, draped on the ground; col = (across -1..1 -> 0..1, along 0..1)."""
    mb = MB(name, ["road"])
    b = mb.bm
    n = len(pts) - 1
    rows = []
    for i, p in enumerate(pts):
        d = (pts[min(n, i + 1)] - pts[max(0, i - 1)]).normalized()
        nrm = Vector((-d.y, d.x))
        row = []
        for j in range(nv + 1):
            s_ = -1 + 2 * j / nv
            q = p + nrm * s_ * half
            z = F.z(q.x, q.y) + lift
            onb = 0.0
            if F.river:
                d = F.river.dist(q.x, q.y)
                z = max(z, F.h + 0.016 - max(0.0, d - 1.5 * RW) * 0.35)
                onb = 1 - smooth01((d - 1.35 * RW) / (0.3 * RW))
            row.append((b.verts.new((q.x, q.y, z)), s_, i / n, onb))
        rows.append(row)
    for i in range(n):
        for j in range(nv):
            f = b.faces.new((rows[i][j][0], rows[i][j + 1][0], rows[i + 1][j + 1][0], rows[i + 1][j][0]))
            f.smooth = True
    info = {vv: (s_, t_, ob_) for row in rows for (vv, s_, t_, ob_) in row}
    for f in b.faces:
        for l in f.loops:
            s_, t_, ob_ = info[l.vert]
            l[mb.col] = (0.5 + 0.5 * s_, t_, ob_, 1.0)
    return mb.link()

def box(mb, center, direction, size, color, rng=None):
    d = Vector((direction.x, direction.y, 0)).normalized()
    rot = Matrix(((d.x, -d.y, 0, 0), (d.y, d.x, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
    S = Matrix.Diagonal((size[0], size[1], size[2], 1))
    M = Matrix.Translation(center) @ rot @ S
    before = set(mb.bm.faces)
    bmesh.ops.create_cube(mb.bm, size=1.0, matrix=M)
    mb.paint(mb.new_faces_since(before), lambda co: color, smooth=False)

def bridge(F, pts, name):
    """Plank bridge wherever the road path crosses the river channel."""
    if not F.river:
        return None
    ds = [F.river.dist(p.x, p.y) for p in pts]
    on = [d < 1.75 * RW for d in ds]
    if not any(on):
        return None
    mb = MB(name, ["wood"])
    rng = random.Random(name)
    z = F.h + 0.016
    runs, cur = [], []
    for i, o in enumerate(on):
        if o:
            cur.append(i)
        elif cur:
            runs.append(cur); cur = []
    if cur:
        runs.append(cur)
    woods = [hx("#8a6a48"), hx("#7a5c3e"), hx("#94744f")]
    for run in runs:
        a, b_ = pts[max(0, run[0] - 1)], pts[min(len(pts) - 1, run[-1] + 1)]
        seg = b_ - a
        L = seg.length
        d = seg.normalized()
        nrm = Vector((-d.y, d.x))
        n = max(3, int(L / 0.016))
        for i in range(n + 1):
            p = a + seg * (i / n)
            box(mb, Vector((p.x, p.y, z - 0.004)), d, (0.012, 0.15 + rng.uniform(-0.01, 0.01), 0.008), mul(woods[rng.randrange(3)], rng.uniform(0.92, 1.06)))
        for side in (-1, 1):
            off = nrm * side * 0.074
            posts = [a + seg * t for t in (0.0, 0.5, 1.0)]
            for p in posts:
                box(mb, Vector((p.x + off.x, p.y + off.y, z + 0.012)), d, (0.01, 0.01, 0.034), hx("#5e4632"))
            mid = a + seg * 0.5
            box(mb, Vector((mid.x + off.x, mid.y + off.y, z + 0.026)), d, (L + 0.01, 0.008, 0.007), hx("#6b5038"))
    return mb.link()

def road_arm(F, k):
    m = edge_mid(k)
    pts = []
    n = 48
    nrm = Vector((-m.y, m.x)).normalized()
    wob = 0.025 * (1 if (k * 5 + 1) % 3 else -1)
    for i in range(n + 1):
        t = i / n
        p = m * t + nrm * wob * math.sin(2 * math.pi * t) * math.sin(math.pi * t)
        pts.append(p)
    return road_strip(F, pts, f"road{k}"), bridge(F, pts, f"bridge{k}")

def road_center(F):
    mb = MB("roadc", ["road"])
    b = mb.bm
    res = bmesh.ops.create_circle(b, cap_ends=True, segments=32, radius=0.11)
    bmesh.ops.subdivide_edges(b, edges=b.edges[:], cuts=3, use_grid_fill=True)
    onb = {}
    for v in b.verts:
        z = F.z(v.co.x, v.co.y) + 0.006
        o = 0.0
        if F.river:
            d = F.river.dist(v.co.x, v.co.y)
            z = max(z, F.h + 0.016 - max(0.0, d - 1.5 * RW) * 0.35)
            o = 1 - smooth01((d - 1.35 * RW) / (0.3 * RW))
        v.co.z = z
        onb[v] = o
    for f in b.faces:
        f.smooth = True
        for l in f.loops:
            r = math.hypot(l.vert.co.x, l.vert.co.y) / 0.11
            l[mb.col] = (0.5 + 0.5 * r, 0.5, onb[l.vert], 1.0)
    return mb.link()

# ------------------------------------------------------------------ scene
def reset_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)

def camera(ppu):
    sc = bpy.context.scene
    cd = bpy.data.cameras.new("cam")
    cd.type = "ORTHO"
    cd.ortho_scale = TOP_U + BOT_U
    cd.shift_y = ((TOP_U - BOT_U) / 2) / cd.ortho_scale
    cd.clip_start, cd.clip_end = 1, 60
    cam = bpy.data.objects.new("cam", cd)
    a = math.pi / 2 - ELEV
    cam.rotation_euler = (a, 0, 0)
    cam.location = -Vector((0, math.sin(a), -math.cos(a))) * 20
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.resolution_x = int(round(W_U * ppu))
    sc.render.resolution_y = int(round((TOP_U + BOT_U) * ppu))
    sc.render.resolution_percentage = 100
    return cam

def sun(energy, angle_deg, color=(1, 1, 1), direction=(0.85, -0.5, -1.15)):
    ld = bpy.data.lights.new("sun", "SUN")
    ld.energy = energy
    ld.angle = math.radians(angle_deg)
    ld.color = color
    ob = bpy.data.objects.new("sun", ld)
    ob.rotation_euler = Vector(direction).normalized().to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(ob)
    return ob

# ------------------------------------------------------------------ image io
import numpy as np

def load_px(path):
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1].copy()

def save_px(arr, path, depth="8"):
    h, w = arr.shape[:2]
    img = bpy.data.images.new("out", w, h, alpha=True, float_buffer=depth != "8")
    img.colorspace_settings.name = "Non-Color" if depth != "8" else "sRGB"
    img.pixels.foreach_set(np.ascontiguousarray(np.clip(arr, 0, 1)[::-1]).ravel().astype(np.float32))
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)

def downsample(arr, f):
    h, w = arr.shape[:2]
    pm = arr.copy()
    pm[..., :3] *= pm[..., 3:4]
    pm = pm.reshape(h // f, f, w // f, f, 4).mean(axis=(1, 3))
    a = pm[..., 3:4]
    pm[..., :3] = np.where(a > 1e-4, pm[..., :3] / np.maximum(a, 1e-4), 0)
    return pm

# Wylls characters — design prototype in the map art's own pipeline (style A, 2.5D diorama):
# Cycles, the same sun and world light, vertex-colour materials with AO, the map's camera
# elevation. One painted-miniature figure per unit; the same model makes the portrait bust.
#   blender -b --factory-startup --python units3d.py -- <job> [samples] [factions]
#   jobs: atlas (map sheets) | cards (unit portraits) | show | lineup | portraits | test
import bpy, bmesh, sys, os, math, random, json
from mathutils import Vector, Matrix, noise
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C
import render_a as RA
hx, lin, mix, mul = C.hx, C.lin, C.mix, C.mul

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
JOB = ARGV[0] if ARGV else "test"
if JOB == "portraits": pass
RA.SAMPLES = int(ARGV[1]) if len(ARGV) > 1 else 128
OUT = os.path.join(HERE, "..", "_out")

# ------------------------------------------------------------------ the six peoples (faction order of the UI)
# (2026-10-09: the nations' colours are the six leaders' clothes, permutation-server/web/frontier/palette.mjs. The sheets in the
# client were repainted from the old colours by docs/frontier/art/_src/recolour_nations.mjs; a fresh render takes these.)
FILL = ["#cc303b", "#31bedb", "#eac21b", "#a34cd8", "#edeee7", "#f19232"]
DARK = ["#81242c", "#237489", "#8c721c", "#69338c", "#5f6a68", "#9c581f"]
PEOPLE = [
    dict(key="aster", skin=["#e7c2a2", "#d6a684", "#bf8f72"], hair=["#2a2420", "#4d4540", "#a39d96"], eye="#4c5c66", steel="#a9afb4"),
    dict(key="borealis", skin=["#c48b62", "#a8704a", "#87583a"], hair=["#1e1a18", "#c9a66c", "#6a4a30"], eye="#2f4f5a", steel="#8a6036"),
    dict(key="cinder", skin=["#e6b791", "#cf966e", "#ad7050"], hair=["#8f3016", "#b9481c", "#3a1a10"], eye="#7a4c16", steel="#c08a38"),
    dict(key="dunmar", skin=["#c7a077", "#ab855a", "#866444"], hair=["#4a3420", "#6c4c2c", "#2e2418"], eye="#3e5c30", steel="#8a6436"),
    dict(key="ember", skin=["#efcfb2", "#d9b08f", "#986848"], hair=["#26262c", "#6a5038", "#d9c18c"], eye="#2e2216", steel="#c9a24a"),
    dict(key="fjordal", skin=["#f1d4c1", "#e6bfa6", "#d8ae94"], hair=["#e2d2aa", "#c8a870", "#efe8d6"], eye="#4e7ea6", steel="#6f7479"),
]
LEATHER, LEATHER_D, WOOD, WOOD_D = hx("#6b4a2e"), hx("#3e2a1a"), hx("#8a6440"), hx("#5a3e26")
STEEL, BRASS, GOLD = hx("#a9afb4"), hx("#c9a24a"), hx("#e0b84e")
TROUSER = hx("#4a3f36")

# ------------------------------------------------------------------ materials
def materials():
    t = RA.NT("skin")
    col = t.vmul(t.vmul(t.vcol(), t.math("MULTIPLY_ADD", t.noise(260.0), 0.05, 0.975)), t.ao_k(0.02, 0.55))
    m = t.finish(col, rough=0.52, spec=0.32, sss=0.12)
    m.node_tree.nodes["Principled BSDF"].inputs["Subsurface Radius"].default_value = (0.004, 0.002, 0.0015)
    RA._M["skin"] = m
    t = RA.NT("fabric")
    weave = t.math("MULTIPLY_ADD", t.noise(420.0, detail=2.0), 0.08, 0.96)
    col = t.vmul(t.vmul(t.vmul(t.vcol(), weave), t.math("MULTIPLY_ADD", t.noise(40.0), 0.1, 0.95)), t.ao_k(0.03, 0.45))
    t.bump(t.noise(380.0, detail=2.0), 0.12, 0.002)
    RA._M["fabric"] = t.finish(col, rough=0.88, spec=0.18)
    t = RA.NT("leather")
    col = t.vmul(t.vmul(t.vcol(), t.math("MULTIPLY_ADD", t.noise(120.0), 0.14, 0.93)), t.ao_k(0.03, 0.45))
    t.bump(t.noise(200.0), 0.2, 0.002)
    RA._M["leather"] = t.finish(col, rough=0.55, spec=0.35)
    t = RA.NT("metal")
    col = t.vmul(t.vmul(t.vcol(), t.math("MULTIPLY_ADD", t.noise(90.0, detail=5.0), 0.12, 0.94)), t.ao_k(0.03, 0.5))
    t.bump(t.noise(160.0, detail=4.0), 0.08, 0.002)
    m = t.finish(col, rough=0.48, spec=0.4)
    m.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.7
    RA._M["metal"] = m
    t = RA.NT("mail")
    vor = t.node("ShaderNodeTexVoronoi"); vor.inputs["Scale"].default_value = 900.0
    t.L.new(t.coord(), vor.inputs["Vector"])
    ring = t.math("MULTIPLY_ADD", vor.outputs["Distance"], 0.9, 0.55)
    col = t.vmul(t.vmul(t.vcol(), ring), t.ao_k(0.03, 0.4))
    t.bump(vor.outputs["Distance"], 0.5, 0.002)
    m = t.finish(col, rough=0.38, spec=0.5)
    m.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.8
    RA._M["mail"] = m
    t = RA.NT("hair")   # sculpted hair: grooves running down the head (wave bands across x and y, distorted)
    wv = t.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="X")
    wv.inputs["Scale"].default_value = 60.0; wv.inputs["Distortion"].default_value = 1.6; wv.inputs["Detail"].default_value = 2.0; wv.inputs["Detail Scale"].default_value = 1.5
    t.L.new(t.coord(), wv.inputs["Vector"])
    wv2 = t.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Y")
    wv2.inputs["Scale"].default_value = 55.0; wv2.inputs["Distortion"].default_value = 1.6; wv2.inputs["Detail"].default_value = 2.0
    t.L.new(t.coord(), wv2.inputs["Vector"])
    g = t.math("MULTIPLY", t.math("ADD", wv.outputs["Fac"], wv2.outputs["Fac"]), 0.5)
    tone = t.math("MULTIPLY_ADD", g, 0.35, 0.8)
    col = t.vmul(t.vmul(t.vcol(), tone), t.ao_k(0.02, 0.4))
    t.bump(g, 0.6, 0.003)
    RA._M["hair"] = t.finish(col, rough=0.45, spec=0.4)
    t = RA.NT("eye")
    RA._M["eye"] = t.finish(t.vcol(), rough=0.06, spec=0.9)
    t = RA.NT("wood")
    mp = t.node("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (90.0, 90.0, 8.0)
    t.L.new(t.coord(), mp.inputs["Vector"])
    RA._M["wood"] = t.finish(t.vmul(t.vmul(t.vcol(), t.math("MULTIPLY_ADD", t.noise(1.0, mp.outputs["Vector"], 4.0), 0.3, 0.85)), t.ao_k(0.03, 0.5)), rough=0.75, spec=0.2)
    t = RA.NT("paint")   # painted leather / shields: a little gloss like a varnished miniature
    RA._M["paint"] = t.finish(t.vmul(t.vcol(), t.ao_k(0.03, 0.5)), rough=0.45, spec=0.35)
    t = RA.NT("base")
    col = t.vmul(t.vmul(t.vcol(), t.math("MULTIPLY_ADD", t.noise(70.0, detail=5.0), 0.3, 0.85)), t.ao_k(0.04, 0.5))
    t.bump(t.noise(120.0, detail=5.0), 0.4, 0.004)
    RA._M["base"] = t.finish(col, rough=0.9, spec=0.15)

# ------------------------------------------------------------------ geometry
ROOT = None
OBJS = []
class Part:
    def __init__(self, role, sub=0):
        self.mb = C.MB(f"p{len(OBJS)}_{role}", [role], smooth=True)
        self.sub = sub
        OBJS.append(self)
    def link(self):
        if not len(self.mb.bm.faces):
            self.mb.bm.free(); return None
        ob = self.mb.link()
        if self.sub:
            m = ob.modifiers.new("s", "SUBSURF"); m.levels = m.render_levels = self.sub
        ob.parent = ROOT
        return ob

def _since(mb, before): return [f for f in mb.bm.faces if f not in before]
def solid(fn):
    """Colour helper: a constant or a function of the vertex position."""
    return fn if callable(fn) else (lambda co, c=fn: c)

def sphere(P, c, r, col, scale=(1, 1, 1), sub=3, deform=None):
    mb = P.mb; before = set(mb.bm.faces)
    res = bmesh.ops.create_icosphere(mb.bm, subdivisions=sub, radius=r)
    for v in res["verts"]:
        p = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2]))
        if deform: p = deform(p)
        v.co = p + Vector(c)
    fs = _since(mb, before); mb.paint(fs, solid(col)); return fs

def tube(P, p0, p1, r0, r1, col, seg=12, caps=True):
    mb = P.mb; p0, p1 = Vector(p0), Vector(p1); d = p1 - p0
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    M = Matrix.Translation((p0 + p1) / 2) @ q.to_matrix().to_4x4()
    before = set(mb.bm.faces)
    bmesh.ops.create_cone(mb.bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r0, radius2=r1, depth=d.length, matrix=M)
    fs = _since(mb, before); mb.paint(fs, solid(col)); return fs

def block(P, c, size, col, rot=None):
    mb = P.mb
    M = Matrix.Translation(Vector(c)) @ (rot.to_4x4() if rot is not None else Matrix.Identity(4)) @ Matrix.Diagonal((size[0], size[1], size[2], 1))
    before = set(mb.bm.faces)
    bmesh.ops.create_cube(mb.bm, size=1.0, matrix=M)
    fs = _since(mb, before); mb.paint(fs, solid(col)); return fs

def shell(P, c, r, col, keep, scale=(1, 1, 1), sub=4, push=None):
    """A sphere shell around (c), keeping faces whose centre satisfies keep(p) (p relative to c)."""
    mb = P.mb; before = set(mb.bm.faces)
    res = bmesh.ops.create_icosphere(mb.bm, subdivisions=sub, radius=r)
    for v in res["verts"]:
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2]))
        if push: v.co = push(v.co)
    fs = _since(mb, before)
    gone = [f for f in fs if not keep(f.calc_center_median())]
    bmesh.ops.delete(mb.bm, geom=gone, context="FACES")
    fs = _since(mb, before)
    for f in fs:
        for v in f.verts: pass
    vs = {v for f in fs for v in f.verts}
    for v in vs: v.co += Vector(c)
    mb.paint(fs, solid(col)); return fs

def rbox(P, c, size, col, radius=0.03, rot=None):
    """A box with rounded edges (bevelled, no shrink)."""
    mb = P.mb
    M = Matrix.Translation(Vector(c)) @ (rot.to_4x4() if rot is not None else Matrix.Identity(4)) @ Matrix.Diagonal((size[0], size[1], size[2], 1))
    before = set(mb.bm.faces)
    res = bmesh.ops.create_cube(mb.bm, size=1.0, matrix=M)
    bmesh.ops.bevel(mb.bm, geom=list({e for v in res["verts"] for e in v.link_edges}) + res["verts"], offset=radius, segments=4, profile=0.5, affect="EDGES")
    fs = _since(mb, before); mb.paint(fs, solid(col)); return fs

def dome(P, c, r, col, zcut, scale=(1, 1, 1), push=None, keep=None):
    """A sphere cut cleanly by the plane z = zcut (head-local), the part above kept."""
    mb = P.mb; before = set(mb.bm.faces)
    res = bmesh.ops.create_uvsphere(mb.bm, u_segments=48, v_segments=28, radius=r)
    for v in res["verts"]:
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2]))
        if push: v.co = push(v.co)
    geom = list(set(mb.bm.verts) - {v for f in before for v in f.verts}) 
    fs = _since(mb, before)
    g = list({v for f in fs for v in f.verts}) + list({e for f in fs for e in f.edges}) + fs
    bmesh.ops.bisect_plane(mb.bm, geom=g, plane_co=(0, 0, zcut), plane_no=(0, 0, 1), clear_inner=True)
    fs = _since(mb, before)
    if keep:
        gone = [f for f in fs if not keep(f.calc_center_median())]
        bmesh.ops.delete(mb.bm, geom=gone, context="FACES"); fs = _since(mb, before)
    for v in {v for f in fs for v in f.verts}: v.co += Vector(c)
    mb.paint(fs, solid(col)); return fs

def solidify(ob, t):
    if ob is None: return
    m = ob.modifiers.new("t", "SOLIDIFY"); m.thickness = t; m.offset = 1.0
    # keep the subsurf after the shell gets its thickness
    if "s" in ob.modifiers: ob.modifiers.move(len(ob.modifiers) - 1, 0)

# ------------------------------------------------------------------ the head
HEAD = Vector((0, 0, 0.81))
HR = 0.1
EYE = [Vector((d * 0.033, -0.087, 0.009)) for d in (-1, 1)]

def head_deform(sex, jaw):
    def f(p):
        p = Vector((p.x * 0.92, p.y * 0.95, p.z * 1.02))
        if p.z < -0.005:
            t = min(1.0, (-p.z - 0.005) / 0.1)
            p.x *= 1 - (0.24 if sex == "f" else 0.15 - (0.05 if jaw == "square" else 0)) * t
            p.y *= 1 - 0.1 * t
        if p.y > 0 and p.z > -0.02: p.y *= 1.06                     # the back of the skull
        if p.y < 0: p.y *= 1.04                                       # the face comes forward of the skull
        for e in EYE:                                                 # eye sockets
            d = (p - e).length
            if d < 0.036: p.y += 0.011 * (1 - d / 0.036) ** 2
        if 0.02 < p.z < 0.046 and p.y < -0.05 and abs(p.x) < 0.065: p.y -= 0.008 * math.sin((p.z - 0.02) / 0.026 * math.pi)  # brow ridge
        if abs(p.x) > 0.04 and -0.034 < p.z < -0.002 and p.y < -0.03: p.y -= 0.006 * math.sin((p.z + 0.034) / 0.032 * math.pi)  # cheekbones
        if p.z < -0.06 and abs(p.x) < 0.035 and p.y < -0.03: p.y -= 0.01 * (1 - abs(p.x) / 0.035)                              # the chin
        if -0.06 < p.z < -0.02 and abs(p.x) > 0.05 and p.y < -0.02: p.y += 0.004                                                # under the cheekbones
        if 0.04 < p.z and p.y < -0.04: p.y += (p.z - 0.04) * 0.25                                                              # the forehead slopes back
        return p
    return f

def face_paint(spec, skin, f):
    """Skin colour with the cheeks' warmth, the lips' area and the faction's mark (head-local position)."""
    blush = hx("#d07a6a")
    def col(co):
        p = co - HEAD
        c = skin
        for d in (-1, 1):
            k = max(0.0, 1 - (Vector((p.x - d * 0.052, p.y + 0.07, p.z + 0.012))).length / 0.035)
            c = mix(c, blush, k * (0.4 if f == 5 else 0.2))
        k = max(0.0, 1 - (Vector((p.x, p.y + 0.1, p.z + 0.02))).length / 0.03); c = mix(c, hx("#d98a7a"), k * 0.25)      # the nose tip
        for e in EYE:
            k = max(0.0, 1 - (p - e - Vector((0, 0, 0.004))).length / 0.03); c = mul(c, 1 - 0.12 * k)                   # the eye socket's shade
        if p.z < -0.065 and spec.get("stubble"): c = mix(c, mul(spec["_hair"], 0.8), 0.28)
        if spec.get("beard", "none") in ("short", "full", "braided"):
            top = -0.028 - 0.022 * max(0.0, 1 - abs(p.x) / 0.06)
            if p.z < top + 0.016 and p.y < 0.02: c = mix(c, mul(spec["_hair"], 0.85), 0.45 * max(0.0, min(1.0, (top + 0.016 - p.z) / 0.016)))
        # faction marks
        if f == 0 and not spec.get("_helm") and abs(p.x) < 0.018 - (0.054 - p.z) * 0.12 and 0.036 < p.z < 0.062 and p.y < 0: c = hx("#a8382a")
        if f == 1 and p.x > 0.03 and p.y < -0.03:
            for k in (0, 1):
                zz = -0.022 - k * 0.012 + 0.004 * math.sin((p.x - 0.03) * 380)
                if abs(p.z - zz) < 0.0022 and p.x < 0.075: c = hx("#1c4f58")
        if f == 2 and -0.003 < p.z < 0.026 and p.y < 0.01: c = mix(c, hx("#1c1410"), 0.86)
        if f == 2 and p.z < -0.085 and abs(p.x) < 0.007 and p.y < -0.05: c = hx("#ff7a2a")
        if f == 3:
            for x in (-0.012, -0.004, 0.004, 0.012):
                if (Vector((p.x - x, 0, p.z - 0.004))).length < 0.0035 and p.y < -0.06: c = hx("#3e6a2a")
            for d in (-1, 1):
                if (Vector((p.x - d * 0.052, 0, p.z + 0.018))).length < 0.008 and p.y < -0.03: c = hx("#4f7a32")
        if f == 4 and p.x > 0.055 and 0.008 < p.z < 0.036 and p.y < 0.0:
            q = Vector((p.x - 0.07, 0, p.z - 0.022))
            a = math.atan2(q.z, q.x); r = q.length
            if r < 0.006 + 0.007 * abs(math.cos(2 * a)) ** 6: c = hx("#24497b")
        if f == 5:
            for d in (-1, 1):
                for x in (0.03, 0.044):
                    if abs(p.x - d * x) < 0.0032 and -0.04 < p.z < -0.004 and p.y < -0.05: c = hx("#3a4048")
        return c
    return col

def head(spec, f):
    pp = PEOPLE[f]
    skin = hx(pp["skin"][spec.get("skin", 1)]); hair = hx(pp["hair"][spec.get("hairIdx", 0)])
    spec["_hair"] = hair
    sex, age = spec.get("sex", "m"), spec.get("age", 1)
    H = Part("skin", sub=1)
    sphere(H, HEAD, HR, face_paint(spec, skin, f), sub=4, deform=head_deform(sex, spec.get("jaw", "oval")))
    # nose, ears, lips
    nk = 0.85 if sex == "f" else 1.0
    sphere(H, HEAD + Vector((0, -0.089, -0.004)), 0.015 * nk, skin, scale=(0.75, 0.8, 1.4), sub=3)
    sphere(H, HEAD + Vector((0, -0.097, -0.019)), 0.0115 * nk, mix(skin, hx("#d08a76"), 0.15), scale=(1.2, 0.85, 0.85), sub=3)
    for d in (-1, 1): sphere(H, HEAD + Vector((d * 0.0105 * nk, -0.092, -0.022)), 0.0075 * nk, skin, scale=(1.0, 0.8, 0.75), sub=2)
    for d in (-1, 1):
        sphere(H, HEAD + Vector((d * 0.089, 0.006, -0.002)), 0.024, mul(skin, 0.95), scale=(0.42, 0.78, 1.2), sub=3)
    lip = mix(skin, hx("#a8473c"), 0.35 if sex == "f" else 0.22)
    if spec.get("beard", "none") not in ("full", "braided"):
        for d in (-1, 1): sphere(H, HEAD + Vector((d * 0.0068, -0.0912, -0.0405)), 0.0118, mul(lip, 0.86), scale=(1.15, 0.42, 0.36), sub=3)
        sphere(H, HEAD + Vector((0, -0.0895, -0.0488)), 0.0128, mix(lip, hx("#ffffff"), 0.06), scale=(1.2, 0.48, 0.4 if sex == "m" else 0.48), sub=3)
    H.link()
    if spec.get("beard", "none") not in ("full", "braided"):
        Ml = Part("eye"); tube(Ml, HEAD + Vector((-0.0165, -0.0915, -0.0448)), HEAD + Vector((0.0165, -0.0915, -0.0448)), 0.0014, 0.0014, mul(lip, 0.4), seg=6); Ml.link()
    # eyes: the white, the iris and a lid line; the gloss gives the catchlight
    E = Part("eye")
    for e in EYE:
        c = HEAD + Vector((e.x, e.y - 0.002, e.z))
        sphere(E, c + Vector((0, 0.002, 0)), 0.0155 if sex == "f" else 0.0145, hx("#e9ddcf"), scale=(1.15, 0.5, 0.72), sub=3)
        sphere(E, c + Vector((0, -0.006, 0.0002)), 0.0092, hx(pp["eye"]), scale=(1, 0.5, 1), sub=3)
        sphere(E, c + Vector((0, -0.0092, 0.0002)), 0.0046, hx("#0d0a08"), scale=(1, 0.4, 1), sub=2)
    E.link()
    L = Part("skin")
    for e in EYE:   # upper lids (skin shells over the eye) and the lash line
        c = HEAD + Vector((e.x, e.y - 0.001, e.z + 0.003))
        sphere(L, c + Vector((0, 0.0, 0.0015)), 0.0158, mul(skin, 0.84), scale=(1.18, 0.6, 0.5), sub=3)
        sphere(L, c + Vector((0, 0.001, -0.009)), 0.0145, mul(skin, 0.92), scale=(1.12, 0.55, 0.28), sub=3)
    L.link()
    LS = Part("hair")
    for d, e in zip((-1, 1), EYE):
        c = HEAD + Vector((e.x, e.y - 0.0085, e.z + 0.0028))
        tube(LS, c + Vector((-0.0155, 0.004, -0.002)), c + Vector((0.0155, 0.004, -0.002)), 0.0016 if sex == "m" else 0.0024, 0.0016 if sex == "m" else 0.0024, hx("#1a120c"), seg=6)
        # brows
        bz = 0.033 if f not in (0, 5) else 0.030
        p0 = HEAD + Vector((d * 0.014, -0.093, bz - (0.004 if f in (0, 5) else 0)))
        p1 = HEAD + Vector((d * 0.056, -0.072, bz + (0.002 if f in (2, 4) else 0)))
        tube(LS, p0, p1, 0.0055 if sex == "m" else 0.0035, 0.0035 if sex == "m" else 0.002, mul(hair, 0.8), seg=6)
    LS.link()
    if age >= 2:   # the years: a heavier lid and cheek lines are left to the paint; grey streaks in the brows
        pass
    hair_and_beard(spec, f, hair, sex)

def hairline_keep(style):
    def keep(p):
        front = max(0.0, min(1.0, -p.y / 0.095))
        side = abs(p.x) / 0.1
        if style == "crop": thr = -0.01 + 0.052 * front ** 1.4
        elif style == "topknot": thr = 0.0 + 0.05 * front ** 1.4
        elif style in ("long", "braids"): thr = -0.06 + 0.10 * front ** 1.2 if front > 0.35 else -0.2
        elif style == "bob": thr = (-0.07 + 0.11 * front ** 1.3) if front > 0.3 else -0.075
        elif style == "swept": thr = -0.012 + 0.046 * front ** 1.3 - 0.012 * max(0, p.x / 0.1)
        elif style == "receding": thr = -0.01 + 0.075 * front ** 0.8
        else: thr = -0.01 + 0.05 * front
        if style in ("long", "braids", "bob") and front > 0.35:
            # parted: a centre parting and the hair down past the temples
            if side > 0.62: thr = -0.07 if style != "bob" else -0.075
        if style == "receding" and p.z > 0.075 and front < 0.85: return abs(p.x) > 0.06
        return p.z > thr
    return keep

def hair_and_beard(spec, f, hair, sex):
    style = spec.get("hair", "crop")
    helm = spec.get("_helm")
    hood = spec.get("_hood")
    if style != "bald" and not (helm and style not in ("long", "braids")) and not hood:
        Hh = Part("hair", sub=1)
        R = random.Random(spec.get("seed", 1))
        push = lambda v: v * (1 + 0.04 * noise.noise(v * 60 + Vector((R.random(),) * 3)))
        shell(Hh, HEAD + Vector((0, 0.004, 0.006)), 0.108, hair, hairline_keep(style), scale=(0.94, 1.0, 1.08), push=push, sub=5)
        if style == "topknot":
            sphere(Hh, HEAD + Vector((0, 0.01, 0.118)), 0.03, hair, scale=(0.8, 0.8, 1.6), sub=2, deform=lambda p: Vector((p.x * (1 - max(0, p.z) * 6), p.y, p.z)))
            tube(Hh, HEAD + Vector((0, 0.01, 0.105)), HEAD + Vector((0, 0.01, 0.115)), 0.016, 0.016, GOLD, seg=10)
        if style == "long":
            sphere(Hh, HEAD + Vector((0, 0.035, -0.09)), 0.085, hair, scale=(1.05, 0.45, 1.5), sub=3)
        if style == "bob":
            pass
        ob = Hh.link(); solidify(ob, 0.006)
        if False:
            Lk = Part("hair", sub=1)
            keep = hairline_keep(style)
            Rl = random.Random(spec.get("seed", 1) * 31)
            n = 0
            for i in range(900):
                if n >= 110: break
                u, v = Rl.uniform(-1, 1), Rl.uniform(0, math.tau)
                nrm = Vector((math.sqrt(1 - u * u) * math.cos(v), math.sqrt(1 - u * u) * math.sin(v), u))
                p = Vector((nrm.x * 0.108 * 0.94, nrm.y * 0.108, nrm.z * 0.108 * 1.08))
                if not keep(p) or p.z < -0.02 and style in ("crop", "topknot", "swept"): continue
                flow = Vector((0, 0.35, -1)) if nrm.z < 0.75 else Vector((math.copysign(0.7, nrm.x + 1e-3), -0.35, -0.25))
                if style == "swept" and nrm.y < -0.3: flow = Vector((1.0, 0.0, -0.4))
                if style in ("long", "braids", "bob") and nrm.y < -0.2: flow = Vector((math.copysign(1.0, nrm.x + 1e-3), 0.1, -0.6))
                d = (flow - nrm * nrm.dot(flow)).normalized()
                L = Rl.uniform(0.03, 0.05) * (1.5 if style in ("long", "bob") else 1.0)
                # the lock follows the skull: points along the great circle from nrm toward d
                pts = []
                for k in range(4):
                    t = L / 0.11 * k / 3
                    w = nrm * math.cos(t) + d * math.sin(t)
                    pts.append(HEAD + Vector((0, 0.004, 0.006)) + Vector((w.x * 0.94, w.y, w.z * 1.08)) * (0.1115 - k * 0.0005))
                c = mix(hair, (1, 1, 1), Rl.uniform(0, 0.1)) if Rl.random() > 0.3 else mul(hair, 0.85)
                r0 = Rl.uniform(0.007, 0.01)
                for k in range(3):
                    tube(Lk, pts[k], pts[k + 1], r0 * (1 - k / 3.2), r0 * (1 - (k + 1) / 3.2), c, seg=6)
                n += 1
            Lk.link()
        if style == "braids":
            B = Part("hair", sub=1)
            for d in (-1, 1):
                for i in range(7):
                    sphere(B, HEAD + Vector((d * (0.088 + i * 0.002), -0.01 + i * 0.004, -0.03 - i * 0.026)), 0.017 - i * 0.0007, hair, scale=(1, 1, 1.25), sub=2)
                if f == 1:
                    sphere(B, HEAD + Vector((d * 0.104, 0.018, -0.215)), 0.008, hx("#e8dcc2"), sub=2)
            B.link()
    if style == "bald" or (style == "receding" and not helm):
        pass
    b = spec.get("beard", "none")
    if b != "none":
        R = random.Random(spec.get("seed", 1) + 7)
        Bd = Part("hair", sub=1)
        def keep_beard(p):
            if p.y > 0.02: return False
            if b == "moustache": return False
            lo = -0.2
            mouth = abs(p.x) < 0.024 and -0.062 < p.z < -0.036 and p.y < -0.06
            if b == "short" and mouth: return False
            top = -0.028 - 0.022 * max(0.0, 1 - abs(p.x) / 0.06)
            return lo < p.z < top
        def push(v):
            v = v * (1 + 0.05 * noise.noise(v * 70 + Vector((R.random(),) * 3)))
            if b in ("full", "braided") and v.z < -0.06:
                k = (-0.06 - v.z)
                v = Vector((v.x * (1 - k * 2.2), v.y - k * 0.5, v.z - k * (1.6 if b == "full" else 2.4)))
            return v
        shell(Bd, HEAD + Vector((0, -0.002, -0.002)), 0.101, hair, keep_beard, scale=(0.9, 0.96, 1.06), push=push)
        # moustache
        for d in (-1, 1):
            sphere(Bd, HEAD + Vector((d * 0.014, -0.1, -0.036)), 0.013, hair, scale=(1.3, 0.55, 0.5), sub=2,
                   deform=lambda p, d=d: Vector((p.x, p.y, p.z - (p.x * d) * 0.25)))
        ob = Bd.link(); solidify(ob, 0.005)
        if b == "braided":
            Rg = Part("metal")
            for z in (0.64, 0.6):
                tube(Rg, Vector((0, -0.105, z)), Vector((0, -0.105, z + 0.016)), 0.016, 0.016, hx("#8c9196"), seg=12)
            Rg.link()

# ------------------------------------------------------------------ headgear
def headgear(spec, f):
    hg = spec.get("_gear")
    if hg == "none": return
    pp = PEOPLE[f]
    if hg == "hood":
        c = hx("#4b6a34") if f == 3 else mul(hx(FILL[f]), 0.72)
        Hd = Part("fabric", sub=1)
        def keep(p):
            if p.y < -0.04 and abs(p.x) < 0.078 and -0.1 < p.z < 0.068 - (abs(p.x) / 0.078) ** 2 * 0.02: return False
            return p.z > -0.12 or p.y > -0.02
        shell(Hd, HEAD + Vector((0, 0.01, 0.012)), 0.128, c, keep, scale=(0.95, 1.0, 1.06), sub=5,
              push=lambda v: Vector((v.x, v.y + (0.03 if v.z > 0.09 and v.y > 0 else 0), v.z + (0.02 if v.z > 0.09 and v.y > 0.03 else 0))))
        ob = Hd.link(); solidify(ob, 0.01)
        if f == 3:
            Lf = Part("fabric", sub=1)
            for i in range(15):
                a = math.pi * (0.1 + i / 14 * 0.8)
                p = HEAD + Vector((math.cos(a) * 0.085, -0.093, 0.012 + math.sin(a) * 0.08))
                sphere(Lf, p, 0.016, [hx("#6f9a46"), hx("#4f7a32"), hx("#88b25a")][i % 3], scale=(1, 0.35, 0.6), sub=2)
            Lf.link()
        return
    G = Part("metal", sub=1)
    steel = hx(pp["steel"])
    if f == 0:   # kettle helm, brim, nasal, the keystone painted on the front
        def paint(co):
            p = co - HEAD
            if abs(p.x) < 0.02 - (p.z - 0.06) * 0.25 and 0.06 < p.z < 0.1 and p.y < -0.05: return hx("#a8382a")
            return steel
        dome(G, HEAD + Vector((0, 0, 0.02)), 0.118, paint, 0.008, scale=(0.98, 1.0, 1.0))
        P2 = Part("metal")
        tube(P2, HEAD + Vector((0, 0, 0.026)), HEAD + Vector((0, 0, 0.034)), 0.172, 0.128, mul(steel, 0.92), seg=48)
        block(P2, HEAD + Vector((0, -0.113, -0.006)), (0.012, 0.01, 0.07), steel)
        for i in range(10):
            a = math.pi * 2 * i / 10
            sphere(P2, HEAD + Vector((math.cos(a) * 0.112, math.sin(a) * 0.112, 0.045)), 0.005, hx("#d8dde0"), sub=1)
        P2.link()
    elif f == 1:   # leather sea cap, a teal band, brass rim; a gull feather for riders
        L = Part("leather", sub=1)
        dome(L, HEAD + Vector((0, 0.003, 0.02)), 0.114, hx("#7a5634"), 0.012, scale=(0.98, 1.0, 0.92))
        tube(L, HEAD + Vector((0, 0.003, 0.03)), HEAD + Vector((0, 0.003, 0.05)), 0.113, 0.11, hx(FILL[1]), seg=32)
        L.link()
        tube(G, HEAD + Vector((0, 0.003, 0.026)), HEAD + Vector((0, 0.003, 0.031)), 0.116, 0.116, BRASS, seg=32)
        if spec.get("kind") in ("horseman", "knight"):
            Ft = Part("fabric", sub=1)
            sphere(Ft, HEAD + Vector((0.085, 0.03, 0.12)), 0.03, hx("#f4efe4"), scale=(0.25, 0.5, 2.2), sub=2, deform=lambda p: Vector((p.x, p.y + p.z * 0.3, p.z)))
            Ft.link()
    elif f == 2:   # bronze helm, cheek guards, a red horsehair crest
        dome(G, HEAD + Vector((0, 0, 0.012)), 0.118, steel, -0.004, scale=(0.98, 1.0, 1.02))
        for d in (-1, 1):
            block(G, HEAD + Vector((d * 0.09, -0.04, -0.03)), (0.016, 0.06, 0.075), steel, rot=Matrix.Rotation(d * 0.25, 3, "Z"))
        Cr = Part("hair", sub=1)
        for i in range(19):
            a = math.pi * (0.08 + i / 18 * 0.9)
            p = HEAD + Vector((0, -math.cos(a) * 0.12, 0.03 + math.sin(a) * 0.12))
            sphere(Cr, p, 0.03, hx("#b02a16") if i % 2 else hx("#c8381c"), scale=(0.35, 0.6, 1.3), sub=2,
                   deform=lambda q, a=a: Vector((q.x, q.y * math.cos(a) - q.z * math.sin(a) * 0.2, q.z)))
        Cr.link()
    elif f == 3:   # a circlet of twigs with antler tines over a leaf band
        W = Part("wood", sub=1)
        tube(W, HEAD + Vector((0, 0, 0.05)), HEAD + Vector((0, 0, 0.062)), 0.106, 0.104, hx("#6f4e2e"), seg=32)
        for d in (-1, 1):
            base = HEAD + Vector((d * 0.07, -0.04, 0.07))
            tip = base + Vector((d * 0.07, 0.02, 0.11))
            tube(W, base, tip, 0.008, 0.004, hx("#c8b090"), seg=8)
            tube(W, base + (tip - base) * 0.5, base + (tip - base) * 0.5 + Vector((d * 0.01, -0.02, 0.05)), 0.006, 0.003, hx("#c8b090"), seg=8)
        W.link()
        Lf = Part("fabric", sub=1)
        for i in range(14):
            a = math.pi * 2 * i / 14
            sphere(Lf, HEAD + Vector((math.cos(a) * 0.108, math.sin(a) * 0.108, 0.058)), 0.016, [hx("#6f9a46"), hx("#4f7a32"), hx("#88b25a")][i % 3], scale=(1, 0.5, 0.6), sub=2)
        Lf.link()
    elif f == 4:   # a surveyor's felt cap with a brass rim and the goggles pushed up
        Fe = Part("fabric", sub=1)
        dome(Fe, HEAD + Vector((0, 0.003, 0.024)), 0.114, mul(hx(FILL[4]), 0.85), 0.006, scale=(0.98, 1.0, 0.85))
        block(Fe, HEAD + Vector((0, -0.11, 0.03)), (0.11, 0.05, 0.008), mul(hx(FILL[4]), 0.6), rot=Matrix.Rotation(-0.25, 3, "X"))
        Fe.link()
        tube(G, HEAD + Vector((0, 0.003, 0.028)), HEAD + Vector((0, 0.003, 0.036)), 0.117, 0.117, BRASS, seg=32)
        Gl = Part("eye")
        for d in (-1, 1):
            c = HEAD + Vector((d * 0.034, -0.1, 0.07))
            tube(G, c + Vector((0, 0.012, 0)), c + Vector((0, -0.008, 0)), 0.02, 0.021, BRASS, seg=16)
            tube(Gl, c + Vector((0, -0.008, 0)), c + Vector((0, -0.0095, 0)), 0.016, 0.016, hx("#6aa6d8"), seg=16)
        Gl.link()
        S = Part("leather"); tube(S, HEAD + Vector((-0.112, 0.0, 0.065)), HEAD + Vector((0.112, 0.0, 0.065)), 0.005, 0.005, LEATHER_D, seg=6); S.link()
    elif f == 5:   # the spectacle helm and a mail aventail
        dome(G, HEAD + Vector((0, 0, 0.018)), 0.12, steel, 0.0, scale=(0.98, 1.0, 1.04))
        block(G, HEAD + Vector((0, 0, 0.095)), (0.012, 0.24, 0.04), mul(steel, 0.85))
        for e in EYE:
            c = HEAD + Vector((e.x, -0.104, e.z + 0.002))
            bm = G.mb.bm; before = set(bm.faces)
            M = Matrix.Translation(c) @ Matrix.Rotation(math.pi / 2, 4, "X")
            bmesh.ops.create_cone(bm, cap_ends=False, segments=20, radius1=0.026, radius2=0.022, depth=0.012, matrix=M)
            G.mb.paint(_since(G.mb, before), lambda co: steel)
        block(G, HEAD + Vector((0, -0.108, 0.0)), (0.014, 0.012, 0.05), steel)
        block(G, HEAD + Vector((0, -0.1, 0.032)), (0.13, 0.02, 0.016), steel)
        Ma = Part("mail", sub=1)
        shell(Ma, HEAD + Vector((0, 0.004, 0.0)), 0.124, hx("#6d7176"),
              lambda p: (-0.16 < p.z < 0.02) and not (p.y < -0.03 and abs(p.x) < 0.075 and p.z > -0.11), scale=(1.0, 1.0, 1.15),
              push=lambda v: Vector((v.x * (1 + max(0, -v.z) * 1.2), v.y * (1 + max(0, -v.z) * 0.8), v.z)))
        ob = Ma.link(); solidify(ob, 0.006)
    ob = G.link()
    if f in (0, 2, 5): solidify(ob, 0.008)
    if spec.get("kind") == "knight":   # a commander's plume
        Pl = Part("fabric", sub=1)
        for i in range(6):
            sphere(Pl, HEAD + Vector((0.01 * i, 0.03 + i * 0.022, 0.15 + i * 0.012 - i * i * 0.004)), 0.03 - i * 0.003, hx(FILL[f]) if i % 2 else mul(hx(FILL[f]), 0.8), scale=(0.5, 1.2, 0.6), sub=2)
        Pl.link()

# ------------------------------------------------------------------ body and kit
def torso(spec, f):
    cloth = hx(FILL[f]); dark = hx(DARK[f])
    kind = spec.get("kind", "spearman")
    Bt = Part("leather", sub=1)
    Lg = Part("fabric", sub=1)
    if spec.get("_mounted"):
        # astride: thighs out along the horse's flanks, shins down, boots in the stirrups
        for d in (-1, 1):
            hip, knee, foot = Vector((d * 0.06, 0, 0.36)), Vector((d * 0.19, -0.1, 0.3)), Vector((d * 0.2, -0.04, 0.06))
            tube(Lg, hip, knee, 0.046, 0.042, TROUSER, seg=10); sphere(Lg, knee, 0.042, TROUSER, sub=2)
            tube(Bt, knee, foot, 0.04, 0.036, LEATHER_D, seg=10)
            block(Bt, foot + Vector((0, -0.03, -0.02)), (0.06, 0.1, 0.05), LEATHER_D)
    else:
        st = spec.get("_step", 0)
        for d in (-1, 1):
            dy = 0.0 if st == 0 else (0.075 if (st == 1) == (d < 0) else -0.075)   # a stride: one foot ahead (−y), one behind
            lift = 0.025 if st and dy > 0 else 0.0
            rbox(Bt, (d * 0.056, -0.014 + dy, 0.05 + lift), (0.085, 0.13, 0.1), LEATHER_D, radius=0.03)
            tube(Lg, (d * 0.055, dy, 0.08 + lift), (d * 0.058, dy * 0.15, 0.36), 0.05, 0.056, TROUSER, seg=12)
    Bt.link()
    if kind == "knight":   # the knight's plate over the tunic
        Kp = Part("metal", sub=1)
        st = hx(PEOPLE[f]["steel"]) if f not in (1, 3) else STEEL
        block(Kp, (0, -0.004, 0.6), (0.25, 0.165, 0.19), st)
        for d in (-1, 1): sphere(Kp, (d * 0.135, 0, 0.665), 0.064, st, scale=(1.0, 1.1, 0.78), sub=2)
        Kp.link()
    robe = f == 4 or kind == "settler"
    # tunic skirt and body
    tube(Lg, (0, 0, 0.26 if robe else 0.31), (0, 0, 0.5), 0.15 if robe else 0.135, 0.118, cloth, seg=20)
    sphere(Lg, (0, 0.005, 0.69), 0.07, cloth, scale=(1.75, 1.05, 0.55), sub=3)
    rbox(Lg, (0, 0, 0.6), (0.25, 0.16, 0.2), radius=0.045, col= (lambda co: hx("#efe7d4") if (f == 1 and co.y < -0.06 and abs(co.x) < max(0.0, (co.z - 0.56)) * 0.45) else cloth))
    Lg.link()
    # belt
    Be = Part("leather")
    tube(Be, (0, 0, 0.47), (0, 0, 0.495), 0.124, 0.123, LEATHER, seg=28)
    Be.link()
    Bk = Part("metal"); block(Bk, (0, -0.125, 0.482), (0.03, 0.01, 0.024), BRASS); Bk.link()
    # faction garments
    if f == 0 and kind not in ("settler", "scout", "archer"):
        Pl = Part("metal", sub=1)
        for d in (-1, 1): sphere(Pl, (d * 0.13, 0, 0.665), 0.062, hx(PEOPLE[0]["steel"]), scale=(1.0, 1.1, 0.75), sub=2)
        tube(Pl, (0, 0, 0.66), (0, 0, 0.7), 0.09, 0.06, hx(PEOPLE[0]["steel"]), seg=20)
        Pl.link()
        Tb = Part("fabric", sub=1); block(Tb, (0, -0.086, 0.5), (0.13, 0.02, 0.32), mul(cloth, 0.8)); Tb.link()
        Ks = Part("paint"); block(Ks, (0, -0.098, 0.57), (0.04, 0.006, 0.045), GOLD); Ks.link()
    if f == 1:
        Rp = Part("fabric", sub=1)
        for i in range(9):
            a = math.pi * (1.15 + i / 8 * 0.7)
            sphere(Rp, (math.cos(a) * 0.075, -0.088, 0.7 + math.sin(a) * 0.075), 0.011, [hx("#e8dcc2"), hx(FILL[1]), hx("#c95a3a")][i % 3], sub=1)
        Rp.link()
        Cl = Part("fabric", sub=1)
        for d in (-1, 1): block(Cl, (d * 0.1, -0.02, 0.6), (0.05, 0.16, 0.22), mul(cloth, 0.7))
        Cl.link()
    if f == 2 and kind not in ("settler", "scout", "archer"):
        Lm = Part("metal")
        for r in range(4):
            for i in range(14):
                a = math.pi * 2 * (i + (r % 2) * 0.5) / 14
                if math.sin(a) > 0.55: continue
                block(Lm, (math.cos(a) * 0.13, math.sin(a) * 0.086, 0.53 + r * 0.04), (0.03, 0.006, 0.036), mul(hx("#b07a2a"), 0.9 + 0.1 * (i % 2)), rot=Matrix.Rotation(a + math.pi / 2, 3, "Z"))
        Lm.link()
    if f == 3:
        Lf = Part("fabric", sub=1)
        for i in range(16):
            a = math.pi * 2 * i / 16
            sphere(Lf, (math.cos(a) * 0.12, math.sin(a) * 0.085, 0.66 - 0.01 * (i % 2)), 0.032, [hx("#6f9a46"), hx("#4f7a32"), hx("#3e6428")][i % 3], scale=(1, 0.6, 0.5), sub=2)
        Lf.link()
    if f == 4:
        Tr = Part("paint")
        for d in (-1, 1): block(Tr, (d * 0.035, -0.083, 0.58), (0.01, 0.006, 0.2), GOLD)
        Tr.link()
        Cp = Part("metal")
        tube(Cp, (-0.075, -0.1, 0.52), (-0.075, -0.085, 0.52), 0.028, 0.028, BRASS, seg=20)
        Cp.link()
    if f == 5:
        Fu = Part("fabric", sub=1)
        R = random.Random(5)
        for i in range(22):
            a = math.pi * 2 * i / 22
            sphere(Fu, (math.cos(a) * 0.105, math.sin(a) * 0.075, 0.685), 0.034, mix(hx("#bdb2a0"), hx("#8a7a62"), R.random() * 0.5), scale=(1, 1, 0.7), sub=2)
        Fu.link()
        Ml = Part("mail", sub=1); tube(Ml, (0, 0, 0.28), (0, 0, 0.33), 0.142, 0.138, hx("#6d7176"), seg=20); Ml.link()
    # neck
    Nk = Part("skin", sub=1)
    skin = hx(PEOPLE[f]["skin"][spec.get("skin", 1)])
    tube(Nk, (0, 0, 0.66), (0, 0, 0.77), 0.054, 0.048, mul(skin, 0.9), seg=14)
    Nk.link()
    return skin

def arms(spec, f, skin, pose):
    """pose: hand targets in body space, (left, right)."""
    cloth = hx(FILL[f])
    A = Part("fabric", sub=1)
    Hn = Part("skin", sub=1)
    for d, (elbow, hand) in zip((-1, 1), pose):
        sh = Vector((d * 0.135, 0, 0.66))
        tube(A, sh, elbow, 0.038, 0.034, cloth, seg=10)
        tube(A, elbow, hand, 0.033, 0.03, mul(cloth, 0.92), seg=10)
        sphere(A, elbow, 0.031, cloth, sub=2)
        sphere(A, sh + Vector((0, 0, -0.005)), 0.046, cloth, sub=2)
        sphere(Hn, hand, 0.028, skin, scale=(0.9, 1.0, 1.1), sub=2)
    A.link(); Hn.link()

def kit(spec, f):
    kind = spec.get("kind", "spearman")
    L, R = Vector((-0.17, -0.07, 0.47)), Vector((0.19, -0.06, 0.45))
    pose = ((Vector((-0.17, -0.02, 0.52)), L), (Vector((0.18, 0.0, 0.52)), R))
    cloth, dark = hx(FILL[f]), hx(DARK[f])
    W = Part("wood")
    M = Part("metal")
    Pt = Part("paint")
    if kind == "spearman":
        R = Vector((0.2, -0.04, 0.5)); pose = ((Vector((-0.17, -0.04, 0.55)), Vector((-0.12, -0.13, 0.52))), (Vector((0.19, 0.0, 0.55)), R))
        tube(W, R + Vector((0, 0.02, -0.48)), R + Vector((0.0, -0.02, 0.72)), 0.011, 0.011, WOOD, seg=8)
        tube(M, R + Vector((0, -0.02, 0.72)), R + Vector((0, -0.025, 0.82)), 0.02, 0.0, STEEL, seg=8)
        # round shield on the left arm, faction paint: the rim, the field and the people's sign
        c = Vector((-0.11, -0.16, 0.5))
        def sp(co):
            p = co - c; r = math.hypot(p.x, p.z)
            if r > 0.118: return mul(dark, 0.9)
            if f == 0 and abs(p.x) < 0.035 - (p.z) * 0.15 and -0.04 < p.z < 0.045: return GOLD
            if f == 1 and abs(p.z - 0.012 * math.sin(p.x * 90)) < 0.012: return hx("#efe7d4")
            if f == 2 and r < 0.05: return hx("#f2b33d")
            if f == 3 and abs(abs(p.x) - abs(p.z) * 0.6) < 0.012 and r < 0.09: return hx("#6f9a46")
            if f == 4 and (abs(p.x) < 0.01 or abs(p.z) < 0.01) and r < 0.09: return GOLD
            if f == 5 and r < 0.1 and int((math.atan2(p.z, p.x) + math.pi) / (math.pi / 3)) % 2: return mul(cloth, 0.75)
            return cloth
        bm = Pt.mb.bm; before = set(bm.faces)
        Mx = Matrix.Translation(c) @ Matrix.Rotation(math.pi / 2, 4, "X") @ Matrix.Rotation(0.15, 4, "Y")
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=40, radius1=0.13, radius2=0.122, depth=0.022, matrix=Mx)
        Pt.mb.paint(_since(Pt.mb, before), sp)
        sphere(M, c + Vector((0, -0.016, 0)), 0.03, STEEL, scale=(1, 0.6, 1), sub=2)
    elif kind == "pikeman":
        R = Vector((0.16, -0.08, 0.48)); pose = ((Vector((-0.16, -0.06, 0.56)), Vector((-0.06, -0.16, 0.58))), (Vector((0.19, -0.02, 0.5)), R))
        d = Vector((-0.35, -0.12, 0.93)).normalized()
        tube(W, R - d * 0.5, R + d * 1.25, 0.011, 0.01, WOOD, seg=8)
        tube(M, R + d * 1.25, R + d * 1.36, 0.017, 0.0, STEEL, seg=8)
    elif kind == "archer":
        Lh = Vector((-0.2, -0.17, 0.6)); pose = ((Vector((-0.2, -0.08, 0.6)), Lh), (Vector((0.16, -0.02, 0.66)), Vector((0.06, -0.06, 0.74))))
        pts = [Lh + Vector((0, 0.03 * (1 - (t * 2 - 1) ** 2), 0.3 * (t * 2 - 1))) for t in [i / 12 for i in range(13)]]
        for a, b in zip(pts, pts[1:]): tube(W, a, b, 0.009, 0.009, mul(WOOD, 0.85), seg=6)
        Sg = Part("fabric"); tube(Sg, pts[0], Vector((0.06, -0.06, 0.74)), 0.002, 0.002, hx("#efe6d0"), seg=4); tube(Sg, Vector((0.06, -0.06, 0.74)), pts[-1], 0.002, 0.002, hx("#efe6d0"), seg=4); Sg.link()
        Q = Part("leather", sub=1); tube(Q, (0.08, 0.1, 0.42), (0.13, 0.1, 0.74), 0.035, 0.04, LEATHER, seg=12); Q.link()
        for i in range(5): tube(W, Vector((0.12 + i * 0.005, 0.1, 0.72)), Vector((0.135 + i * 0.006, 0.1 + (i - 2) * 0.006, 0.82)), 0.003, 0.003, hx("#efe6d0"), seg=4)
    elif kind == "crossbowman":
        pose = ((Vector((-0.15, -0.08, 0.52)), Vector((-0.06, -0.17, 0.5))), (Vector((0.16, -0.04, 0.5)), Vector((0.07, -0.13, 0.46))))
        block(W, (0.0, -0.2, 0.48), (0.04, 0.24, 0.035), WOOD)
        pts = [Vector((0.15 * (t * 2 - 1), -0.3 - 0.03 * (1 - (t * 2 - 1) ** 2), 0.49)) for t in [i / 10 for i in range(11)]]
        for a, b in zip(pts, pts[1:]): tube(M, a, b, 0.007, 0.007, mul(STEEL, 0.8), seg=6)
    elif kind == "scout":
        R = Vector((0.18, -0.06, 0.48)); pose = ((Vector((-0.16, -0.02, 0.5)), Vector((-0.17, -0.05, 0.4))), (Vector((0.18, 0.0, 0.55)), R))
        tube(W, R + Vector((0, 0.02, -0.46)), R + Vector((0, -0.02, 0.5)), 0.012, 0.01, mul(WOOD, 0.9), seg=8)
        Cp = Part("fabric", sub=1)
        c = hx("#4b6a34") if f == 3 else mul(cloth, 0.72)
        tube(Cp, (0, 0.02, 0.2), (0, 0.0, 0.7), 0.17, 0.11, c, seg=20, caps=False)
        ob = Cp.link(); solidify(ob, 0.008)
    elif kind == "settler":
        pose = ((Vector((-0.17, -0.02, 0.5)), Vector((-0.16, -0.08, 0.4))), (Vector((0.17, 0.0, 0.52)), Vector((0.17, -0.07, 0.4))))
        Bd = Part("fabric", sub=1); sphere(Bd, (0, 0.13, 0.6), 0.1, hx("#d8c39a"), scale=(1, 0.7, 1.1), sub=2); Bd.link()
        Rp = Part("leather"); tube(Rp, (-0.1, -0.07, 0.68), (-0.08, 0.1, 0.5), 0.008, 0.008, LEATHER_D, seg=6); tube(Rp, (0.1, -0.07, 0.68), (0.08, 0.1, 0.5), 0.008, 0.008, LEATHER_D, seg=6); Rp.link()
        tube(W, Vector((0.17, -0.07, 0.15)), Vector((0.17, -0.07, 0.62)), 0.01, 0.01, WOOD, seg=8)
        block(M, (0.17, -0.07, 0.11), (0.06, 0.012, 0.08), mul(STEEL, 0.85))
    elif kind == "horseman":
        R = Vector((0.2, -0.08, 0.62)); pose = ((Vector((-0.15, -0.08, 0.5)), Vector((-0.06, -0.2, 0.44))), (Vector((0.21, -0.04, 0.6)), R))
        tube(M, R, R + Vector((0.08, -0.06, 0.32)), 0.01, 0.004, STEEL, seg=8)     # a raised sabre
        block(M, R + Vector((0, 0, -0.01)), (0.07, 0.016, 0.012), BRASS)
    elif kind == "knight":
        R = Vector((0.17, -0.12, 0.5)); pose = ((Vector((-0.16, -0.06, 0.52)), Vector((-0.08, -0.18, 0.46))), (Vector((0.19, -0.02, 0.52)), R))
        d = Vector((-0.12, -0.95, 0.28)).normalized()
        tube(W, R - d * 0.32, R + d * 1.1, 0.016, 0.009, hx(FILL[f]), seg=10)       # the lance, in the faction's colour
        tube(M, R + d * 1.1, R + d * 1.2, 0.014, 0.0, STEEL, seg=8)
        tube(M, R + d * 0.05, R + d * 0.12, 0.012, 0.045, STEEL, seg=12)            # the vamplate
        # a heater shield on the left arm
        c = Vector((-0.12, -0.15, 0.48))
        bm = Pt.mb.bm; before = set(bm.faces)
        vs = [bm.verts.new(c + Vector((x, 0, z))) for x, z in ((-0.08, 0.09), (0.08, 0.09), (0.075, -0.02), (0.0, -0.12), (-0.075, -0.02))]
        fa = bm.faces.new(vs)
        Pt.mb.paint([fa], lambda co: mul(dark, 0.9) if abs(co.x - c.x) > 0.06 or co.z - c.z > 0.07 else hx(FILL[f]))
    W.link(); M.link(); Pt.link()
    return pose

def horse(spec, at, facing):
    """A horse under a rider, facing along −y; barded in the faction's cloth for a knight."""
    global ROOT
    f = spec["f"]
    ROOT = bpy.data.objects.new("horse", None); bpy.context.scene.collection.objects.link(ROOT)
    ROOT.location = Vector(at); ROOT.rotation_euler = (0, 0, facing)
    coat = [hx("#7b5636"), hx("#5a3e28"), hx("#9a7a5a"), hx("#3a2c22")][spec.get("seed", 1) % 4]
    if f == 5: coat = hx("#4a4a4c")
    mane = mul(coat, 0.45)
    Hb = Part("leather", sub=2)
    # a stocky cob: the barrel at z 0.46, short strong legs
    rbox(Hb, (0, 0.0, 0.47), (0.26, 0.62, 0.27), coat, radius=0.11)
    sphere(Hb, (0, -0.25, 0.5), 0.15, coat, scale=(0.9, 1.0, 1.05), sub=2)     # the chest
    sphere(Hb, (0, 0.25, 0.5), 0.155, coat, scale=(1.0, 1.0, 1.0), sub=2)      # the rump
    tube(Hb, (0, -0.28, 0.55), (0, -0.4, 0.8), 0.11, 0.075, coat, seg=14)      # neck
    hd = Vector((0, -0.48, 0.8))
    Mh = Matrix.Rotation(-0.8, 3, "X")
    rbox(Hb, hd, (0.1, 0.25, 0.12), coat, radius=0.04, rot=Mh)                  # head
    sphere(Hb, hd + Vector((0, -0.11, -0.09)), 0.055, mul(coat, 0.8), scale=(0.95, 1.0, 0.8), sub=2)  # muzzle
    for d in (-1, 1):
        tube(Hb, hd + Vector((d * 0.035, 0.07, 0.07)), hd + Vector((d * 0.04, 0.09, 0.13)), 0.018, 0.004, coat, seg=6)
    Hb.link()
    Ey = Part("eye")
    for d in (-1, 1): sphere(Ey, hd + Vector((d * 0.05, -0.02, 0.02)), 0.012, hx("#120c08"), sub=2)
    Ey.link()
    Lg = Part("leather", sub=1)
    st = spec.get("_step", 0)
    for dx, dy, ph in ((-0.08, -0.24, 0), (0.08, -0.24, 1), (-0.08, 0.24, 1), (0.08, 0.24, 0)):
        sw = 0.0 if st == 0 else (0.07 if (st == 1) == (ph == 0) else -0.07)       # a walk: diagonal pairs swing together
        lift = 0.035 if sw < 0 else 0.0
        top = Vector((dx, dy, 0.42)); knee = Vector((dx, dy + sw * 0.6 + (0.03 if ph else -0.02), 0.2 + lift)); foot = Vector((dx, dy + sw + (0.0 if ph else -0.04), 0.045 + lift))
        tube(Lg, top, knee, 0.062, 0.042, coat, seg=10); sphere(Lg, knee, 0.042, coat, sub=2); tube(Lg, knee, foot, 0.038, 0.034, coat, seg=10)
        tube(Lg, foot, foot + Vector((0, 0, -0.045)), 0.04, 0.046, hx("#2a221c"), seg=10)
    Lg.link()
    Hr = Part("hair", sub=1)
    for i in range(7):   # mane and tail
        t = i / 6
        sphere(Hr, Vector((0, -0.28 - t * 0.12, 0.62 + t * 0.22)) + Vector((0, 0.06, 0.03)), 0.045, mane, scale=(0.5, 1, 1.2), sub=2)
    tube(Hr, (0, 0.36, 0.55), (0, 0.46, 0.22), 0.05, 0.03, mane, seg=10)
    Hr.link()
    Tk = Part("leather")   # saddle, reins
    rbox(Tk, (0, 0.02, 0.615), (0.22, 0.22, 0.05), hx("#4a2e1c"), radius=0.02)
    tube(Tk, hd + Vector((0, -0.08, -0.05)), Vector((0, -0.16, 0.7)), 0.005, 0.005, hx("#2a1a10"), seg=6)
    Tk.link()
    if spec.get("kind") == "knight":   # barding: the faction's cloth over the barrel, striped
        Bd = Part("fabric", sub=1)
        rbox(Bd, (0, 0.0, 0.44), (0.32, 0.74, 0.3), lambda co: hx(FILL[f]) if int((co.y + 1) * 14) % 2 else mul(hx(FILL[f]), 0.8), radius=0.12)
        Bd.link()
    else:
        Sc = Part("fabric"); rbox(Sc, (0, 0.02, 0.59), (0.32, 0.26, 0.02), hx(FILL[f]), radius=0.008); Sc.link()
    return ROOT

def mounted(spec, at=(0, 0, 0), facing=0.0, size=1.0):
    spec["_mounted"] = True
    hs = 1.25
    h = horse(spec, at, facing); h.scale = (size * hs, size * hs, size * hs)
    a = Vector(at)
    r = figure(spec, at=(a.x, a.y, a.z + (0.64 * hs - 0.35) * size), facing=facing, size=size)
    # the rider sits a little back on the saddle
    r.location += Matrix.Rotation(facing, 3, "Z") @ Vector((0, 0.02 * size, 0))

def figure(spec, at=(0, 0, 0), facing=0.0, size=1.0):
    """A figure, feet at `at` (world), facing the viewer when facing = 0 (looks along −y)."""
    global ROOT
    f = spec["f"]
    kind = spec.get("kind", "spearman")
    spec["_gear"] = spec.get("headgear") or ("none" if kind == "settler" else "hood" if kind in ("archer", "scout") else "helm")
    spec["_helm"] = spec["_gear"] == "helm" and f != 3
    spec["_hood"] = spec["_gear"] == "hood"
    ROOT = bpy.data.objects.new(f"fig{len(OBJS)}", None)
    bpy.context.scene.collection.objects.link(ROOT)
    ROOT.location = Vector(at); ROOT.rotation_euler = (0, 0, facing); ROOT.scale = (size, size, size)
    skin = torso(spec, f)
    pose = kit(spec, f)
    arms(spec, f, skin, pose)
    head(spec, f)
    headgear(spec, f)
    return ROOT

def base_disc(at, f, size, kind="stone"):
    """The token's base: a ground-coloured disc with the faction's rim (案B)."""
    global ROOT
    ROOT = bpy.data.objects.new("base", None); bpy.context.scene.collection.objects.link(ROOT)
    ROOT.location = Vector(at); ROOT.scale = (size, size, size)
    # a low base, earth and grass on top, the faction's colour on its rim (it reads as the map's ground)
    B = Part("base", sub=1)
    tube(B, (0, 0, 0), (0, 0, 0.026), 0.235, 0.228, lambda co: mix(hx("#6f7a44"), hx("#8a8a58"), max(0, min(1, 0.5 + co.x * 2))), seg=40)
    B.link()
    Rm = Part("paint", sub=1)
    tube(Rm, (0, 0, 0.0), (0, 0, 0.022), 0.238, 0.238, hx(FILL[f]), seg=40, caps=False)
    ob = Rm.link(); solidify(ob, 0.008)
    G = Part("base")
    R = random.Random(f)
    for i in range(16):
        a = R.random() * math.tau; r = R.uniform(0.04, 0.2)
        sphere(G, (math.cos(a) * r, math.sin(a) * r, 0.028), R.uniform(0.01, 0.02), [hx("#5f8a34"), hx("#7f9a48"), hx("#6a7a3a")][i % 3], scale=(1, 1, 0.55), sub=1)
    G.link()

# ------------------------------------------------------------------ cameras and lights
def map_camera(scale, res):
    """The map's camera (orthographic, the same elevation) framing `scale` world units; `res` pixels high."""
    sc = bpy.context.scene
    cd = bpy.data.cameras.new("cam"); cd.type = "ORTHO"; cd.ortho_scale = scale
    cam = bpy.data.objects.new("cam", cd)
    a = math.pi / 2 - C.ELEV
    cam.rotation_euler = (a, 0, 0)
    cam.location = -Vector((0, math.sin(a), -math.cos(a))) * 20 + Vector((0, 0, scale * 0.32))
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x = res; sc.render.resolution_y = res
    return cam

def portrait_camera(target, res=(800, 1000), lens=85, dist=1.25, yaw=-0.42, pitch=0.06):
    sc = bpy.context.scene
    cd = bpy.data.cameras.new("pcam"); cd.lens = lens; cd.sensor_width = 36
    cam = bpy.data.objects.new("pcam", cd)
    d = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    cam.location = Vector(target) + d * dist
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    return cam

def lights(portrait=False, rim=None):
    C.sun(2.7, 2.5, color=(1.0, 0.94, 0.84), direction=(0.55, 0.5, -1.0))
    if portrait:
        for loc, energy, color, size in (((1.2, -0.9, 0.9), 12, (0.7, 0.8, 1.0), 1.5), ((0.8, 0.9, 1.25), 70, rim or (1, 1, 1), 0.35), ((-0.7, 0.6, 1.4), 30, (1.0, 0.9, 0.75), 0.3)):
            ld = bpy.data.lights.new("a", "AREA"); ld.energy = energy; ld.color = color; ld.size = size
            ob = bpy.data.objects.new("a", ld); ob.location = loc
            ob.rotation_euler = (Vector((0, 0, 0.8)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
            bpy.context.scene.collection.objects.link(ob)

def shadow_catcher(r=3.0):
    mb = C.MB("catcher", ["base"])
    pts = [Vector((r * math.cos(i * math.tau / 32), r * math.sin(i * math.tau / 32), 0)) for i in range(32)]
    vs = [mb.bm.verts.new(p) for p in pts]; mb.bm.faces.new(vs)
    ob = mb.link(); ob.is_shadow_catcher = True
    return ob

def assign_all():
    for ob in bpy.context.scene.objects:
        if ob.type == "MESH" and "roles" in ob:
            RA.assign([ob])

def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path, flush=True)

def fresh():
    global OBJS
    C.reset_scene(); OBJS = []
    for o in list(bpy.data.cameras): bpy.data.cameras.remove(o)
    for o in list(bpy.data.lights): bpy.data.lights.remove(o)

# ------------------------------------------------------------------ jobs
def job_test():
    fresh(); lights(); shadow_catcher()
    spec = dict(f=0, kind="spearman", beard="short", skin=1, hairIdx=0)
    base_disc((0, 0, 0), 0, 1.0)
    figure(spec, at=(0, 0, 0.04))
    assign_all()
    map_camera(1.6, 900); render(os.path.join(OUT, "test_map.png"))
    fresh(); lights(portrait=True);
    figure(dict(spec), at=(0, 0, 0))
    assign_all()
    portrait_camera((0, 0, 0.74)); render(os.path.join(OUT, "test_portrait.png"))

LINE = [dict(f=0, kind=k, beard="short", skin=1, hairIdx=0, seed=i) for i, k in enumerate(["spearman", "archer", "horseman", "pikeman", "crossbowman", "knight", "scout", "settler"])]
PEOPLE_ROW = [
    dict(f=0, kind="spearman", beard="short", skin=1, hairIdx=0, jaw="square", seed=1),
    dict(f=1, kind="horseman", skin=0, hairIdx=1, stubble=True, seed=5),
    dict(f=2, kind="settler", hair="topknot", skin=1, hairIdx=1, stubble=True, seed=7),
    dict(f=3, kind="archer", beard="full", skin=1, hairIdx=0, age=2, seed=10),
    dict(f=4, kind="crossbowman", skin=1, hairIdx=1, stubble=True, seed=14),
    dict(f=5, kind="spearman", beard="braided", skin=1, hairIdx=0, seed=16),
    dict(f=1, kind="settler", sex="f", hair="braids", skin=1, hairIdx=0, seed=4),
    dict(f=0, kind="settler", sex="f", hair="long", skin=0, hairIdx=1, seed=2),
    dict(f=4, kind="settler", sex="f", hair="bob", skin=0, hairIdx=0, seed=13),
]

def map_one(spec, name, scale=None):
    fresh(); lights(); shadow_catcher()
    mountedk = spec.get("kind") in ("horseman", "knight")
    base_disc((0, 0, 0), spec["f"], 1.5 if mountedk else 1.0)
    if mountedk: mounted(dict(spec), at=(0, 0, 0.04), facing=-0.75)
    else: figure(dict(spec), at=(0, 0, 0.04), facing=-0.35)
    assign_all()
    map_camera(scale or (2.5 if mountedk else 1.6), 640)
    render(os.path.join(OUT, name))

def portrait_one(spec, name):
    fresh(); lights(portrait=True, rim=tuple(lin(mix(hx(FILL[spec["f"]]), (1, 1, 1), 0.5))))
    s = dict(spec)
    figure(s, at=(0, 0, 0))
    assign_all()
    portrait_camera((0, 0, 0.76), dist=1.05, yaw=-0.5, pitch=0.03)
    render(os.path.join(OUT, name))

def show_one(spec, name, close=False):
    """The miniature's showcase shot: the figure on its base, a little from above (the UI's portrait)."""
    fresh(); lights(portrait=True, rim=tuple(lin(mix(hx(FILL[spec["f"]]), (1, 1, 1), 0.4)))); shadow_catcher()
    mk = spec.get("kind") in ("horseman", "knight")
    base_disc((0, 0, 0), spec["f"], 1.5 if mk else 1.0)
    if mk: mounted(dict(spec), at=(0, 0, 0.04), facing=-0.6)
    else: figure(dict(spec), at=(0, 0, 0.04), facing=-0.25)
    assign_all()
    if close: portrait_camera((0, 0, 0.66), res=(800, 1000), lens=85, dist=1.9, yaw=-0.35, pitch=0.22)
    elif mk: portrait_camera((0, 0, 0.62), res=(800, 1000), lens=60, dist=3.6, yaw=-0.3, pitch=0.3)
    else: portrait_camera((0, 0, 0.5), res=(800, 1000), lens=70, dist=2.7, yaw=-0.3, pitch=0.3)
    render(os.path.join(OUT, name))

SHOW = [
    dict(f=0, kind="spearman", beard="short", skin=1, hairIdx=0, jaw="square", seed=1),
    dict(f=1, kind="horseman", skin=0, hairIdx=1, stubble=True, seed=5),
    dict(f=2, kind="spearman", skin=1, hairIdx=1, stubble=True, seed=7),
    dict(f=3, kind="archer", beard="full", skin=1, hairIdx=0, age=2, seed=10),
    dict(f=4, kind="crossbowman", skin=1, hairIdx=1, stubble=True, seed=14),
    dict(f=5, kind="knight", beard="braided", skin=1, hairIdx=0, seed=16),
    dict(f=1, kind="settler", sex="f", hair="braids", skin=1, hairIdx=0, seed=4),
    dict(f=2, kind="settler", hair="topknot", skin=1, hairIdx=1, stubble=True, seed=8),
    dict(f=0, kind="pikeman", beard="none", skin=0, hairIdx=1, seed=2),
    dict(f=3, kind="scout", skin=2, hairIdx=1, seed=11),
]

def job_show():
    for i, s in enumerate(SHOW): show_one(s, f"show_{i}.png")
    for i in (0, 2, 6, 7): show_one(SHOW[i], f"close_{i}.png", close=True)

KINDS = ["spearman", "archer", "horseman", "pikeman", "crossbowman", "knight", "scout", "settler"]
TYPICAL = [dict(beard="short", jaw="square"), dict(stubble=True, hairIdx=1, skin=0), dict(stubble=True, hairIdx=1, hair="topknot"),
           dict(beard="full"), dict(stubble=True, hairIdx=1), dict(beard="braided")]
CELL_U, CELL_PX, ANCHOR = 2.0, 320, (0.42, 0.74)

def cell_camera():
    sc = bpy.context.scene
    cd = bpy.data.cameras.new("cam"); cd.type = "ORTHO"; cd.ortho_scale = CELL_U
    cd.shift_x = 0.5 - ANCHOR[0]; cd.shift_y = ANCHOR[1] - 0.5
    cam = bpy.data.objects.new("cam", cd)
    a = math.pi / 2 - C.ELEV
    cam.rotation_euler = (a, 0, 0)
    cam.location = -Vector((0, math.sin(a), -math.cos(a))) * 20
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x = sc.render.resolution_y = CELL_PX

def unit_spec(f, kind, seed=0):
    d = dict(f=f, kind=kind, skin=1, hairIdx=0, seed=seed); d.update(TYPICAL[f]); return d

def job_atlas():
    """Map sprites: per people one sheet, rows = KINDS, columns = (face +1, face −1) × (idle, step A, step B)."""
    import numpy as np
    only = [int(x) for x in ARGV[2].split(",")] if len(ARGV) > 2 else range(6)
    raw = os.path.join(OUT, "_cells"); os.makedirs(raw, exist_ok=True)
    for f in only:
        sheet = np.zeros((CELL_PX * len(KINDS), CELL_PX * 6, 4), dtype=np.float32)
        for r, kind in enumerate(KINDS):
            for fi, face in enumerate((1, -1)):
                for st in range(3):
                    fresh(); lights(); shadow_catcher()
                    spec = unit_spec(f, kind, seed=r); spec["_step"] = st
                    mk = kind in ("horseman", "knight")
                    base_disc((0, 0, 0), f, 1.5 if mk else 1.0)
                    bob = 0.012 if st else 0.0
                    if mk: mounted(spec, at=(0, 0, 0.026 + bob * 0.5), facing=face * 0.95)
                    else: figure(spec, at=(0, 0, 0.026 + bob), facing=face * 0.55)
                    assign_all(); cell_camera()
                    path = os.path.join(raw, f"{f}_{kind}_{fi}_{st}.png")
                    render(path)
                    px = RA.grade(C.load_px(path))
                    c = fi * 3 + st
                    sheet[r * CELL_PX:(r + 1) * CELL_PX, c * CELL_PX:(c + 1) * CELL_PX] = px
        C.save_px(sheet, os.path.join(OUT, f"units_{f}@2x.png"))
        C.save_px(C.downsample(sheet, 2), os.path.join(OUT, f"units_{f}@1x.png"))
        print("ATLAS", f, flush=True)

def job_cards():
    """Unit portraits for the UI: the miniature on its base, per people and unit type."""
    only = [int(x) for x in ARGV[2].split(",")] if len(ARGV) > 2 else range(6)
    for f in only:
        for r, kind in enumerate(KINDS):
            show_one(unit_spec(f, kind, seed=r), f"card_{f}_{kind}.png")

def job_lineup():
    for i, s in enumerate(LINE): map_one(s, f"map_0_{s['kind']}.png")
    for s in PEOPLE_ROW[:6]: map_one(dict(s, kind="spearman" if s["kind"] in ("settler", "crossbowman", "horseman", "archer") and s["f"] != 3 else s["kind"]), f"map_f{s['f']}.png")

def job_portraits():
    for i, s in enumerate(PEOPLE_ROW): portrait_one(s, f"portrait_{i}.png")

if __name__ == "__main__":
    RA.setup()
    bpy.context.scene.cycles.transparent_max_bounces = 16
    materials()
    if JOB[0] == "p" and JOB[1:].isdigit(): i = int(JOB[1:]); portrait_one(PEOPLE_ROW[i], f"portrait_{i}.png")
    elif JOB[0] == "s" and JOB[1:].isdigit(): i = int(JOB[1:]); show_one(SHOW[i], f"show_{i}.png")
    else: {"test": job_test, "lineup": job_lineup, "portraits": job_portraits, "show": job_show, "atlas": job_atlas, "cards": job_cards}[JOB]()

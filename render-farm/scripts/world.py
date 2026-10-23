# Wylls cinematic world: one river valley at the Aster–Fjordal frontier, built once and saved.
# Units are metres. x = east, y = north, z = up.
#   Aster's walled town on a western terrace; a stone bridge over the river; the road east to the pass;
#   Fjordal's keep on a crag above the pass; a camp in the southern woods; mountains round the valley.
import bpy, bmesh, math, random, os, sys
import numpy as np
from mathutils import Vector, Matrix, noise

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")

def srgb(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c) + (1.0,)
ASTER, FJORDAL = srgb('#cc303b'), srgb('#f19232')     # palette.mjs NATION_FILL

# ------------------------------------------------------------------ layout
SIZE = 1400.0
TOWN = Vector((-300.0, 40.0)); TOWN_R = 78.0; TOWN_Z = 14.0
KEEP = Vector((330.0, 150.0)); KEEP_Z = 62.0
BRIDGE = Vector((-10.0, 8.0))
BATTLE = Vector((175.0, 30.0))
CAMP = Vector((-120.0, -300.0))
def river_x(y):           # the river's centre line, meandering north-south
    return -10.0 + 38.0 * math.sin(y / 170.0) + 14.0 * math.sin(y / 61.0 + 1.3)
RIVER_W = 16.0
ROAD = [TOWN + Vector((TOWN_R + 4, -12)), Vector((-170, 5)), Vector((-60, 10)), BRIDGE + Vector((-14, 0)), BRIDGE + Vector((14, 0)),
        Vector((80, 12)), BATTLE, Vector((250, 70)), KEEP + Vector((-38, -22))]
ROAD2 = [TOWN + Vector((0, -TOWN_R - 4)), Vector((-250, -120)), Vector((-170, -230)), CAMP + Vector((0, 25))]
ROAD3 = [TOWN + Vector((-TOWN_R - 4, 10)), Vector((-480, 60)), Vector((-640, 90))]
FIELDS = []

def seg_dist(p, a, b):
    ab = b - a; t = max(0.0, min(1.0, (p - a).dot(ab) / max(1e-9, ab.length_squared)))
    return (p - (a + ab * t)).length, t
def path_dist(p, pts):
    best = (1e9, 0)
    for a, b in zip(pts, pts[1:]):
        d, _ = seg_dist(p, a, b)
        if d < best[0]: best = (d, 0)
    return best[0]

def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t)

def fbm(x, y, oct=6, lac=2.0, gain=0.5, base=0.0):
    a, f, s = 1.0, 1.0, 0.0
    for i in range(oct):
        s += a * noise.noise(Vector((x * f, y * f, base + i * 7.3)))
        a *= gain; f *= lac
    return s
def ridged(x, y, oct=5):
    a, f, s = 1.0, 1.0, 0.0
    for i in range(oct):
        n = 1.0 - abs(noise.noise(Vector((x * f, y * f, 31.7 + i * 3.1))))
        s += a * n * n; a *= 0.5; f *= 2.03
    return s

def height(x, y):
    p = Vector((x, y))
    # rolling valley floor
    h = 6.0 * fbm(x / 260, y / 260) + 2.0 * fbm(x / 60, y / 60, 4)
    # mountains round the valley: north, east and south-west
    ring = math.hypot(x / 1.0, (y - 40) / 0.85)
    mount = smoothstep(380, 650, ring)
    h += mount * (95 * ridged(x / 420 + 3, y / 420) + 25 * fbm(x / 120, y / 120))
    # the river valley is lower
    rx = river_x(y); dr = abs(x - rx)
    vw = 1 - smoothstep(RIVER_W * 1.2, 160, dr)          # the floodplain slopes gently down to the water
    h = h * (1 - vw) + (0.6 + 0.6 * fbm(x / 40, y / 40, 3)) * vw
    # the crag under the keep
    dk = (p - KEEP).length
    h += KEEP_Z * (1 - smoothstep(30, 150, dk)) ** 1.6 + 6 * ridged(x / 40, y / 40) * (1 - smoothstep(20, 120, dk))
    # the pass east of the battle ground rises gently
    h += 10 * smoothstep(150, 320, x) * (1 - smoothstep(380, 600, ring))
    # the town terrace: flatten toward TOWN_Z
    dt = (p - TOWN).length
    w = 1 - smoothstep(TOWN_R + 10, TOWN_R + 70, dt)
    h = h * (1 - w) + (TOWN_Z + 0.6 * fbm(x / 30, y / 30, 3)) * w
    # the river channel
    bank = smoothstep(RIVER_W * 0.55, RIVER_W * 1.3, dr)
    h = h * bank + (-2.2) * (1 - bank)
    # road beds are levelled a little
    return h

# ------------------------------------------------------------------ helpers
def link(ob, coll=None):
    (coll or bpy.context.scene.collection).objects.link(ob); return ob

def new_coll(name, parent=None):
    c = bpy.data.collections.new(name); (parent or bpy.context.scene.collection).children.link(c); return c

def tex_node(nt, path, non_color=False, mapping=None):
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = bpy.data.images.load(path, check_existing=True)
    if non_color: t.image.colorspace_settings.name = 'Non-Color'
    t.projection = 'BOX'; t.projection_blend = 0.25
    if mapping is not None: nt.links.new(mapping, t.inputs['Vector'])
    return t

def pbr_mat(name, tex, scale=1.0, tint=None, rough_mul=1.0, disp=0.0, coord='Object', bump=0.6):
    """A material from a downloaded Poly Haven texture set, box-mapped in object or generated space."""
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    b = nt.nodes['Principled BSDF']; D = os.path.join(ASSETS, 'tex', tex)
    tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (scale, scale, scale)
    nt.links.new(tc.outputs[coord], mp.inputs['Vector'])
    d = tex_node(nt, os.path.join(D, 'diff.jpg'), mapping=mp.outputs[0])
    col = d.outputs['Color']
    if tint:
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'
        mx.inputs['Factor'].default_value = 1.0; mx.inputs['B'].default_value = tint
        nt.links.new(col, mx.inputs['A']); col = mx.outputs['Result']
    nt.links.new(col, b.inputs['Base Color'])
    if os.path.exists(os.path.join(D, 'rough.jpg')):
        r = tex_node(nt, os.path.join(D, 'rough.jpg'), True, mp.outputs[0])
        mm = nt.nodes.new('ShaderNodeMath'); mm.operation = 'MULTIPLY'; mm.inputs[1].default_value = rough_mul
        nt.links.new(r.outputs['Color'], mm.inputs[0]); nt.links.new(mm.outputs[0], b.inputs['Roughness'])
    if os.path.exists(os.path.join(D, 'nor.jpg')):
        n = tex_node(nt, os.path.join(D, 'nor.jpg'), True, mp.outputs[0])
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = bump
        nt.links.new(n.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs[0], b.inputs['Normal'])
    return m

def flat_mat(name, color, rough=0.6, metal=0.0, emit=None, sheen=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = color; b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal; b.inputs['Sheen Weight'].default_value = sheen
    if emit:
        b.inputs['Emission Color'].default_value = emit[0]; b.inputs['Emission Strength'].default_value = emit[1]
    return m

def mesh_ob(name, bm, mats, coll=None, smooth=False):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for m in mats: me.materials.append(m)
    if smooth:
        for p in me.polygons: p.use_smooth = True
    return link(bpy.data.objects.new(name, me), coll)

def box(bm, c, size, rot=0.0, mat=0):
    M = Matrix.Translation(c) @ Matrix.Rotation(rot, 4, 'Z') @ Matrix.Diagonal((size[0], size[1], size[2], 1))
    res = bmesh.ops.create_cube(bm, size=1.0, matrix=M)
    for f in {f for v in res['verts'] for f in v.link_faces}: f.material_index = mat
    return res

# ------------------------------------------------------------------ terrain
def terrain_material():
    """Grass, dirt, rock and road blended by slope, height and painted masks, with a faint hex lattice."""
    m = bpy.data.materials.new('terrain'); m.use_nodes = True; nt = m.node_tree; L = nt.links
    b = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    def layer(tex, scale, tint=None):
        mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = (scale, scale, scale)
        L.new(tc.outputs['Object'], mp.inputs['Vector'])
        D = os.path.join(ASSETS, 'tex', tex)
        d = tex_node(nt, os.path.join(D, 'diff.jpg'), mapping=mp.outputs[0]); d.projection = 'FLAT'
        r = tex_node(nt, os.path.join(D, 'rough.jpg'), True, mp.outputs[0]); r.projection = 'FLAT'
        n = tex_node(nt, os.path.join(D, 'nor.jpg'), True, mp.outputs[0]); n.projection = 'FLAT'
        col = d.outputs['Color']
        if tint:
            mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'
            mx.inputs['Factor'].default_value = 1.0; mx.inputs['B'].default_value = tint
            L.new(col, mx.inputs['A']); col = mx.outputs['Result']
        return col, r.outputs['Color'], n.outputs['Color']
    grass = layer('aerial_grass_rock', 1 / 9.0, (0.62, 0.86, 0.48, 1))
    grass2 = layer('forest_ground_04', 1 / 5.0, (0.8, 0.95, 0.7, 1))
    rock = layer('rocky_terrain_02', 1 / 7.0)
    dirt = layer('brown_mud_leaves_01', 1 / 5.0)
    road = layer('dry_riverbed_rock', 1 / 3.0, (0.62, 0.52, 0.42, 1))
    def mixc(f, a, bb, dtype='RGBA'):
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = dtype
        L.new(f, mx.inputs['Factor']); L.new(a, mx.inputs[6 if dtype == 'RGBA' else 2]); L.new(bb, mx.inputs[7 if dtype == 'RGBA' else 3])
        return mx.outputs[2 if dtype == 'RGBA' else 0]
    def attr(name):
        a = nt.nodes.new('ShaderNodeAttribute'); a.attribute_name = name; return a.outputs['Fac']
    def ramp(f, a, bb):
        mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs[1].default_value = a; mr.inputs[2].default_value = bb
        L.new(f, mr.inputs[0]); return mr.outputs[0]
    # macro variation between the two grasses
    mn = nt.nodes.new('ShaderNodeTexNoise'); mn.inputs['Scale'].default_value = 0.012; mn.inputs['Detail'].default_value = 4
    L.new(tc.outputs['Object'], mn.inputs['Vector'])
    gmix = ramp(mn.outputs['Fac'], 0.42, 0.62)
    col = mixc(gmix, grass[0], grass2[0]); rgh = mixc(gmix, grass[1], grass2[1]); nor = mixc(gmix, grass[2], grass2[2])
    for mask, lay in ((attr('dirt'), dirt), (attr('rock'), rock), (attr('road'), road)):
        col = mixc(mask, col, lay[0]); rgh = mixc(mask, rgh, lay[1]); nor = mixc(mask, nor, lay[2])
    # fields: ploughed rows and ripening crop in the painted field mask
    wv = nt.nodes.new('ShaderNodeTexWave'); wv.inputs['Scale'].default_value = 0.35; wv.inputs['Distortion'].default_value = 0.4
    L.new(attr('fieldu'), wv.inputs['Vector'])
    fc = nt.nodes.new('ShaderNodeValToRGB'); fc.color_ramp.elements[0].color = srgb('#6b5a32'); fc.color_ramp.elements[1].color = srgb('#c2a64f')
    L.new(wv.outputs['Fac'], fc.inputs['Fac'])
    tone = nt.nodes.new('ShaderNodeMix'); tone.data_type = 'RGBA'; tone.blend_type = 'MULTIPLY'
    L.new(attr('fieldtone'), tone.inputs['Factor']); L.new(fc.outputs['Color'], tone.inputs[6]); tone.inputs[7].default_value = srgb('#7e9a3e')
    fcol = nt.nodes.new('ShaderNodeMix'); fcol.data_type = 'RGBA'; fcol.blend_type = 'MULTIPLY'; fcol.inputs['Factor'].default_value = 1.0
    L.new(tone.outputs[2], fcol.inputs[6]); L.new(dirt[0], fcol.inputs[7])
    fbright = nt.nodes.new('ShaderNodeMath'); fbright.operation = 'MULTIPLY'; fbright.inputs[1].default_value = 1.0
    col = mixc(attr('field'), col, fcol.outputs[2])
    # the hex lattice: distance to the nearest hex edge (pointy-top, circumradius HEXR)
    hexs = nt.nodes.new('ShaderNodeValue'); hexs.name = 'HEX_STRENGTH'; hexs.outputs[0].default_value = 0.0
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Object'], sep.inputs[0])
    hexn = build_hex_lines(nt, sep.outputs['X'], sep.outputs['Y'], 46.0)
    hm = nt.nodes.new('ShaderNodeMath'); hm.operation = 'MULTIPLY'; L.new(hexn, hm.inputs[0]); L.new(hexs.outputs[0], hm.inputs[1])
    hexcol = nt.nodes.new('ShaderNodeMix'); hexcol.data_type = 'RGBA'; hexcol.blend_type = 'SCREEN'
    L.new(hm.outputs[0], hexcol.inputs['Factor']); L.new(col, hexcol.inputs[6]); hexcol.inputs[7].default_value = (0.55, 0.52, 0.42, 1)
    col = hexcol.outputs[2]
    # the nation wash for the strategic views
    wash = nt.nodes.new('ShaderNodeValue'); wash.name = 'WASH_STRENGTH'; wash.outputs[0].default_value = 0.0
    wa = nt.nodes.new('ShaderNodeMath'); wa.operation = 'MULTIPLY'; L.new(attr('aster_land'), wa.inputs[0]); L.new(wash.outputs[0], wa.inputs[1])
    wm = nt.nodes.new('ShaderNodeMix'); wm.data_type = 'RGBA'; wm.blend_type = 'OVERLAY'
    L.new(wa.outputs[0], wm.inputs['Factor']); L.new(col, wm.inputs[6]); wm.inputs[7].default_value = ASTER
    wf = nt.nodes.new('ShaderNodeMath'); wf.operation = 'MULTIPLY'; L.new(attr('fjordal_land'), wf.inputs[0]); L.new(wash.outputs[0], wf.inputs[1])
    wm2 = nt.nodes.new('ShaderNodeMix'); wm2.data_type = 'RGBA'; wm2.blend_type = 'OVERLAY'
    L.new(wf.outputs[0], wm2.inputs['Factor']); L.new(wm.outputs[2], wm2.inputs[6]); wm2.inputs[7].default_value = FJORDAL
    L.new(wm2.outputs[2], b.inputs['Base Color'])
    L.new(rgh, b.inputs['Roughness'])
    nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 0.8
    L.new(nor, nm.inputs['Color']); L.new(nm.outputs[0], b.inputs['Normal'])
    return m

def build_hex_lines(nt, X, Y, R):
    """Shader math: 1 near the edges of a pointy-top hex lattice, 0 inside. Line width ~0.6 m."""
    L = nt.links
    def m(op, a, b=None, c=None):
        n = nt.nodes.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, b, c)):
            if v is None: continue
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: L.new(v, n.inputs[i])
        return n.outputs[0]
    # axial coordinates, cube rounding
    q = m('DIVIDE', m('SUBTRACT', m('MULTIPLY', X, math.sqrt(3) / 3), m('MULTIPLY', Y, 1 / 3)), R)
    r = m('DIVIDE', m('MULTIPLY', Y, 2 / 3), R)
    s = m('SUBTRACT', m('MULTIPLY', q, -1), r)
    rq, rr, rs = m('ROUND', q), m('ROUND', r), m('ROUND', s)
    dq, dr, ds = m('ABSOLUTE', m('SUBTRACT', rq, q)), m('ABSOLUTE', m('SUBTRACT', rr, r)), m('ABSOLUTE', m('SUBTRACT', rs, s))
    # fix the coordinate with the largest rounding error
    q_big = m('MULTIPLY', m('GREATER_THAN', dq, dr), m('GREATER_THAN', dq, ds))
    r_big = m('MULTIPLY', m('SUBTRACT', 1, q_big), m('GREATER_THAN', dr, ds))
    fq = m('ADD', m('MULTIPLY', q_big, m('SUBTRACT', m('MULTIPLY', m('ADD', rr, rs), -1), rq)), rq)
    fr = m('ADD', m('MULTIPLY', r_big, m('SUBTRACT', m('MULTIPLY', m('ADD', rq, rs), -1), rr)), rr)
    # back to world: centre of the cell
    cx = m('MULTIPLY', m('ADD', m('MULTIPLY', fq, math.sqrt(3)), m('MULTIPLY', fr, math.sqrt(3) / 2)), R)
    cy = m('MULTIPLY', m('MULTIPLY', fr, 1.5), R)
    lx, ly = m('ABSOLUTE', m('SUBTRACT', X, cx)), m('ABSOLUTE', m('SUBTRACT', Y, cy))
    # hex distance (pointy-top): max(|x|*cos30 + |y|*0.5, |y|)
    d = m('MAXIMUM', m('ADD', m('MULTIPLY', lx, 0.5), m('MULTIPLY', ly, math.sqrt(3) / 2)), lx)   # pointy-top: edge normals at 0, 60, 120 degrees
    edge = m('SUBTRACT', R * math.sqrt(3) / 2, d)
    return m('SUBTRACT', 1, m('MINIMUM', 1, m('DIVIDE', m('MAXIMUM', 0, m('SUBTRACT', edge, 0.15)), 0.55)))

def build_terrain(res=int(os.environ.get("TRES", "700"))):
    n = res; xs = np.linspace(-SIZE / 2, SIZE / 2, n); ys = np.linspace(-SIZE / 2, SIZE / 2, n)
    bm = bmesh.new()
    vs = []
    H = np.zeros((n, n))
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            H[j, i] = height(x, y)
    # levelled road beds
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            p = Vector((x, y))
            for pts in (ROAD, ROAD2, ROAD3):
                d = path_dist(p, pts)
                if d < 9: H[j, i] = H[j, i] * smoothstep(3, 9, d) + (H[j, i] - 0.25) * (1 - smoothstep(3, 9, d))
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            vs.append(bm.verts.new((x, y, H[j, i])))
    for j in range(n - 1):
        for i in range(n - 1):
            bm.faces.new((vs[j * n + i], vs[j * n + i + 1], vs[(j + 1) * n + i + 1], vs[(j + 1) * n + i]))
    me = bpy.data.meshes.new('terrain'); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    me.update()
    ob = link(bpy.data.objects.new('terrain', me))
    # painted masks as point attributes
    co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    nrm = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('normal', nrm); nrm = nrm.reshape(-1, 3)
    slope = 1 - nrm[:, 2]
    def add(name, vals):
        a = me.attributes.new(name, 'FLOAT', 'POINT'); a.data.foreach_set('value', np.clip(vals, 0, 1).astype(np.float32))
    rock = np.clip((slope - 0.12) / 0.12, 0, 1)
    rock = np.maximum(rock, np.clip((co[:, 2] - 70) / 40, 0, 1) * 0.8)
    add('rock', rock)
    rng = np.random.default_rng(1)
    road = np.zeros(len(co)); dirt = np.zeros(len(co)); field = np.zeros(len(co)); fu = np.zeros(len(co)); ft = np.zeros(len(co))
    aster = np.zeros(len(co)); fj = np.zeros(len(co))
    for k, (x, y, z) in enumerate(co):
        p = Vector((x, y))
        d = min(path_dist(p, ROAD), path_dist(p, ROAD2), path_dist(p, ROAD3))
        road[k] = 1 - smoothstep(1.8, 3.6, d + 1.0 * noise.noise(Vector((x / 4, y / 4, 0))))
        dirt[k] = max(1 - smoothstep(5, 14, d), 0.7 * smoothstep(0.55, 0.75, 0.5 + 0.5 * noise.noise(Vector((x / 70, y / 70, 5)))))
        dt = (p - TOWN).length
        if dt < TOWN_R - 4: dirt[k] = max(dirt[k], 0.55)
        dx = x - river_x(y)
        if abs(dx) < RIVER_W * 1.8: dirt[k] = max(dirt[k], 1 - smoothstep(RIVER_W * 0.9, RIVER_W * 1.8, abs(dx)))
        for (c, a, w, h, tone) in FIELDS:
            lp = p - c; u = lp.x * math.cos(-a) - lp.y * math.sin(-a); v = lp.x * math.sin(-a) + lp.y * math.cos(-a)
            if abs(u) < w / 2 and abs(v) < h / 2:
                field[k] = 1 - smoothstep(-2, 0, max(abs(u) - w / 2, abs(v) - h / 2)); fu[k] = u; ft[k] = tone
        aster[k] = 1.0 if x < river_x(y) - 4 else 0.0
        fj[k] = 1.0 if x > river_x(y) + 4 and x > 60 else 0.0
    add('road', road); add('dirt', dirt * (1 - road)); add('field', field * (1 - road))
    a = me.attributes.new('fieldu', 'FLOAT', 'POINT'); a.data.foreach_set('value', fu.astype(np.float32))
    add('fieldtone', ft); add('aster_land', aster); add('fjordal_land', fj)
    me.materials.append(terrain_material())
    return ob, H, xs, ys

_HCACHE = {}
def ground(x, y):
    """Height of the built terrain mesh at (x, y), bilinear from the grid."""
    H, xs, ys = _HCACHE['H'], _HCACHE['xs'], _HCACHE['ys']
    n = len(xs); f = (n - 1) / SIZE
    gx, gy = (x + SIZE / 2) * f, (y + SIZE / 2) * f
    i, j = int(max(0, min(n - 2, gx))), int(max(0, min(n - 2, gy)))
    tx, ty = gx - i, gy - j
    return (H[j, i] * (1 - tx) + H[j, i + 1] * tx) * (1 - ty) + (H[j + 1, i] * (1 - tx) + H[j + 1, i + 1] * tx) * ty

def water():
    bm = bmesh.new()
    n = 160; ys = np.linspace(-SIZE / 2, SIZE / 2, n)
    left, right = [], []
    for y in ys:
        x = river_x(y)
        left.append(bm.verts.new((x - RIVER_W * 1.25, y, -0.9))); right.append(bm.verts.new((x + RIVER_W * 1.25, y, -0.9)))
    for k in range(n - 1):
        bm.faces.new((left[k], right[k], right[k + 1], left[k + 1]))
    m = bpy.data.materials.new('water'); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = srgb('#2c4a46'); b.inputs['Roughness'].default_value = 0.03
    b.inputs['Transmission Weight'].default_value = 0.85; b.inputs['IOR'].default_value = 1.333
    tc = nt.nodes.new('ShaderNodeTexCoord'); nz = nt.nodes.new('ShaderNodeTexNoise'); nz.noise_dimensions = '4D'
    nz.inputs['Scale'].default_value = 0.35; nz.inputs['Detail'].default_value = 6; nz.name = 'WATER_NOISE'
    mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = (1, 0.4, 1)
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector']); nt.links.new(mp.outputs[0], nz.inputs['Vector'])
    bp = nt.nodes.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.25
    nt.links.new(nz.outputs['Fac'], bp.inputs['Height']); nt.links.new(bp.outputs[0], b.inputs['Normal'])
    return mesh_ob('water', bm, [m])

# ------------------------------------------------------------------ buildings
MATS = {}
def mats():
    MATS['plaster'] = pbr_mat('plaster', 'plastered_wall_04', 1 / 2.5)
    MATS['stone'] = pbr_mat('stone', 'castle_wall_slates', 1 / 3.0)
    MATS['rough_stone'] = pbr_mat('rough_stone', 'rock_wall_08', 1 / 4.0)
    MATS['tiles'] = pbr_mat('tiles', 'roof_tiles_14', 1 / 2.0, tint=(0.95, 0.75, 0.65, 1))
    MATS['tiles_fj'] = pbr_mat('tiles_fj', 'roof_tiles_14', 1 / 2.0, tint=(1.0, 0.62, 0.32, 1))
    MATS['thatch'] = pbr_mat('thatch', 'thatch_roof_angled', 1 / 2.5)
    MATS['wood'] = pbr_mat('wood', 'wood_planks_grey', 1 / 2.0, tint=(0.55, 0.42, 0.3, 1))
    MATS['beam'] = flat_mat('beam', srgb('#3b2a1c'), 0.7)
    MATS['window'] = flat_mat('window', srgb('#16120e'), 0.4)
    MATS['window_lit'] = flat_mat('window_lit', srgb('#2a1a0a'), 0.4, emit=(srgb('#ffb257'), 0.0))
    MATS['canvas'] = flat_mat('canvas', srgb('#cfc1a0'), 0.85, sheen=0.3)
    MATS['cobble'] = pbr_mat('cobble', 'cobblestone_floor_01', 1 / 2.0)

def house(bm, c, w, d, h, rot, roof_mat_idx, timber=True, chimney=True, rng=None):
    """Walls (plaster 0 or stone 1), a gable roof (index roof_mat_idx), timber frame, door and windows."""
    rng = rng or random.Random(0)
    z = c.z
    box(bm, Vector((c.x, c.y, z + h / 2 - 0.5)), (w, d, h + 1.0), rot, 0 if timber else 1)
    R = Matrix.Rotation(rot, 3, 'Z')
    ov = 0.45; rh = d * 0.55 + rng.uniform(-0.3, 0.6)
    pts = [(-w / 2 - ov, -d / 2 - ov, 0), (w / 2 + ov, -d / 2 - ov, 0), (w / 2 + ov, 0, rh), (-w / 2 - ov, 0, rh),
           (-w / 2 - ov, d / 2 + ov, 0), (w / 2 + ov, d / 2 + ov, 0)]
    V = [bm.verts.new(Vector((c.x, c.y, z + h)) + R @ Vector(p)) for p in pts]
    for f in ((V[0], V[1], V[2], V[3]), (V[3], V[2], V[5], V[4])):
        face = bm.faces.new(f); face.material_index = roof_mat_idx
    # gables
    for (a, b_, top) in ((V[0], V[4], V[3]), (V[1], V[5], V[2])):
        pa = Vector((a.co.x, a.co.y, z + h)); pb = Vector((b_.co.x, b_.co.y, z + h))
        g = [bm.verts.new(pa.lerp(top.co, 0.0)), bm.verts.new(pb), bm.verts.new(top.co - Vector((0, 0, 0.05)))]
        face = bm.faces.new(g); face.material_index = 0 if timber else 1
    if timber:
        for sx in (-1, 0, 1):
            box(bm, Vector((c.x, c.y, z + h / 2)) + R @ Vector((sx * w * 0.47, -d / 2 - 0.05, 0)), (0.25, 0.12, h), rot, 3)
            box(bm, Vector((c.x, c.y, z + h / 2)) + R @ Vector((sx * w * 0.47, d / 2 + 0.05, 0)), (0.25, 0.12, h), rot, 3)
        box(bm, Vector((c.x, c.y, z + h * 0.55)) + R @ Vector((0, -d / 2 - 0.06, 0)), (w, 0.12, 0.22), rot, 3)
        box(bm, Vector((c.x, c.y, z + h * 0.55)) + R @ Vector((0, d / 2 + 0.06, 0)), (w, 0.12, 0.22), rot, 3)
    # door and windows
    box(bm, Vector((c.x, c.y, z + 1.0)) + R @ Vector((rng.uniform(-w / 4, w / 4), -d / 2 - 0.04, 0)), (1.1, 0.1, 2.0), rot, 4)
    for sx in (-0.3, 0.3):
        box(bm, Vector((c.x, c.y, z + h * 0.72)) + R @ Vector((sx * w, -d / 2 - 0.04, 0)), (0.8, 0.1, 0.9), rot, 5)
        box(bm, Vector((c.x, c.y, z + h * 0.72)) + R @ Vector((sx * w, d / 2 + 0.04, 0)), (0.8, 0.1, 0.9), rot, 5)
    if chimney and rng.random() < 0.6:
        box(bm, Vector((c.x, c.y, z + h + rh * 0.8)) + R @ Vector((w * 0.3, d * 0.15, 0)), (0.8, 0.8, rh * 1.2), rot, 1)

def crenellated_wall(bm, a, b, h, thick, merlon=1.0, idx=1):
    d = b - a; L = d.length; ang = math.atan2(d.y, d.x)
    mid = (a + b) / 2
    box(bm, Vector((mid.x, mid.y, mid.z + h / 2 - 2)), (L + thick * 0.5, thick, h + 4), ang, idx)
    n = max(1, int(L / (merlon * 2)))
    for i in range(n):
        p = a + d * ((i + 0.5) / n)
        box(bm, Vector((p.x, p.y, max(a.z, b.z) + h + 0.6)), (merlon, thick, 1.2), ang, idx)

def tower(bm, c, r, h, seg=14, idx=1, roof_idx=None, roof_h=None):
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r * 0.95, depth=h + 3, matrix=Matrix.Translation((c.x, c.y, c.z + h / 2 - 1.5)))
    for f in {f for v in res['verts'] for f in v.link_faces}: f.material_index = idx
    if roof_idx is not None:
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r * 1.15, radius2=0.0, depth=roof_h or r * 2.2, matrix=Matrix.Translation((c.x, c.y, c.z + h + (roof_h or r * 2.2) / 2)))
        for f in {f for v in res['verts'] for f in v.link_faces}: f.material_index = roof_idx
    else:
        for i in range(seg):
            if i % 2: continue
            a = i / seg * math.tau
            box(bm, Vector((c.x + math.cos(a) * r * 0.9, c.y + math.sin(a) * r * 0.9, c.z + h + 0.6)), (1.0, 0.8, 1.2), a)

def town(coll):
    """Aster's walled town: ~70 houses inside a stone curtain with towers, a gate east, a granary, a market square,
    the drill ground in the square, one wall stretch in scaffolding."""
    rng = random.Random(7)
    bm = bmesh.new()   # materials: 0 plaster, 1 stone, 2 tiles, 3 beam, 4 door(window), 5 window, 6 thatch, 7 wood
    placed = []
    sq_r = 18.0
    for k in range(900):
        if len(placed) >= 85: break
        a = rng.random() * math.tau; rr = math.sqrt(rng.random()) * (TOWN_R - 9)
        p = TOWN + Vector((math.cos(a) * rr, math.sin(a) * rr))
        if (p - TOWN).length < sq_r + 4: continue
        # the main street east to the gate, and the south and west gates
        if abs(p.y - (TOWN.y - 4)) < 4.5 and p.x > TOWN.x: continue
        if abs(p.x - TOWN.x) < 4.5 and p.y < TOWN.y: continue
        if abs(p.y - (TOWN.y + 10 * 0)) < 4.5 and p.x < TOWN.x: continue
        w, d = rng.uniform(6, 10), rng.uniform(5, 7.5)
        if any((p - q).length < (w + qw) * 0.62 for q, qw in placed): continue
        placed.append((p, w))
        rot = math.atan2(p.y - TOWN.y, p.x - TOWN.x) + math.pi / 2 + rng.uniform(-0.15, 0.15)
        house(bm, Vector((p.x, p.y, ground(p.x, p.y))), w, d, rng.uniform(4.5, 7.5), rot, 2 if rng.random() < 0.8 else 6, timber=rng.random() < 0.7, rng=rng)
    # a granary and a hall by the square
    for (off, w, d, h) in ((Vector((-sq_r - 9, 6)), 16, 10, 8), (Vector((sq_r + 8, 14)), 18, 11, 9)):
        p = TOWN + off
        house(bm, Vector((p.x, p.y, ground(p.x, p.y))), w, d, h, 0.1, 2, timber=False, chimney=False, rng=rng)
    # the curtain wall and towers; the north-west stretch is scaffolded, not finished
    N = 18; pts = []
    for i in range(N):
        a = i / N * math.tau
        p = TOWN + Vector((math.cos(a), math.sin(a))) * TOWN_R
        pts.append(Vector((p.x, p.y, ground(p.x, p.y))))
    gate_ang = [math.atan2(-12, TOWN_R + 4), -math.pi / 2, math.pi + 0.13]
    scaf = []
    for i in range(N):
        a0 = i / N * math.tau; a1 = (i + 1) / N * math.tau
        mid = (a0 + a1) / 2
        if any(abs(((mid - g) + math.pi) % math.tau - math.pi) < 0.12 for g in gate_ang): continue
        unfinished = 2.0 < mid < 2.45
        crenellated_wall(bm, pts[i], pts[(i + 1) % N], 3.5 if unfinished else 8.5, 2.2)
        if unfinished: scaf.append((pts[i], pts[(i + 1) % N]))
    for i in range(N):
        tower(bm, pts[i], 3.6, 12.0, roof_idx=2 if i % 3 == 0 else None, roof_h=7)
    for g in gate_ang:
        p = TOWN + Vector((math.cos(g), math.sin(g))) * TOWN_R
        for s in (-1, 1):
            q = p + Vector((-math.sin(g), math.cos(g))) * 5.5 * s
            tower(bm, Vector((q.x, q.y, ground(q.x, q.y))), 3.2, 14.0, roof_idx=2, roof_h=7)
    # scaffolding: poles and ledgers in front of the unfinished stretch, stone blocks waiting
    wb = bmesh.new()
    for (a, b) in scaf:
        d = b - a; L = d.length; ang = math.atan2(d.y, d.x); out = Vector((-d.y, d.x, 0)).normalized()
        for k in range(int(L / 2.2) + 1):
            p = a + d * (k / max(1, int(L / 2.2)))
            for o in (-1.8, 1.8):
                q = p + out * o
                box(wb, Vector((q.x, q.y, q.z + 4)), (0.18, 0.18, 8), 0, 0)
        for zz in (2.5, 5.0, 7.5):
            for o in (-1.8, 1.8):
                q = (a + b) / 2 + out * o
                box(wb, Vector((q.x, q.y, q.z + zz)), (L, 0.14, 0.14), ang, 0)
            q = (a + b) / 2
            box(wb, Vector((q.x, q.y, q.z + zz + 0.1)), (L, 3.4, 0.08), ang, 0)
        for k in range(14):
            p = a + d * random.Random(k).random() + out * (4 + random.Random(k + 9).random() * 3)
            box(bm, Vector((p.x, p.y, ground(p.x, p.y) + 0.35)), (1.2, 0.7, 0.7), random.Random(k).random(), 1)
    obw = mesh_ob('scaffold', wb, [MATS['wood']], coll)
    ob = mesh_ob('town', bm, [MATS['plaster'], MATS['stone'], MATS['tiles'], MATS['beam'], MATS['window'], MATS['window_lit'], MATS['thatch'], MATS['wood']], coll)
    # the square: cobbles
    cb = bmesh.new()
    res = bmesh.ops.create_circle(cb, cap_ends=True, segments=48, radius=sq_r)
    for v in cb.verts: v.co = Vector((TOWN.x + v.co.x, TOWN.y + v.co.y, ground(TOWN.x + v.co.x, TOWN.y + v.co.y) + 0.06))
    mesh_ob('square', cb, [MATS['cobble']], coll)
    return ob

def keep(coll):
    """Fjordal's keep on its crag: a square donjon, a curtain with round towers, orange roofs."""
    bm = bmesh.new()   # 0 stone, 1 tiles_fj, 2 window
    c = Vector((KEEP.x, KEEP.y, ground(KEEP.x, KEEP.y)))
    box(bm, Vector((c.x, c.y, c.z + 15)), (16, 16, 34), 0.3, 0)
    for i in range(4):
        a = 0.3 + i * math.pi / 2 + math.pi / 4
        tower(bm, Vector((c.x + math.cos(a) * 11.3, c.y + math.sin(a) * 11.3, c.z)), 2.6, 36, idx=0, roof_idx=1, roof_h=8)
    for i in range(12):
        a = i / 12 * math.tau
        box(bm, Vector((c.x + math.cos(a) * 7.6, c.y + math.sin(a) * 7.6, c.z + 32.6)), (1.3, 1.0, 1.4), a)
    N = 10; pts = []
    for i in range(N):
        a = i / N * math.tau + 0.2; r = 34 + 6 * math.sin(i * 1.7)
        p = KEEP + Vector((math.cos(a), math.sin(a))) * r
        pts.append(Vector((p.x, p.y, ground(p.x, p.y))))
    for i in range(N):
        crenellated_wall(bm, pts[i], pts[(i + 1) % N], 9, 2.6, idx=0)
        tower(bm, pts[i], 4.2, 15, idx=0, roof_idx=1, roof_h=9)
    rng = random.Random(3)
    for k in range(9):
        a = rng.random() * math.tau; r = rng.uniform(16, 26)
        p = KEEP + Vector((math.cos(a), math.sin(a))) * r
        house(bm, Vector((p.x, p.y, ground(p.x, p.y))), rng.uniform(7, 10), rng.uniform(5, 7), rng.uniform(5, 7), a + math.pi / 2, 1, timber=False, rng=rng)
    # house() uses material slots 0..7; map them onto stone/roof here
    return mesh_ob('keep', bm, [MATS['stone'], MATS['tiles_fj'], MATS['tiles_fj'], MATS['beam'], MATS['window'], MATS['window'], MATS['tiles_fj'], MATS['wood']], coll)

def bridge(coll):
    bm = bmesh.new()
    y = BRIDGE.y; x0 = river_x(y)
    L = RIVER_W * 3.4
    for k in range(3):
        cx = x0 - L / 2 + (k + 0.5) * L / 3
        for s in range(10):
            a0 = s / 10 * math.pi
            px = cx + math.cos(a0) * L / 6.5
            box(bm, Vector((px, y, 0.6 + math.sin(a0) * 2.6 - 1.4)), (L / 30, 7.5, 0.9), 0)
    box(bm, Vector((x0, y, 1.9)), (L + 8, 7.0, 0.9), 0)
    for s in (-1, 1):
        box(bm, Vector((x0, y + s * 3.3, 2.8)), (L + 8, 0.6, 1.0), 0)
    return mesh_ob('bridge', bm, [MATS['stone']], coll)

def camp(coll):
    bm = bmesh.new(); rng = random.Random(4)
    for k in range(16):
        a = rng.random() * math.tau; r = rng.uniform(8, 32)
        p = CAMP + Vector((math.cos(a) * r, math.sin(a) * r)); z = ground(p.x, p.y)
        rot = rng.random() * math.pi
        R = Matrix.Rotation(rot, 3, 'Z'); w, d, h = rng.uniform(3, 5), rng.uniform(4, 6), rng.uniform(2.2, 3.0)
        V = [bm.verts.new(Vector((p.x, p.y, z)) + R @ Vector(q)) for q in ((-w / 2, -d / 2, 0), (w / 2, -d / 2, 0), (w / 2, d / 2, 0), (-w / 2, d / 2, 0), (0, -d / 2, h), (0, d / 2, h))]
        bm.faces.new((V[0], V[4], V[5], V[3])); bm.faces.new((V[1], V[2], V[5], V[4])); bm.faces.new((V[0], V[1], V[4])); bm.faces.new((V[3], V[5], V[2]))
    return mesh_ob('camp', bm, [MATS['canvas']], coll)

# ------------------------------------------------------------------ vegetation and rocks (Poly Haven, CC0)
def import_model(name, coll):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ASSETS, 'models', name, name + '.gltf'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        for c in list(o.users_collection): c.objects.unlink(o)
        coll.objects.link(o)
        o.location = (0, 0, 0)
    return [o for o in new if o.type == 'MESH']

def scatter(coll, protos, n, accept, seed, scale=(0.8, 1.3), zoff=0.0):
    rng = random.Random(seed); placed = 0; tries = 0
    while placed < n and tries < n * 40:
        tries += 1
        x, y = rng.uniform(-SIZE / 2 + 20, SIZE / 2 - 20), rng.uniform(-SIZE / 2 + 20, SIZE / 2 - 20)
        if not accept(x, y, rng): continue
        o = bpy.data.objects.new('i', None); o.instance_type = 'COLLECTION'
        o.instance_collection = protos[rng.randrange(len(protos))]
        s = rng.uniform(*scale)
        o.location = (x, y, ground(x, y) + zoff); o.rotation_euler = (0, 0, rng.random() * math.tau); o.scale = (s, s, s)
        coll.objects.link(o); placed += 1
    return placed

def forest_density(x, y):
    n = 0.5 + 0.5 * noise.noise(Vector((x / 160, y / 160, 9)))
    n += 0.25 * noise.noise(Vector((x / 50, y / 50, 3)))
    return n

def clear_of_works(x, y, pad=1.0):
    p = Vector((x, y))
    if (p - TOWN).length < (TOWN_R + 30) * pad: return False
    if (p - KEEP).length < 60 * pad: return False
    if (p - CAMP).length < 40 * pad: return False
    if abs(x - river_x(y)) < RIVER_W * 1.6: return False
    if min(path_dist(p, ROAD), path_dist(p, ROAD2), path_dist(p, ROAD3)) < 9 * pad: return False
    if (p - BATTLE).length < 55 * pad: return False
    for (c, a, w, h, _) in FIELDS:
        if (p - c).length < max(w, h) * 0.6: return False
    return True

def make_fields():
    rng = random.Random(12)
    for k in range(14):
        a = rng.uniform(-0.4, 0.4) + (0 if k % 2 else math.pi / 2)
        ang = rng.uniform(math.radians(110), math.radians(330))
        r = TOWN_R + rng.uniform(45, 150)
        c = TOWN + Vector((math.cos(ang) * r, math.sin(ang) * r))
        if min(path_dist(c, ROAD), path_dist(c, ROAD2), path_dist(c, ROAD3)) < 25: continue
        FIELDS.append((c, a, rng.uniform(35, 60), rng.uniform(25, 45), rng.random()))

def build(out_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_fields()
    ob, H, xs, ys = build_terrain()
    _HCACHE.update(H=H, xs=xs, ys=ys)
    water()
    mats()
    built = new_coll('built')
    town(built); keep(built); bridge(built); camp(built)
    protos = new_coll('protos'); protos.hide_render = False
    lib = {}
    for name in ('fir_tree_01', 'island_tree_02', 'tree_small_02', 'rock_moss_set_01', 'boulder_01', 'namaqualand_cliff_02'):
        c = bpy.data.collections.new('P_' + name); protos.children.link(c)
        meshes = import_model(name, c)
        per = []
        for m in meshes:     # one collection per variant
            cc = bpy.data.collections.new(f'V_{m.name}'); c.children.link(cc)
            for col in list(m.users_collection): col.objects.unlink(m)
            cc.objects.link(m); per.append(cc)
        lib[name] = per
    # keep the prototypes off the map: exclude them from the view layer
    lc = bpy.context.view_layer.layer_collection.children['protos']; lc.exclude = True
    veg = new_coll('vegetation')
    nf = scatter(veg, lib['fir_tree_01'], 9000, lambda x, y, r: clear_of_works(x, y) and forest_density(x, y) > 0.55 + 0.12 * r.random() and ground(x, y) < 140, 1, (0.75, 1.3))
    nb = scatter(veg, lib['island_tree_02'] + lib['tree_small_02'], 3500, lambda x, y, r: clear_of_works(x, y) and 0.45 < forest_density(x, y) + 0.2 * r.random() < 0.75 and ground(x, y) < 60, 2, (1.4, 2.4))
    nr = scatter(veg, lib['rock_moss_set_01'] + lib['boulder_01'], 900, lambda x, y, r: clear_of_works(x, y, 0.8) and (ground(x, y) > 25 or r.random() < 0.15), 3, (1.0, 3.0), -0.3)
    nc = scatter(veg, lib['namaqualand_cliff_02'], 60, lambda x, y, r: (Vector((x, y)) - KEEP).length < 140 and (Vector((x, y)) - KEEP).length > 45, 4, (1.2, 2.2), -2.0)
    print('scatter', nf, nb, nr, nc, flush=True)
    bpy.ops.wm.save_as_mainfile(filepath=out_path)
    print('SAVED', out_path, flush=True)

if __name__ == '__main__':
    build(sys.argv[sys.argv.index('--') + 1])

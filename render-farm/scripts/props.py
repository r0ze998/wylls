# Props for the thread media v2: supply carts and convoys, the forge, the mine, the depot, fire, and the painted
# supply routes on the ground. Everything faces -y in its own space, like the characters, and is instanced.
import bpy, bmesh, math, random
from mathutils import Vector, Matrix
import world as W
import army as A
from army import _cyl, _ell, _tag

def M(name):
    """A world material by name (the world file carries them; build them if a test scene doesn't)."""
    m = bpy.data.materials.get(name)
    if m is None:
        if not W.MATS: W.mats()
        m = W.MATS.get(name) or bpy.data.materials[name]
    return m

def sigil_mat():
    return bpy.data.materials.get('sigil_white') or W.flat_mat('sigil_white', (0.86, 0.82, 0.74, 1), 0.6)

def char_mat():
    return bpy.data.materials.get('charred') or A._mat('charred', W.srgb('#1b1612'), 0.9)

def _sigil(bm, nation, c, normal_x, r=0.32, idx=0):
    """The nation's sign painted on a vertical surface facing +x or -x: a filled circle (Aster) or a hexagon
    outline (Fjordal)."""
    R = Matrix.Rotation(math.pi / 2, 4, 'Y') if normal_x else Matrix.Identity(4)
    if nation == 'aster':
        res = bmesh.ops.create_circle(bm, cap_ends=True, segments=28, radius=r, matrix=Matrix.Translation(c) @ R)
        _tag(res, idx)
    else:
        outer = [Vector((0, math.cos(a), math.sin(a))) * r for a in (math.pi / 6 + k * math.pi / 3 for k in range(6))]
        inner = [v * 0.68 for v in outer]
        vo = [bm.verts.new(c + v) for v in outer]; vi = [bm.verts.new(c + v) for v in inner]
        for k in range(6):
            f = bm.faces.new((vo[k], vo[(k + 1) % 6], vi[(k + 1) % 6], vi[k])); f.material_index = idx

# ------------------------------------------------------------------ the cart
def cart(nation, coll, variant=0, burnt=False):
    """An ox-drawn supply wagon under a canvas hood in the nation's colour with its sign on both sides, crates and
    barrels inside. burnt=True gives the wreck: charred bed, hood gone, a wheel off, no ox."""
    rng = random.Random(variant * 13 + (7 if nation == 'aster' else 3) + (100 if burnt else 0))
    bm = bmesh.new()
    # materials: 0 wood, 1 canvas, 2 iron, 3 sigil, 4 ox hide, 5 horn, 6 rope/leather, 7 charred
    wood, iron = 0, 2
    bed_z = 0.95
    W.box(bm, Vector((0, 0.2, bed_z)), (1.5, 2.8, 0.14), 0, 7 if burnt else wood)            # bed
    for sx in (-1, 1):                                                                         # side boards
        W.box(bm, Vector((sx * 0.72, 0.2, bed_z + 0.28)), (0.07, 2.8, 0.45), (rng.uniform(-0.25, 0.25) if burnt else 0), 7 if burnt else wood)
    W.box(bm, Vector((0, 1.58, bed_z + 0.28)), (1.5, 0.07, 0.45), 0, 7 if burnt else wood)    # tailboard
    wheels = [(-0.86, -0.75), (0.86, -0.75), (-0.86, 1.15), (0.86, 1.15)]
    for i, (x, y) in enumerate(wheels):
        if burnt and i == 1: continue                                                          # one wheel gone
        tilt = rng.uniform(-0.35, 0.35) if burnt else 0
        c = Vector((x, y, 0.55 - (0.15 if burnt and i == 0 else 0)))
        rim = bmesh.ops.create_cone(bm, cap_ends=False, segments=20, radius1=0.55, radius2=0.55, depth=0.09,
                                    matrix=Matrix.Translation(c) @ Matrix.Rotation(math.pi / 2 + tilt, 4, 'Y'))
        _tag(rim, iron)
        hub = _cyl(bm, c - Vector((0.08, 0, 0)), c + Vector((0.08, 0, 0)), 0.11, 0.11, 10); _tag(hub, 7 if burnt else wood)
        for k in range(6):                                                                     # spokes
            a = k * math.pi / 3
            sp = _cyl(bm, c, c + Vector((0, math.cos(a), math.sin(a))) * 0.5, 0.03, 0.03, 6); _tag(sp, 7 if burnt else wood)
    _tag(_cyl(bm, Vector((-0.86, -0.75, 0.55)), Vector((0.86, -0.75, 0.55)), 0.05, 0.05, 6), iron)   # axles
    _tag(_cyl(bm, Vector((-0.86, 1.15, 0.55)), Vector((0.86, 1.15, 0.55)), 0.05, 0.05, 6), iron)
    if not burnt:
        # the hood: canvas over hoops, the sign painted on both sides
        hood = bmesh.ops.create_cone(bm, cap_ends=False, segments=24, radius1=0.78, radius2=0.78, depth=2.5,
                                     matrix=Matrix.Translation((0, 0.25, bed_z + 0.45)) @ Matrix.Rotation(math.pi / 2, 4, 'X'))
        bmesh.ops.delete(bm, geom=[v for v in hood['verts'] if v.co.z < bed_z + 0.42], context='VERTS')
        for f in {f for v in hood['verts'] if v.is_valid for f in v.link_faces}: f.material_index = 1
        for yy in (-0.95, 0.25, 1.45):                                                         # hoops
            hp = bmesh.ops.create_cone(bm, cap_ends=False, segments=24, radius1=0.8, radius2=0.8, depth=0.05,
                                       matrix=Matrix.Translation((0, yy, bed_z + 0.45)) @ Matrix.Rotation(math.pi / 2, 4, 'X'))
            bmesh.ops.delete(bm, geom=[v for v in hp['verts'] if v.co.z < bed_z + 0.42], context='VERTS')
            for f in {f for v in hp['verts'] if v.is_valid for f in v.link_faces}: f.material_index = wood
        for sx in (-1, 1):
            _sigil(bm, nation, Vector((sx * 0.8, 0.25, bed_z + 0.95)), True, 0.3, 3)
        # shafts forward to the ox, and the yoke
        for sx in (-1, 1):
            _tag(_cyl(bm, Vector((sx * 0.35, -1.2, bed_z - 0.1)), Vector((sx * 0.3, -3.3, 1.05)), 0.05, 0.045, 6), wood)
        _tag(_cyl(bm, Vector((-0.6, -3.25, 1.3)), Vector((0.6, -3.25, 1.3)), 0.07, 0.07, 8), wood)
        # the ox: a stocky draught animal, chibi to match the soldiers
        oc = Vector((0, -3.75, 1.05))
        _tag(_ell(bm, oc, 0.62, (0.95, 1.55, 0.85)), 4)
        _tag(_ell(bm, oc + Vector((0, -0.95, 0.25)), 0.38, (0.85, 1.05, 0.9)), 4)               # head
        _tag(_ell(bm, oc + Vector((0, -1.28, 0.12)), 0.2, (1.1, 0.8, 0.8)), 6)                 # muzzle
        for sx in (-1, 1):
            _tag(_cyl(bm, oc + Vector((sx * 0.25, -0.98, 0.52)), oc + Vector((sx * 0.62, -1.05, 0.7)), 0.07, 0.025, 8), 5)   # horns
            for yy in (-0.6, 0.6):                                                             # legs
                _tag(_cyl(bm, oc + Vector((sx * 0.32, yy, -0.25)), oc + Vector((sx * 0.33, yy - 0.05, -1.05)), 0.14, 0.12, 8), 4)
                _tag(_ell(bm, oc + Vector((sx * 0.33, yy - 0.08, -1.0)), 0.13, (1, 1.2, 0.5)), 5)   # hooves
    # cargo: crates and sacks, a couple tumbled out on the wreck
    for k in range(4):
        x = rng.uniform(-0.35, 0.35); y = 0.2 + (k - 1.5) * 0.6
        z = bed_z + 0.25 if not burnt else (bed_z + 0.25 if k % 2 else 0.18)
        if burnt and k % 2 == 0: x += rng.choice((-1.6, 1.6))
        W.box(bm, Vector((x, y, z)), (0.5, 0.5, 0.42), rng.uniform(-0.3, 0.3), 7 if burnt else wood)
    mats = [M('wood'), A._mat(f'cartcloth_{nation}', W.srgb('#a51d27') if nation == 'aster' else W.srgb('#d6701c'), 0.85, sheen=0.25),
            A._mat('iron', W.srgb('#3a3a3c'), 0.5, 0.8), sigil_mat(), A._mat('oxhide', W.srgb('#6b4a32'), 0.8, sheen=0.3),
            A._mat('horn', W.srgb('#d8ccb0'), 0.5), A._mat('leather', W.srgb('#4a3020'), 0.6), char_mat()]
    ob = W.mesh_ob(f'cart_{nation}_{variant}{"_burnt" if burnt else ""}', bm, mats, coll)
    return ob

def cart_collections():
    """Instancable carts: (nation, burnt) -> list of collections, kept out of the view layer."""
    lib = bpy.data.collections.get('carts') or W.new_coll('carts')
    out = {}
    for nation in ('aster', 'fjordal'):
        for burnt in (False, True):
            lst = []
            for v in range(3):
                name = f'C_{nation}_{v}_{int(burnt)}'
                c = bpy.data.collections.get(name)
                if c is None:
                    c = bpy.data.collections.new(name); lib.children.link(c); cart(nation, c, v, burnt)
                lst.append(c)
            out[(nation, burnt)] = lst
    bpy.context.view_layer.layer_collection.children['carts'].exclude = True
    return out

def path_at(pts):
    segs = list(zip(pts, pts[1:])); lens = [(b - a).length for a, b in segs]; total = sum(lens)
    def at(s):
        s = max(0.0, min(total - 0.01, s))
        for (a, b), l in zip(segs, lens):
            if s <= l: return a + (b - a) * (s / l), (b - a).normalized()
            s -= l
    return at, total

CONVOYS = []      # every convoy built, so a film can roll the carts along their roads: (at, [(obj, s, side offset)])

def convoy(lib, nation, pts, n=6, gap=7.5, start=0.0, seed=0, escort=None, burnt=False, coll=None):
    """Carts one behind another along a road; escort = troop library to walk a soldier beside each cart."""
    coll = coll or bpy.context.scene.collection
    rng = random.Random(seed); at, total = path_at(pts); obs = []; reg = []
    CONVOYS.append((at, reg, burnt))
    for i in range(n):
        p, d = at(start - i * gap)
        o = bpy.data.objects.new('cart', None); o.instance_type = 'COLLECTION'
        o.instance_collection = rng.choice(lib[(nation, burnt)])
        yaw = math.atan2(d.x, -d.y) + (rng.uniform(-0.9, 0.9) if burnt else rng.uniform(-0.04, 0.04))
        o.location = (p.x, p.y, W.ground(p.x, p.y)); o.rotation_euler = (0, 0, yaw)
        coll.objects.link(o); obs.append(o); reg.append((o, start - i * gap, 0.0))
        if escort and not burnt and i % 2 == 0:
            side = Vector((-d.y, d.x)); q = p + side * 1.9 + d * 1.0
            e = bpy.data.objects.new('escort', None); e.instance_type = 'COLLECTION'; e.instance_collection = rng.choice(escort[(nation, 'march')])
            e.location = (q.x, q.y, W.ground(q.x, q.y)); e.rotation_euler = (0, 0, yaw); coll.objects.link(e); obs.append(e)
            reg.append((e, start - i * gap + 1.0, 1.9))
    return obs, at

# ------------------------------------------------------------------ buildings
def forge(at, rot=0.0, coll=None, smoke=True):
    """A stone workshop with an open hearth glowing under a lean-to, an anvil yard, ore heaps and a tall chimney."""
    bm = bmesh.new(); z = W.ground(at.x, at.y)
    R = Matrix.Rotation(rot, 3, 'Z'); P = lambda x, y, zz: Vector((at.x, at.y, z)) + R @ Vector((x, y, zz))
    W.house(bm, P(0, 0, 0), 9, 6.5, 4.2, rot, 2, timber=False, chimney=False, rng=random.Random(5))
    W.box(bm, P(3.2, -1.2, 4.5), (1.4, 1.4, 9.0), rot, 1)                                        # chimney
    # lean-to over the hearth on the front
    for sx in (-3.5, 3.5):
        W.box(bm, P(sx, -5.2, 1.4), (0.25, 0.25, 2.8), rot, 3)
    roof = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(P(0, -4.4, 3.0)) @ Matrix.Rotation(rot, 4, 'Z') @ Matrix.Rotation(-0.35, 4, 'X') @ Matrix.Diagonal((7.6, 2.6, 0.15, 1)))
    _tag(roof, 6)
    W.box(bm, P(-1.5, -4.3, 0.55), (2.0, 1.4, 1.1), rot, 1)                                      # hearth
    W.box(bm, P(-1.5, -4.3, 1.13), (1.4, 0.9, 0.1), rot, 5)                                      # the coals
    W.box(bm, P(1.6, -4.6, 0.45), (0.9, 0.35, 0.9), rot, 7)                                      # anvil block
    W.box(bm, P(1.6, -4.6, 0.95), (1.0, 0.3, 0.18), rot, 7)
    for k, (x, y) in enumerate(((5.8, -2.0), (6.6, 0.8), (-6.0, -2.4))):                         # ore heaps
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=1.3 - 0.2 * k, radius2=0.1, depth=1.0,
                                    matrix=Matrix.Translation(P(x, y, 0.4)))
        _tag(res, 4)
    mats = [M('plaster'), M('stone'), M('tiles'), M('beam'), A._mat('ore', W.srgb('#3f3a38'), 0.85),
            W.flat_mat('coals', (0.2, 0.05, 0.01, 1), 0.6, emit=((1.0, 0.36, 0.08, 1), 18.0)) if 'coals' not in bpy.data.materials else bpy.data.materials['coals'],
            M('wood'), A._mat('iron', W.srgb('#3a3a3c'), 0.5, 0.8)]
    ob = W.mesh_ob('forge', bm, mats, coll)
    glow = bpy.data.lights.new('forgeglow', 'POINT'); glow.energy = 1500; glow.color = (1.0, 0.45, 0.15); glow.shadow_soft_size = 0.6
    lo = bpy.data.objects.new('forgeglow', glow); lo.location = P(-1.5, -4.6, 1.8); bpy.context.scene.collection.objects.link(lo)
    if smoke:
        import stage as S
        S.plume(P(3.2, -1.2, 9.1), height=26, width=9, wind=rot + 0.6, name='forge_smoke')
    return ob

def mine(at, rot=0.0, coll=None):
    """A timbered adit into the slope, rails out to a spoil heap, an ore cart."""
    bm = bmesh.new(); z = W.ground(at.x, at.y)
    R = Matrix.Rotation(rot, 3, 'Z'); P = lambda x, y, zz: Vector((at.x, at.y, z)) + R @ Vector((x, y, zz))
    W.box(bm, P(0, 1.2, 1.6), (3.6, 3.0, 3.6), rot, 0)                                          # dark mouth (sunk into the hill)
    for sx in (-1.9, 1.9):
        W.box(bm, P(sx, -0.3, 1.8), (0.35, 0.35, 3.6), rot, 1)
    W.box(bm, P(0, -0.3, 3.7), (4.6, 0.45, 0.45), rot, 1)                                       # lintel
    for sx in (-0.45, 0.45):
        W.box(bm, P(sx, -5.5, 0.08), (0.08, 11.0, 0.08), rot, 2)                                # rails
    for k in range(12):
        W.box(bm, P(0, -0.6 - k * 0.9, 0.04), (1.4, 0.18, 0.06), rot, 1)                         # sleepers
    W.box(bm, P(0, -4.0, 0.6), (1.0, 1.4, 0.7), rot, 1)                                         # ore cart
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=4.5, radius2=0.6, depth=2.4, matrix=Matrix.Translation(P(3.5, -10.5, 0.9)))
    _tag(res, 3)
    mats = [W.flat_mat('adit', (0.01, 0.01, 0.01, 1), 1.0) if 'adit' not in bpy.data.materials else bpy.data.materials['adit'],
            M('wood'), A._mat('iron', W.srgb('#3a3a3c'), 0.5, 0.8), A._mat('ore', W.srgb('#3f3a38'), 0.85)]
    return W.mesh_ob('mine', bm, mats, coll)

def depot(at, rot=0.0, coll=None, nation='aster'):
    """A long timber warehouse by the road, a loading yard of crates and barrels, the nation's banner."""
    bm = bmesh.new(); z = W.ground(at.x, at.y)
    R = Matrix.Rotation(rot, 3, 'Z'); P = lambda x, y, zz: Vector((at.x, at.y, z)) + R @ Vector((x, y, zz))
    W.house(bm, P(0, 0, 0), 16, 8, 4.5, rot, 1, timber=True, chimney=False, rng=random.Random(9))
    rng = random.Random(4)
    for k in range(16):
        x = rng.uniform(-7, 7); y = rng.uniform(-7.5, -4.8); h = rng.choice((0.6, 0.6, 1.2))
        W.box(bm, P(x, y, h / 2), (0.9, 0.9, h), rot + rng.uniform(-0.2, 0.2), 3)
    mats = [M('plaster'), M('thatch'), M('tiles'), M('wood'), M('beam'), M('window'), M('window_lit')]
    ob = W.mesh_ob('depot', bm, mats, coll)
    A.banner(nation, P(-8.5, -5.5, 0), 6.0, size=(1.6, 1.1))
    return ob

# ------------------------------------------------------------------ fire and routes
def fire_mat():
    m = bpy.data.materials.get('fire')
    if m: return m
    m = bpy.data.materials.new('fire'); m.use_nodes = True; nt = m.node_tree; L = nt.links
    out = nt.nodes['Material Output']; nt.nodes.remove(nt.nodes['Principled BSDF'])
    vol = nt.nodes.new('ShaderNodeVolumePrincipled'); vol.inputs['Color'].default_value = (0.06, 0.05, 0.05, 1)
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Generated'], sep.inputs[0])
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.name = 'FIRENOISE'; nz.noise_dimensions = '4D'
    nz.inputs['Scale'].default_value = 3.5; nz.inputs['Detail'].default_value = 7; nz.inputs['Distortion'].default_value = 1.2
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    def m_(op, a, b=None):
        n = nt.nodes.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, b)):
            if v is None: continue
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: L.new(v, n.inputs[i])
        return n.outputs[0]
    zz = sep.outputs['Z']
    dx = m_('SUBTRACT', sep.outputs['X'], 0.5); dy = m_('SUBTRACT', sep.outputs['Y'], 0.5)
    r = m_('SQRT', m_('ADD', m_('MULTIPLY', dx, dx), m_('MULTIPLY', dy, dy)))
    radius = m_('SUBTRACT', 0.48, m_('MULTIPLY', zz, 0.38))                      # a tongue narrowing upward
    core = m_('MAXIMUM', 0.0, m_('SUBTRACT', 1.0, m_('DIVIDE', r, radius)))
    flick = m_('MAXIMUM', 0.0, m_('SUBTRACT', m_('MULTIPLY', nz.outputs['Fac'], 1.9), 0.55))
    heat = m_('MULTIPLY', m_('MULTIPLY', core, flick), m_('POWER', m_('SUBTRACT', 1.0, zz), 1.6))
    L.new(m_('MULTIPLY', heat, 3.0), vol.inputs['Density'])
    ramp = nt.nodes.new('ShaderNodeValToRGB'); e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (0.0, 0.0, 0.0, 1); e[1].position = 0.6; e[1].color = (1.0, 0.85, 0.45, 1)
    mid = e.new(0.2); mid.color = (0.9, 0.22, 0.02, 1)
    L.new(heat, ramp.inputs['Fac']); L.new(ramp.outputs['Color'], vol.inputs['Emission Color'])
    st = nt.nodes.new('ShaderNodeValue'); st.name = 'FIRESTR'; st.outputs[0].default_value = 40.0
    L.new(m_('MULTIPLY', heat, st.outputs[0]), vol.inputs['Emission Strength'])
    L.new(vol.outputs[0], out.inputs['Volume'])
    return m

def fire(at, size=(3.0, 3.0, 4.5), name='fire', smoke=True, light=1800):
    """A burning heap: a volume of flame, black smoke rising from it, and orange light on the surroundings."""
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.5))
    ob = W.mesh_ob(name, bm, [fire_mat()]); ob.location = at; ob.scale = size
    ld = bpy.data.lights.new(name + '_l', 'POINT'); ld.energy = light; ld.color = (1.0, 0.42, 0.12); ld.shadow_soft_size = 1.0
    lo = bpy.data.objects.new(name + '_l', ld); lo.location = at + Vector((0, 0, size[2] * 0.4)); bpy.context.scene.collection.objects.link(lo)
    if smoke:
        import stage as S
        p = S.plume(at + Vector((0, 0, size[2] * 0.6)), height=size[2] * 7, width=size[0] * 5.0, wind=0.4, name=name + '_smoke')
        sm = bpy.data.materials.get('plume_black')
        if sm is None:
            sm = bpy.data.materials['plume'].copy(); sm.name = 'plume_black'
            for n in sm.node_tree.nodes:
                if n.type == 'PRINCIPLED_VOLUME':
                    n.inputs['Color'].default_value = W.srgb('#1c1a18'); n.inputs['Absorption Color'].default_value = (0.02, 0.02, 0.02, 1)
            sm.node_tree.nodes['PLUMEDENS'].outputs[0].default_value = 10.0
        p.data.materials[0] = sm
    return ob

def route_mat(nation):
    name = f'route_{nation}'
    m = bpy.data.materials.get(name)
    if m: return m
    col = (0.30, 0.07, 0.06, 1) if nation == 'aster' else (0.42, 0.2, 0.05, 1)
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; L = nt.links
    b = nt.nodes['Principled BSDF']; out = nt.nodes['Material Output']
    b.inputs['Base Color'].default_value = col; b.inputs['Roughness'].default_value = 1.0
    b.inputs['Emission Color'].default_value = col; b.inputs['Emission Strength'].default_value = 0.0
    tc = nt.nodes.new('ShaderNodeTexCoord'); nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.9; nz.inputs['Detail'].default_value = 6
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].position = 0.42; ramp.color_ramp.elements[1].position = 0.56
    L.new(nz.outputs['Fac'], ramp.inputs['Fac'])
    tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mix = nt.nodes.new('ShaderNodeMixShader')
    L.new(ramp.outputs['Color'], mix.inputs['Fac']); L.new(tr.outputs[0], mix.inputs[1]); L.new(b.outputs[0], mix.inputs[2])
    L.new(mix.outputs[0], out.inputs['Surface'])
    return m

def route(pts, nation, start=0.0, length=None, width=0.7, dash=4.0, gap=3.0, name='route', side=0.0):
    """A dashed trail painted along a road: who supplies whom, readable from above."""
    at, total = path_at(pts); end = total if length is None else min(total, start + length)
    bm = bmesh.new(); s = start
    while s < end - 0.5:
        a, b = s, min(end, s + dash); ring = []
        for t in (a, (a + b) / 2, b):
            p, d = at(t); n = Vector((-d.y, d.x)); c = p + n * side
            for q in (c - n * width / 2, c + n * width / 2): ring.append(bm.verts.new((q.x, q.y, W.ground(q.x, q.y) + 0.3)))
        for k in (0, 2): bm.faces.new((ring[k], ring[k + 1], ring[k + 3], ring[k + 2]))
        s += dash + gap
    return W.mesh_ob(name, bm, [route_mat(nation)])

def clear_vegetation(centers=(), corridors=(), keep_rocks=False):
    """Clear scattered trees (and rocks) from staged spots: centers = [(xy, radius)], corridors = [(points, half_width)]."""
    gone = 0
    for o in list(bpy.context.scene.objects):
        ic = o.instance_collection
        if not ic or not ic.name.startswith('V_'): continue
        if keep_rocks and ('rock' in ic.name or 'boulder' in ic.name or 'cliff' in ic.name): continue
        p = o.location.xy
        hit = any((p - Vector(c[:2])).length < r for c, r in centers) or any(W.path_dist(p, pts) < hw for pts, hw in corridors)
        if hit: bpy.data.objects.remove(o); gone += 1
    return gone

def clear_rocks(center, radius):
    """Remove the big cliff and boulder pieces near a staged spot (they read as floating slabs up close)."""
    for o in list(bpy.context.scene.objects):
        ic = o.instance_collection
        if ic and ('cliff' in ic.name or 'drone_rock' in ic.name or 'boulder' in ic.name) and (o.location.xy - Vector(center[:2])).length < radius:
            bpy.data.objects.remove(o)

def clear_view(cam, target, near=6.0, far=0.0, upto=0.8):
    """Keep the camera's sight line open: remove trees and rocks within a corridor from the camera toward the target,
    `near` metres wide at the lens widening by `far` per metre, for the first `upto` fraction of the way."""
    c = Vector(cam[:2]); t = Vector(target[:2]); L = (t - c).length; d = (t - c).normalized()
    for o in list(bpy.context.scene.objects):
        ic = o.instance_collection
        if not ic or not ic.name.startswith('V_'): continue
        v = o.location.xy - c; s = v.dot(d)
        if s < -4 or s > L * upto: continue
        if abs(v.x * d.y - v.y * d.x) < near + far * max(0.0, s): bpy.data.objects.remove(o)

def sky_water():
    """Water seen from above: show the sky in it instead of the dark bed below."""
    wm = bpy.data.materials['water'].node_tree.nodes['Principled BSDF']
    wm.inputs['Transmission Weight'].default_value = 0.2; wm.inputs['Base Color'].default_value = W.srgb('#3f6461'); wm.inputs['Roughness'].default_value = 0.06

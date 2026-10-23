# Staging shared by the pieces: the battle on the pass road, columns, dust, smoke, torches.
import bpy, bmesh, math, random
from mathutils import Vector, Matrix
import world as W
import army as A

def dust_mat():
    m = bpy.data.materials.get('dust')
    if m: return m
    m = bpy.data.materials.new('dust'); m.use_nodes = True; nt = m.node_tree; L = nt.links
    out = nt.nodes['Material Output']; nt.nodes.remove(nt.nodes['Principled BSDF'])
    vol = nt.nodes.new('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = W.srgb('#b9a17c'); vol.inputs['Anisotropy'].default_value = 0.4
    tc = nt.nodes.new('ShaderNodeTexCoord'); nz = nt.nodes.new('ShaderNodeTexNoise'); nz.name = 'DUSTNOISE'
    nz.noise_dimensions = '4D'; nz.inputs['Scale'].default_value = 0.18; nz.inputs['Detail'].default_value = 5
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    # thicker near the ground, fading with height and toward the edges of the box
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Generated'], sep.inputs[0])
    def m_(op, a, b=None):
        n = nt.nodes.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, b)):
            if v is None: continue
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: L.new(v, n.inputs[i])
        return n.outputs[0]
    hz = m_('POWER', m_('SUBTRACT', 1, sep.outputs['Z']), 2.2)
    ex = m_('MULTIPLY', m_('SUBTRACT', 1, m_('ABSOLUTE', m_('MULTIPLY', m_('SUBTRACT', sep.outputs['X'], 0.5), 2))),
            m_('SUBTRACT', 1, m_('ABSOLUTE', m_('MULTIPLY', m_('SUBTRACT', sep.outputs['Y'], 0.5), 2))))
    dens = m_('MULTIPLY', m_('MULTIPLY', m_('MAXIMUM', 0, m_('SUBTRACT', nz.outputs['Fac'], 0.42)), hz), m_('POWER', m_('MAXIMUM', 0, ex), 0.6))
    dv = nt.nodes.new('ShaderNodeValue'); dv.name = 'DUSTDENS'; dv.outputs[0].default_value = 0.35
    L.new(m_('MULTIPLY', dens, dv.outputs[0]), vol.inputs['Density'])
    L.new(vol.outputs[0], out.inputs['Volume'])
    return m

def dust(center, size=(80, 40, 14), rot=0.0, density=0.35, name='dust'):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    ob = W.mesh_ob(name, bm, [dust_mat()])
    ob.location = (center.x, center.y, W.ground(center.x, center.y) + size[2] / 2 - 1.5); ob.scale = size; ob.rotation_euler = (0, 0, rot)
    bpy.data.materials['dust'].node_tree.nodes['DUSTDENS'].outputs[0].default_value = density
    return ob

def battle(lib, ranks=8, files=26, gap=2.6, seed=0, axis=None, ban_depth=None, ban_sides=None, ban_h=6.5):
    """Aster and Fjordal lines meeting across the pass road at BATTLE. Aster comes from the west (faces east)."""
    c = W.BATTLE.to_3d()
    axis = (axis or Vector((1, 0.18, 0))).normalized()       # Aster's direction of advance (default: along the road)
    face_e = math.atan2(axis.x, -axis.y)                     # facing along +axis
    face_w = face_e + math.pi
    a_c = c - axis * (gap / 2 + ranks * 1.15 * 1.05 / 2)
    f_c = c + axis * (gap / 2 + ranks * 1.15 * 1.05 / 2)
    a = A.formation(lib, 'aster', a_c + axis * (ranks * 0.6), face_e, ranks, files, poses=('brace', 'march', 'brace'), seed=seed + 1, front_pose='thrust')
    f = A.formation(lib, 'fjordal', f_c - axis * (ranks * 0.6), face_w, ranks, files, poses=('brace', 'march', 'brace'), seed=seed + 2, front_pose='thrust')
    bans = []
    side = Vector((-axis.y, axis.x, 0))
    # banners: by default behind each block; ban_depth (metres from the clash line) pulls them into the ranks
    for i, k in enumerate(ban_sides or (-files * 0.38, 0, files * 0.38)):
        for nation, sgn, cc in (('aster', -1, a_c), ('fjordal', 1, f_c)):
            base = (c + axis * sgn * ban_depth) if ban_depth is not None else (cc + axis * sgn * ranks * 0.9)
            p = base + side * (k + sgn * 0.7 * i)
            bans.append(A.banner(nation, Vector((p.x, p.y, W.ground(p.x, p.y))), ban_h, size=(2.2, 1.6)))
    return a, f, bans, axis

def column(lib, nation, pts, n=120, files=4, spacing=1.2, seed=0, start=0.0, pose='march'):
    """A marching column along a polyline, starting `start` metres along it."""
    rng = random.Random(seed); obs = []
    segs = list(zip(pts, pts[1:])); lens = [(b - a).length for a, b in segs]; total = sum(lens)
    def at(s):
        s = max(0.0, min(total - 0.01, s))
        for (a, b), l in zip(segs, lens):
            if s <= l: return a + (b - a) * (s / l), (b - a).normalized()
            s -= l
    for i in range(n):
        rank, fl = divmod(i, files)
        p, d = at(start - rank * spacing * 1.1)
        side = Vector((-d.y, d.x))
        q = p + side * (fl - (files - 1) / 2) * spacing + Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15)))
        o = bpy.data.objects.new('s', None); o.instance_type = 'COLLECTION'; o.instance_collection = rng.choice(lib[(nation, pose)])
        o.location = (q.x, q.y, W.ground(q.x, q.y)); o.rotation_euler = (0, 0, math.atan2(d.x, -d.y) + rng.uniform(-0.08, 0.08))
        bpy.context.scene.collection.objects.link(o); obs.append(o)
    return obs, at

def smoke(at, height=18, name='smoke', density=0.6):
    m = bpy.data.materials.get('smoke')
    if not m:
        m = dust_mat().copy(); m.name = 'smoke'
        m.node_tree.nodes['Volume Principled' if 'Volume Principled' in m.node_tree.nodes else [n.name for n in m.node_tree.nodes if n.type == 'PRINCIPLED_VOLUME'][0]].inputs['Color'].default_value = W.srgb('#8e8a84')
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    ob = W.mesh_ob(name, bm, [m]); ob.location = (at.x, at.y, at.z + height / 2); ob.scale = (5, 5, height)
    m.node_tree.nodes['DUSTDENS'].outputs[0].default_value = density
    return ob

def plume_mat():
    """Chimney smoke: a plume that leaves the flue thin and dense, widens and thins as it rises, broken by
    fine turbulent noise. Drawn inside a box whose origin sits on the chimney top (generated z 0 → 1 upward)."""
    m = bpy.data.materials.get('plume')
    if m: return m
    m = bpy.data.materials.new('plume'); m.use_nodes = True; nt = m.node_tree; L = nt.links
    out = nt.nodes['Material Output']; nt.nodes.remove(nt.nodes['Principled BSDF'])
    vol = nt.nodes.new('ShaderNodeVolumePrincipled'); vol.inputs['Color'].default_value = W.srgb('#a89f94'); vol.inputs['Anisotropy'].default_value = 0.55
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Generated'], sep.inputs[0])
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.name = 'PLUMENOISE'; nz.noise_dimensions = '4D'
    nz.inputs['Scale'].default_value = 5.0; nz.inputs['Detail'].default_value = 8; nz.inputs['Roughness'].default_value = 0.65
    nz.inputs['Distortion'].default_value = 0.8
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    def m_(op, a, b=None):
        n = nt.nodes.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, b)):
            if v is None: continue
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: L.new(v, n.inputs[i])
        return n.outputs[0]
    z = sep.outputs['Z']
    # the plume drifts downwind (+x of the box) as it rises, and its radius grows from 0.06 to 0.45 of the box
    cx = m_('ADD', 0.5, m_('MULTIPLY', m_('POWER', z, 1.5), 0.28)); cx = m_('SUBTRACT', cx, 0.14)
    dx = m_('SUBTRACT', sep.outputs['X'], cx); dy = m_('SUBTRACT', sep.outputs['Y'], 0.5)
    r = m_('SQRT', m_('ADD', m_('MULTIPLY', dx, dx), m_('MULTIPLY', dy, dy)))
    rad = m_('ADD', 0.05, m_('MULTIPLY', z, 0.32))
    core = m_('MAXIMUM', 0.0, m_('SUBTRACT', 1.0, m_('DIVIDE', r, rad)))
    fade = m_('MULTIPLY', m_('POWER', m_('SUBTRACT', 1.0, z), 1.4), m_('MINIMUM', 1.0, m_('MULTIPLY', z, 25.0)))
    turb = m_('POWER', m_('MAXIMUM', 0.0, m_('SUBTRACT', m_('MULTIPLY', nz.outputs['Fac'], 1.8), 0.62)), 1.5)
    dens = m_('MULTIPLY', m_('MULTIPLY', m_('POWER', core, 1.1), fade), m_('ADD', 0.05, turb))
    dv = nt.nodes.new('ShaderNodeValue'); dv.name = 'PLUMEDENS'; dv.outputs[0].default_value = 6.0
    L.new(m_('MULTIPLY', dens, dv.outputs[0]), vol.inputs['Density'])
    L.new(vol.outputs[0], out.inputs['Volume'])
    return m

def plume(at, height=24.0, width=9.0, wind=0.0, name='plume'):
    """One chimney plume rising from `at`; `wind` is the downwind heading in radians."""
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.5))           # origin at the bottom face
    ob = W.mesh_ob(name, bm, [plume_mat()])
    ob.location = at; ob.scale = (width, width, height); ob.rotation_euler = (0, 0, wind)
    return ob

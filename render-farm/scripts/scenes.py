# Small builders shared by the v2 stills and trailer: hamlets, crop fields, palisades.
import bpy, bmesh, math, random
from mathutils import Vector, Matrix
import world as W
import army as A
import props as P

def hamlet(center, n=9, radius=22, nation='aster', seed=0, coll=None, banner=True, roof=None, lit=False):
    """A cluster of timber and stone houses around a little green, roofs in the nation's tile, a banner."""
    rng = random.Random(seed); bm = bmesh.new(); placed = []
    roof_idx = 2
    for k in range(400):
        if len(placed) >= n: break
        a = rng.uniform(0, math.tau); r = radius * math.sqrt(rng.uniform(0.15, 1.0))
        p = center + Vector((math.cos(a), math.sin(a))) * r
        w, d = rng.uniform(5.5, 8.5), rng.uniform(4.5, 6.5)
        if any((p - q).length < (w + qw) * 0.62 for q, qw in placed): continue
        placed.append((p, w))
        rot = math.atan2(p.y - center.y, p.x - center.x) + math.pi / 2 + rng.uniform(-0.25, 0.25)
        W.house(bm, Vector((p.x, p.y, W.ground(p.x, p.y))), w, d, rng.uniform(4.0, 6.0), rot, roof_idx if rng.random() < 0.75 else 6,
                timber=rng.random() < 0.7, rng=rng)
    tiles = roof or (P.M('tiles') if nation == 'aster' else P.M('tiles_fj'))
    win = P.M('window_lit') if lit else P.M('window')
    ob = W.mesh_ob(f'hamlet_{seed}', bm, [P.M('plaster'), P.M('stone'), tiles, P.M('beam'), P.M('window'), win, P.M('thatch'), P.M('wood')], coll)
    if banner:
        A.banner(nation, Vector((center.x, center.y, W.ground(center.x, center.y))), 7.0, size=(1.8, 1.3))
    return ob, placed

def crop_mat(seed=0):
    name = f'crops_{seed}'
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; L = nt.links; b = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord'); wv = nt.nodes.new('ShaderNodeTexWave'); wv.wave_type = 'BANDS'
    wv.inputs['Scale'].default_value = 0.35; wv.inputs['Distortion'].default_value = 0.4; wv.inputs['Detail'].default_value = 3
    L.new(tc.outputs['Object'], wv.inputs['Vector'])
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.08; nz.inputs['Detail'].default_value = 5; L.new(tc.outputs['Object'], nz.inputs['Vector'])
    pal = [('#c8ab52', '#6e5a2a'), ('#86a442', '#3f5a1f'), ('#d6be6a', '#7d6634'), ('#7c6a44', '#3f3220'), ('#a7b04e', '#55622a')][seed % 5]
    ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].color = W.srgb(pal[1]); ramp.color_ramp.elements[1].color = W.srgb(pal[0])
    mix = nt.nodes.new('ShaderNodeMath'); mix.operation = 'MULTIPLY'
    L.new(wv.outputs['Fac'], mix.inputs[0]); L.new(nz.outputs['Fac'], mix.inputs[1])
    L.new(mix.outputs[0], ramp.inputs['Fac']); L.new(ramp.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.9
    bp = nt.nodes.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = 1.0
    L.new(wv.outputs['Fac'], bp.inputs['Height']); L.new(bp.outputs[0], b.inputs['Normal'])
    return m

def field(center, size, rot, seed=0, coll=None):
    """A crop field that drapes over the ground: furrows in the nation's farmland colours."""
    bm = bmesh.new(); nx, ny = 12, 12
    R = Matrix.Rotation(rot, 3, 'Z')
    g = [[None] * (nx + 1) for _ in range(ny + 1)]
    for j in range(ny + 1):
        for i in range(nx + 1):
            p = center + (R @ Vector(((i / nx - 0.5) * size[0], (j / ny - 0.5) * size[1], 0))).xy
            g[j][i] = bm.verts.new((p.x, p.y, W.ground(p.x, p.y) + 0.12))
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]))
    return W.mesh_ob(f'field_{seed}', bm, [crop_mat(seed)], coll)

def palisade(center, radius, gaps=(), coll=None, seg=40):
    """A ring of sharpened stakes, with gaps (angles in radians) for the gates."""
    bm = bmesh.new()
    for k in range(seg * 3):
        a = k / (seg * 3) * math.tau
        if any(abs(((a - g) + math.pi) % math.tau - math.pi) < 0.12 for g in gaps): continue
        p = center + Vector((math.cos(a), math.sin(a))) * radius; z = W.ground(p.x, p.y)
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.22, radius2=0.22, depth=3.2, matrix=Matrix.Translation((p.x, p.y, z + 1.2)))
        tip = bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.22, radius2=0.0, depth=0.5, matrix=Matrix.Translation((p.x, p.y, z + 3.05)))
    return W.mesh_ob('palisade', bm, [P.M('wood')], coll)

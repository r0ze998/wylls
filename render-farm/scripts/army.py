# Soldiers: one modelled trooper per nation and pose, instanced into formations; banners with the nations' signs.
# Aster: red tabard over mail, steel kettle helm, round red shield with a white circle.
# Fjordal: orange surcoat with fur collar, dark spectacle helm, round orange shield with a white hexagon outline.
import bpy, bmesh, math, random, os
from mathutils import Vector, Matrix
import world as W

def _mat(name, col, rough=0.6, metal=0.0, sheen=0.0):
    """Worn, used materials: per-soldier tone variation (object random), grime in the crevices, fine surface bump."""
    if name in bpy.data.materials: return bpy.data.materials[name]
    m = W.flat_mat(name, col, rough, metal, sheen=sheen); nt = m.node_tree; L = nt.links; b = nt.nodes['Principled BSDF']
    oi = nt.nodes.new('ShaderNodeObjectInfo'); tc = nt.nodes.new('ShaderNodeTexCoord')
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 9.0; nz.inputs['Detail'].default_value = 6
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    var = nt.nodes.new('ShaderNodeMapRange'); var.inputs[3].default_value = 0.78; var.inputs[4].default_value = 1.12
    L.new(oi.outputs['Random'], var.inputs[0])
    tone = nt.nodes.new('ShaderNodeMix'); tone.data_type = 'RGBA'; tone.blend_type = 'MULTIPLY'; tone.inputs['Factor'].default_value = 1.0
    tone.inputs[6].default_value = col
    vc = nt.nodes.new('ShaderNodeCombineColor'); L.new(var.outputs[0], vc.inputs[0]); L.new(var.outputs[0], vc.inputs[1]); L.new(var.outputs[0], vc.inputs[2])
    L.new(vc.outputs[0], tone.inputs[7])
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion'); ao.inputs['Distance'].default_value = 0.12
    L.new(tone.outputs[2], ao.inputs['Color'])
    grime = nt.nodes.new('ShaderNodeMix'); grime.data_type = 'RGBA'; grime.blend_type = 'MULTIPLY'; grime.inputs['Factor'].default_value = 0.55
    L.new(tone.outputs[2], grime.inputs[6])
    aoc = nt.nodes.new('ShaderNodeCombineColor')
    for i in range(3): L.new(ao.outputs['AO'], aoc.inputs[i])
    L.new(aoc.outputs[0], grime.inputs[7])
    dirt = nt.nodes.new('ShaderNodeMix'); dirt.data_type = 'RGBA'; dirt.blend_type = 'MULTIPLY'; dirt.inputs['Factor'].default_value = 0.3
    L.new(grime.outputs[2], dirt.inputs[6]); L.new(nz.outputs['Color'], dirt.inputs[7])
    L.new(dirt.outputs[2], b.inputs['Base Color'])
    rr = nt.nodes.new('ShaderNodeMapRange'); rr.inputs[3].default_value = rough * 0.75; rr.inputs[4].default_value = min(1.0, rough * 1.25)
    L.new(nz.outputs['Fac'], rr.inputs[0]); L.new(rr.outputs[0], b.inputs['Roughness'])
    bp = nt.nodes.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.25
    n2 = nt.nodes.new('ShaderNodeTexNoise'); n2.inputs['Scale'].default_value = 60.0
    L.new(tc.outputs['Object'], n2.inputs['Vector']); L.new(n2.outputs['Fac'], bp.inputs['Height']); L.new(bp.outputs[0], b.inputs['Normal'])
    return m

def shield_mat(nation):
    """A painted shield: the nation's field, a darker rim and the white sign (circle or hexagon outline)."""
    name = f'shield_{nation}'
    if name in bpy.data.materials: return bpy.data.materials[name]
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; L = nt.links
    b = nt.nodes['Principled BSDF']; b.inputs['Roughness'].default_value = 0.45
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Generated'], sep.inputs[0])
    def mm(op, a, bb=None):
        n = nt.nodes.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, bb)):
            if v is None: continue
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: L.new(v, n.inputs[i])
        return n.outputs[0]
    x = mm('SUBTRACT', sep.outputs['X'], 0.5); z = mm('SUBTRACT', sep.outputs['Z'], 0.5)
    r = mm('SQRT', mm('ADD', mm('MULTIPLY', x, x), mm('MULTIPLY', z, z)))
    field = W.ASTER if nation == 'aster' else W.FJORDAL
    rim = tuple(c * 0.45 for c in field[:3]) + (1,)
    white = (0.86, 0.82, 0.74, 1)
    if nation == 'aster':
        sign = mm('LESS_THAN', r, 0.17)
    else:
        ax, az = mm('ABSOLUTE', x), mm('ABSOLUTE', z)
        hd = mm('MAXIMUM', mm('ADD', mm('MULTIPLY', ax, 0.5), mm('MULTIPLY', az, math.sqrt(3) / 2)), ax)
        sign = mm('MULTIPLY', mm('LESS_THAN', hd, 0.2), mm('GREATER_THAN', hd, 0.12))
    is_rim = mm('GREATER_THAN', r, 0.43)
    c1 = nt.nodes.new('ShaderNodeMix'); c1.data_type = 'RGBA'; L.new(sign, c1.inputs['Factor']); c1.inputs[6].default_value = field; c1.inputs[7].default_value = white
    c2 = nt.nodes.new('ShaderNodeMix'); c2.data_type = 'RGBA'; L.new(is_rim, c2.inputs['Factor']); L.new(c1.outputs[2], c2.inputs[6]); c2.inputs[7].default_value = rim
    # wear: a little dirt
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 18
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    c3 = nt.nodes.new('ShaderNodeMix'); c3.data_type = 'RGBA'; c3.blend_type = 'MULTIPLY'; c3.inputs['Factor'].default_value = 0.35
    L.new(c2.outputs[2], c3.inputs[6]); L.new(nz.outputs['Color'], c3.inputs[7])
    L.new(c3.outputs[2], b.inputs['Base Color'])
    return m

def _cyl(bm, p0, p1, r0, r1, seg=10):
    """A capped tube with extra rings near both ends, so that one level of subdivision keeps its length and
    radius (a plain two-ring cylinder shrinks into a lozenge and pulls away from what it should touch)."""
    p0, p1 = Vector(p0), Vector(p1); d = p1 - p0
    M = Matrix.Translation(p0) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    L = d.length; e = min(0.03, L * 0.1)
    rings = []
    for z, kr in ((0, 0.0), (0, 0.7), (0, 1.0), (e, 1.0), (L / 2, 1.0), (L - e, 1.0), (L, 1.0), (L, 0.7), (L, 0.0)):
        r = (r0 + (r1 - r0) * (z / L)) * kr
        if kr == 0.0: rings.append([bm.verts.new(M @ Vector((0, 0, z)))]); continue
        rings.append([bm.verts.new(M @ Vector((r * math.cos(a), r * math.sin(a), z))) for a in (2 * math.pi * k / seg for k in range(seg))])
    for ra, rb in zip(rings, rings[1:]):
        for k in range(seg):
            if len(ra) == 1: bm.faces.new((ra[0], rb[(k + 1) % seg], rb[k]))
            elif len(rb) == 1: bm.faces.new((ra[k], ra[(k + 1) % seg], rb[0]))
            else: bm.faces.new((ra[k], ra[(k + 1) % seg], rb[(k + 1) % seg], rb[k]))
    return {'verts': [v for r in rings for v in r]}

def _sph(bm, c, r, s=(1, 1, 1), sub=2):
    res = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    for v in res['verts']: v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2])) + Vector(c)
    return res

def _tag(res, idx):
    vs = res['verts']
    for f in {f for v in vs for f in v.link_faces}: f.material_index = idx


# ------------------------------------------------------------------ characters: about 2.5 heads tall, each with a face
SKINS = ['#f1c9a5', '#d9a57e', '#b57a52', '#8a5636', '#5e3a24']
HAIRS = ['#2b1d14', '#5a3720', '#8c5a2e', '#c99a58', '#e0c690', '#7a2e1a', '#bfb8ae']

def _ell(bm, c, r, s=(1, 1, 1), sub=3):
    return _sph(bm, c, r, s, sub)

def character(nation, pose, variant, coll):
    """A chibi soldier, feet at the origin, facing -y, ~1.8 m tall with a head about 0.72 m.
    variant (0..5) picks face, beard, hair, build and helm details, so every file of a formation differs.
    Materials: 0 cloth, 1 steel, 2 skin, 3 leather, 4 wood, 5 shield, 6 fur, 7 hair, 8 eye white, 9 iris,
    10 mouth, 11 gold, 12 cloth dark, 13 cheek."""
    rng = random.Random((0 if nation == 'aster' else 1000) + variant * 7 + 3)
    bm = bmesh.new()
    lean = {'march': 0.04, 'brace': 0.14, 'thrust': 0.3}[pose]
    stride = {'march': 0.1, 'brace': 0.2, 'thrust': 0.3}[pose]
    build = [1.0, 1.12, 0.92, 1.05, 1.18, 0.96][variant % 6]          # stocky to slight
    HIP = 0.5
    def P(x, y, z):
        v = Vector((x, y, z - HIP)); v.rotate(Matrix.Rotation(-lean, 3, 'X')); return v + Vector((0, 0, HIP))
    # legs: short and sturdy, big boots
    for sgn, fw in ((-1, stride), (1, -stride * 0.6)):
        _tag(_cyl(bm, (sgn * 0.11, -fw * 0.4, HIP), (sgn * 0.12, -fw, 0.16), 0.13 * build, 0.11), 12)
        _tag(_ell(bm, (sgn * 0.13, -fw - 0.05, 0.08), 0.11, (1.0, 1.45, 0.75)), 3)
    # body: a barrel of mail under the tabard / surcoat
    bw = 0.27 * build
    _tag(_ell(bm, P(0, 0, 0.82), bw, (1.0, 0.82, 1.15)), 1)
    _tag(_ell(bm, P(0, 0.0, 0.8), bw * 1.05, (0.96, 0.85, 1.12)), 0)          # tabard all round, so the nation reads from behind
    _tag(_ell(bm, P(0, bw * 0.7, 0.8), bw * 1.08, (0.98, 0.3, 1.25)), 0)       # short cape down the back
    _tag(_cyl(bm, P(0, bw * 0.78, 0.48), P(0, bw * 0.84, 0.53), bw * 0.95, bw * 0.95, 16), 12)   # its dark hem
    _tag(_cyl(bm, P(0, -0.01, 0.42), P(0, -0.01, 0.74), bw * 1.18, bw * 1.0, 16), 0)      # skirts
    _tag(_cyl(bm, P(0, 0, 0.6), P(0, 0, 0.67), bw * 1.07, bw * 1.07, 18), 3)              # belt
    _tag(_ell(bm, P(0, -bw * 1.02, 0.635), 0.045, (1.2, 0.5, 1.0)), 11)                   # buckle
    if nation == 'aster':      # the gold keystone on the tabard
        ks = bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=0.085, radius2=0.06, depth=0.02,
                                   matrix=Matrix.Translation(P(0, -bw * 0.86 - 0.012, 0.86)) @ Matrix.Rotation(math.pi / 2, 4, 'X') @ Matrix.Rotation(math.pi / 4, 4, 'Z'))
        _tag(ks, 11)
    else:                      # fur collar, iron-ringed belt
        _tag(_ell(bm, P(0, 0.0, 1.06), 0.3 * build, (1.1, 1.0, 0.42)), 6)
    for sgn in (-1, 1):        # pauldrons
        _tag(_ell(bm, P(sgn * bw * 1.02, 0, 1.0), 0.13, (1.1, 1.0, 0.8)), 1)
    # head: big, the soul of the character
    HC = P(0, -0.02, 1.38); hr = 0.33
    _tag(_ell(bm, HC, hr, (0.98, 0.95, 1.0), 4), 2)
    _tag(_ell(bm, HC + Vector((0, 0.07, 0.0)), hr * 1.02, (1.0, 1.0, 0.92)), 7)                  # hair at the back of the head
    for sgn in (-1, 1):
        _tag(_ell(bm, HC + Vector((sgn * hr * 0.97, 0.02, -0.02)), 0.07, (0.5, 0.8, 1.0)), 2)     # ears
    nose = [(0.07, (1.0, 1.0, 1.0)), (0.06, (0.9, 1.1, 1.3)), (0.085, (1.1, 1.0, 0.9)), (0.065, (0.8, 1.2, 1.2))][variant % 4]
    _tag(_ell(bm, HC + Vector((0, -hr * 0.97, -0.04)), nose[0], nose[1]), 2)
    for sgn in (-1, 1):
        _tag(_ell(bm, HC + Vector((sgn * 0.17, -hr * 0.8, -0.1)), 0.06, (1.0, 0.4, 0.7)), 13)    # cheeks
    # eyes: whites, irises with a glint; brows set the mood
    eye_y = -hr * 0.86; eye_z = 0.04; eye_x = 0.12
    mood = {'march': [0.0, 0.15, -0.1, 0.25, 0.05, 0.3][variant % 6], 'brace': 0.35, 'thrust': 0.6}[pose]
    for sgn in (-1, 1):
        ec = HC + Vector((sgn * eye_x, eye_y, eye_z))
        _tag(_ell(bm, ec, 0.072, (1.0, 0.45, 1.15 - 0.35 * mood)), 8)
        _tag(_ell(bm, ec + Vector((sgn * -0.01, -0.03, -0.005)), 0.04, (1.0, 0.4, 1.15 - 0.3 * mood)), 9)
        _tag(_ell(bm, ec + Vector((sgn * -0.025, -0.05, 0.02)), 0.012, (1, 0.5, 1)), 8)       # glint
        # brow: angled down toward the nose as anger rises
        inner = ec + Vector((-sgn * 0.035, -0.035, 0.085 - 0.05 * mood)); outer = ec + Vector((sgn * 0.07, -0.01, 0.1 + 0.02 * mood))
        _tag(_cyl(bm, inner, outer, 0.028, 0.022, 8), 7)
    # mouth: a firm line on the march, a shout in the push
    mz = -0.17; open_ = {'march': 0.0, 'brace': 0.25, 'thrust': 1.0}[pose]
    if open_ > 0.5:
        _tag(_ell(bm, HC + Vector((0, -hr * 0.9, mz)), 0.07, (1.1, 0.45, 0.8)), 10)
    else:
        _tag(_cyl(bm, HC + Vector((-0.06, -hr * 0.93, mz + 0.01 * variant % 2)), HC + Vector((0.06, -hr * 0.93, mz)), 0.016, 0.016, 6), 10)
    # beards and hair: Fjordal braided beards with iron rings; Aster short or clean
    beard = (['braid', 'braid', 'full', 'braid2', 'full', 'braid'] if nation == 'fjordal' else ['none', 'short', 'stubble', 'mous', 'none', 'short'])[variant % 6]
    if beard in ('full', 'braid', 'braid2'):
        _tag(_ell(bm, HC + Vector((0, -hr * 0.62, -0.2)), 0.24, (1.0, 0.65, 0.75)), 7)
        if beard.startswith('braid'):
            for sgn in ((0,) if beard == 'braid' else (-1, 1)):
                b0 = HC + Vector((sgn * 0.09, -hr * 0.85, -0.3)); b1 = b0 + Vector((0, -0.03, -0.32))
                _tag(_cyl(bm, b0, b1, 0.06, 0.035, 8), 7)
                _tag(_cyl(bm, b0.lerp(b1, 0.5), b0.lerp(b1, 0.62), 0.05, 0.05, 10), 1)          # iron ring
    elif beard == 'short':
        _tag(_ell(bm, HC + Vector((0, -hr * 0.66, -0.2)), 0.2, (1.05, 0.55, 0.55)), 7)
    elif beard == 'mous':
        for sgn in (-1, 1):
            _tag(_cyl(bm, HC + Vector((0, -hr * 0.98, -0.11)), HC + Vector((sgn * 0.13, -hr * 0.9, -0.17)), 0.025, 0.012, 8), 7)
    elif beard == 'stubble':
        _tag(_ell(bm, HC + Vector((0, -hr * 0.55, -0.16)), 0.25, (1.0, 0.62, 0.55)), 7)
    # headgear: Aster kettle helm with brim and nasal; Fjordal spectacle helm with a mail aventail
    if nation == 'aster':
        _tag(_ell(bm, HC + Vector((0, 0.02, 0.17)), hr * 1.05, (1.0, 1.0, 0.8)), 1)
        _tag(_cyl(bm, HC + Vector((0, 0.02, 0.15)), HC + Vector((0, 0.02, 0.175)), hr * 1.32, hr * 1.26, 28), 1)
        for sgn in (-1, 1): _tag(_ell(bm, HC + Vector((sgn * hr * 0.88, -0.05, 0.05)), 0.09, (0.6, 0.9, 1.2)), 7)   # hair below the helm
        ks = bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=0.05, radius2=0.035, depth=0.015,
                                   matrix=Matrix.Translation(HC + Vector((0, -hr * 0.95, 0.34))) @ Matrix.Rotation(math.pi / 2 - 0.5, 4, 'X') @ Matrix.Rotation(math.pi / 4, 4, 'Z'))
        _tag(ks, 13)    # the red-ochre keystone mark painted on the helm
    else:
        _tag(_ell(bm, HC + Vector((0, 0.01, 0.1)), hr * 1.06, (1.0, 1.0, 0.92)), 1)
        _tag(_ell(bm, HC + Vector((0, 0.06, -0.08)), hr * 1.1, (1.02, 0.95, 0.75)), 1)         # aventail at the back
        for sgn in (-1, 1):   # spectacle guard round the eyes
            c = HC + Vector((sgn * eye_x, eye_y - 0.035, eye_z + 0.01))
            tor = bmesh.ops.create_cone(bm, cap_ends=False, segments=16, radius1=0.1, radius2=0.1, depth=0.03,
                                        matrix=Matrix.Translation(c) @ Matrix.Rotation(math.pi / 2, 4, 'X'))
            _tag(tor, 1)
        _tag(_cyl(bm, HC + Vector((-0.02, -hr * 0.98, 0.05)), HC + Vector((0.02, -hr * 0.98, 0.05)), 0.03, 0.03, 6), 1)
        for k in range(3):   # iron-grey stripes under the eyes
            pass
    # arms and hands, posed
    if pose == 'march':
        sh_c = P(-0.42, -0.12, 0.76); sp_hand = P(0.36, -0.12, 0.72)
        spear = (sp_hand + Vector((0, 0.05, -0.65)), sp_hand + Vector((0, -0.08, 1.75)))
    elif pose == 'brace':
        sh_c = P(-0.16, -0.5, 0.8); sp_hand = P(0.3, -0.25, 0.86)
        spear = (sp_hand + Vector((0, 0.9, 0.2)), sp_hand + Vector((0, -2.0, -0.12)))
    else:
        sh_c = P(-0.2, -0.56, 0.86); sp_hand = P(0.24, -0.62, 0.95)
        spear = (sp_hand + Vector((0, 1.0, 0.0)), sp_hand + Vector((0, -2.0, -0.05)))
    for sgn, hand in ((-1, sh_c + Vector((0.1, 0.1, 0))), (1, sp_hand)):
        shoulder = P(sgn * bw * 1.05, 0, 0.98)
        elbow = shoulder.lerp(hand, 0.5) + Vector((sgn * 0.1, 0.06, -0.1))
        _tag(_cyl(bm, shoulder, elbow, 0.085, 0.075), 0)
        _tag(_cyl(bm, elbow, hand, 0.075, 0.065), 1)
        _tag(_ell(bm, hand, 0.08, (1.0, 1.0, 1.0)), 3)          # leather glove
    _tag(_cyl(bm, spear[0], spear[1], 0.028, 0.025, 8), 4)
    d = (spear[1] - spear[0]).normalized()
    _tag(_cyl(bm, spear[1], spear[1] + d * 0.3, 0.05, 0.0, 8), 1)
    # shield, held on the left arm, its face toward -y
    SR = Matrix.Rotation(math.pi / 2, 4, 'X') if pose != 'march' else Matrix.Rotation(-1.0, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'X')
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=28, radius1=0.42, radius2=0.39, depth=0.07,
                                matrix=Matrix.Translation(sh_c + Vector((0, -0.07, 0))) @ SR)
    _tag(res, 3)
    sb = bmesh.new()
    bmesh.ops.create_cone(sb, cap_ends=True, segments=40, radius1=0.43, radius2=0.43, depth=0.012,
                          matrix=Matrix.Translation(sh_c + (Vector((0, -0.11, 0)) if pose != 'march' else Vector((-0.03, -0.035, 0)))) @ SR)
    me_s = bpy.data.meshes.new(f'shieldface_{nation}_{pose}_{variant}'); sb.to_mesh(me_s); sb.free()
    me_s.materials.append(shield_mat(nation))
    sface = bpy.data.objects.new(me_s.name, me_s); coll.objects.link(sface)
    cloth = W.srgb('#9e1622') if nation == 'aster' else W.srgb('#d4650f')      # deeper than the UI swatches: they read true in strong sun
    skin = W.srgb(SKINS[(variant * 3 + (1 if nation == 'aster' else 0)) % len(SKINS)] if nation == 'aster' else SKINS[variant % 3])
    hair = W.srgb(HAIRS[(variant * 2) % len(HAIRS)] if nation == 'aster' else ['#d9c08a', '#b0703a', '#e6d8b0', '#8a5a30', '#c9a060', '#a4643a'][variant % 6])
    mats = [_mat(f'cloth_{nation}', cloth, 0.85, sheen=0.12),
            _mat('steel' if nation == 'aster' else 'darksteel', W.srgb('#a3a8ad') if nation == 'aster' else W.srgb('#5b5f64'), 0.55, 0.75),
            _skin(f'skin_{nation}_{variant}', skin), _mat('leather', W.srgb('#4a3020'), 0.6), _mat('spearwood', W.srgb('#6b4a2e'), 0.7),
            shield_mat(nation), _mat('fur', W.srgb('#7a6248'), 0.95, sheen=0.8), _mat(f'hair_{nation}_{variant}', hair, 0.55, sheen=0.3),
            W.flat_mat('eyewhite', W.srgb('#f2eee6'), 0.25) if 'eyewhite' not in bpy.data.materials else bpy.data.materials['eyewhite'],
            W.flat_mat('iris', W.srgb('#1c1a1a'), 0.1) if 'iris' not in bpy.data.materials else bpy.data.materials['iris'],
            W.flat_mat('mouth', W.srgb('#4a1a16'), 0.5) if 'mouth' not in bpy.data.materials else bpy.data.materials['mouth'],
            _mat('gold', W.srgb('#d4a43c'), 0.3, 0.9), _mat(f'clothdark_{nation}', tuple(c * 0.45 for c in cloth[:3]) + (1,), 0.8),
            W.flat_mat('cheek', W.srgb('#c7584c'), 0.6) if 'cheek' not in bpy.data.materials else bpy.data.materials['cheek']]
    ob = W.mesh_ob(f'char_{nation}_{pose}_{variant}', bm, mats, coll, smooth=True)
    # subdivide once into the mesh itself: a modifier here would be evaluated per instance and blow memory up
    sub = ob.modifiers.new('s', 'SUBSURF'); sub.levels = 1; sub.render_levels = 1
    dg = bpy.context.evaluated_depsgraph_get(); old = ob.data
    ob.data = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    ob.modifiers.remove(sub); bpy.data.meshes.remove(old)
    return ob

def _skin(name, col):
    if name in bpy.data.materials: return bpy.data.materials[name]
    m = W.flat_mat(name, col, 0.5); b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Subsurface Weight'].default_value = 0.35; b.inputs['Subsurface Radius'].default_value = (0.1, 0.04, 0.02)
    b.inputs['Subsurface Scale'].default_value = 0.05; b.inputs['Coat Weight'].default_value = 0.1
    return m

NVAR = 6
def troop_collections():
    """A collection per nation × pose × variant (the character and its shield face), for instancing.
    Keys are (nation, pose) -> list of collections."""
    out = {}
    lib = bpy.data.collections.get('troops') or W.new_coll('troops')
    for nation in ('aster', 'fjordal'):
        for pose in ('march', 'brace', 'thrust'):
            lst = []
            for v in range(NVAR):
                name = f'T_{nation}_{pose}_{v}'
                if name in bpy.data.collections: lst.append(bpy.data.collections[name]); continue
                c = bpy.data.collections.new(name); lib.children.link(c)
                character(nation, pose, v, c); lst.append(c)
            out[(nation, pose)] = lst
    bpy.context.view_layer.layer_collection.children['troops'].exclude = True
    return out

def formation(lib, nation, center, facing, ranks, files, spacing=1.35, poses=('march',), seed=0, coll=None, jitter=0.18, z_of=None, front_pose=None):
    """Ranks × files of soldiers centred on `center`, looking along `facing` (radians; 0 = -y)."""
    rng = random.Random(seed)
    coll = coll or bpy.context.scene.collection
    fw = Vector((math.sin(facing), -math.cos(facing), 0)); side = Vector((-fw.y, fw.x, 0))   # the model looks down -y; rotated by `facing` that is (sin, -cos)
    obs = []
    for rk in range(ranks):
        for fl in range(files):
            p = Vector((center.x, center.y, 0)) + side * (fl - (files - 1) / 2) * spacing - fw * rk * spacing * 1.05
            p += Vector((rng.uniform(-jitter, jitter), rng.uniform(-jitter, jitter), 0))
            pose = front_pose if (front_pose and rk == 0) else poses[rng.randrange(len(poses))]
            o = bpy.data.objects.new('s', None); o.instance_type = 'COLLECTION'; o.instance_collection = rng.choice(lib[(nation, pose)])
            z = (z_of or W.ground)(p.x, p.y)
            o.location = (p.x, p.y, z); o.rotation_euler = (0, 0, facing + rng.uniform(-0.12, 0.12))
            s = rng.uniform(0.94, 1.06); o.scale = (s, s, s)
            coll.objects.link(o); obs.append(o)
    return obs

def banner(nation, at, height=5.0, coll=None, size=(1.6, 1.1)):
    """A pole with a hanging banner in the nation's colour and its sign."""
    coll = coll or bpy.context.scene.collection
    bm = bmesh.new()
    _cyl(bm, (0, 0, 0), (0, 0, height), 0.05, 0.04, 8)
    _cyl(bm, (-size[0] / 2 - 0.1, 0, height - 0.1), (size[0] / 2 + 0.1, 0, height - 0.1), 0.03, 0.03, 6)
    pole = W.mesh_ob('pole', bm, [_mat('spearwood', W.srgb('#6b4a2e'), 0.7)], coll); pole.location = at
    cb = bmesh.new(); nx, nz = 14, 12
    g = [[cb.verts.new((-size[0] / 2 + size[0] * i / nx, 0, height - 0.15 - size[1] * j / nz - (0.25 * size[1] if j == nz and i in (nx // 2,) else 0))) for i in range(nx + 1)] for j in range(nz + 1)]
    uv = cb.loops.layers.uv.new()
    for j in range(nz):
        for i in range(nx):
            f = cb.faces.new((g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]))
            for l, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                l[uv].uv = (a / nx, 1 - b / nz)
    me = bpy.data.meshes.new('banner'); cb.to_mesh(me); cb.free()
    for p in me.polygons: p.use_smooth = True
    m = bpy.data.materials.get(f'banner_{nation}')
    if not m:
        m = shield_mat(nation).copy(); m.name = f'banner_{nation}'
        nt = m.node_tree
        tc = [n for n in nt.nodes if n.type == 'TEX_COORD'][0]; sep = [n for n in nt.nodes if n.type == 'SEPXYZ'][0]
        # on the banner the sign is drawn in UV space; flip UV's Y into Z of the separate node
        cmb = nt.nodes.new('ShaderNodeSeparateXYZ'); um = nt.nodes.new('ShaderNodeCombineXYZ')
        nt.links.new(tc.outputs['UV'], cmb.inputs[0])
        nt.links.new(cmb.outputs['X'], um.inputs['X']); nt.links.new(cmb.outputs['Y'], um.inputs['Z'])
        nt.links.new(um.outputs[0], sep.inputs[0])
        nt.nodes['Principled BSDF'].inputs['Sheen Weight'].default_value = 0.5
        nt.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.85
        m.use_backface_culling = False
    me.materials.append(m)
    cloth = bpy.data.objects.new('banner', me); coll.objects.link(cloth); cloth.location = at
    cloth['rest'] = [tuple(v.co) for v in me.vertices]
    return pole, cloth

def wave(cloth, t, amp=0.18, speed=3.0):
    rest = cloth['rest']; me = cloth.data
    for v, r in zip(me.vertices, rest):
        k = (r[2] - (max(q[2] for q in rest))) * -1
        v.co = (r[0], r[1] + amp * k * math.sin(r[0] * 2.2 - t * speed + r[2] * 1.3), r[2])
    me.update()

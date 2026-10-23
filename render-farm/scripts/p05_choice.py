# ⑤ The choice (an illustration, not a record): the valley at night from high above, the hex lattice showing.
# Three roads leave Aster's town; two are only faint chalk traces, the third carries a column of torches south
# toward the camp. Moonlit blue, warm fire. Env overrides for tests.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import bmesh
import army as A, stage as S
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world()
set_value('terrain', 'HEX_STRENGTH', E('HEX', 0.55))
bpy.data.materials['window_lit'].node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = E('WINE', 4.0)   # the town is awake: lit windows

def chalk_mat():
    """Faint chalk rubbed along the ground: a broken, uneven line (noise-cut transparency), barely lit."""
    m = bpy.data.materials.get('chalk')
    if m: return m
    m = bpy.data.materials.new('chalk'); m.use_nodes = True; nt = m.node_tree; L = nt.links
    b = nt.nodes['Principled BSDF']; out = nt.nodes['Material Output']
    b.inputs['Base Color'].default_value = (0.85, 0.87, 0.9, 1); b.inputs['Roughness'].default_value = 1.0
    b.inputs['Emission Color'].default_value = (0.75, 0.82, 1.0, 1); b.inputs['Emission Strength'].default_value = E('CHALKE', 0.25)
    tc = nt.nodes.new('ShaderNodeTexCoord'); nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.35; nz.inputs['Detail'].default_value = 8
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].position = 0.45; ramp.color_ramp.elements[1].position = 0.62
    L.new(nz.outputs['Fac'], ramp.inputs['Fac'])
    tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mix = nt.nodes.new('ShaderNodeMixShader')
    L.new(ramp.outputs['Color'], mix.inputs['Fac']); L.new(tr.outputs[0], mix.inputs[1]); L.new(b.outputs[0], mix.inputs[2])
    L.new(mix.outputs[0], out.inputs['Surface'])
    return m

def chalk(pts, name, width=1.8, start=6.0, length=170.0):
    """A pale broken trace laid on the ground along a road: the routes not taken. Fades out along its length."""
    bm = bmesh.new()
    segs = list(zip(pts, pts[1:])); lens = [(b - a).length for a, b in segs]
    def at(s):
        for (a, b), l in zip(segs, lens):
            if s <= l: return a + (b - a) * (s / l), (b - a).normalized()
            s -= l
        a, b = segs[-1]; return b, (b - a).normalized()
    prev = None; s = start; step = 3.0
    while s < min(start + length, sum(lens)):
        p, d = at(s); n = Vector((-d.y, d.x)) * (width / 2) * (1 - 0.6 * (s - start) / length)
        ring = [bm.verts.new((q.x, q.y, W.ground(q.x, q.y) + 0.25)) for q in (p - n, p + n)]
        if prev: bm.faces.new((prev[0], prev[1], ring[1], ring[0]))
        prev = ring; s += step
    return W.mesh_ob(name, bm, [chalk_mat()])

chalk(W.ROAD, 'chalk_east', length=E('CHL', 150))
chalk(W.ROAD3, 'chalk_west', length=E('CHL', 150))

# the chosen road: a torch-lit column out of the south gate toward the camp
lib = A.troop_collections()
obs, at = S.column(lib, 'aster', W.ROAD2, n=int(E('N', 160)), files=2, spacing=1.5, seed=9, start=E('START', 260))
flame = W.flat_mat('flame', (1.0, 0.55, 0.18, 1), 0.5, emit=((1.0, 0.5, 0.15, 1), 30.0))
rng = random.Random(3)
for i, o in enumerate(obs):
    if i % 3: continue
    p = Vector(o.location) + Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), 2.6))
    ld = bpy.data.lights.new(f't{i}', 'POINT'); ld.energy = E('TORCHW', 60); ld.color = (1.0, 0.52, 0.2); ld.shadow_soft_size = 0.15
    lo = bpy.data.objects.new(f't{i}', ld); lo.location = p; bpy.context.scene.collection.objects.link(lo)
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=0.22)
    fo = W.mesh_ob(f'fl{i}', bm, [flame]); fo.location = p; fo.scale = (1, 1, 1.6)
    lo.visible_shadow = False

sky('rogland_clear_night', E('SKYS', 0.12), E('HROT', 0), E('SEL', 38), E('SAZ', 300), E('MOON', 1.0), (0.62, 0.72, 1.0), 0.6)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 1.1))
bpy.context.scene.cycles.light_sampling_threshold = 0.01
haze((0.06, 0.08, 0.13), E('HZS', 500), E('HZD', 2200), E('HZA', 0.35))
# camera: high and steep over the town's south side, looking a little north so the three exits read
c = W.TOWN + Vector((E('CX', 40), E('CY', -160)))
cam = Vector((c.x, c.y, W.ground(c.x, c.y) + E('CH', 1350)))
tc = W.TOWN + Vector((E('TX', 40), E('TY', -90)))
tgt = Vector((tc.x, tc.y, W.ground(tc.x, tc.y)))
camera(cam, tgt, lens=E('LENS', 70), w=Wd, h=Hd)
render(OUT)

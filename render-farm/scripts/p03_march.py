# ③ Dawn march: an Aster column leaves the east gate on the road toward the pass and walks into the fog.
# Long lens from above and behind the gate; overcast, cool, the valley ahead dissolving. Env overrides for tests.
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import bmesh
import army as A, stage as S
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world()

def ground_fog(center, size, density, name='fog'):
    """A low, uniform-coloured fog bank: thick at the ground, thinning out with height, broken by slow noise."""
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; L = nt.links
    nt.nodes.remove(nt.nodes['Principled BSDF']); out = nt.nodes['Material Output']
    vol = nt.nodes.new('ShaderNodeVolumePrincipled'); vol.inputs['Color'].default_value = (0.86, 0.89, 0.93, 1)
    vol.inputs['Anisotropy'].default_value = 0.3
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Generated'], sep.inputs[0])
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.02; nz.inputs['Detail'].default_value = 3
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    def m_(op, a, b):
        n = nt.nodes.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: L.new(v, n.inputs[i])
        return n.outputs[0]
    hfall = m_('POWER', m_('SUBTRACT', 1.0, sep.outputs['Z']), 3.0)
    d = m_('MULTIPLY', m_('MULTIPLY', hfall, m_('ADD', 0.45, nz.outputs['Fac'])), density)
    L.new(d, vol.inputs['Density']); L.new(vol.outputs[0], out.inputs['Volume'])
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    ob = W.mesh_ob(name, bm, [m]); ob.location = center + Vector((0, 0, size[2] / 2 - 2)); ob.scale = size
    return ob

lib = A.troop_collections()
g0 = W.ROAD[0]                                                  # just outside the east gate
street_in = W.TOWN + Vector((30, -4))                           # the main street inside the walls
pts = [street_in, Vector((W.TOWN.x + W.TOWN_R - 6, W.TOWN.y - 9)), g0] + list(W.ROAD[1:4])
obs, at = S.column(lib, 'aster', pts, n=int(E('N', 220)), files=4, spacing=1.45, seed=5, start=E('START', 150))
# banner bearers in the column, and a rider-less standard at its head
bans = []
for s in (E('START', 150) - 4, E('START', 150) - 30, E('START', 150) - 58):
    p, d = at(s); side = Vector((-d.y, d.x))
    q = p + side * 3.6
    bans.append((A.banner('aster', Vector((q.x, q.y, W.ground(q.x, q.y))), 5.5, size=(1.6, 1.15)), d))

# camera: up on the wall-walk behind the gate, looking down the road
cpos = W.TOWN + Vector((W.TOWN_R - E('CBACK', 20), -12 + E('CSIDE', 8)))
cam = Vector((cpos.x, cpos.y, W.ground(cpos.x, cpos.y) + E('CH', 26)))
tp, _ = at(E('TS', 120)); tgt = Vector((tp.x, tp.y, W.ground(tp.x, tp.y) + E('TZ', -6)))
for (pole, cloth), d in bans:
    v = cam - pole.location; th = math.atan2(v.x, -v.y) + 0.5   # three-quarter to the camera so the sign shows
    pole.rotation_euler.z = th; cloth.rotation_euler.z = th
    A.wave(cloth, 2.1, amp=0.14)
fc, _ = at(E('START', 150) + 160)
ground_fog(Vector((fc.x, fc.y, W.ground(fc.x, fc.y))), (520, 260, 26), E('FOG', 0.032))
if os.environ.get('NOGRASS') != '1': grass([(g0 + Vector((70, 8)), 75)], count=int(E('GCOUNT', 600000)), length=0.3)
sky('overcast_soil_puresky', E('SKYS', 0.8), E('HROT', 0), E('SEL', 6), E('SAZ', 85), E('SUNE', 1.6), (1.0, 0.78, 0.62), 6.0)
render_settings(SAMP, 'AgX - Medium Contrast', E('EXPO', 0.2))
bpy.context.scene.cycles.volume_step_rate = 4.0
haze((0.76, 0.8, 0.86), E('HZS', 25), E('HZD', 420), E('HZA', 0.68), falloff='LINEAR')
camera(cam, tgt, lens=E('LENS', 85), w=Wd, h=Hd, fstop=E('FSTOP', 5.6), focus=Vector((at(E('START', 150) - 20)[0].x, at(E('START', 150) - 20)[0].y, W.ground(*at(E('START', 150) - 20)[0]) + 1)))
render(OUT)

# v2 ⑥ "Some of your neighbors are AI": night on the plain. Two hamlets that could be twins, every window dark.
# Out of one gate a cart rolls on its own under torchlight — its owner asleep, an agent at the reins.
# Nothing tells you which hamlet is human.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S, props as P, scenes as SC
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world(os.environ.get('WORLDF') and os.path.join(ROOT, os.environ['WORLDF']))
HA = Vector((-205.0, -228.0)); HB = Vector((-140.0, -214.0))
road = [HB + Vector((0, -12)), HB + Vector((-6, -40)), HB + Vector((-24, -75))]
P.clear_vegetation([(HA, 34), (HB, 34)], [(road, 8), ([HA, HB], 8)])
lib = A.troop_collections(); cl = P.cart_collections()
for h, seed in ((HA, 41), (HB, 41)):                           # the same seed: two identical hamlets
    SC.hamlet(h, n=8, radius=17, nation='aster', seed=seed)
    SC.palisade(h, 24, gaps=(0.0, math.pi, -math.pi / 2))
    for k, ang in enumerate((0.8, 2.6, 4.2)):
        SC.field(h + Vector((math.cos(ang), math.sin(ang))) * 40, (26, 18), ang, seed=k + 1)
carts, at = P.convoy(cl, 'aster', road, n=1, gap=9, start=E('C1', 22), seed=3)
flame = bpy.data.materials.get('flame') or W.flat_mat('flame', (1.0, 0.55, 0.18, 1), 0.5, emit=((1.0, 0.5, 0.15, 1), 40.0))
import bmesh
from mathutils import Matrix
for c in carts:                                                  # two torches on poles at the cart's front corners
    yaw = c.rotation_euler.z; R = Matrix.Rotation(yaw, 3, 'Z')
    for sx in (-1, 1):
        p = Vector(c.location) + R @ Vector((sx * 0.9, -1.4, 2.2))
        ld = bpy.data.lights.new('torch', 'POINT'); ld.energy = E('TORCHW', 220); ld.color = (1.0, 0.5, 0.18); ld.shadow_soft_size = 0.12
        lo = bpy.data.objects.new('torch', ld); lo.location = p; bpy.context.scene.collection.objects.link(lo)
        bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=0.16)
        fo = W.mesh_ob('flame', bm, [flame]); fo.location = p; fo.scale = (1, 1, 1.7)
P.route(road, 'aster', 0, None, name='route')
set_value('terrain', 'HEX_STRENGTH', E('HEX', 0.1))
if os.environ.get('NOGRASS') != '1': grass([(HA, 50), (HB, 50)], count=int(E('GCOUNT', 500000)), length=0.25)
sky('rogland_clear_night', E('SKYS', 0.14), E('HROT', 0), E('SEL', 40), E('SAZ', 300), E('MOON', 1.1), (0.6, 0.7, 1.0), 0.6)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 1.3))
haze((0.05, 0.07, 0.12), 120, 900, 0.4)
mid = HA.lerp(HB, 0.5)
cam = Vector((mid.x + E('CX', 0), mid.y + E('CY', -125), W.ground(mid.x, mid.y) + E('CH', 78)))
tgt = Vector((mid.x + E('TX', 4), mid.y + E('TY', 0), W.ground(mid.x, mid.y)))
P.clear_view(cam, tgt, 6, 0.05, 0.6)
P.clear_rocks((mid.x, mid.y - 60), 75)                          # pale boulder slabs in the near ground read as tents
camera(cam, tgt, lens=E('LENS', 24), w=Wd, h=Hd)
render(OUT)

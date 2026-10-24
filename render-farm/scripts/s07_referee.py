# v2 ⑦ "So nobody can bribe the referee": the game seen as a fair board. A clash at a river ford from high above,
# the hex lattice clear on the land, the formations like pieces; Fjordal's line has met the brace and is breaking.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S, props as P
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world(os.environ.get('WORLDF') and os.path.join(ROOT, os.environ['WORLDF']))
fx, fy = E('FX', 70.0), E('FY', -150.0); F = Vector((fx, fy))     # open ground east of the river
P.clear_vegetation([(F, 110)]); P.sky_water()
lib = A.troop_collections()
# Aster holds the west bank in a brace; Fjordal came across and is coming apart
A.formation(lib, 'aster', Vector((fx - 26, fy, 0)), math.pi / 2 * -1 + math.pi, 6, 16, poses=('brace',), seed=1, front_pose='brace')
A.formation(lib, 'aster', Vector((fx - 44, fy + 24, 0)), math.pi / 2, 5, 10, poses=('march',), seed=2)
f = A.formation(lib, 'fjordal', Vector((fx - 12, fy, 0)), -math.pi / 2, 4, 16, poses=('thrust', 'march'), seed=3)
rng = random.Random(5)
rear = A.formation(lib, 'fjordal', Vector((fx + 18, fy - 4, 0)), -math.pi / 2, 6, 14, poses=('march',), seed=4)
for o in rear:                                                   # the broken line: scattered, turned, falling back
    o.location.x += rng.uniform(-4, 14); o.location.y += rng.uniform(-9, 9)
    o.location.z = W.ground(o.location.x, o.location.y); o.rotation_euler.z += rng.uniform(-2.6, 2.6)
for nation, at, k in (('aster', Vector((fx - 40, fy - 8)), 0), ('aster', Vector((fx - 40, fy + 10)), 1), ('fjordal', Vector((fx + 30, fy + 12)), 2)):
    A.banner(nation, Vector((at.x, at.y, W.ground(at.x, at.y))), 7.0, size=(2.0, 1.4))
S.dust(Vector((fx - 16, fy, W.ground(fx, fy))), (40, 60, 6), 0.0, 0.35)
set_value('terrain', 'HEX_STRENGTH', E('HEX', 0.28))
if os.environ.get('NOGRASS') != '1': grass([(F, 100)], count=int(E('GCOUNT', 700000)), length=0.2)
sky('kloofendal_48d_partly_cloudy_puresky', 0.45, E('HROT', 20), E('SEL', 48), E('SAZ', 160), 6.0, (1.0, 0.9, 0.8), 1.5)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 0.0))
bpy.context.scene.cycles.volume_step_rate = 4.0
haze((0.8, 0.82, 0.86), 160, 1500, 0.3)
cam = Vector((fx + E('CX', 58), fy + E('CY', 6), W.ground(fx, fy) + E('CH', 52)))
tgt = Vector((fx - E('TX', 8), fy + E('TY', 2), W.ground(fx, fy)))
camera(cam, tgt, lens=E('LENS', 32), w=Wd, h=Hd)
render(OUT)

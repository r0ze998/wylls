# v2 ③ "Your forge can end up fueling a war you're not even in": a quiet forge hamlet in the foreground; its cart
# trail joins the main road, passes a depot and the bridge, and runs on to the keep, where smoke rises from a siege.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S, props as P, scenes as SC
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world(os.environ.get('WORLDF') and os.path.join(ROOT, os.environ['WORLDF']))
FH = Vector((-176.0, -34.0))                       # the forge hamlet, south of the road
spur = [FH + Vector((6, 10)), Vector((-172, 2))]
main = [Vector((-172, 3))] + list(W.ROAD[2:])      # on east over the bridge to the keep
P.clear_vegetation([(FH, 40), (Vector((-84, 26)), 26)], [(main, 16), (spur, 10)])
lib = A.troop_collections(); cl = P.cart_collections()
SC.hamlet(FH, n=7, radius=16, nation='aster', seed=31)
P.forge(FH + Vector((-6, 8)), 0.3)
P.depot(Vector((-84, 26)), 0.05)
P.route(spur, 'aster', 0, None, name='r_spur')
P.route(main, 'aster', 0, None, name='r_main')
P.convoy(cl, 'aster', spur + main[1:], n=2, gap=9, start=E('C1', 30), seed=1)
P.convoy(cl, 'aster', main, n=3, gap=9, start=E('C2', 120), escort=lib, seed=2)
P.convoy(cl, 'aster', main, n=3, gap=9, start=E('C3', 300), escort=lib, seed=3)
# the siege at the keep: the Aster host before the walls, burning outworks, smoke over the crag
K = W.KEEP
A.formation(lib, 'aster', Vector((K.x - 70, K.y - 44, 0)), math.atan2(0.75, -0.66), 8, 18, poses=('march', 'brace'), seed=7)
for i, off in enumerate((Vector((-38, -20)), Vector((-20, -36)), Vector((-46, 4)))):
    q = K + off; P.fire(Vector((q.x, q.y, W.ground(q.x, q.y))), (6, 6, 8), f'sfire{i}', light=6000)
set_value('terrain', 'HEX_STRENGTH', E('HEX', 0.06))
if os.environ.get('NOGRASS') != '1': grass([(FH, 50)], count=int(E('GCOUNT', 500000)), length=0.25)
sky('kloofendal_48d_partly_cloudy_puresky', 0.45, E('HROT', 20), E('SEL', 26), E('SAZ', 200), 6.5, (1.0, 0.8, 0.6), 1.5)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 0.1))
bpy.context.scene.cycles.volume_step_rate = 4.0
haze((0.74, 0.76, 0.82), 120, 1500, 0.45)
cam = Vector((FH.x + E('CX', -60), FH.y + E('CY', -70), W.ground(FH.x, FH.y) + E('CH', 95)))
tgt = Vector((E('TX', 10.0), E('TY', 20.0), E('TZ', 30.0)))
P.clear_view(cam, tgt, 6, 0.05, 0.35)
camera(cam, tgt, lens=E('LENS', 30), w=Wd, h=Hd)
render(OUT)

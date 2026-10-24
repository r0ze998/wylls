# v2 ② "Nobody gets strong alone": a hill hamlet with its mine and forge (top), a plains hamlet in its fields
# (bottom), and the two convoys that keep each other alive on the road between. Morning, strategy-game overhead.
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S, props as P, scenes as SC
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world(os.environ.get('WORLDF') and os.path.join(ROOT, os.environ['WORLDF']))
HILL = Vector((-440.0, -128.0)); PLAIN = Vector((-308.0, -166.0))
road = [HILL + Vector((16, -4)), Vector((-392, -146)), Vector((-350, -158)), PLAIN + Vector((-16, 2))]
P.clear_vegetation([(HILL, 46), (PLAIN, 58), (HILL + Vector((-30, -14)), 22)], [(road, 12)])
lib = A.troop_collections(); cl = P.cart_collections()
SC.hamlet(HILL, n=8, radius=18, nation='aster', seed=21)
P.mine(HILL + Vector((-30, -12)), math.pi / 2 + 0.2)
P.forge(HILL + Vector((10, 18)), math.pi / 2 + 0.3)
SC.hamlet(PLAIN, n=10, radius=20, nation='aster', seed=22)
for k, (off, sz, r) in enumerate(((Vector((30, 20)), (34, 22), 0.2), (Vector((34, -18)), (30, 26), -0.1), (Vector((-6, -38)), (40, 20), 0.35),
                                  (Vector((-36, -30)), (24, 20), 0.6), (Vector((8, 40)), (28, 18), -0.3))):
    SC.field(PLAIN + off, sz, r, seed=k)
# ore and weapons go down to the plain, grain and timber come up to the hill
P.convoy(cl, 'aster', road, n=3, gap=8.5, start=E('C1', 70), escort=lib, seed=4)
P.convoy(cl, 'aster', list(reversed(road)), n=3, gap=8.5, start=E('C2', 64), seed=5)
P.route(road, 'aster', 4, None, side=-2.2, name='route_down')
P.route(list(reversed(road)), 'aster', 4, None, side=-2.2, name='route_up')
set_value('terrain', 'HEX_STRENGTH', E('HEX', 0.07))
if os.environ.get('NOGRASS') != '1': grass([(PLAIN, 60), (HILL, 40)], count=int(E('GCOUNT', 600000)), length=0.22)
sky('kloofendal_48d_partly_cloudy_puresky', 0.45, E('HROT', 20), E('SEL', 20), E('SAZ', 110), 7.0, (1.0, 0.78, 0.55), 1.5)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 0.1))
haze((0.78, 0.8, 0.85), 140, 1200, 0.35)
mid = HILL.lerp(PLAIN, 0.5)
cam = Vector((mid.x + E('CX', 120), mid.y + E('CY', -85), W.ground(mid.x, mid.y) + E('CH', 80)))
tgt = Vector((mid.x - E('TX', -30), mid.y + E('TY', 0), W.ground(mid.x, mid.y) + 8))
camera(cam, tgt, lens=E('LENS', 30), w=Wd, h=Hd)
render(OUT)

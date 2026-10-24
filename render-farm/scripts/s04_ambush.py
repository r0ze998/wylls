# v2 ④ "Who's waiting in the pass at 6:30?": dawn on the road up to the keep. An Aster supply convoy winds up
# below; in the foreground, Fjordal soldiers crouch among the trees on the slope, spears low, watching it come.
# MODE=burn turns the same place into ⑤: the convoy wrecked and burning, the attackers gone, smoke over the pass.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S, props as P
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
MODE = os.environ.get('MODE', 'ambush')
open_world(os.environ.get('WORLDF') and os.path.join(ROOT, os.environ['WORLDF']))
road = list(W.ROAD[5:])                                       # (80,12) → the battle field → up toward the keep
at, total = P.path_at(road)
AMB = 150.0                                                   # metres along the road where it happens
p0, d0 = at(AMB); side = Vector((-d0.y, d0.x))
# which side climbs: put the watchers on the higher ground
up = side if W.ground(*(p0 + side * 20)) > W.ground(*(p0 - side * 20)) else -side
P.clear_vegetation([], [(road, 6)])
P.clear_vegetation([(p0 + up * 12 - d0 * 2, 9), (p0 + up * 12 + d0 * 14, 7)])   # small gaps in the wood where the watchers crouch
P.clear_rocks(p0, 120)
lib = A.troop_collections(); cl = P.cart_collections()
rng = random.Random(6)
if MODE == 'ambush':
    P.convoy(cl, 'aster', road, n=5, gap=9.0, start=AMB + E('LEAD', 26), escort=lib, seed=8)
    P.route(road, 'aster', AMB - 80, 200, name='route')
    # the watchers: a loose line crouched between the trees, facing the road
    face = math.atan2(-up.x, up.y)                            # looking down-slope toward the road
    for k in range(int(E('NAMB', 26))):
        q = p0 + d0 * rng.uniform(-14, 26) + up * rng.uniform(7, 17)
        o = bpy.data.objects.new('amb', None); o.instance_type = 'COLLECTION'; o.instance_collection = rng.choice(lib[('fjordal', 'brace')])
        o.location = (q.x, q.y, W.ground(q.x, q.y) - 0.25); o.rotation_euler = (0, 0, face + rng.uniform(-0.3, 0.3)); o.scale = (1, 1, 0.92)
        bpy.context.scene.collection.objects.link(o)
    sun = (E('SEL', 7), E('SAZ', 95), 6.0, (1.0, 0.62, 0.38))
else:
    P.clear_vegetation([(p0 + d0 * 10, 34)])
    wr, _ = P.convoy(cl, 'aster', road, n=4, gap=7.0, start=AMB + 14, burnt=True, seed=9)
    for i, o in enumerate(wr):
        P.fire(Vector(o.location) + Vector((rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), 0)), (3.4, 3.4, 4.6 + rng.uniform(-1, 1)), f'fire{i}', light=2200)
    P.route(road, 'aster', AMB - 90, 90 + 4, name='route')                     # the supply line ends at the fire
    for k in range(int(E('NDEAD', 10))):                                        # scattered cargo and dropped shields
        q = p0 + d0 * rng.uniform(-8, 26) + side * rng.uniform(-7, 7)
        o = bpy.data.objects.new('debris', None); o.instance_type = 'COLLECTION'; o.instance_collection = rng.choice(cl[('aster', True)])
        o.location = (q.x, q.y, W.ground(q.x, q.y) - 0.9); o.rotation_euler = (rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6), rng.uniform(0, 6.28)); o.scale = (0.5,) * 3
        bpy.context.scene.collection.objects.link(o)
    sun = (E('SEL', 24), E('SAZ', 230), 5.0, (1.0, 0.75, 0.55))
if os.environ.get('NOGRASS') != '1': grass([(p0, 80)], count=int(E('GCOUNT', 700000)), length=0.3)
sky('kloofendal_48d_partly_cloudy_puresky', E('SKYS', 0.35), E('HROT', 60), sun[0], sun[1], sun[2], sun[3], 1.5)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 0.2))
bpy.context.scene.cycles.volume_step_rate = 4.0
haze((0.75, 0.74, 0.78), 60, 700, 0.45)
if MODE == 'ambush':   # camera: behind the watchers on the slope, looking down the pass along the convoy
    cpos = p0 - d0 * E('CB', 12) + up * E('CU', 24)
    cam = Vector((cpos.x, cpos.y, W.ground(cpos.x, cpos.y) + E('CH', 3.2)))
    tq = p0 + d0 * E('TA', 34); tgt = Vector((tq.x, tq.y, W.ground(tq.x, tq.y) + 1))
else:                  # camera: down the road behind the wreck, looking up the pass toward the starving keep
    cpos = p0 - d0 * E('CB', 46) - up * E('CU', 6)
    cam = Vector((cpos.x, cpos.y, W.ground(cpos.x, cpos.y) + E('CH', 7)))
    tgt = Vector((W.KEEP.x, W.KEEP.y, W.KEEP_Z * 0.0 + W.ground(W.KEEP.x, W.KEEP.y) - E('TD', 30)))
P.clear_view(cam, tgt, 4, 0.08, 0.5)
camera(cam, tgt, lens=E('LENS', 32), w=Wd, h=Hd, fstop=E('FSTOP', 6), focus=Vector((p0.x, p0.y, W.ground(p0.x, p0.y))))
render(OUT)

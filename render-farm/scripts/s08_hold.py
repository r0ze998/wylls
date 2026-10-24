# v2 ⑧ "Who held the forts": sunset at the keep. Fjordal's defenders line the curtain wall against the low sun;
# below, an Aster assault with ladders up and a ram at the wall, the dust and smoke of the day hanging in the air.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import bmesh
import army as A, stage as S, props as P
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world(os.environ.get('WORLDF') and os.path.join(ROOT, os.environ['WORLDF']))
K = W.KEEP
N = 10; pts = []                                                 # the curtain wall, as world.keep() builds it
for i in range(N):
    a = i / N * math.tau + 0.2; r = 34 + 6 * math.sin(i * 1.7)
    p = K + Vector((math.cos(a), math.sin(a))) * r; pts.append(Vector((p.x, p.y, W.ground(p.x, p.y))))
# the attacked stretch: the one facing the battle field (south-west)
sw = min(range(N), key=lambda i: ((pts[i] + pts[(i + 1) % N]) / 2).xy.__sub__(W.BATTLE).length)
a_, b_ = pts[sw], pts[(sw + 1) % N]; mid = (a_ + b_) / 2; along = (b_ - a_).normalized(); out = Vector((mid.x - K.x, mid.y - K.y, 0)).normalized()
P.clear_vegetation([(mid.xy + out.xy * 30, 45)])
lib = A.troop_collections(); rng = random.Random(8)
face_out = math.atan2(out.x, -out.y)
for seg in (sw - 1, sw, sw + 1):                                 # defenders on the wall-walk of three stretches
    s0, s1 = pts[seg % N], pts[(seg + 1) % N]
    top = max(s0.z, s1.z) + 9.0
    for k in range(9):
        t = (k + 0.5) / 9; q = s0.lerp(s1, t) - Vector((s1.y - s0.y, -(s1.x - s0.x), 0)).normalized() * 0.4 * 0
        o = bpy.data.objects.new('def', None); o.instance_type = 'COLLECTION'; o.instance_collection = rng.choice(lib[('fjordal', rng.choice(('brace', 'thrust')))])
        o.location = (q.x, q.y, top); o.rotation_euler = (0, 0, face_out + rng.uniform(-0.2, 0.2)); bpy.context.scene.collection.objects.link(o)
    A.banner('fjordal', Vector((s0.x, s0.y, max(s0.z, s1.z) + 16.0)), 6.0, size=(2.2, 1.6))
# the assault: a host at the foot of the wall, ladders up, a ram
A.formation(lib, 'aster', mid + out * 13, face_out + math.pi, 7, 20, poses=('march', 'brace'), seed=3)
lad = bmesh.new()
for k in range(5):
    t = (k + 0.5) / 5; foot = a_.lerp(b_, t) + out * 4.5; foot.z = W.ground(foot.x, foot.y); topp = a_.lerp(b_, t) + out * 1.6; topp.z = max(a_.z, b_.z) + 9.5
    side = along * 0.35
    for s in (-1, 1): A._cyl(lad, foot + side * s, topp + side * s, 0.07, 0.06, 6)
    for r in range(12):
        u = (r + 0.5) / 12; A._cyl(lad, foot.lerp(topp, u) - side, foot.lerp(topp, u) + side, 0.04, 0.04, 5)
W.mesh_ob('ladders', lad, [P.M('wood')])
ram = bmesh.new(); rp = mid + out * 6 + along * 6; rp.z = W.ground(rp.x, rp.y); R = math.atan2(out.y, out.x)
W.box(ram, rp + Vector((0, 0, 1.6)), (7, 3.2, 0.3), R, 0)
for s in (-1, 1):
    W.box(ram, rp + Vector((0, 0, 2.4)) + Vector((-out.y, out.x, 0)) * s * 1.3, (7, 0.25, 1.8), R, 0)
A._cyl(ram, rp - out * 4.5 + Vector((0, 0, 1.0)), rp + out * 3.0 + Vector((0, 0, 1.0)), 0.35, 0.35, 10)
W.mesh_ob('ram', ram, [P.M('wood')])
S.dust(mid + out * 26, (70, 50, 10), R, 0.5)
for i in range(3):
    q = mid + out * rng.uniform(6, 12) + along * rng.choice((-1, 1)) * rng.uniform(14, 30); P.fire(Vector((q.x, q.y, W.ground(q.x, q.y))), (4, 4, 6), f'f{i}', light=3000)
if os.environ.get('NOGRASS') != '1': grass([(mid.xy + out.xy * 30, 60)], count=int(E('GCOUNT', 500000)), length=0.25)
sky('kloofendal_48d_partly_cloudy_puresky', E('SKYS', 0.16), E('HROT', 140), E('SEL', 5), math.degrees(math.atan2(-out.x, -out.y)) + E('SAZO', 25), 8.0, (1.0, 0.5, 0.25), 1.2)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 0.4))
bpy.context.scene.cycles.volume_step_rate = 4.0
haze((0.9, 0.62, 0.42), 80, 900, 0.45)
cp = mid + out * E('CD', 62) + along * E('CA', -34)
cam = Vector((cp.x, cp.y, max(W.ground(cp.x, cp.y) + 2, mid.z + E('CH', 16))))
tgt = mid + Vector((0, 0, E('TZ', 3))) - out * 4
P.clear_view(cam, tgt, 8, 0.1, 0.9)
camera(cam, tgt, lens=E('LENS', 28), w=Wd, h=Hd)
render(OUT)

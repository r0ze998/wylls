# v2 trailer, about 20 s at 30 fps (600 frames, 1080×1350), cut like the thread. Each shot reuses a still's set-up
# (the still script runs with its render switched off), then moves the camera and brings the set to life: carts roll,
# fire and smoke churn, banners and dust move.
#   1    1– 90  ② the two hamlets, a slow drift              4  271–360  ⑤ the burning convoy, easing back
#   2   91–180  ② riding beside the convoy, low              5  361–450  ⑧ the wall at sunset, trucking along
#   3  181–270  ④ through the watchers toward the convoy     6  451–600  ③ the forge's road, craning up to the valley
# Usage: tr_v2.py -- W H SAMPLES OUTDIR SHOT [FIRST LAST]. Frames already on disk are skipped, so runs resume.
import sys, os, math, runpy
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUTDIR, SHOT = int(args[0]), int(args[1]), int(args[2]), args[3], int(args[4])
SHOTS = {1: ('s02_interdep.py', {}, 1, 90), 2: ('s02_interdep.py', {}, 91, 180), 3: ('s04_ambush.py', {'MODE': 'ambush'}, 181, 270),
         4: ('s04_ambush.py', {'MODE': 'burn'}, 271, 360), 5: ('s08_hold.py', {}, 361, 450), 6: ('s03_chain.py', {}, 451, 600)}
script, env, F0, F1 = SHOTS[SHOT]
if len(args) > 6: F0, F1 = int(args[5]), int(args[6])
os.environ.update(env)
import shot
shot.render = lambda path: None
sys.argv = [sys.argv[0], '--', str(Wd), str(Hd), str(SAMP), '/dev/null']
G = runpy.run_path(os.path.join(HERE, script), run_name='__main__')
import bpy
from mathutils import Vector
import world as W, props as P, army as A
sc = bpy.context.scene; FPS = 30
sc.render.fps = FPS; sc.cycles.seed = 11; sc.cycles.use_animated_seed = False
sc.cycles.adaptive_threshold = 0.03; sc.cycles.volume_step_rate = max(sc.cycles.volume_step_rate, 5.0)
cam = sc.camera; cd = cam.data
bpy.context.view_layer.update()                          # the still set the camera's rotation; make matrix_world current
c0 = cam.location.copy(); fwd = cam.matrix_world.to_quaternion() @ Vector((0, 0, -1))
right = cam.matrix_world.to_quaternion() @ Vector((1, 0, 0))
t0 = c0 + fwd * 60.0                                     # where the still's camera looks
aim = bpy.data.objects.new('aim', None); sc.collection.objects.link(aim)
tr = cam.constraints.new('TRACK_TO'); tr.target = aim; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
flat = Vector((fwd.x, fwd.y, 0)).normalized()

def ease(x): x = max(0.0, min(1.0, x)); return x * x * (3 - 2 * x)
def lin(a, b, u): return a + (b - a) * u

# camera paths: (start, end) for position and aim, eased over the shot
if SHOT == 1:
    path = lambda u: (c0 + right * lin(-10, 10, u) + flat * lin(-6, 6, u), t0 + right * lin(-4, 4, u))
elif SHOT == 2:
    at, reg, _ = P.CONVOYS[0]; lead = reg[0]
    def path(u):
        s = lead[1] + 1.4 * u * 3.0 - 3.0
        p, d = at(s); side = Vector((-d.y, d.x))
        c = p + side * 6.5 - d * lin(9, 5, u); q = p + d * 6
        return (Vector((c.x, c.y, W.ground(c.x, c.y) + 1.6)), Vector((q.x, q.y, W.ground(q.x, q.y) + 1.2)))
elif SHOT == 3:
    path = lambda u: (c0 + flat * lin(0, 9, u) + Vector((0, 0, lin(0, 0.6, u))), t0 + flat * lin(0, 6, u))
elif SHOT == 4:
    path = lambda u: (c0 - flat * lin(0, 8, u) + Vector((0, 0, lin(0, 2.5, u))), t0)
elif SHOT == 5:
    path = lambda u: (c0 + right * lin(-12, 12, u), t0 + right * lin(-6, 6, u))
else:
    end_c = Vector((-620.0, -260.0, 330.0)); end_t = Vector((40.0, 60.0, 0.0))
    path = lambda u: (c0.lerp(end_c, u), t0.lerp(end_t, u))

N = F1 - F0 + 1 if SHOT != 6 else 150
fires = [m.node_tree.nodes['FIRENOISE'] for m in bpy.data.materials if m.name == 'fire']
noises = [n for m in bpy.data.materials if m.node_tree for n in m.node_tree.nodes if n.name in ('PLUMENOISE', 'DUSTNOISE')]
cloths = [o for o in sc.objects if o.type == 'MESH' and 'rest' in o.keys()]
hexn = bpy.data.materials['terrain'].node_tree.nodes['HEX_STRENGTH']; hex0 = hexn.outputs[0].default_value

def update(scene, *_):
    f = scene.frame_current; t = (f - 1) / FPS
    u = ease((f - SHOTS[SHOT][2]) / max(1, N - 1))
    c, q = path(u); cam.location = c; aim.location = q
    for at, reg, burnt in P.CONVOYS:
        if burnt: continue
        for o, s0, off in reg:
            p, d = at(s0 + 1.4 * (t - (SHOTS[SHOT][2] - 1) / FPS))
            side = Vector((-d.y, d.x)) * off
            o.location = (p.x + side.x, p.y + side.y, W.ground(p.x + side.x, p.y + side.y) + (0.03 * abs(math.sin(t * 6 + s0)) if off else 0))
            o.rotation_euler.z = math.atan2(d.x, -d.y)
    for n in fires: n.inputs['W'].default_value = t * 1.6
    for n in noises: n.inputs['W'].default_value = t * 0.25
    for o in cloths: A.wave(o, t + o.location.x * 0.1, amp=0.16, speed=2.6)
    if SHOT == 6: hexn.outputs[0].default_value = lin(hex0, 0.32, ease((u - 0.55) / 0.4))
bpy.app.handlers.frame_change_pre.append(update)
os.makedirs(OUTDIR, exist_ok=True)
for fr in range(F0, F1 + 1, int(os.environ.get('STEP', '1'))):
    path_ = os.path.join(OUTDIR, f'{fr:04d}.png')
    if os.path.exists(path_): continue
    sc.frame_set(fr); sc.render.filepath = path_
    bpy.ops.render.render(write_still=True)
    print('FRAME', fr, flush=True)

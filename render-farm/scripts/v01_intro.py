# ① Intro film, 9 s at 30 fps (270 frames), 1080×1350.
# 0–2.5 s  low beside the clash under the keep (the ④ set-up): front ranks thrust in offset phases, banners, dust.
# 2.5–6.5 s an eased crane up and back over the battle.
# 6.5–9 s  settle on the shared valley: town, river, bridge, keep, columns on the roads; the hex lattice fades in.
# Usage: v01_intro.py -- W H SAMPLES OUTDIR [FIRST LAST]. Frames already on disk are skipped, so it resumes.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUTDIR = int(args[0]), int(args[1]), int(args[2]), args[3]
F0, F1 = (int(args[4]), int(args[5])) if len(args) > 5 else (1, 270)
E = lambda k, d: float(os.environ.get(k, d))
FPS, N = 30, 270
open_world()
sc = bpy.context.scene; sc.render.fps = FPS; sc.frame_start, sc.frame_end = 1, N
lib = A.troop_collections()
K0 = Vector((W.KEEP[0], W.KEEP[1], 0)); B = W.BATTLE.to_3d(); gB = W.ground(B.x, B.y); d0 = (K0 - B).normalized()
a, f, bans, axis = S.battle(lib, files=14, gap=1.5, axis=Vector((d0.y, -d0.x, 0)), ban_depth=3.4, ban_sides=(1.0, 7.0, 15.0), ban_h=6.0)
cam0 = B - d0 * 14.5 - axis * 1.2; cam0 = Vector((cam0.x, cam0.y, W.ground(cam0.x, cam0.y) + 1.7))
for pole, cloth in bans:
    v = cam0 - pole.location; th = math.atan2(v.x, -v.y); pole.rotation_euler.z = th; cloth.rotation_euler.z = th
S.dust(B, (70, 26, 9), math.atan2(axis.y, axis.x), 0.9)
S.dust(B + d0 * 34, (80, 40, 16), math.atan2(axis.y, axis.x), 0.9, name='dust_far')
# other columns on the roads, seen in the reveal: Aster reinforcements on the south road, Fjordal down from the keep
colA, atA = S.column(lib, 'aster', W.ROAD2, n=120, files=4, spacing=1.45, seed=21, start=200)
colF, atF = S.column(lib, 'fjordal', list(reversed(W.ROAD))[:3], n=100, files=4, spacing=1.45, seed=22, start=90)
grass([(W.BATTLE, 90)], count=int(E('GCOUNT', 900000)), length=0.2)
sky('kloofendal_48d_partly_cloudy_puresky', 0.45, 20, 22, 232, 8.0, (1.0, 0.7, 0.45), 1.5)
render_settings(SAMP, 'AgX - High Contrast', 0.1)
sc.cycles.volume_step_rate = E('VSTEP', 6.0); sc.cycles.adaptive_threshold = E('ADAPT', 0.03)
sc.cycles.seed = 7; sc.cycles.use_animated_seed = False
haze((0.62, 0.6, 0.6), 60, 700, 0.5)

# ---------------------------------------------------------------- camera: keyframed position and aim, eased
K = Vector((W.KEEP[0], W.KEEP[1], W.KEEP_Z))
tgt0 = B.lerp(K, 0.26); tgt0.z = gB + 7.2
valley = Vector((10, 40, 0)); valley.z = W.ground(valley.x, valley.y)
side = -d0                                       # away from the keep, toward where the camera stands
keys = [   # frame, camera position, aim point, lens
    (1,   cam0, tgt0, 27),
    (75,  cam0 + side * 6 + Vector((0, 0, 1.2)) - axis * 1.5, tgt0 + Vector((0, 0, 1.0)), 27),        # slow push along the line
    (140, B - d0 * 70 + Vector((0, 0, gB + 38)) - axis * 30, B.lerp(K, 0.4) + Vector((0, 0, 6)), 28),   # crane up and back
    (200, Vector((-260, 5, 270)), Vector((60, 60, 10)), 28),
    (270, Vector((-700, 20, 520)), Vector((-40, 60, 0)), 28),                                           # the shared valley: town, river, battle, keep
]
cd = bpy.data.cameras.new('cam'); cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 24; cd.clip_start, cd.clip_end = 0.5, 8000
cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
aim = bpy.data.objects.new('aim', None); sc.collection.objects.link(aim)
tr = cam.constraints.new('TRACK_TO'); tr.target = aim; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
cd.dof.use_dof = True; cd.dof.focus_object = aim
for fr, p, t, lens in keys:
    cam.location = p; cam.keyframe_insert('location', frame=fr)
    aim.location = t; aim.keyframe_insert('location', frame=fr)
    cd.lens = lens; cd.keyframe_insert('lens', frame=fr)
for fr, fs in ((1, 4.0), (75, 4.0), (115, 22.0), (150, 128.0), (270, 128.0)):   # shallow focus in the clash only
    cd.dof.aperture_fstop = fs; cd.dof.keyframe_insert('aperture_fstop', frame=fr)
for idb in (cam, aim, cd):
    ad = idb.animation_data
    for fc in ad.action.fcurves if hasattr(ad.action, 'fcurves') else [fc for l in ad.action.layers for s in l.strips for cb in s.channelbags for fc in cb.fcurves]:
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER'; kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'
        fc.update()
sc.render.resolution_x, sc.render.resolution_y = Wd, Hd
# water seen from above: show the sky in it instead of the dark bed below
wm = bpy.data.materials['water'].node_tree.nodes['Principled BSDF']
wm.inputs['Transmission Weight'].default_value = 0.25; wm.inputs['Base Color'].default_value = W.srgb('#3f6461'); wm.inputs['Roughness'].default_value = 0.06
hz_amt = sc.compositing_node_group.nodes['HAZE_AMT']
# the focus distance follows the aim (the clash first, then the valley); the battle stays sharp early on

# ---------------------------------------------------------------- per-frame life
rng = random.Random(1)
def rest_of(objs):
    return [(o, Vector(o.location), o.rotation_euler.z, rng.uniform(0, math.tau), rng.uniform(0.85, 1.2)) for o in objs]
def front_of(objs, along):          # the first rank of a block: the ones furthest along its direction of advance
    d = sorted(objs, key=lambda o: -Vector(o.location).dot(along))
    return d[:14], d[14:]
fa, ra = front_of(a, axis); ff, rf = front_of(f, -axis)
FRONT = [(r, axis) for r in rest_of(fa)] + [(r, -axis) for r in rest_of(ff)]
REAR = rest_of(ra + rf)
COLS = [(o, atA, 200 - i // 4 * 1.45 * 1.1, Vector(o.location) - atA(200 - i // 4 * 1.45 * 1.1)[0].to_3d()) for i, o in enumerate(colA)] + \
       [(o, atF, 90 - i // 4 * 1.45 * 1.1, Vector(o.location) - atF(90 - i // 4 * 1.45 * 1.1)[0].to_3d()) for i, o in enumerate(colF)]
hexnode = bpy.data.materials['terrain'].node_tree.nodes['HEX_STRENGTH']
dnodes = [m.node_tree.nodes['DUSTNOISE'] for m in bpy.data.materials if m.name.startswith('dust') and 'DUSTNOISE' in m.node_tree.nodes]

def ease(x): x = max(0.0, min(1.0, x)); return x * x * (3 - 2 * x)

def update(scene, *_):
    t = (scene.frame_current - 1) / FPS
    for (o, p0, rz, ph, sp), d in FRONT:       # thrust cycles: lunge forward, recoil, offset per soldier
        c = math.sin(t * 2 * math.pi * 0.9 * sp + ph)
        o.location = p0 + d * (0.22 * max(0.0, c) - 0.08 * max(0.0, -c))
        o.rotation_euler.z = rz + 0.04 * math.sin(t * 3.1 + ph)
    for o, p0, rz, ph, sp in REAR:            # the press behind: shuffling, weight shifting
        o.location = p0 + Vector((0, 0, 0.03 * abs(math.sin(t * 2.6 * sp + ph))))
        o.rotation_euler.z = rz + 0.03 * math.sin(t * 1.7 * sp + ph)
    for o, at, s0, off in COLS:               # columns walk at 1.3 m/s, with a step bob
        p, dd = at(s0 + 1.3 * t)
        o.location = Vector((p.x + off.x, p.y + off.y, W.ground(p.x + off.x, p.y + off.y) + 0.03 * abs(math.sin(t * 6.0 + s0))))
        o.rotation_euler.z = math.atan2(dd.x, -dd.y)
    for pole, cloth in bans: A.wave(cloth, t * 1.0 + pole.location.x * 0.1, amp=0.18, speed=2.6)
    for n in dnodes: n.inputs['W'].default_value = t * 0.35
    hexnode.outputs[0].default_value = 0.35 * ease((t - 6.6) / 1.8)
    e = ease((t - 2.4) / 4.0)                  # thin the air as the camera climbs, so the valley reads clear
    scene.world.mist_settings.start = 60 + 340 * e; scene.world.mist_settings.depth = 700 + 2500 * e
    hz_amt.inputs[1].default_value = 0.5 - 0.28 * e
bpy.app.handlers.frame_change_pre.append(update)

os.makedirs(OUTDIR, exist_ok=True)
for fr in range(F0, F1 + 1, int(E('STEP', 1))):
    path = os.path.join(OUTDIR, f'{fr:04d}.png')
    if os.path.exists(path): continue
    sc.frame_set(fr)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('FRAME', fr, flush=True)

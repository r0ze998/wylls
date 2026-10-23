# ④ Battle: the two lines meet below Fjordal's keep. Low camera beside the clash line, the keep on its crag above.
# Defaults are the approved style frame; environment variables override them for tests.
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world()
lib = A.troop_collections()
K0 = Vector((W.KEEP[0], W.KEEP[1], 0)); B = W.BATTLE.to_3d(); gB = W.ground(B.x, B.y); d0 = (K0 - B).normalized()
# for this shot the lines meet side-on to the camera, which looks up at the keep: Aster enters from the left
a, f, bans, axis = S.battle(lib, files=int(E('FILES', 14)), gap=E('GAP', 1.5), axis=Vector((d0.y, -d0.x, 0)),
                            ban_depth=E('BAND', 3.4), ban_sides=(1.0, 7.0, 15.0), ban_h=E('BANH', 6.0))
cam_xy = B - d0 * E('CD', 14.5) - axis * E('CA', 1.2)
cam = Vector((cam_xy.x, cam_xy.y, W.ground(cam_xy.x, cam_xy.y) + E('CH', 1.7)))
for pole, cloth in bans:      # banners turn their faces to the camera so the sign reads
    v = (cam - pole.location); th = math.atan2(v.x, -v.y)
    pole.rotation_euler.z = th; cloth.rotation_euler.z = th
    A.wave(cloth, 1.3)
S.dust(B, (70, 26, 9), math.atan2(axis.y, axis.x), E('DUST', 0.9))
S.dust(B + d0 * 34, (80, 40, 16), math.atan2(axis.y, axis.x), E('DUST', 0.9), name='dust_far')   # a second veil between the lines and the crag
if os.environ.get('NOGRASS') != '1': grass([(W.BATTLE, 90)], count=int(E('GCOUNT', 900000)), length=0.2)
sky('kloofendal_48d_partly_cloudy_puresky', 0.45, E('HROT', 20), E('SEL', 22), E('SAZ', 232), 8.0, (1.0, 0.7, 0.45), 1.5)
render_settings(SAMP, 'AgX - High Contrast', 0.1)
bpy.context.scene.cycles.volume_step_rate = 4.0
haze((0.62, 0.6, 0.6), 60, 700, 0.5)
K = Vector((W.KEEP[0], W.KEEP[1], W.KEEP_Z))
tgt = B.lerp(K, E('TL', 0.26)); tgt.z = gB + E('TZ', 7.2)
camera(cam, tgt, lens=E('LENS', 27), w=Wd, h=Hd, fstop=4.0, focus=Vector((B.x, B.y, gB + 1.2)) - d0 * 4)
render(OUT)

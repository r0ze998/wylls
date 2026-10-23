# ② Aster's town on its terrace at golden morning: chimney smoke, the scaffolded wall stretch, recruits drilling
# in the square under an instructor. 3/4 aerial, 50 mm. Environment variables override the framing for tests.
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
open_world()
T = W.TOWN.to_3d(); gT = W.ground(T.x, T.y)

def chimneys():
    """Where the town's chimneys stand: rebuild the town once with box() recording the chimney blocks
    (stone, 0.8 × 0.8 m), then throw that copy away."""
    found = []; real_box = W.box
    def rec(bm, c, size, rot=0.0, mat=0):
        if mat == 1 and abs(size[0] - 0.8) < 1e-6 and abs(size[1] - 0.8) < 1e-6: found.append((Vector(c), size[2]))
        return real_box(bm, c, size, rot, mat)
    W.box = rec
    if not W.MATS: W.mats()
    tmp = W.new_coll('tmp_town'); W.town(tmp)
    W.box = real_box
    for o in list(tmp.objects): bpy.data.objects.remove(o)
    bpy.data.collections.remove(tmp)
    return [Vector((c.x, c.y, c.z + h / 2)) for c, h in found]

ch = chimneys()
rng = random.Random(4)
for i, c in enumerate(rng.sample(ch, min(len(ch), int(E('NSMOKE', 12))))):
    S.plume(c + Vector((0, 0, 0.2)), height=E('SMH', 28) * rng.uniform(0.8, 1.2), width=E('SMW', 11), wind=math.radians(E('WIND', 200)), name=f'plume{i}')
bpy.data.materials['plume'].node_tree.nodes['PLUMEDENS'].outputs[0].default_value = E('SMD', 2.5)

# recruits drilling in the square, facing the instructor
lib = A.troop_collections()
face = math.radians(E('FACE', 200))
fw = Vector((math.sin(face), -math.cos(face), 0))
blk = T + Vector((E('BX', -2), E('BY', -3), 0))
A.formation(lib, 'aster', blk, face, int(E('RANKS', 4)), int(E('FILES', 7)), spacing=1.6, poses=('march', 'march', 'brace'), seed=11)
ins = blk + fw * 7.5
o = bpy.data.objects.new('instructor', None); o.instance_type = 'COLLECTION'; o.instance_collection = lib[('aster', 'march')][3]
o.location = (ins.x, ins.y, W.ground(ins.x, ins.y)); o.rotation_euler = (0, 0, face + math.pi); o.scale = (1.1,) * 3
bpy.context.scene.collection.objects.link(o)
# a second squad marching in down the main street from the east gate
street = [W.TOWN + Vector((W.TOWN_R - 8, -5)), W.TOWN + Vector((24, -4))]
S.column(lib, 'aster', street, n=int(E('NCOL', 24)), files=3, spacing=1.5, seed=13, start=E('CSTART', 44))
# the square's clutter: barrels and crates stacked by the houses (CC0 props)
props = W.new_coll('props'); bpy.context.view_layer.layer_collection.children['props'].exclude = True
protos = []
for nm in ('wooden_barrels_01', 'wooden_crate_01'):
    c = bpy.data.collections.new('P_' + nm); props.children.link(c)
    for o in W.import_model(nm, c): pass
    protos.append(c)
prng = random.Random(8)
for k in range(int(E('NPROPS', 22))):
    a_ = prng.uniform(0, math.tau); r_ = 18.5 + prng.uniform(0.5, 2.5)
    if abs(((a_ - math.radians(-10)) + math.pi) % math.tau - math.pi) < 0.35: continue    # keep the street mouth clear
    p = T + Vector((math.cos(a_) * r_, math.sin(a_) * r_, 0))
    o = bpy.data.objects.new('prop', None); o.instance_type = 'COLLECTION'; o.instance_collection = prng.choice(protos)
    o.location = (p.x, p.y, W.ground(p.x, p.y)); o.rotation_euler = (0, 0, prng.uniform(0, math.tau)); o.scale = (1.0,) * 3
    bpy.context.scene.collection.objects.link(o)
# banners at the square, turned to the camera below
bans = []
for k, off in enumerate((Vector((-15, 9)), Vector((13, 11)))):
    p = T + off.to_3d()
    bans.append(A.banner('aster', Vector((p.x, p.y, W.ground(p.x, p.y))), 7.5, size=(2.0, 1.5)))

if os.environ.get('NOGRASS') != '1': grass([(W.TOWN + Vector((60, -70)), 70), (W.TOWN + Vector((-40, -95)), 60)], count=int(E('GCOUNT', 700000)), length=0.25)
sky('kloppenheim_06_puresky', E('SKYS', 0.35), E('HROT', 150), E('SEL', 8), E('SAZ', 100), E('SUNE', 9.0), (1.0, 0.6, 0.32), 1.2)
render_settings(SAMP, 'AgX - Medium High Contrast', E('EXPO', 0.45))
bpy.context.scene.cycles.volume_step_rate = 4.0
haze((0.96, 0.78, 0.6), E('HZS', 120), E('HZD', 900), E('HZA', 0.55))
az = math.radians(E('CAZ', 150))                       # bearing of the camera from the town centre, clockwise from north
dist = E('CDIST', 135); hgt = E('CH', 72)
cam = T + Vector((math.sin(az), math.cos(az), 0)) * dist
cam = Vector((cam.x, cam.y, gT + hgt))
tgt = T + Vector((E('TX', -16), E('TY', 14), 0)); tgt.z = gT + E('TZ', 0)
for pole, cloth in bans:
    v = cam - pole.location; th = math.atan2(v.x, -v.y); pole.rotation_euler.z = th; cloth.rotation_euler.z = th
    A.wave(cloth, 0.8, amp=0.12)
camera(cam, tgt, lens=E('LENS', 50), w=Wd, h=Hd, fstop=E('FSTOP', 8), focus=blk + Vector((0, 0, gT + 1)))
render(OUT)

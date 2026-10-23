# ⑥ Replay (an illustration, not a verification result): the battle below the keep seen high and oblique.
# One camera, four renders, put together by p06_post.py: the left half in colour, the right half the same scene
# re-traced as an engraving on parchment.
# MODE=color  the finished colour frame
# MODE=shade  plain white clay under the same sun (for hatching density)
# MODE=normal camera-space normals, MODE=mist  depth (for the ink outlines)
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
import army as A, stage as S
args = sys.argv[sys.argv.index('--') + 1:]
Wd, Hd, SAMP, OUT = int(args[0]), int(args[1]), int(args[2]), args[3]
E = lambda k, d: float(os.environ.get(k, d))
MODE = os.environ.get('MODE', 'color')
open_world()
lib = A.troop_collections()
K0 = Vector((W.KEEP[0], W.KEEP[1], 0)); B = W.BATTLE.to_3d(); gB = W.ground(B.x, B.y); d0 = (K0 - B).normalized()
a, f, bans, axis = S.battle(lib, files=18, gap=1.5, axis=Vector((d0.y, -d0.x, 0)), ban_depth=4.0, ban_sides=(-6.0, 2.0, 10.0), ban_h=6.0)
# camera: high oblique from the south-west of the clash, the keep's crag closing the top of the frame
cam = B - d0 * E('CD', 48) - axis * E('CA', 10); cam = Vector((cam.x, cam.y, gB + E('CH', 34)))
tgt = B + d0 * E('TD', 14); tgt.z = gB + E('TZ', 2)
for pole, cloth in bans:
    v = cam - pole.location; th = math.atan2(v.x, -v.y); pole.rotation_euler.z = th; cloth.rotation_euler.z = th
    A.wave(cloth, 1.3)
sc = bpy.context.scene
if MODE == 'color':
    S.dust(B, (70, 26, 9), math.atan2(axis.y, axis.x), 0.6)
    grass([(W.BATTLE, 90)], count=int(E('GCOUNT', 900000)), length=0.2)
sky('kloofendal_48d_partly_cloudy_puresky', 0.45, 20, 30, 232, 7.0, (1.0, 0.82, 0.62), 1.5)
render_settings(SAMP, 'AgX - Medium High Contrast', 0.0)
if MODE == 'color':
    haze((0.7, 0.68, 0.66), 80, 900, 0.4)
else:
    # flat light-grey world: no sky detail in the data passes
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
    clay = W.flat_mat('clay', (0.8, 0.8, 0.8, 1), 0.9)
    vl = bpy.context.view_layer; vl.material_override = clay
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
    if MODE in ('normal', 'mist'):
        sc.cycles.samples = 1; sc.cycles.use_denoising = False
        sc.render.image_settings.color_depth = '16'
        vl.use_pass_normal = True; vl.use_pass_mist = True
        w = sc.world; w.mist_settings.start = 0; w.mist_settings.depth = E('MISTD', 900); w.mist_settings.falloff = 'LINEAR'
        ng = bpy.data.node_groups.new('comp', 'CompositorNodeTree'); sc.compositing_node_group = ng
        rl = ng.nodes.new('CompositorNodeRLayers')
        ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        go = ng.nodes.new('NodeGroupOutput')
        try: sc.render.compositor_device = 'CPU'
        except Exception: pass
        if MODE == 'mist':
            ng.links.new(rl.outputs['Mist'], go.inputs[0])
        else:   # world-space normal → 0..1 colour
            mx = ng.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'ADD'; mx.inputs['Factor'].default_value = 1.0
            ng.links.new(rl.outputs['Normal'], mx.inputs[6]); mx.inputs[7].default_value = (1, 1, 1, 1)
            ml = ng.nodes.new('ShaderNodeMix'); ml.data_type = 'RGBA'; ml.blend_type = 'MULTIPLY'; ml.inputs['Factor'].default_value = 1.0
            ng.links.new(mx.outputs[2], ml.inputs[6]); ml.inputs[7].default_value = (0.5, 0.5, 0.5, 1)
            ng.links.new(ml.outputs[2], go.inputs[0])
camera(cam, tgt, lens=E('LENS', 45), w=Wd, h=Hd, fstop=(E('FSTOP', 11) if MODE == 'color' else None), focus=B + Vector((0, 0, gB)))
render(OUT)

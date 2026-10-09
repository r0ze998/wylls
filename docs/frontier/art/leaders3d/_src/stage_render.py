"""Stage renders of the six leaders: the package's rigged models and clips, seen from the front.
Lights and render settings follow the package's own recipe (source/render_motion.py: Eevee, Standard view,
warm upper-left sun, soft face fill, quiet hair rim, transparent film). The model file is opened, never saved.
usage: blender -b --python stage_render.py -- <models dir> <out dir> <keys> <clip:frames,...> <yaw> <resx> <resy> <ortho> <camz> [samples] [pitch]
"""
import bpy, sys, math, json
from pathlib import Path
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
models, out = Path(a[0]), Path(a[1])
keys = a[2].split(',')
clips = [(c.split(':')[0], int(c.split(':')[1])) for c in a[3].split(',')]
yaw, resx, resy, ortho, camz = float(a[4]), int(a[5]), int(a[6]), float(a[7]), float(a[8])
samples = int(a[9]) if len(a) > 9 else 32
pitch = float(a[10]) if len(a) > 10 else 0.0
NAMES = {'idle': 'Idle', 'walk': 'Walk', 'attack': 'Attack', 'hit': 'Hit'}
LOOP = {'idle', 'walk'}

def lights(scene):
    world = bpy.data.worlds.new('Wylls animation daylight'); world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (.5, .6, .8, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .42
    scene.world = world
    sun = bpy.data.lights.new('Wylls warm upper-left sun', 'SUN')
    sun.energy, sun.angle, sun.color = 2.7, math.radians(8), (1, .94, .85)
    ob = bpy.data.objects.new(sun.name, sun); scene.collection.objects.link(ob)
    ob.rotation_euler = Vector((.55, .5, -1)).normalized().to_track_quat('-Z', 'Y').to_euler()
    for name, loc, target, energy, size, colour in (('Soft face fill', (0, -5, 3.4), (0, 0, 1.15), 190, 6, (.88, .94, 1)), ('Quiet hair rim', (0, 3, 3.7), (0, 0, 1.2), 140, 5, (.94, 1, .91))):
        d = bpy.data.lights.new(name, 'AREA'); d.energy, d.size, d.color = energy, size, colour
        o = bpy.data.objects.new(name, d); scene.collection.objects.link(o); o.location = loc
        o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()

def camera(scene):
    d = bpy.data.cameras.new('Stage front'); d.type = 'ORTHO'; d.ortho_scale = ortho
    o = bpy.data.objects.new(d.name, d); scene.collection.objects.link(o)
    ang = math.pi / 2 - math.radians(pitch)
    o.rotation_euler = (ang, 0, 0)
    o.location = Vector((0, 0, camz)) - Vector((0, math.sin(ang), -math.cos(ang))) * 8
    scene.render.resolution_x, scene.render.resolution_y = resx, resy
    scene.camera = o

def use_action(arm, action):
    ad = arm.animation_data_create()
    for t in ad.nla_tracks: t.mute = True
    ad.action = action
    slots = list(action.slots) if hasattr(action, 'slots') else []
    if slots: ad.action_slot = next((s for s in slots if getattr(s, 'target_id_type', None) == 'OBJECT'), slots[0])
    bpy.context.view_layer.update()

for key in keys:
    bpy.ops.wm.open_mainfile(filepath=str(models / (key + '.blend')))
    scene = bpy.context.scene
    arm = next(o for o in scene.objects if o.type == 'ARMATURE')
    for o in list(scene.objects):
        if o.type in ('CAMERA', 'LIGHT'): bpy.data.objects.remove(o, do_unlink=True)
    kids = [o for o in scene.objects if o.parent is None and o.type in ('MESH', 'EMPTY', 'ARMATURE')]
    wrap = bpy.data.objects.new('Render state', None); scene.collection.objects.link(wrap)
    for o in kids:
        m = o.matrix_world.copy(); o.parent = wrap; o.matrix_world = m
    wrap.rotation_euler.z = yaw
    scene.render.engine = 'BLENDER_EEVEE'; scene.eevee.taa_render_samples = samples; scene.eevee.use_raytracing = False
    scene.render.film_transparent = True; scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'; scene.view_settings.look = 'None'; scene.view_settings.exposure = 0
    lights(scene); camera(scene)
    for clip, n in clips:
        act = bpy.data.actions.get(NAMES[clip]) or next(x for x in bpy.data.actions if x.name.split('.')[0] == NAMES[clip])
        use_action(arm, act)
        start, end = map(float, act.frame_range)
        for i in range(n):
            frac = i / (n if clip in LOOP else n - 1)
            frame = start + (end - start) * frac
            for b in arm.pose.bones: b.matrix_basis.identity()
            scene.frame_set(math.floor(frame), subframe=frame % 1); bpy.context.view_layer.update()
            folder = out / key / clip; folder.mkdir(parents=True, exist_ok=True)
            scene.render.filepath = str(folder / f'frame-{i:03d}.png')
            bpy.ops.render.render(write_still=True)
        print('STAGE', key, clip, n, flush=True)

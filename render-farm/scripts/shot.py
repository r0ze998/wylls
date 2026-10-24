# Shared shot set-up: open the saved world, set sky, sun, haze, camera, render settings.
import bpy, math, os, sys
from mathutils import Vector
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import world as W

def open_world(path=None):
    bpy.ops.wm.open_mainfile(filepath=path or os.path.join(ROOT, os.environ.get('WORLD', 'world.blend')))
    t = bpy.data.objects['terrain'].data
    import numpy as np
    n = int(round(math.sqrt(len(t.vertices))))
    co = np.zeros(len(t.vertices) * 3); t.vertices.foreach_get('co', co); co = co.reshape(n, n, 3)
    W._HCACHE.update(H=co[:, :, 2], xs=co[0, :, 0], ys=co[:, 0, 1])
    # the big cliff and boulder pieces that landed right under the keep read as rocks floating in front of its
    # walls from the battle side: clear them from the crag top
    for o in list(bpy.context.scene.objects):
        ic = o.instance_collection
        if ic and ('drone_rock' in ic.name or 'boulder' in ic.name) and (o.location.xy - W.KEEP).length < 55:
            bpy.data.objects.remove(o)
    return bpy.context.scene

def sky(hdri, strength=1.0, rot_deg=0.0, sun_elev=30, sun_az=220, sun_energy=4.0, sun_color=(1.0, 0.9, 0.78), sun_angle=1.0):
    sc = bpy.context.scene
    w = bpy.data.worlds.new('sky'); sc.world = w; w.use_nodes = True; nt = w.node_tree
    bg = nt.nodes['Background']
    env = nt.nodes.new('ShaderNodeTexEnvironment'); env.image = bpy.data.images.load(os.path.join(ROOT, 'assets', 'hdri', hdri + '_2k.hdr'))
    tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Rotation'].default_value = (0, 0, math.radians(rot_deg))
    nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs[0], env.inputs['Vector'])
    nt.links.new(env.outputs['Color'], bg.inputs['Color']); bg.inputs['Strength'].default_value = strength
    sd = bpy.data.lights.new('sun', 'SUN'); sd.energy = sun_energy; sd.color = sun_color; sd.angle = math.radians(sun_angle)
    so = bpy.data.objects.new('sun', sd); sc.collection.objects.link(so)
    e, a = math.radians(sun_elev), math.radians(sun_az)
    d = -Vector((math.cos(e) * math.sin(a), math.cos(e) * math.cos(a), math.sin(e)))
    so.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return so

def camera(loc, target, lens=35, w=1080, h=1350, fstop=None, focus=None):
    sc = bpy.context.scene
    cd = bpy.data.cameras.new('cam'); cd.lens = lens; cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 24
    cd.clip_start, cd.clip_end = 0.5, 6000
    cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    cam.location = Vector(loc); cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    if fstop:
        cd.dof.use_dof = True; cd.dof.aperture_fstop = fstop
        cd.dof.focus_distance = (Vector(focus or target) - Vector(loc)).length
    sc.render.resolution_x, sc.render.resolution_y = w, h; sc.render.resolution_percentage = 100
    return cam

def haze(color=(0.75, 0.82, 0.92), start=80, depth=900, amount=0.55, falloff='QUADRATIC'):
    """Aerial perspective in the compositor from the mist pass, applied to the land only; the sky comes from the
    environment pass, so the clouds keep their contrast."""
    sc = bpy.context.scene; vl = bpy.context.view_layer
    vl.use_pass_mist = True; vl.use_pass_environment = True
    try: sc.render.compositor_device = 'CPU'
    except Exception as e: print('compdev', e)
    sc.render.film_transparent = True
    w = sc.world; w.mist_settings.start = start; w.mist_settings.depth = depth; w.mist_settings.falloff = falloff
    ng = bpy.data.node_groups.new('comp', 'CompositorNodeTree'); sc.compositing_node_group = ng
    rl = ng.nodes.new('CompositorNodeRLayers')
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    go = ng.nodes.new('NodeGroupOutput')
    def mix(blend, fac, a, b):
        n = ng.nodes.new('ShaderNodeMix'); n.data_type = 'RGBA'; n.blend_type = blend
        for sock, v in ((n.inputs['Factor'], fac), (n.inputs[6], a), (n.inputs[7], b)):
            if isinstance(v, (int, float)): sock.default_value = v
            elif isinstance(v, tuple): sock.default_value = v
            else: ng.links.new(v, sock)
        return n.outputs[2]
    def math_(op, a, b):
        n = ng.nodes.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: ng.links.new(v, n.inputs[i])
        return n.outputs[0]
    bl = ng.nodes.new('CompositorNodeBlur')
    try: bl.filter_type = 'GAUSS'
    except Exception: pass
    for nm, v in (('Size', (8, 8)),):
        try: bl.inputs[nm].default_value = v
        except Exception:
            try: bl.size_x = bl.size_y = 8
            except Exception as e: print('blur', e)
    if os.environ.get('HAZE_MIST') == '1':
        ng.links.new(rl.outputs['Mist'], bl.inputs[0])
    else:
        # Smoke and dust volumes write into the mist pass and came out bleached white. The depth pass sees only
        # surfaces but isn't antialiased. Take the smaller of the two: surfaces keep the mist pass's clean edges, and a
        # plume in front of a hill takes the hill's distance. Against open sky (no surface, mist saturated) the
        # pixel is left to the sky term instead.
        vl.use_pass_z = True
        lin_ = math_('DIVIDE', math_('SUBTRACT', rl.outputs['Depth'], float(start)), float(depth))
        cl = ng.nodes.new('ShaderNodeClamp'); ng.links.new(lin_, cl.inputs['Value'])
        kd = math_('POWER', cl.outputs[0], 2.0 if falloff == 'QUADRATIC' else 1.0)
        km = math_('MINIMUM', rl.outputs['Mist'], kd)
        volsky = math_('MULTIPLY', math_('GREATER_THAN', rl.outputs['Depth'], 1.0e5), math_('GREATER_THAN', rl.outputs['Mist'], 0.97))
        ng.links.new(math_('MULTIPLY', km, math_('SUBTRACT', 1.0, volsky)), bl.inputs[0])
    k = math_('MULTIPLY', bl.outputs[0], amount); k.node.name = 'HAZE_AMT'     # animatable haze strength
    hz_a = mix('MULTIPLY', 1.0, tuple(color) + (1,), rl.outputs['Alpha'])           # haze colour, premultiplied
    fg = mix('MIX', k, rl.outputs['Image'], hz_a)
    inv = math_('SUBTRACT', 1.0, rl.outputs['Alpha'])
    sky_ = mix('MULTIPLY', 1.0, rl.outputs['Environment'], inv)
    out = mix('ADD', 1.0, fg, sky_)
    ng.links.new(out, go.inputs[0])
    if os.environ.get('HAZE_DEBUG'):                       # show the haze factor (or the raw alpha) instead of the image
        dbg = {'k': k, 'a': rl.outputs['Alpha']}[os.environ['HAZE_DEBUG']]
        ng.links.new(dbg, go.inputs[0])
    return ng

def render_settings(samples=128, look='AgX - Medium High Contrast', exposure=0.0):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    sc.cycles.samples = samples; sc.cycles.use_adaptive_sampling = True; sc.cycles.adaptive_threshold = 0.02
    sc.cycles.use_denoising = True; sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    sc.cycles.max_bounces = 6; sc.cycles.diffuse_bounces = 3; sc.cycles.glossy_bounces = 3; sc.cycles.transmission_bounces = 6
    sc.cycles.transparent_max_bounces = 24
    sc.cycles.caustics_reflective = sc.cycles.caustics_refractive = False
    sc.cycles.texture_limit_render = '2048'
    sc.render.use_persistent_data = True
    sc.view_settings.view_transform = 'AgX'
    try: sc.view_settings.look = look
    except Exception: pass
    sc.view_settings.exposure = exposure
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'

def set_value(mat, node, v):
    bpy.data.materials[mat].node_tree.nodes[node].outputs[0].default_value = v

def render(path):
    """BORDER=y0,y1 renders only that band of the frame (0 = bottom), uncropped, so halves can be stacked."""
    if os.environ.get('BORDER'):
        y0, y1 = map(float, os.environ['BORDER'].split(','))
        r = bpy.context.scene.render; r.use_border = True; r.use_crop_to_border = False
        r.border_min_x, r.border_max_x, r.border_min_y, r.border_max_y = 0, 1, y0, y1
        # stay RGB: an RGBA PNG stores straight alpha, which un-premultiplies the haze/sky composite (white halos
        # on every sky edge, a wrong sky); stack_bands cuts inside each band, so it needs no alpha
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('RENDERED', path, flush=True)

def grass(centers, radius=70, count=400000, length=0.32, seed=1):
    """Grass blades as hair on the terrain within `radius` of each centre (Cycles renders hair as curves)."""
    import numpy as np
    ob = bpy.data.objects['terrain']; me = ob.data
    vg = ob.vertex_groups.new(name='grass')
    co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    road = np.zeros(len(me.vertices)); me.attributes['road'].data.foreach_get('value', road)
    rock = np.zeros(len(me.vertices)); me.attributes['rock'].data.foreach_get('value', rock)
    w = np.zeros(len(co))
    for c, r in centers:
        d = np.hypot(co[:, 0] - c[0], co[:, 1] - c[1])
        w = np.maximum(w, np.clip(1 - d / r, 0, 1) ** 0.5)
    w *= (1 - road) * (1 - rock)
    idx = np.nonzero(w > 0.01)[0]
    for i in idx: vg.add([int(i)], float(w[i]), 'REPLACE')
    mod = ob.modifiers.new('grass', 'PARTICLE_SYSTEM'); ps = mod.particle_system
    s = ps.settings; s.type = 'HAIR'; s.count = count; s.hair_length = length; s.use_advanced_hair = False
    s.emit_from = 'FACE'; s.distribution = 'RAND'; s.use_even_distribution = True
    s.brownian_factor = 0.0
    s.root_radius = 0.6; s.tip_radius = 0.0; s.radius_scale = 0.012; s.render_step = 2; s.display_step = 1
    s.use_hair_bspline = False
    ps.vertex_group_density = 'grass'; ps.vertex_group_length = 'grass'; ps.seed = seed
    s.rotation_mode = 'NOR'; s.phase_factor_random = 2.0
    s.child_type = 'NONE'
    m = bpy.data.materials.new('grassblade'); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    hi = nt.nodes.new('ShaderNodeHairInfo'); rmp = nt.nodes.new('ShaderNodeValToRGB')
    rmp.color_ramp.elements[0].color = W.srgb('#3c5a1e'); rmp.color_ramp.elements[1].color = W.srgb('#a3a85a')
    nt.links.new(hi.outputs['Intercept'], rmp.inputs['Fac'])
    rnd = nt.nodes.new('ShaderNodeMix'); rnd.data_type = 'RGBA'; rnd.blend_type = 'MULTIPLY'
    nt.links.new(hi.outputs['Random'], rnd.inputs['Factor']); nt.links.new(rmp.outputs['Color'], rnd.inputs[6]); rnd.inputs[7].default_value = W.srgb('#c9b56a')
    nt.links.new(rnd.outputs[2], b.inputs['Base Color']); b.inputs['Roughness'].default_value = 0.6
    b.inputs['Subsurface Weight'].default_value = 0.2
    me.materials.append(m); s.material = len(me.materials)
    return ps

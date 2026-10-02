# Style A: 2.5D diorama tiles rendered with Cycles.
# Run: blender -b --factory-startup --python render_a.py -- [terrain,...] [variants]
import bpy, sys, os, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
MODE = ARGV.pop(0) if ARGV and ARGV[0] in ("tiles", "rivers", "roads", "riverroads", "sites") else "tiles"
ONLY = ARGV[0].split(",") if ARGV and ARGV[0] != "all" else None
VARIANTS = int(ARGV[1]) if len(ARGV) > 1 and ARGV[1].isdigit() else 3
SAMPLES = int(ARGV[2]) if len(ARGV) > 2 and ARGV[2].isdigit() else 384
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "A"))

def setup():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "METAL"
    sc.cycles.device = "GPU"
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.cycles.denoiser = "OPENIMAGEDENOISE"
    sc.cycles.filter_width = 1.5
    sc.cycles.caustics_reflective = sc.cycles.caustics_refractive = False
    sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "16"
    w = bpy.data.worlds.new("w")
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.5, 0.6, 0.8, 1)
    bg.inputs["Strength"].default_value = 0.42

# ---------------------------------------------------------------- node helpers
class NT:
    def __init__(self, name):
        self.m = bpy.data.materials.new(name)
        self.m.use_nodes = True
        self.t = self.m.node_tree
        self.N, self.L = self.t.nodes, self.t.links
        self.bsdf = self.N["Principled BSDF"]
        self.out = self.N["Material Output"]

    def node(self, kind, **inputs):
        n = self.N.new(kind)
        for k, v in inputs.items():
            if hasattr(n, k) and not k[0].isupper():
                setattr(n, k, v)
            else:
                self.set(n.inputs[k], v)
        return n

    def set(self, sock, v):
        if hasattr(v, "is_output") or (hasattr(v, "node") and hasattr(v, "links")):
            self.L.new(v, sock)
        else:
            sock.default_value = v

    def math(self, op, a, b=None, c=None, clamp=False):
        n = self.N.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b, c)):
            if v is not None:
                self.set(n.inputs[i], v)
        return n.outputs[0]

    def vmul(self, a, b):
        n = self.N.new("ShaderNodeVectorMath")
        n.operation = "MULTIPLY"
        self.set(n.inputs[0], a)
        self.set(n.inputs[1], b if not isinstance(b, (int, float)) else (b, b, b))
        return n.outputs[0]

    def vcol(self):
        n = self.N.new("ShaderNodeVertexColor")
        n.layer_name = "col"
        return n.outputs["Color"]

    def coord(self, kind="Object"):
        if not hasattr(self, "_tc"):
            self._tc = self.N.new("ShaderNodeTexCoord")
        return self._tc.outputs[kind]

    def noise(self, scale, vec=None, detail=4.0, rough=0.55):
        n = self.N.new("ShaderNodeTexNoise")
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        self.L.new(vec or self.coord(), n.inputs["Vector"])
        return n.outputs["Fac"]

    def ao(self, dist):
        n = self.N.new("ShaderNodeAmbientOcclusion")
        n.samples = 16
        n.inputs["Distance"].default_value = dist
        return n.outputs["AO"]

    def ao_k(self, dist, lo):
        return self.math("MULTIPLY_ADD", self.ao(dist), 1 - lo, lo)

    def ramp(self, fac, colors, positions=None):
        r = self.N.new("ShaderNodeValToRGB")
        els = r.color_ramp.elements
        while len(els) < len(colors):
            els.new(0.5)
        for i, c in enumerate(colors):
            els[i].position = positions[i] if positions else i / max(1, len(colors) - 1)
            els[i].color = C.lin(C.hx(c)) + (1,)
        self.L.new(fac, r.inputs["Fac"])
        return r.outputs["Color"]

    def mixc(self, fac, a, b):
        n = self.N.new("ShaderNodeMix")
        n.data_type = "RGBA"
        self.set(n.inputs[0], fac)
        ins = [i for i in n.inputs if i.type == "RGBA"]
        self.set(ins[0], a if not isinstance(a, tuple) else a + (1,) if len(a) == 3 else a)
        self.set(ins[1], b if not isinstance(b, tuple) else b + (1,) if len(b) == 3 else b)
        return [o for o in n.outputs if o.type == "RGBA"][0]

    def bump(self, height, strength, dist=0.02):
        b = self.N.new("ShaderNodeBump")
        b.inputs["Strength"].default_value = strength
        b.inputs["Distance"].default_value = dist
        self.L.new(height, b.inputs["Height"])
        self.L.new(b.outputs["Normal"], self.bsdf.inputs["Normal"])

    def finish(self, color, rough=0.9, spec=0.2, translucent=0.0, sss=0.0):
        self.L.new(color, self.bsdf.inputs["Base Color"])
        self.bsdf.inputs["Roughness"].default_value = rough
        self.bsdf.inputs["Specular IOR Level"].default_value = spec
        if sss:
            self.bsdf.inputs["Subsurface Weight"].default_value = sss
            self.bsdf.inputs["Subsurface Radius"].default_value = (0.02, 0.03, 0.02)
        if translucent:
            tr = self.N.new("ShaderNodeBsdfTranslucent")
            self.L.new(color, tr.inputs["Color"])
            mx = self.N.new("ShaderNodeMixShader")
            mx.inputs[0].default_value = translucent
            self.L.new(self.bsdf.outputs[0], mx.inputs[1])
            self.L.new(tr.outputs[0], mx.inputs[2])
            self.L.new(mx.outputs[0], self.out.inputs["Surface"])
        return self.m

_M = {}

def material(role):
    if role in _M:
        return _M[role]
    t = NT(role)
    if role == "ground":
        fine = t.noise(70.0)
        k = t.math("MULTIPLY_ADD", fine, 0.22, 0.89)
        col = t.vmul(t.vmul(t.vcol(), k), t.ao_k(0.05, 0.5))
        t.bump(t.noise(140.0), 0.18)
        m = t.finish(col, rough=0.95, spec=0.15)
    elif role in ("grass", "wheat"):
        col = t.vmul(t.vcol(), t.ao_k(0.03, 0.72))
        m = t.finish(col, rough=0.62, spec=0.25, translucent=0.22)
    elif role == "wall":
        sep = t.node("ShaderNodeSeparateXYZ")
        t.L.new(t.coord(), sep.inputs[0])
        z = sep.outputs["Z"]
        wv = t.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Z")
        wv.inputs["Scale"].default_value = 4.0
        wv.inputs["Distortion"].default_value = 6.0
        wv.inputs["Detail"].default_value = 3.0
        t.L.new(t.coord(), wv.inputs["Vector"])
        strata = t.ramp(wv.outputs["Fac"], ["#6a5241", "#7f654e", "#8c7a68", "#766553", "#9a8a76"])
        dark = t.math("GREATER_THAN", t.math("MULTIPLY_ADD", t.noise(30.0), 0.02, z), C.H_LAND - 0.038)
        col = t.mixc(dark, strata, C.lin(C.hx("#4a3628")))
        shade = t.math("MULTIPLY_ADD", z, 1.2, 0.72, clamp=True)
        col = t.vmul(t.vmul(col, shade), t.ao_k(0.04, 0.55))
        t.bump(t.noise(22.0, detail=6.0), 0.55)
        m = t.finish(col, rough=0.95, spec=0.1)
    elif role in ("foliage", "bush"):
        v = t.math("MULTIPLY_ADD", t.noise(55.0), 0.3, 0.85)
        col = t.vmul(t.vmul(t.vcol(), v), t.ao_k(0.12, 0.35))
        t.bump(t.noise(110.0, detail=2.0), 0.4)
        m = t.finish(col, rough=0.7, spec=0.3, translucent=0.2)
    elif role == "conifer":
        v = t.math("MULTIPLY_ADD", t.noise(90.0), 0.25, 0.87)
        col = t.vmul(t.vmul(t.vcol(), v), t.ao_k(0.1, 0.4))
        t.bump(t.noise(160.0, detail=2.0), 0.35)
        m = t.finish(col, rough=0.8, spec=0.2, translucent=0.1)
    elif role in ("bark", "wood"):
        m = t.finish(t.vmul(t.vcol(), t.ao_k(0.05, 0.5)), rough=0.9, spec=0.1)
    elif role in ("rock", "mrock", "grock"):
        v = t.math("MULTIPLY_ADD", t.noise(18.0, detail=6.0), 0.3, 0.84)
        col = t.vmul(t.vmul(t.vcol(), v), t.ao_k(0.08 if role == "mrock" else 0.04, 0.42))
        t.bump(t.noise(38.0, detail=8.0), 0.55 if role == "mrock" else 0.45)
        m = t.finish(col, rough=0.88, spec=0.2)
    elif role == "snow":
        col = t.vmul(t.vcol(), t.ao_k(0.06, 0.7))
        t.bump(t.noise(24.0), 0.15)
        m = t.finish(col, rough=0.5, spec=0.35, sss=0.1)
    elif role == "flower":
        m = t.finish(t.vcol(), rough=0.5, spec=0.3, translucent=0.15)
    elif role == "water":
        vc = t.N.new("ShaderNodeVertexColor")
        vc.layer_name = "col"
        inner = vc.outputs["Alpha"]
        mp = t.node("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (1.0, 2.8, 1.0)
        t.L.new(t.coord(), mp.inputs["Vector"])
        fac = t.math("MULTIPLY_ADD", t.math("SUBTRACT", t.noise(3.0, mp.outputs["Vector"], 3.0), 0.5), inner, 0.5)
        body = t.ramp(fac, ["#1f5b6e", "#28697d", "#32778a"], [0.35, 0.5, 0.65])
        lw = t.node("ShaderNodeLayerWeight")
        lw.inputs["Blend"].default_value = 0.35
        col = t.mixc(lw.outputs["Facing"], body, C.lin(C.hx("#5d9dac")))
        fleck = t.math("GREATER_THAN", t.noise(26.0, mp.outputs["Vector"], 6.0, 0.6), 0.71)
        col = t.mixc(t.math("MULTIPLY", t.math("MULTIPLY", fleck, inner), 0.22), col, C.lin(C.hx("#cfe6e6")))
        h1 = t.noise(9.0, mp.outputs["Vector"], 4.0)
        h2 = t.noise(30.0, mp.outputs["Vector"], 3.0)
        t.bump(t.math("MULTIPLY", t.math("MULTIPLY_ADD", h2, 0.4, h1), inner), 0.14, 0.01)
        m = t.finish(col, rough=0.07, spec=0.75)
    elif role == "river":
        sep = t.node("ShaderNodeSeparateColor")
        t.L.new(t.vcol(), sep.inputs[0])
        d = sep.outputs["Red"]
        n1 = t.noise(14.0, detail=3.0)
        body = t.ramp(t.math("MULTIPLY_ADD", n1, 0.15, d), ["#2a6f80", "#327c8c", "#4a939b", "#7fb9b0"], [0.1, 0.45, 0.72, 0.95])
        lw = t.node("ShaderNodeLayerWeight")
        lw.inputs["Blend"].default_value = 0.35
        col = t.mixc(t.math("MULTIPLY", lw.outputs["Facing"], 0.6), body, C.lin(C.hx("#7fb7bf")))
        foam = t.math("MULTIPLY", t.math("GREATER_THAN", t.noise(48.0, detail=4.0), 0.64), t.math("GREATER_THAN", d, 0.55))
        col = t.mixc(t.math("MULTIPLY", foam, 0.5), col, C.lin(C.hx("#dcefec")))
        t.bump(t.math("MULTIPLY_ADD", t.noise(40.0), 0.4, n1), 0.12, 0.01)
        m = t.finish(col, rough=0.08, spec=0.7)
    elif role == "road":
        sep = t.node("ShaderNodeSeparateColor")
        t.L.new(t.vcol(), sep.inputs[0])
        s_ = t.math("ABSOLUTE", t.math("MULTIPLY_ADD", sep.outputs["Red"], 2.0, -1.0))
        n1 = t.noise(16.0, detail=4.0)
        fine = t.noise(90.0, detail=5.0)
        edge = t.math("MULTIPLY_ADD", t.math("SUBTRACT", n1, 0.5), 0.45, s_)
        alpha = t.math("SUBTRACT", 1.0, t.math("MULTIPLY", t.math("SUBTRACT", edge, 0.58), 3.2, clamp=True), clamp=True)
        alpha = t.math("MULTIPLY", alpha, t.math("SUBTRACT", 1.0, sep.outputs["Blue"]))
        dirt = t.ramp(t.math("MULTIPLY_ADD", fine, 0.6, t.math("MULTIPLY", n1, 0.4)), ["#7b6446", "#957a58", "#ad946d", "#bca47c"])
        rut = t.math("LESS_THAN", t.math("ABSOLUTE", t.math("SUBTRACT", t.math("MULTIPLY_ADD", t.math("SUBTRACT", fine, 0.5), 0.12, s_), 0.36)), 0.07)
        col = t.mixc(t.math("MULTIPLY", rut, 0.55), dirt, C.lin(C.hx("#5e4b36")))
        peb = t.math("GREATER_THAN", t.noise(160.0, detail=2.0), 0.7)
        col = t.mixc(t.math("MULTIPLY", peb, 0.6), col, C.lin(C.hx("#cfc2a4")))
        col = t.vmul(col, t.ao_k(0.03, 0.6))
        t.bump(t.math("MULTIPLY_ADD", rut, -0.4, fine), 0.35, 0.01)
        t.bsdf.inputs["Roughness"].default_value = 0.95
        t.bsdf.inputs["Specular IOR Level"].default_value = 0.15
        t.L.new(col, t.bsdf.inputs["Base Color"])
        tr = t.N.new("ShaderNodeBsdfTransparent")
        mx = t.N.new("ShaderNodeMixShader")
        t.L.new(alpha, mx.inputs[0])
        t.L.new(tr.outputs[0], mx.inputs[1])
        t.L.new(t.bsdf.outputs[0], mx.inputs[2])
        t.L.new(mx.outputs[0], t.out.inputs["Surface"])
        m = t.m
    elif role == "holdout":
        for n in list(t.N):
            if n.type != "OUTPUT_MATERIAL":
                t.N.remove(n)
        h = t.N.new("ShaderNodeHoldout")
        t.L.new(h.outputs[0], t.out.inputs["Surface"])
        m = t.m
    else:
        m = t.finish(t.vcol())
    _M[role] = m
    return m

GROUNDISH = ("ground", "wall", "river", "water", "grock")

def assign(objs, holdout=()):
    for ob in objs:
        roles = ob["roles"].split(",")
        for i, r in enumerate(roles):
            m = material("holdout" if r in holdout else r)
            if i < len(ob.data.materials):
                ob.data.materials[i] = m
            else:
                ob.data.materials.append(m)

def shoot(dirs, name):
    raw = os.path.join(OUT, "_raw", name)
    bpy.context.scene.render.filepath = raw
    bpy.ops.render.render(write_still=True)
    px = grade(C.load_px(raw))
    for sub, f in (("master_4x", 1), ("@2x", 2), ("@1x", 4)):
        d = os.path.join(OUT, dirs, sub)
        os.makedirs(d, exist_ok=True)
        C.save_px(px if f == 1 else C.downsample(px, f), os.path.join(d, name))

def scene_for(terrain, v, river=0, site=False):
    C.reset_scene()
    C.camera(C.PPU1 * 4)
    C.sun(2.7, 2.5, color=(1.0, 0.94, 0.84), direction=(0.55, 0.5, -1.0))
    return C.build(terrain, v, "A", river=river, site=site)

def grade(px):
    rgb = px[..., :3]
    lum = (rgb * np.array([0.2126, 0.7152, 0.0722])).sum(-1, keepdims=True)
    rgb = lum + (rgb - lum) * 1.04
    rgb = 0.5 + (rgb - 0.5) * 1.08
    rgb = rgb * np.array([1.006, 1.0, 0.99])
    out = px.copy()
    out[..., :3] = np.clip(rgb, 0, 1)
    return out

LAND = ["grassland", "plains", "forest", "hills"]

def main():
    setup()
    os.makedirs(os.path.join(OUT, "_raw"), exist_ok=True)
    if MODE == "tiles":
        for terrain in C.TERRAINS:
            if ONLY and terrain not in ONLY:
                continue
            for v in range(1, VARIANTS + 1):
                F, objs = scene_for(terrain, v)
                name = f"{terrain}_{v}.png"
                assign(objs)
                shoot(".", name)
                assign(objs, holdout=GROUNDISH)
                shoot("props", name)
                print("RENDERED A", name, flush=True)
    elif MODE == "sites":
        for terrain in LAND:
            if ONLY and terrain not in ONLY:
                continue
            for v in range(1, VARIANTS + 1):
                F, objs = scene_for(terrain, v, site=True)
                name = f"{terrain}_{v}.png"
                assign(objs)
                shoot("sites", name)
                assign(objs, holdout=GROUNDISH)
                shoot("sites_props", name)
                print("RENDERED site", name, flush=True)
    elif MODE == "rivers":
        for terrain in LAND:
            if ONLY and terrain not in ONLY:
                continue
            for mask in range(1, 64):
                v = 1 + mask % 3
                F, objs = scene_for(terrain, v, river=mask)
                name = f"{terrain}_{mask:02d}.png"
                assign(objs)
                shoot("rivers", name)
                assign(objs, holdout=GROUNDISH)
                shoot("rivers_props", name)
                print("RENDERED river", name, flush=True)
    elif MODE == "roads":
        for terrain in LAND:
            if ONLY and terrain not in ONLY:
                continue
            for v in range(1, VARIANTS + 1):
                F, objs = scene_for(terrain, v)
                for ob in objs:
                    ob.hide_render = True
                ground = [ob for ob in objs if set(ob["roles"].split(",")) & set(GROUNDISH)]
                assign(ground, holdout=GROUNDISH + ("mrock", "snow"))
                for ob in ground:
                    ob.hide_render = False
                pieces = [(str(k), [o for o in C.road_arm(F, k) if o]) for k in range(6)] + [("c", [C.road_center(F)])]
                assign([o for _, obs in pieces for o in obs])
                for key, obs in pieces:
                    for _, o2s in pieces:
                        for o2 in o2s:
                            o2.hide_render = o2 not in obs
                    shoot("roads", f"{terrain}_{v}_{key}.png")
                print("RENDERED roads", terrain, v, flush=True)
    elif MODE == "riverroads":
        for terrain in LAND:
            if ONLY and terrain not in ONLY:
                continue
            for mask in range(1, 64):
                v = 1 + mask % 3
                F, objs = scene_for(terrain, v, river=mask)
                for ob in objs:
                    ob.hide_render = True
                ground = [ob for ob in objs if set(ob["roles"].split(",")) & set(GROUNDISH)]
                assign(ground, holdout=GROUNDISH)
                for ob in ground:
                    ob.hide_render = False
                pieces = [(str(k), [o for o in C.road_arm(F, k) if o]) for k in range(6)] + [("c", [C.road_center(F)])]
                assign([o for _, obs in pieces for o in obs])
                for key, obs in pieces:
                    for _, o2s in pieces:
                        for o2 in o2s:
                            o2.hide_render = o2 not in obs
                    shoot("river_roads", f"{terrain}_{mask:02d}_{key}.png")
                print("RENDERED riverroads", terrain, mask, flush=True)

if __name__ == "__main__":
    main()

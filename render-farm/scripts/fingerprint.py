# Prints a fingerprint of the built world so every render machine can prove it built the same one.
import sys, os, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import *
open_world()
h = hashlib.sha256()
obs = sorted(bpy.context.scene.objects, key=lambda o: o.name)
for o in obs:
    ic = o.instance_collection.name if o.instance_collection else ''
    h.update(f'{o.name}|{ic}|{o.location.x:.3f},{o.location.y:.3f},{o.location.z:.3f}|{o.scale.x:.3f}\n'.encode())
t = bpy.data.objects['terrain'].data
h.update(f"{len(t.vertices)}|{sum(v.co.z for v in t.vertices):.2f}".encode())
print('FINGERPRINT', len(obs), h.hexdigest()[:16], flush=True)

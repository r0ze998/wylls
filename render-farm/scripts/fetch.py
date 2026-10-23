# Download Poly Haven CC0 assets: textures (2k jpg diff/nor_gl/rough/disp), models (gltf 1k), HDRIs (2k hdr).
import json, os, sys, urllib.request, hashlib
ROOT = sys.argv[1]
import subprocess
def get(url):
    return subprocess.run(['curl', '-sSfL', '--max-time', '600', url], check=True, capture_output=True).stdout
def save(url, path):
    if os.path.exists(path): return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url); open(path, 'wb').write(data)
log = []
TEX = ['aerial_grass_rock', 'forest_ground_04', 'rocky_terrain_02', 'brown_mud_leaves_01', 'cobblestone_floor_01',
       'roof_tiles_14', 'plastered_wall_04', 'wood_planks_grey', 'castle_wall_slates', 'thatch_roof_angled', 'gravel_road_01', 'snow_02', 'rock_wall_08', 'dry_riverbed_rock']
for t in TEX:
    try:
        f = json.loads(get(f'https://api.polyhaven.com/files/{t}'))
        for kind, key in (('Diffuse', 'diff'), ('nor_gl', 'nor'), ('Rough', 'rough'), ('Displacement', 'disp')):
            if kind in f and '2k' in f[kind]:
                ext = 'jpg' if 'jpg' in f[kind]['2k'] else list(f[kind]['2k'])[0]
                save(f[kind]['2k'][ext]['url'], f'{ROOT}/tex/{t}/{key}.{ext}')
        log.append(('texture', t, 'ok'))
    except Exception as e: log.append(('texture', t, f'ERR {e}'))
MOD = ['fir_tree_01', 'pine_tree_01', 'island_tree_02', 'tree_small_02', 'rock_moss_set_01', 'boulder_01', 'namaqualand_cliff_02', 'wooden_barrels_01', 'wooden_crate_01', 'kite_shield', 'dead_tree_trunk', 'pine_sapling_medium']
for m in MOD:
    try:
        f = json.loads(get(f'https://api.polyhaven.com/files/{m}'))
        g = f['gltf']['1k']['gltf']
        save(g['url'], f'{ROOT}/models/{m}/{m}.gltf')
        for rel, inc in g.get('include', {}).items():
            save(inc['url'], f'{ROOT}/models/{m}/{rel}')
        log.append(('model', m, 'ok'))
    except Exception as e: log.append(('model', m, f'ERR {e}'))
for h in ['kloofendal_48d_partly_cloudy_puresky', 'kloppenheim_06_puresky', 'moonless_golf', 'rogland_clear_night', 'overcast_soil_puresky']:
    try:
        f = json.loads(get(f'https://api.polyhaven.com/files/{h}'))
        save(f['hdri']['2k']['hdr']['url'], f'{ROOT}/hdri/{h}_2k.hdr'); log.append(('hdri', h, 'ok'))
    except Exception as e: log.append(('hdri', h, f'ERR {e}'))
for l in log: print(*l)

"""Package the rendered layers into the deliverables (media/world-map/dist):

  world/  world-notext.jpg        the master without words (base: land + life)
          world-borders.jpg       + the nations' lands and rims (realms)
          world-ja.jpg / -en.jpg  + realms, nation names, the Concord, town names
          world-layers.ora        every layer, stacked and named (OpenRaster: GIMP, Krita, MyPaint)
  layers/ the transparent word and line layers as PNG (realms, grid, routes, labels-ja/en, names-ja/en)
  posts/  <name>-notext.jpg, <name>-ja.jpg, <name>-en.jpg for every post of posts.json
  contact-sheet.jpg

  python3 media/world-map/scripts/package.py   (after render.mjs for master-ja, master-en and posts.mjs for posts-ja, posts-en)
"""
import json, os, zipfile, io, sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
OUT = os.path.join(ROOT, 'out')
DIST = os.path.join(ROOT, 'dist')
for d in ('world', 'layers', 'posts'):
    os.makedirs(os.path.join(DIST, d), exist_ok=True)

def rgba(path):
    return Image.open(path).convert('RGBA')

def stack(base, *overlays):
    im = base.copy()
    for o in overlays:
        im.alpha_composite(o)
    return im.convert('RGB')

def jpg(im, path, q=92):
    im.save(path, 'JPEG', quality=q, optimize=True, progressive=True, subsampling=0)

# ---- the master
ja, en = os.path.join(OUT, 'master-ja'), os.path.join(OUT, 'master-en')
base = rgba(os.path.join(ja, 'base.png'))
L = {n: rgba(os.path.join(ja, f'{n}.png')) for n in ('land', 'life', 'realms', 'grid', 'routes', 'labels', 'names')}
L['labels-en'], L['names-en'] = rgba(os.path.join(en, 'labels.png')), rgba(os.path.join(en, 'names.png'))
jpg(base.convert('RGB'), os.path.join(DIST, 'world', 'world-notext.jpg'))
jpg(stack(base, L['realms']), os.path.join(DIST, 'world', 'world-borders.jpg'))
jpg(stack(base, L['realms'], L['labels'], L['names']), os.path.join(DIST, 'world', 'world-ja.jpg'))
jpg(stack(base, L['realms'], L['labels-en'], L['names-en']), os.path.join(DIST, 'world', 'world-en.jpg'))
for n in ('realms', 'grid', 'routes'):
    L[n].save(os.path.join(DIST, 'layers', f'{n}.png'), optimize=True)
for n, k in (('labels-ja', 'labels'), ('names-ja', 'names'), ('labels-en', 'labels-en'), ('names-en', 'names-en')):
    L[k].save(os.path.join(DIST, 'layers', f'{n}.png'), optimize=True)

# ---- the layered file (OpenRaster: a zip of PNG layers with stack.xml, top layer first)
W, H = base.size
order = [('names-en', False), ('labels-en', False), ('names-ja', True), ('labels-ja', True), ('routes', False), ('grid', False), ('realms', True), ('life', True), ('land', True)]
src = {'names-en': 'names-en', 'labels-en': 'labels-en', 'names-ja': 'names', 'labels-ja': 'labels', 'routes': 'routes', 'grid': 'grid', 'realms': 'realms', 'life': 'life', 'land': 'land'}
with zipfile.ZipFile(os.path.join(DIST, 'world', 'world-layers.ora'), 'w') as z:
    z.writestr('mimetype', 'image/openraster', compress_type=zipfile.ZIP_STORED)
    xml = [f'<?xml version="1.0" encoding="UTF-8"?>\n<image w="{W}" h="{H}"><stack>']
    for name, shown in order:
        buf = io.BytesIO(); L[src[name]].save(buf, 'PNG'); z.writestr(f'data/{name}.png', buf.getvalue(), compress_type=zipfile.ZIP_STORED)
        xml.append(f'<layer name="{name}" src="data/{name}.png" visibility="{"visible" if shown else "hidden"}"/>')
    xml.append('</stack></image>')
    z.writestr('stack.xml', '\n'.join(xml))
    th = base.convert('RGB'); th.thumbnail((256, 256)); buf = io.BytesIO(); th.save(buf, 'PNG'); z.writestr('Thumbnails/thumbnail.png', buf.getvalue())
    buf = io.BytesIO(); stack(base, L['realms'], L['labels'], L['names']).save(buf, 'PNG'); z.writestr('mergedimage.png', buf.getvalue())

# ---- the posts
thumbs = []
for lang in ('ja', 'en'):
    meta = json.load(open(os.path.join(OUT, f'posts-{lang}', 'posts.json')))
    for p in meta['posts']:
        b = rgba(p['files']['base'])
        if lang == 'ja':
            jpg(b.convert('RGB'), os.path.join(DIST, 'posts', f"{p['name']}-notext.jpg"))
        t = stack(b, *[rgba(p['files'][n]) for n in p.get('words', [])])
        jpg(t, os.path.join(DIST, 'posts', f"{p['name']}-{lang}.jpg"))
        if lang == 'ja':
            s = t.copy(); s.thumbnail((620, 620)); thumbs.append(s)

# ---- the contact sheet of the posts (Japanese)
cols, pad = 4, 12
cw = max(t.width for t in thumbs)
rows = []
row, rw = [], 0
for t in thumbs:
    if len(row) == cols:
        rows.append(row); row = []
    row.append(t)
rows.append(row)
hs = [max(t.height for t in r) for r in rows]
sheet = Image.new('RGB', (cols * (cw + pad) + pad, sum(hs) + pad * (len(rows) + 1)), (26, 30, 28))
y = pad
for r, h in zip(rows, hs):
    x = pad
    for t in r:
        sheet.paste(t, (x, y)); x += cw + pad
    y += h + pad
jpg(sheet, os.path.join(DIST, 'contact-sheet.jpg'), 88)
for d, _, fs in os.walk(DIST):
    for f in sorted(fs):
        print(f'{os.path.relpath(os.path.join(d, f), DIST)}  {os.path.getsize(os.path.join(d, f)) // 1024} KB')

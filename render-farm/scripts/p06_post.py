# ⑥ post: put the colour frame and its engraved re-trace side by side, split down the middle with a soft seam.
# The engraving is built from the data passes: ink outlines where depth or normals jump, cross-hatching where the
# clay shading is dark, paper grain, and a faint hand-tint taken from the colour frame so the nations still read.
# Usage: python3 p06_post.py color.png shade.png normal.png mist.png out.png
import sys
import numpy as np
from PIL import Image, ImageFilter

col_p, shade_p, nor_p, mist_p, out_p = sys.argv[1:6]
col = np.asarray(Image.open(col_p).convert('RGB')).astype(np.float32) / 255
H, W = col.shape[:2]
def grey(p): return np.asarray(Image.open(p).convert('F').resize((W, H))).astype(np.float32) / (65535 if Image.open(p).mode.startswith('I') else 255)
shade = grey(shade_p)
nor = np.asarray(Image.open(nor_p).convert('RGB').resize((W, H))).astype(np.float32) / 255
mist = grey(mist_p)
s = W / 1080.0                                   # scale effects with resolution

def blur(a, r):
    return np.asarray(Image.fromarray(a.astype(np.float32), 'F').filter(ImageFilter.GaussianBlur(r))).astype(np.float32)
def grad(a):
    gx = np.zeros_like(a); gy = np.zeros_like(a)
    gx[:, 1:-1] = a[:, 2:] - a[:, :-2]; gy[1:-1, :] = a[2:, :] - a[:-2, :]
    return np.hypot(gx, gy)

# ink outlines: depth discontinuities (relative, so far objects still get lines) and creases in the normals
d = np.log(1e-3 + mist)
e_depth = grad(blur(d, 0.6 * s))
e_nor = sum(grad(blur(nor[..., k], 0.6 * s)) for k in range(3))
ink = np.clip((e_depth - 0.035) * 9, 0, 1) + np.clip((e_nor - 0.22) * 2.5, 0, 1)
ink = np.clip(blur(ink, 0.5 * s) * 1.3, 0, 1)
far = np.clip((mist - 0.35) / 0.5, 0, 1)            # lines thin out with distance, like an engraver's aerial perspective
ink *= 1 - 0.6 * far

# hatching: two diagonal line sets, the second only in the darkest tones
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
period = 5.0 * s
h1 = (np.sin((xx + yy) * (2 * np.pi / period)) * 0.5 + 0.5)
h2 = (np.sin((xx - yy) * (2 * np.pi / period)) * 0.5 + 0.5)
tone = blur(shade, 0.8 * s)
dark = 1 - tone
hatch = np.clip((h1 - (1.05 - dark * 1.4)) * 4, 0, 1) * 0.55 + np.clip((h2 - (1.6 - dark * 1.6)) * 4, 0, 1) * 0.45
hatch *= 1 - 0.5 * far

# paper: warm parchment with fibres and slow mottling
rng = np.random.default_rng(3)
grain = blur(rng.random((H, W)).astype(np.float32), 0.7 * s) - 0.5
mott = blur(rng.random((H, W)).astype(np.float32), 40 * s); mott = (mott - mott.mean()) / (mott.std() + 1e-6)
paper = np.stack([0.93, 0.86, 0.70]) * (1 + 0.035 * mott[..., None] + 0.05 * grain[..., None])
ink_col = np.array([0.24, 0.16, 0.10])

# a faint hand-tint from the colour frame: only where the colour is saturated (banners, shields, tabards, roofs)
mx = col.max(-1); mn = col.min(-1); sat = (mx - mn) / (mx + 1e-4)
tint_amt = np.clip((sat - 0.35) * 1.6, 0, 1)[..., None] * 0.55
tint = paper * (1 - tint_amt) + (col * 0.85 + 0.15) * paper * tint_amt

eng = tint * (1 - 0.2 * dark[..., None])
lines = np.clip(ink + hatch * 0.8, 0, 1)[..., None]
eng = eng * (1 - lines) + ink_col * lines
eng = np.clip(eng, 0, 1)

# the split: colour on the left, engraving on the right, a soft 2% seam with a fine ink rule
x = xx / W
m = np.clip((x - 0.5) / 0.02 + 0.5, 0, 1)[..., None]
out = col * (1 - m) + eng * m
rule = np.exp(-((xx - W / 2) / (0.9 * s)) ** 2)[..., None] * 0.35
out = out * (1 - rule) + ink_col * rule
Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)).save(out_p)
print('wrote', out_p)

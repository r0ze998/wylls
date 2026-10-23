# Finishing grade shared by every still and video frame: a gentle S-curve, a touch of warmth in the highlights,
# a soft vignette and fine film grain (seeded per frame, so video grain moves but a still is reproducible).
# Usage: python3 grade.py in.png out.png [seed] [warm]   or   python3 grade.py --dir indir outdir [warm]
import sys, os
import numpy as np
from PIL import Image

def grade(im, seed=0, warm=0.03, vig=0.22, grain=0.018):
    a = np.asarray(im.convert('RGB')).astype(np.float32) / 255
    H, W = a.shape[:2]
    # S-curve around mid-grey, mild
    a = a + 0.12 * (a - 0.5) * (1 - np.abs(2 * a - 1))
    # warmth in the highlights, a hint of cool in the shadows
    lum = (a @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    a = a + warm * (lum ** 2) * np.array([1.0, 0.35, -0.6]) + 0.015 * ((1 - lum) ** 3) * np.array([-0.4, 0.0, 0.6])
    # vignette, elliptical to the frame
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.hypot((xx / W - 0.5) * 1.0, (yy / H - 0.5) * 0.9)
    a *= (1 - vig * np.clip((r - 0.32) / 0.45, 0, 1) ** 1.6)[..., None]
    # grain: luminance only, finer at higher resolution
    rng = np.random.default_rng(seed)
    g = rng.normal(0, grain * (1080 / W) ** 0.5, (H, W)).astype(np.float32)[..., None]
    a = a + g * (0.6 + 0.4 * (1 - lum))
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))

if __name__ == '__main__':
    if sys.argv[1] == '--dir':
        src, dst = sys.argv[2], sys.argv[3]; warm = float(sys.argv[4]) if len(sys.argv) > 4 else 0.03
        os.makedirs(dst, exist_ok=True)
        for i, fn in enumerate(sorted(f for f in os.listdir(src) if f.endswith('.png'))):
            grade(Image.open(os.path.join(src, fn)), seed=i, warm=warm).save(os.path.join(dst, fn))
        print('graded', i + 1)
    else:
        grade(Image.open(sys.argv[1]), seed=int(sys.argv[3]) if len(sys.argv) > 3 else 0,
              warm=float(sys.argv[4]) if len(sys.argv) > 4 else 0.03).save(sys.argv[2])
        print('graded', sys.argv[2])

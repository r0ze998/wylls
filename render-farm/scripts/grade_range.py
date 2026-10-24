# Grade frames F0..F1 from one folder into another (skipping frames already graded).
# Usage: python3 grade_range.py SRC DST F0 F1
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grade import grade
from PIL import Image
src, dst, a, b = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
os.makedirs(dst, exist_ok=True)
for f in range(a, b + 1):
    out = os.path.join(dst, f'{f:04d}.png')
    if not os.path.exists(out): grade(Image.open(os.path.join(src, f'{f:04d}.png')), seed=f).save(out)

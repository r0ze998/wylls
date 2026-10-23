# Stack four horizontal bands rendered with BORDER (a = top … d = bottom, each overlapping the next by 1% of the
# frame). Each band's outermost rows carry the reconstruction filter's partial edge, so the cut goes through the
# middle of each overlap instead of alpha-blending band over band, which left a faint line along every join.
# Usage: python3 stack_bands.py a.png b.png c.png d.png out.png
import sys
from PIL import Image
bands = [Image.open(p).convert('RGBA') for p in sys.argv[1:5]]
W_, H = bands[0].size
cuts = [0, round(0.245 * H), round(0.495 * H), round(0.745 * H), H]      # mid-overlap rows, top to bottom
out = Image.new('RGB', (W_, H))
for k, b in enumerate(bands):
    out.paste(b.crop((0, cuts[k], W_, cuts[k + 1])).convert('RGB'), (0, cuts[k]))
out.save(sys.argv[5])
print('stacked', sys.argv[5], cuts)

#!/bin/bash
# Render-farm worker for the Wylls concept renders (Blender 5.2 as a Python module, CPU Cycles).
# Everything heavy lives in $HOME/farm, outside the repo; only finished results are copied into render-farm/out/.
#   farm.sh setup                     venv + bpy, CC0 assets from Poly Haven, build the world, print its fingerprint
#   farm.sh video F0 F1 [SAMPLES]     render frames F0..F1 of the intro film, grade them, pack a near-lossless clip
#   farm.sh still SCRIPT NAME [SAMPLES] [WARM]   render one 2160×2700 still in four bands, stack and grade it
#   farm.sh restack NAME [WARM]           re-join existing bands (cut through the overlaps) and re-grade
#   farm.sh pass SCRIPT NAME MODE [SAMPLES]      one extra full-frame pass for the ⑥ replay (MODE=shade|normal|mist)
# Resumable: finished frames and bands are skipped.
set -e
R=$(cd "$(dirname "$0")" && pwd); WK=$HOME/farm; C=$WK/cine; PY=$WK/bl/bin/python
mkdir -p $C $R/out
rsync -a $R/scripts/ $C/scripts/ 2>/dev/null || cp -r $R/scripts/. $C/scripts/
cd $C/scripts
case "$1" in
setup)
  [ -x $PY ] || { python3 -m venv $WK/bl && $WK/bl/bin/pip install -q bpy==5.2.2 numpy; }
  python3 fetch.py $C/assets > $WK/fetch.log 2>&1 || true
  [ -f $C/world.blend ] || $PY world.py -- $C/world.blend > $WK/build.log 2>&1
  $PY fingerprint.py 2>/dev/null | grep FINGERPRINT | tee $R/out/fingerprint_$(hostname).txt
  ;;
video)
  F0=$2; F1=$3; SAMP=${4:-48}; FR=$WK/frames
  $PY v01_intro.py -- 1080 1350 $SAMP $FR $F0 $F1 > $WK/video_${F0}.log 2>&1
  mkdir -p $WK/graded
  python3 - "$FR" "$WK/graded" $F0 $F1 <<'EOF'
import sys, os
sys.path.insert(0, '.')
from grade import grade
from PIL import Image
src, dst, a, b = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
for f in range(a, b + 1):
    out = os.path.join(dst, f'{f:04d}.png')
    if not os.path.exists(out): grade(Image.open(os.path.join(src, f'{f:04d}.png')), seed=f).save(out)
EOF
  ffmpeg -y -loglevel error -framerate 30 -start_number $F0 -i $WK/graded/%04d.png -frames:v $((F1 - F0 + 1)) \
    -c:v libx264 -preset slow -crf 6 -pix_fmt yuv444p $R/out/seg_$(printf %04d $F0)_$(printf %04d $F1).mp4
  cp $WK/graded/$(printf %04d $F0).png $R/out/check_$(printf %04d $F0).png
  echo "video $F0-$F1 done"
  ;;
still)
  SCRIPT=$2; NAME=$3; SAMP=${4:-128}; WARM=${5:-0.03}; B=$WK/bands; mkdir -p $B
  for band in "0.75,1 a" "0.5,0.76 b" "0.25,0.51 c" "0,0.26 d"; do set -- $band
    [ -f $B/${NAME}_$2.png ] && continue
    BORDER=$1 $PY $SCRIPT -- 2160 2700 $SAMP $B/${NAME}_$2.tmp.png > $B/${NAME}_$2.log 2>&1 && mv $B/${NAME}_$2.tmp.png $B/${NAME}_$2.png
  done
  python3 stack_bands.py $B/${NAME}_a.png $B/${NAME}_b.png $B/${NAME}_c.png $B/${NAME}_d.png $R/out/${NAME}_raw.png
  python3 grade.py $R/out/${NAME}_raw.png $R/out/${NAME}.png 0 $WARM
  echo "still $NAME done"
  ;;
restack)
  NAME=$2; WARM=${3:-0.03}; B=$WK/bands
  python3 stack_bands.py $B/${NAME}_a.png $B/${NAME}_b.png $B/${NAME}_c.png $B/${NAME}_d.png $R/out/${NAME}_raw.png
  python3 grade.py $R/out/${NAME}_raw.png $R/out/${NAME}.png 0 $WARM
  ;;
pass)
  SCRIPT=$2; NAME=$3; MODE=$4; SAMP=${5:-64}
  MODE=$MODE $PY $SCRIPT -- 2160 2700 $SAMP $R/out/${NAME}_$MODE.png > $WK/${NAME}_$MODE.log 2>&1
  echo "pass $NAME $MODE done"
  ;;
esac

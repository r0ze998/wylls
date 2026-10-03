#!/bin/sh
# WebP for the web client from the renders in ../_out (units3d.py atlas / cards).
set -e
cd "$(dirname "$0")"
OUT=../_out
WEB=../../../../../permutation-server/web/frontier/art/units
mkdir -p "$WEB/@1x" "$WEB/@2x" "$WEB/cards"
for f in 0 1 2 3 4 5; do
  cwebp -quiet -q 74 -alpha_q 75 -alpha_filter best -m 6 "$OUT/units_$f@1x.png" -o "$WEB/@1x/units_$f.webp"
  cwebp -quiet -q 72 -alpha_q 70 -alpha_filter best -m 6 "$OUT/units_$f@2x.png" -o "$WEB/@2x/units_$f.webp"
done
for p in "$OUT"/card_*.png; do
  n=$(basename "$p" .png); n=${n#card_}
  cwebp -quiet -q 80 -alpha_q 80 -m 6 -resize 240 300 "$p" -o "$WEB/cards/$n.webp"
done
echo "exported to $WEB"

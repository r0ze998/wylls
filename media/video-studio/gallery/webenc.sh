#!/bin/bash
# $1 = source mp4; writes 720p web version (<= ~7 MB) + poster into gallery/v
set -e
G=/tmp/claude-0/-home-user-wylls/4a2c3ebe-a915-5d07-9e8a-8ab678c55426/scratchpad/gallery/v
src=$1; n=$(basename $src .mp4)
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $src)
w=$(ffprobe -v error -select_streams v -show_entries stream=width -of csv=p=0 $src)
if [ $w -gt 1100 ]; then sc="scale=1280:720"; else sc="scale=720:1280"; fi
vb=$(python3 -c "print(int((6.9e6*8/$d - 96000)/1000))")
cd /tmp && T=$(mktemp -d)
cd $T
ffmpeg -y -loglevel error -i $src -vf "$sc:flags=lanczos,hqdn3d=1.5:1.5:4:4" -c:v libx264 -preset slow -b:v ${vb}k -maxrate $((vb*2))k -bufsize $((vb*4))k -pass 1 -an -f null /dev/null
ffmpeg -y -loglevel error -i $src -vf "$sc:flags=lanczos,hqdn3d=1.5:1.5:4:4" -c:v libx264 -preset slow -b:v ${vb}k -maxrate $((vb*2))k -bufsize $((vb*4))k -pass 2 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart $G/$n.mp4
ffmpeg -y -loglevel error -ss $(python3 -c "print($d*0.38)") -i $src -frames:v 1 -vf "scale=$( [ $w -gt 1100 ] && echo 800:450 || echo 450:800 )" -q:v 4 $G/$n.jpg
cd /tmp && rm -rf $T
echo "$n $(stat -c %s $G/$n.mp4)"

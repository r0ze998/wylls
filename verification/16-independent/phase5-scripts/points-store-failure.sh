#!/bin/sh
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad
cd $S/v12-int || exit 1
for c in 8e96f24df4aa4ed51277fa42de6a354a21cd2bc6 1a61caa4 739618ae 232a5aa700f72b04b810d765c3dbb6d51d56f7d6 9e6b0c01 213fa655; do
  git checkout -q --detach "$c" || continue
  sh $S/scripts/bisect-store-failure.sh; r=$?
  case $r in 0) v=PASS;; 125) v=SKIP-compile;; *) v=FAIL;; esac
  echo "$(git rev-parse --short HEAD) $(git log -1 --format=%s | cut -c1-70) -> $v"
done
git checkout -q --detach d0e96d5394d88decf878676f37bc3782654d1045

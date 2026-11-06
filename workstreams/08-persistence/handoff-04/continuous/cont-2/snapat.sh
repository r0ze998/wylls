#!/bin/bash
# snapat.sh RUN TARGET_BELL NAME : wait until the world's bell >= TARGET, then snapshot + journal counts
S=/tmp/claude-0/-home-user-wylls/cba48052-00ba-54bc-95d1-0c72654ae715/scratchpad
export PSF_REPO=/home/user/wylls-08w FRONTIER_BIN=$S/s-tgt-node/debug
RUN=$1; T=$2; N=$3
while true; do
  $S/s-tgt-node/debug/frontier-stack snapshot --run-id $RUN --runs-dir $S/runs --out $S/$RUN-$N.json >/dev/null 2>&1
  b=$(python3 -c "import json;print(json.load(open('$S/$RUN-$N.json'))['bell'])" 2>/dev/null || echo 0)
  if [ "$b" -ge "$T" ] && [ "$b" -lt 1000000 ]; then break; fi
  sleep 15
done
python3 -I /home/user/wylls-08w/scripts/keeper-journal-counts.py $S/runs/$RUN > $S/$RUN-$N-journal.txt 2>&1
echo "$N bell=$b"

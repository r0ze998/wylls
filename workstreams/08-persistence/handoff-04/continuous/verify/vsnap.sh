#!/bin/bash
# vsnap.sh RUN NAME : snapshot + journal counts + drill status into $S/rec-RUN/
S=/tmp/claude-0/-home-user-wylls/cba48052-00ba-54bc-95d1-0c72654ae715/scratchpad
export PSF_REPO=/home/user/wylls-08v FRONTIER_BIN=$S/s-tgt-node/debug
RUN=$1; N=$2; D=$S/rec-$RUN; mkdir -p $D
$S/s-tgt-node/debug/frontier-stack snapshot --run-id $RUN --runs-dir $S/runs --out $D/$N-snapshot.json >/dev/null 2>&1
python3 -I /home/user/wylls-08v/scripts/keeper-journal-counts.py $S/runs/$RUN > $D/$N-journal.txt 2>&1
$S/s-tgt-node/debug/frontier-stack drill --run-id $RUN --runs-dir $S/runs --do status 2>/dev/null > $D/$N-drill.json
python3 -c "import json;d=json.load(open('$D/$N-drill.json'));print('$N bell',d['bell'],'vault',d.get('vault'),'caravans',[(c['seq'],c['present'],c.get('state'),c.get('lamports')) for c in d.get('caravans',[])])"

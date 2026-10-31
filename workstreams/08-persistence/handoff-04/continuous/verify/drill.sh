#!/bin/bash
S=/tmp/claude-0/-home-user-wylls/cba48052-00ba-54bc-95d1-0c72654ae715/scratchpad
export PSF_REPO=/home/user/wylls-08v FRONTIER_BIN=$S/s-tgt-node/debug
$S/s-tgt-node/debug/frontier-stack drill --run-id ver-2 --runs-dir $S/runs "$@"

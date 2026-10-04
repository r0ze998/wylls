#!/usr/bin/env bash
# The MC file list (AI-CITIZENS contract v1.2 section 0.2): the union over every branch frontier/cq-* of
#   git diff --name-only 30ba411...<branch>
# one path per line, sorted. Read-only (git diff and for-each-ref only). The integrator writes the output to
#   docs/frontier/ai-citizens/MC-FILES-<date>.txt   (ai-hook-check.sh reads the union of every such file)
# and records the branch tips it saw (--tips). Usage:
#   permutation-gateway/citizens/bin/mc-files.sh [--base REV] [--tips] [--repo DIR]
set -eu
BASE=30ba411
TIPS=0
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE=$2; shift 2 ;;
    --tips) TIPS=1; shift ;;
    --repo) REPO=$2; shift 2 ;;
    *) echo "mc-files: unknown option $1" >&2; exit 2 ;;
  esac
done
BRANCHES=$(git -C "$REPO" for-each-ref --format='%(refname:short)' 'refs/heads/frontier/cq-*')
[ -n "$BRANCHES" ] || { echo "mc-files: no frontier/cq-* branch" >&2; exit 2; }
if [ "$TIPS" = 1 ]; then
  for b in $BRANCHES; do printf '%s %s\n' "$(git -C "$REPO" rev-parse --short "$b")" "$b"; done
  exit 0
fi
for b in $BRANCHES; do git -C "$REPO" diff --name-only "$BASE...$b"; done | LC_ALL=C sort -u

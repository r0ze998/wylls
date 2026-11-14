#!/usr/bin/env bash
# TEST ONLY post-check of an nft-experimental SBF build of permutation-prize (⑰, 2026-11-15).
#
#   scripts/check-prize-nft-test-only.sh <path/to/permutation_prize.so>
#
# NOT a build script and NOT the production path: scripts/build-prize.sh stays the only way to make the
# deployable artefact, and it refuses nft-experimental. This script only reads a .so that a separate,
# guarded `cargo build-sbf --features nft-experimental` wrote OUTSIDE permutation-prize/target, checks
# that it is what the LiteSVM NFT tests need, and copies it to a name that says what it is:
#   permutation_prize.TEST-ONLY-nft-experimental.so  (beside the input)
# The tests read it only through PRIZE_NFT_SO. NOT DEPLOYABLE (permutation-prize/NFT-PRIZE.md §8.3).
set -euo pipefail
so="${1:?usage: $0 <path/to/permutation_prize.so>}"
[ -f "$so" ] || { echo "$so: no such file" >&2; exit 2; }
repo="$(cd "$(dirname "$0")/.." && pwd)"
abs="$(cd "$(dirname "$so")" && pwd)/$(basename "$so")"
# Never anything under the production artefact directory.
case "$abs" in
  "$repo"/permutation-prize/target/*) echo "refusing: $abs is under permutation-prize/target (the production build's place)" >&2; exit 3;;
esac
[ "$(wc -c < "$so" | tr -d ' ')" -ge 64 ] || { echo "$so: too small to be an ELF" >&2; exit 3; }
flags="$(od -An -t u4 -j 48 -N 4 "$so" | tr -d ' ')"
[ "$flags" = "2" ] || { echo "$so: e_flags $flags, not 2 (SBPF v2)" >&2; exit 3; }
ovf="$({ LC_ALL=C grep -a -o -E 'attempt to (add|subtract|multiply) with overflow' "$so" || true; } | wc -l | tr -d ' ')"
[ "$ovf" -gt 0 ] || { echo "$so: built without overflow checks" >&2; exit 3; }
# The opposite of build-prize.sh: the NFT handlers MUST be in (the live ClaimResident and RecordResidentNation
# paths; the PayResident handler is unreachable and may be optimised out).
for s in 'PRIZE claim-nft' 'PRIZE nation-nft'; do
  LC_ALL=C grep -a -q -F "$s" "$so" || { echo "$so: lacks \"$s\" (not an nft-experimental build)" >&2; exit 3; }
done
out="$(dirname "$abs")/permutation_prize.TEST-ONLY-nft-experimental.so"
cp "$abs" "$out"
echo "TEST ONLY — nft-experimental — NOT DEPLOYABLE (NFT-PRIZE.md §8.3)"
echo "file           $out"
echo "file_sha256    $(shasum -a 256 "$out" | cut -d' ' -f1)"
echo "e_flags        $flags"
echo "overflow_panic $ovf"
echo "so_len         $(wc -c < "$out" | tr -d ' ')"

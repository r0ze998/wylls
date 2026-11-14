#!/usr/bin/env bash
# TEST ONLY post-check of an nft-experimental SBF build of permutation-prize (⑰, 2026-11-15).
#
#   scripts/check-prize-nft-test-only.sh <path/to/permutation_prize.so>
#
# NOT a build script and NOT the production path: scripts/build-prize.sh stays the only way to make the
# deployable artefact, and it refuses nft-experimental. This script checks a .so that a separate, guarded
# `cargo build-sbf --features nft-experimental` wrote OUTSIDE permutation-prize/target, and then WRITES ONE
# FILE: a copy named for what it is,
#   permutation_prize.TEST-ONLY-nft-experimental.so   (in the input's directory)
# The tests read that copy only through PRIZE_NFT_SO. NOT DEPLOYABLE (permutation-prize/NFT-PRIZE.md §8.3).
#
# Refuses (exit 3): a symlink input; any input or output whose PHYSICAL path (symlinks resolved) is under
# permutation-prize/target; a non-ELF64 little-endian SBF/BPF file (magic, class, data, machine), e_flags
# other than 2 (SBPF v2); no overflow-check strings; missing NFT handler strings; an output path that is a
# symlink or anything but a regular file. The copy is made in a fresh temporary file and renamed into
# place (rename replaces the directory entry; it never writes through a link).
set -euo pipefail
so="${1:?usage: $0 <path/to/permutation_prize.so>}"
die() { echo "$*" >&2; exit 3; }
[ -L "$so" ] && die "refusing: $so is a symlink (give the file itself)"
[ -f "$so" ] || { echo "$so: no such regular file" >&2; exit 2; }
# Physical paths: every directory symlink resolved.
repo="$(cd -P "$(dirname "$0")/.." && pwd -P)"
dir="$(cd -P "$(dirname "$so")" && pwd -P)"
abs="$dir/$(basename "$so")"
prod="$repo/permutation-prize/target"
case "$dir/" in "$prod"/*) die "refusing: $abs is under permutation-prize/target (the production build's place)";; esac

size="$(wc -c < "$abs" | tr -d ' ')"
[ "$size" -ge 64 ] || die "$abs: too small to be an ELF"
byte() { od -An -t u1 -j "$1" -N 1 "$abs" | tr -d ' '; }
magic="$(od -An -t x1 -N 4 "$abs" | tr -d ' \n')"
[ "$magic" = "7f454c46" ] || die "$abs: not an ELF file (magic $magic)"
[ "$(byte 4)" = "2" ] || die "$abs: not ELF64 (class $(byte 4))"
[ "$(byte 5)" = "1" ] || die "$abs: not little-endian (data $(byte 5))"
machine="$(od -An -t u2 -j 18 -N 2 "$abs" | tr -d ' ')"
case "$machine" in 247|263) ;; *) die "$abs: e_machine $machine is neither EM_BPF (247) nor EM_SBF (263)";; esac
flags="$(od -An -t u4 -j 48 -N 4 "$abs" | tr -d ' ')"
[ "$flags" = "2" ] || die "$abs: e_flags $flags, not 2 (SBPF v2)"
ovf="$({ LC_ALL=C grep -a -o -E 'attempt to (add|subtract|multiply) with overflow' "$abs" || true; } | wc -l | tr -d ' ')"
[ "$ovf" -gt 0 ] || die "$abs: built without overflow checks"
# The opposite of build-prize.sh: the NFT handlers MUST be in (the live ClaimResident and RecordResidentNation
# paths; the PayResident handler is unreachable and may be optimised out).
for s in 'PRIZE claim-nft' 'PRIZE nation-nft'; do
  LC_ALL=C grep -a -q -F "$s" "$abs" || die "$abs: lacks \"$s\" (not an nft-experimental build)"
done

out="$dir/permutation_prize.TEST-ONLY-nft-experimental.so"
if [ -L "$out" ]; then die "refusing: $out is a symlink"; fi
if [ -e "$out" ] && [ ! -f "$out" ]; then die "refusing: $out exists and is not a regular file"; fi
tmp="$(mktemp "$dir/.prize-nft-test-only.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cat "$abs" > "$tmp"
chmod 0644 "$tmp"
# Re-check right before the rename (a link placed meanwhile is refused, not followed).
if [ -L "$out" ]; then die "refusing: $out became a symlink"; fi
mv -f "$tmp" "$out"
trap - EXIT
echo "TEST ONLY — nft-experimental — NOT DEPLOYABLE (NFT-PRIZE.md §8.3)"
echo "file           $out"
echo "file_sha256    $(shasum -a 256 "$out" | cut -d' ' -f1)"
echo "e_machine      $machine"
echo "e_flags        $flags"
echo "overflow_panic $ovf"
echo "so_len         $(wc -c < "$out" | tr -d ' ')"

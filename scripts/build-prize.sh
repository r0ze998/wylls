#!/usr/bin/env bash
# SBPF v2 build of permutation-prize (the test-asset prize pool), modelled
# on build-frontier.sh:
#
#   scripts/build-prize.sh
#
# Artefact: permutation-prize/target/deploy/permutation_prize.so. Refused
# (exit 3) unless the ELF header's e_flags is 2 (SBPF v2) and the overflow
# panic messages are present ([profile.release] overflow-checks in the
# crate's own workspace). Prints file_sha256, so_len and the --max-len to
# deploy with. The game program's workspace, lock and artefact are not
# touched.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

want="solana-cargo-build-sbf 3.1.9"
have="$(cargo-build-sbf --version | head -1)"
[ "$have" = "$want" ] || { echo "need $want (have $have)" >&2; exit 1; }

out=permutation-prize/target/deploy
CARGO_TARGET_DIR="$PWD/permutation-prize/target" cargo-build-sbf \
  --manifest-path permutation-prize/Cargo.toml --tools-version v1.52 --arch v2 \
  --sbf-out-dir "$out" -- --locked

so="$out/permutation_prize.so"
flags="$(od -An -t u4 -j 48 -N 4 "$so" | tr -d ' ')"
[ "$flags" = "2" ] || { echo "$so: e_flags $flags, not 2 (SBPF v2)" >&2; exit 3; }
ovf="$({ LC_ALL=C grep -a -o -E 'attempt to (add|subtract|multiply) with overflow' "$so" || true; } | wc -l | tr -d ' ')"
[ "$ovf" -gt 0 ] || { echo "$so: built without overflow checks" >&2; exit 3; }
len="$(wc -c < "$so" | tr -d ' ')"
echo "file_sha256    $(shasum -a 256 "$so" | cut -d' ' -f1)"
echo "e_flags        $flags"
echo "overflow_panic $ovf"
echo "so_len         $len"
echo "max_len        $(( ( (len * 5 + 3) / 4 + 4095 ) / 4096 * 4096 ))"

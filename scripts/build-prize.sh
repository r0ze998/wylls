#!/usr/bin/env bash
# SBPF v2 build of permutation-prize (the test-asset prize pool), modelled
# on build-frontier.sh:
#
#   scripts/build-prize.sh                    # default: the legacy per-season pool
#   scripts/build-prize.sh --features epochs  # + continuous-world settlement windows (⑰, test USDC)
#   scripts/build-prize.sh --features goals   # + world goals' prize pool (win-conditions §10.1, test USDC)
#
# Artefacts: permutation-prize/target/deploy/permutation_prize.so (default),
# permutation-prize/target/deploy-epochs/permutation_prize.so
# (--features epochs) and permutation-prize/target/deploy-goals/permutation_prize.so
# (--features goals). Refused (exit 3) unless the ELF header's e_flags is 2
# (SBPF v2) and the overflow panic messages are present ([profile.release]
# overflow-checks in the crate's own workspace), and unless the epochs
# marker PRZ_EPOCHS_TEST_USDC_BUILD is present in exactly the epochs build
# and the goals marker PRZ_GOALS_TEST_USDC_BUILD in exactly the goals build.
# Prints file_sha256, so_len and the --max-len to deploy with. The game
# program's workspace, lock and artefact are not touched.
#
# Key-free: cargo-build-sbf writes <name>-keypair.json into the out dir
# when none exists; a text placeholder is put there first, and the build
# fails (exit 5) if it was replaced.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

feature=""
while [ $# -gt 0 ]; do
  case "$1" in
    --features) shift; feature="${1:-}" ;;
    --features=*) feature="${1#--features=}" ;;
    *) echo "usage: $0 [--features epochs|goals]" >&2; exit 2 ;;
  esac
  shift
done
case "$feature" in
  "") out=permutation-prize/target/deploy; args=() ;;
  epochs) out=permutation-prize/target/deploy-epochs; args=(--features epochs) ;;
  goals) out=permutation-prize/target/deploy-goals; args=(--features goals) ;;
  *) echo "--features: only epochs or goals" >&2; exit 2 ;;
esac

want="solana-cargo-build-sbf 3.1.9"
have="$(cargo-build-sbf --version | head -1)"
[ "$have" = "$want" ] || { echo "need $want (have $have)" >&2; exit 1; }

holder="PLACEHOLDER: not a key. Exists so cargo-build-sbf skips program-keypair generation (scripts/build-prize.sh)."
mkdir -p "$out"
kp="$out/permutation_prize-keypair.json"
[ -e "$kp" ] || printf '%s' "$holder" > "$kp"
case "$(head -c 12 "$kp")" in PLACEHOLDER*) ;; *) echo "$kp: not the placeholder (left unchanged; this build reads no key)" >&2 ;; esac

CARGO_TARGET_DIR="$PWD/permutation-prize/target" cargo-build-sbf \
  --manifest-path permutation-prize/Cargo.toml --tools-version v1.52 --arch v2 \
  --sbf-out-dir "$out" -- --locked ${args[@]+"${args[@]}"}

so="$out/permutation_prize.so"
flags="$(od -An -t u4 -j 48 -N 4 "$so" | tr -d ' ')"
[ "$flags" = "2" ] || { echo "$so: e_flags $flags, not 2 (SBPF v2)" >&2; exit 3; }
ovf="$({ LC_ALL=C grep -a -o -E 'attempt to (add|subtract|multiply) with overflow' "$so" || true; } | wc -l | tr -d ' ')"
[ "$ovf" -gt 0 ] || { echo "$so: built without overflow checks" >&2; exit 3; }
mk="$({ LC_ALL=C grep -a -o 'PRZ_EPOCHS_TEST_USDC_BUILD' "$so" || true; } | wc -l | tr -d ' ')"
if [ "$feature" = epochs ]; then
  [ "$mk" -gt 0 ] || { echo "$so: marker PRZ_EPOCHS_TEST_USDC_BUILD missing from a --features epochs build" >&2; exit 3; }
else
  [ "$mk" -eq 0 ] || { echo "$so: marker PRZ_EPOCHS_TEST_USDC_BUILD in a build without --features epochs" >&2; exit 3; }
fi
gk="$({ LC_ALL=C grep -a -o 'PRZ_GOALS_TEST_USDC_BUILD' "$so" || true; } | wc -l | tr -d ' ')"
if [ "$feature" = goals ]; then
  [ "$gk" -gt 0 ] || { echo "$so: marker PRZ_GOALS_TEST_USDC_BUILD missing from a --features goals build" >&2; exit 3; }
else
  [ "$gk" -eq 0 ] || { echo "$so: marker PRZ_GOALS_TEST_USDC_BUILD in a build without --features goals" >&2; exit 3; }
fi
case "$(head -c 12 "$kp")" in
  PLACEHOLDER*) [ "$(cat "$kp")" = "$holder" ] || { echo "$kp: the placeholder was changed" >&2; exit 5; } ;;
esac
len="$(wc -c < "$so" | tr -d ' ')"
echo "features       ${feature:-none}"
echo "file_sha256    $(shasum -a 256 "$so" | cut -d' ' -f1)"
echo "e_flags        $flags"
echo "overflow_panic $ovf"
echo "epochs_marker  $mk"
echo "goals_marker   $gk"
echo "so_len         $len"
echo "max_len        $(( ( (len * 5 + 3) / 4 + 4095 ) / 4096 * 4096 ))"

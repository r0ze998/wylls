#!/usr/bin/env bash
# Isolated localnet SBF artefact of the playable lane WITH ② rights, ⑨ capacity and ⑩ custody together (feature
# `localnet-coexist-sbf` = `localnet-land-sbf` + `coexist-experimental`; workstream 4's allocation rev 8,
# `frontier_abi::feature_registry`, provisional). Version 0x7805 (custody's base 5 | wide 0x4000 | rights 0x2000 |
# capacity 0x1000 | expedition 0x0800), RULESET_HASH_V4. Never deployable. TEST-ONLY local worlds started with
# `scripts/play-local.sh --coexist`.
#
#   scripts/build-frontier-localnet-coexist-sbf.sh
#
# The same tool pins and checks as the land lane (scripts/build-frontier-localnet-land-sbf.sh, unchanged by this one):
# - solana-cargo-build-sbf 3.1.9, installed platform-tools v1.52 only, --offline --skip-tools-install, --locked;
# - its own cargo target dir ($PSF_LOCALNET_COEXIST_TARGET_DIR, else permutation-frontier/target/localnet-coexist-sbf)
#   and output dir permutation-frontier/target/deploy-localnet-coexist-sbf/, so no other artefact is overwritten;
# - a text placeholder where cargo-build-sbf would otherwise write a program keypair (it writes one only when the
#   file is missing), so this script never creates a key;
# - the refusals: SBPF v2 (e_flags 2), overflow checks present, the markers PSF_LOCALNET_EXPEDITION_SBF_BUILD,
#   PSF_LOCALNET_CONQUEST_SBF_BUILD, PSF_LOCALNET_COEXIST_SBF_BUILD, PSF_RIGHTS_EXPERIMENTAL_BUILD and
#   PSF_CUSTODY_PREVIEW_BUILD present, and every test / devnet / NFT marker absent.
# The program runs only under program id [0x45; 32]. No deploy, key, wallet or network step exists here.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${PSF_LOCALNET_COEXIST_TARGET_DIR:-$root/permutation-frontier/target/localnet-coexist-sbf}"

want="solana-cargo-build-sbf 3.1.9"
have="$(cargo-build-sbf --version | head -1)"
[ "$have" = "$want" ] || { echo "need $want (have $have)" >&2; exit 1; }
tools="$HOME/.cache/solana/v1.52/platform-tools"
for t in "$tools/rust/bin/rustc" "$tools/llvm/bin/clang"; do
  [ -x "$t" ] || { echo "installed platform-tools missing $t; refusing (no install or download)" >&2; exit 1; }
done

out="$root/permutation-frontier/target/deploy-localnet-coexist-sbf"
holder="$out/permutation_frontier-keypair.json"
mkdir -p "$out"
[ -e "$holder" ] || printf '%s\n' "PLACEHOLDER: not a key. Exists so cargo-build-sbf skips program-keypair generation (scripts/build-frontier-localnet-coexist-sbf.sh)." > "$holder"
before="$(cat "$holder")"
[ "${PSF_COEXIST_CHECK_ONLY:-}" = 1 ] || cargo-build-sbf --manifest-path permutation-frontier/Cargo.toml --tools-version v1.52 --arch v2 --sbf-out-dir "$out" \
  --features localnet-coexist-sbf --offline --skip-tools-install -- --locked
[ "$(cat "$holder")" = "$before" ] || { echo "$holder changed during the build" >&2; exit 5; }

so="$out/permutation_frontier.so"
count() { { LC_ALL=C grep -a -o -E "$1" "$2" || true; } | wc -l | tr -d ' '; }
bad=0
flags="$(od -An -t u4 -j 48 -N 4 "$so" | tr -d ' ')"
[ "$flags" = 2 ] || { echo "$so: e_flags $flags, not 2 (SBPF v2)" >&2; bad=1; }
ovf="$(count 'attempt to (add|subtract|multiply) with overflow' "$so")"
[ "$ovf" -gt 0 ] || { echo "$so: built without overflow checks" >&2; bad=1; }
for m in PSF_LOCALNET_EXPEDITION_SBF_BUILD PSF_LOCALNET_CONQUEST_SBF_BUILD PSF_LOCALNET_COEXIST_SBF_BUILD PSF_RIGHTS_EXPERIMENTAL_BUILD PSF_CUSTODY_PREVIEW_BUILD; do
  [ "$(count "$m" "$so")" -gt 0 ] || { echo "$so: marker $m missing" >&2; bad=1; }
done
for m in PSF_ORACLE_BUILD PSF_TRACE_BUILD PSF_TEST_BEACON_BUILD PSF_DEVNET_PLAYABLE_BUILD PSF_NFT_EXPERIMENTAL_BUILD PSF_LOCALNET_NFT_SBF_BUILD; do
  [ "$(count "$m" "$so")" -eq 0 ] || { echo "$so: carries $m (a test, devnet or NFT build); refused" >&2; bad=1; }
done
[ "$bad" = 0 ] || exit 3
echo "artefact        $so"
echo "file_sha256     $(shasum -a 256 "$so" | cut -d' ' -f1)"
echo "so_len          $(wc -c < "$so" | tr -d ' ')"
echo "overflow_panic  $ovf"
echo "features        localnet-coexist-sbf (localnet-land-sbf + rights-experimental + capacity-preview + custody-preview)"
echo "program_id      [0x45; 32]"
echo "program_version 0x7805 (custody base 5 | wide 0x4000 | rights 0x2000 | capacity 0x1000 | expedition 0x0800; provisional)"
echo "ruleset_hash    RULESET_HASH_V4 (custody), rules version 13"
echo "feature_tags    rights 0xD0-0xD5, custody 0xC2-0xCC, capacity 0xF0-0xFD (frontier_abi::feature_registry, rev 8)"
echo "deployable      no"

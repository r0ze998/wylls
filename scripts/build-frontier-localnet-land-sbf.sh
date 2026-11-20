#!/usr/bin/env bash
# Isolated localnet SBF artefact of the conquest lane PLUS the land preview (feature `localnet-land-sbf` =
# `localnet-conquest-sbf` + `land-preview`: FoldLand / ClaimLandYield on the PROVISIONAL tags 0xCD / 0xCE). Never
# deployable. TEST-ONLY local worlds started with the launcher's `--world-option land-preview-v1`.
#
#   scripts/build-frontier-localnet-land-sbf.sh
#
# The same tool pins and checks as scripts/build-frontier.sh's localnet lanes (which this script leaves unchanged):
# - solana-cargo-build-sbf 3.1.9, installed platform-tools v1.52 only, --offline --skip-tools-install, --locked;
# - its own cargo target dir ($PSF_LOCALNET_LAND_TARGET_DIR, else permutation-frontier/target/localnet-land-sbf)
#   and output dir permutation-frontier/target/deploy-localnet-land-sbf/, so no other artefact is overwritten;
# - the refusals: SBPF v2 (e_flags 2), overflow checks present, both localnet markers present
#   (PSF_LOCALNET_EXPEDITION_SBF_BUILD, PSF_LOCALNET_CONQUEST_SBF_BUILD) and every test marker absent.
# The program runs only under program id [0x45; 32]. No deploy, key, wallet or network step exists here.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${PSF_LOCALNET_LAND_TARGET_DIR:-$root/permutation-frontier/target/localnet-land-sbf}"

want="solana-cargo-build-sbf 3.1.9"
have="$(cargo-build-sbf --version | head -1)"
[ "$have" = "$want" ] || { echo "need $want (have $have)" >&2; exit 1; }
tools="$HOME/.cache/solana/v1.52/platform-tools"
for t in "$tools/rust/bin/rustc" "$tools/llvm/bin/clang"; do
  [ -x "$t" ] || { echo "installed platform-tools missing $t; refusing (no install or download)" >&2; exit 1; }
done

out="$root/permutation-frontier/target/deploy-localnet-land-sbf"
# PSF_LAND_CHECK_ONLY=1: the artefact was built by a guarded `cargo build-sbf` with these same arguments; check it only
[ "${PSF_LAND_CHECK_ONLY:-}" = 1 ] || cargo-build-sbf --manifest-path permutation-frontier/Cargo.toml --tools-version v1.52 --arch v2 --sbf-out-dir "$out" \
  --features localnet-land-sbf --offline --skip-tools-install -- --locked

so="$out/permutation_frontier.so"
count() { { LC_ALL=C grep -a -o -E "$1" "$2" || true; } | wc -l | tr -d ' '; }
bad=0
flags="$(od -An -t u4 -j 48 -N 4 "$so" | tr -d ' ')"
[ "$flags" = 2 ] || { echo "$so: e_flags $flags, not 2 (SBPF v2)" >&2; bad=1; }
ovf="$(count 'attempt to (add|subtract|multiply) with overflow' "$so")"
[ "$ovf" -gt 0 ] || { echo "$so: built without overflow checks" >&2; bad=1; }
for m in PSF_LOCALNET_EXPEDITION_SBF_BUILD PSF_LOCALNET_CONQUEST_SBF_BUILD; do
  [ "$(count "$m" "$so")" -gt 0 ] || { echo "$so: marker $m missing" >&2; bad=1; }
done
# The TEST-only wide->wide switch (Cargo.toml `localnet-wide-depart` inside `localnet-land-sbf`): the marker must
# follow that one line, so removing the line (the documented OFF switch) builds and checks the closed-gate .so.
if grep -qE '^localnet-land-sbf = \[.*"localnet-wide-depart"' "$root/permutation-frontier/Cargo.toml"; then wide_depart=1; else wide_depart=0; fi
if [ "$wide_depart" = 1 ]; then
  [ "$(count PSF_LOCALNET_WIDE_DEPART_BUILD "$so")" -gt 0 ] || { echo "$so: marker PSF_LOCALNET_WIDE_DEPART_BUILD missing" >&2; bad=1; }
else
  [ "$(count PSF_LOCALNET_WIDE_DEPART_BUILD "$so")" -eq 0 ] || { echo "$so: carries PSF_LOCALNET_WIDE_DEPART_BUILD but the switch is off" >&2; bad=1; }
fi
for m in PSF_ORACLE_BUILD PSF_TRACE_BUILD PSF_TEST_BEACON_BUILD PSF_CUSTODY_PREVIEW_BUILD PSF_DEVNET_PLAYABLE_BUILD PSF_LOCALNET_COEXIST_SBF_BUILD PSF_RIGHTS_EXPERIMENTAL_BUILD; do
  [ "$(count "$m" "$so")" -eq 0 ] || { echo "$so: carries $m (a test build); refused" >&2; bad=1; }
done
[ "$bad" = 0 ] || exit 3
echo "artefact       $so"
echo "file_sha256    $(shasum -a 256 "$so" | cut -d' ' -f1)"
echo "so_len         $(wc -c < "$so" | tr -d ' ')"
echo "overflow_panic $ovf"
if [ "$wide_depart" = 1 ]; then
  echo "features       localnet-land-sbf (localnet-conquest-sbf + land-preview + localnet-wide-depart: TEST-only WideDepart debit gate OPEN)"
else
  echo "features       localnet-land-sbf (localnet-conquest-sbf + land-preview; localnet-wide-depart switch OFF: WideDepart refused)"
fi
echo "program_id     [0x45; 32]"
echo "land_tags      0xCD FoldLand, 0xCE ClaimLandYield (PROVISIONAL, unallocated)"
echo "deployable     no"

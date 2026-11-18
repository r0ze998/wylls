#!/usr/bin/env bash
# The DEVNET build of the playable lane (owner decision B7, 2026-11-18): the land lane's code (version 0x4804: the
# expedition wrapper with conquest kinds 12-18, wide land, the land preview) as cargo feature
# `devnet-playable-sbf`, WITHOUT the localnet lane's [0x45; 32] program-id check (id-agnostic, like the S1 release).
#
#   scripts/build-frontier-devnet-playable-sbf.sh [--twice]
#
# - scripts/build-frontier.sh --features devnet-playable-sbf does the build and every check: solana-cargo-build-sbf
#   3.1.9, installed platform-tools v1.52 only, --offline --skip-tools-install, --locked; SBPF v2, overflow checks,
#   no mis-resolved data relocation; marker PSF_DEVNET_PLAYABLE_BUILD present and every other marker absent (both
#   localnet markers included). --twice builds twice in fresh target dirs and requires identical bytes.
# - the release profile as every other build (opt-level 3): smaller profiles were measured and push S1 instructions
#   past the CU rows the clients request (reports/devnet-playable-lane.md), so the code generation and CU are the
#   land lane's that r0ze plays locally.
# - output permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so (its own cargo target dir
#   permutation-frontier/target/devnet-playable-sbf, or $PSF_DEVNET_PLAYABLE_TARGET_DIR).
# - a text placeholder is put where cargo-build-sbf would otherwise write a new program keypair (it writes one only
#   when the file is missing), so this script never creates a key; the program id is r0ze's, made offline.
# Deployable to devnet ONLY, through `node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json`
# (which requires the marker). The S1 profile and build-frontier.sh's plain build refuse this artefact.
# No deploy, key, wallet or network step exists here.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
twice=()
case "${1:-}" in
  "") ;;
  --twice) twice=(--twice) ;;
  -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
  *) echo "unknown argument: $1 (only --twice)" >&2; exit 2 ;;
esac
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${PSF_DEVNET_PLAYABLE_TARGET_DIR:-$root/permutation-frontier/target/devnet-playable-sbf}"
export PSF_DEVNET_PLAYABLE_SBF_LANE=1
out="$root/permutation-frontier/target/deploy-devnet-playable-sbf"
holder="$out/permutation_frontier-keypair.json"
mkdir -p "$out"
[ -e "$holder" ] || printf '%s\n' "PLACEHOLDER: not a key. Exists so cargo-build-sbf skips program-keypair generation (scripts/build-frontier-devnet-playable-sbf.sh)." > "$holder"
before="$(cat "$holder")"
scripts/build-frontier.sh --features devnet-playable-sbf ${twice[@]+"${twice[@]}"}
[ "$(cat "$holder")" = "$before" ] || { echo "$holder changed during the build" >&2; exit 5; }
echo "artefact       $out/permutation_frontier.so"
echo "program_id     none compiled in (id-agnostic); devnet id = scripts/devnet/devnet-playable-profile.json programId"
echo "program_version 0x4804 (S1 4 | wide 0x4000 | expedition 0x0800; provisional)"
echo "conquest_kinds 12-18 through the expedition wrapper only; land tags 0xCD 0xCE (provisional)"

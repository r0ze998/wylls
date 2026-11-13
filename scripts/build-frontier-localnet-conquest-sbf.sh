#!/usr/bin/env bash
# Isolated localnet SBF artefact of the version-0x4804 expedition revision
# PLUS the provisional conquest kinds 12–17 (feature `localnet-conquest-sbf`,
# which includes `localnet-expedition-sbf`). Never deployable.
#
#   scripts/build-frontier-localnet-conquest-sbf.sh
#
# - offline and --locked only, installed platform-tools v1.52 only, exactly
#   as the expedition lane (build-frontier.sh refuses to start otherwise);
# - its own cargo target dir (permutation-frontier/target/localnet-conquest-sbf,
#   or $PSF_LOCALNET_CONQUEST_TARGET_DIR when set) and output dir
#   (permutation-frontier/target/deploy-localnet-conquest-sbf/), so neither the
#   plain build's nor the expedition lane's artefacts are ever overwritten;
# - all of build-frontier.sh's checks (SBPF v2, overflow checks, data
#   relocations), with BOTH PSF_LOCALNET_EXPEDITION_SBF_BUILD and
#   PSF_LOCALNET_CONQUEST_SBF_BUILD required and every other marker refused;
#   it prints "deployable no";
# - the program runs only under program id [0x45; 32]
#   (`LOCALNET_EXPEDITION_PROGRAM_ID`), refused at runtime otherwise;
# - the raw conquest gate (`CONQUEST_LIFECYCLE_ENABLED = false`) and every
#   production gate are unchanged: only the versioned wrapper's kinds 12–17
#   reach the existing conquest consumers.
# No deploy, key, wallet or network step exists here.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${PSF_LOCALNET_CONQUEST_TARGET_DIR:-$root/permutation-frontier/target/localnet-conquest-sbf}"
export PSF_LOCALNET_CONQUEST_SBF_LANE=1
scripts/build-frontier.sh --features localnet-conquest-sbf
so="$root/permutation-frontier/target/deploy-localnet-conquest-sbf/permutation_frontier.so"
echo "artefact       $so"
echo "program_id     $(printf '45%.0s' $(seq 32)) (bytes [0x45; 32])"
echo "conquest_kinds 12 DeclareSiege (reservation when behind), 13 ResolveWithConquest, 14 SettleCapture, 15 SettleSiege, 16 CloseConquest, 17 CloseCaptureEscrow, 18 SettleReservation"

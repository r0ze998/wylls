#!/usr/bin/env bash
# LOCAL TEST CANDIDATE, not an allocation and never deployable: the conquest lane (`localnet-conquest-sbf`: the
# 0x4804 expedition revision plus conquest kinds 12-18) WITH NFT residents (`nft-experimental`: 0xE0 policy,
# 0xE1 join, 0xE2 act, and the wide band's 0xDD WideResidentAct for an NFT Citizen). Feature
# `localnet-conquest-nft-sbf`. Design and open decisions:
# docs/integration/CLAUDE-NFT-WIDE-LANE-INTEGRATION-DESIGN-20261114.md.
#
#   scripts/build-frontier-localnet-conquest-nft-sbf.sh
#
# - NOT BUILT YET (written 2026-11-14 without running any SBF or host build); run it only in an agreed build slot
#   under the usual disk guard (about 250 MB of target expected, as the other lanes);
# - offline and --locked only, installed platform-tools v1.52 only (build-frontier.sh refuses otherwise);
# - its own cargo target dir (permutation-frontier/target/localnet-conquest-nft-sbf, or
#   $PSF_LOCALNET_CONQUEST_NFT_TARGET_DIR) and output dir (target/deploy-localnet-conquest-nft-sbf/): no other
#   lane's artefacts are overwritten;
# - all of build-frontier.sh's checks with PSF_LOCALNET_EXPEDITION_SBF_BUILD, PSF_LOCALNET_CONQUEST_SBF_BUILD and
#   PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD required and every other marker (the local NFT lane's and the test beacon's
#   included) refused; "deployable no";
# - candidate program id [0x4C; 32] (`LOCALNET_CONQUEST_NFT_PROGRAM_ID`), refused at runtime under any other id;
# - candidate Season version 0x4804 | 0x8000 = 0xC804 (`LOCALNET_CONQUEST_NFT_VERSION`): neither the conquest lane's
#   worlds (0x4804), the local NFT lane's (0x8004) nor production Seasons accept its instructions.
# The host tools (keeper, herald, fclient, stack) do not know 0xC804 yet: a world on this artefact needs those too.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${PSF_LOCALNET_CONQUEST_NFT_TARGET_DIR:-$root/permutation-frontier/target/localnet-conquest-nft-sbf}"
export PSF_LOCALNET_CONQUEST_NFT_SBF_LANE=1
scripts/build-frontier.sh --features localnet-conquest-nft-sbf
so="$root/permutation-frontier/target/deploy-localnet-conquest-nft-sbf/permutation_frontier.so"
echo "artefact       $so"
echo "program_id     $(printf '4c%.0s' $(seq 32)) (bytes [0x4C; 32], local test candidate)"
echo "season_version 0xC804 (local test candidate: 0x4804 | 0x8000)"

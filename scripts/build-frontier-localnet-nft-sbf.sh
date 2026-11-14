#!/usr/bin/env bash
# Isolated local NFT world SBF artefact: the S1 program with NFT residents
# (`nft-experimental`, tags 0xE0–0xE2) and the test beacon key, feature
# `localnet-nft-sbf`. Test only; never deployable.
#
#   scripts/build-frontier-localnet-nft-sbf.sh
#
# - offline and --locked only, installed platform-tools v1.52 only (as the
#   other localnet lanes; build-frontier.sh refuses to start otherwise);
# - its own cargo target dir (permutation-frontier/target/localnet-nft-sbf, or
#   $PSF_LOCALNET_NFT_TARGET_DIR) and output dir
#   (permutation-frontier/target/deploy-localnet-nft-sbf/): the plain build's
#   and the expedition / conquest lanes' artefacts are never overwritten;
# - all of build-frontier.sh's checks, with PSF_LOCALNET_NFT_SBF_BUILD and
#   PSF_TEST_BEACON_BUILD required and every other marker refused; it prints
#   "deployable no";
# - the program runs only under program id [0x4E; 32]
#   (`LOCALNET_NFT_PROGRAM_ID`), refused at runtime otherwise;
# - its Seasons carry S1 | 0x8000 (the existing nft-experimental version), so
#   the playable expedition / conquest worlds (0x4804) and production Seasons
#   never accept its instructions, and it never accepts theirs.
# Disk: about 250 MB of target (measured for the expedition lane: 241 MB).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${PSF_LOCALNET_NFT_TARGET_DIR:-$root/permutation-frontier/target/localnet-nft-sbf}"
export PSF_LOCALNET_NFT_SBF_LANE=1
scripts/build-frontier.sh --features localnet-nft-sbf
so="$root/permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so"
echo "artefact       $so"
echo "program_id     $(printf '4e%.0s' $(seq 32)) (bytes [0x4E; 32])"
echo "season_version S1 | 0x8000 (nft-experimental)"

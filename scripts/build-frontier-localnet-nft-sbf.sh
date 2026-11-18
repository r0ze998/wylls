#!/usr/bin/env bash
# ⑳ NFT resident ID (owner decision 2026-11-18 18:26 JST: local and devnet
# only, no sale): the isolated localnet SBF artefact of the playable conquest
# lane PLUS the NFT resident instructions 0xE0–0xE2 (feature
# `localnet-nft-sbf` = `localnet-conquest-sbf` + `nft-experimental`).
# Never deployable.
#
#   scripts/build-frontier-localnet-nft-sbf.sh
#
# - the same pins and checks as the conquest lane (build-frontier.sh:
#   solana-cargo-build-sbf 3.1.9, installed platform-tools v1.52 only,
#   --offline --skip-tools-install, --locked, SBPF v2, overflow checks, data
#   relocations), with all four markers PSF_LOCALNET_EXPEDITION_SBF_BUILD,
#   PSF_LOCALNET_CONQUEST_SBF_BUILD, PSF_LOCALNET_NFT_SBF_BUILD and
#   PSF_NFT_EXPERIMENTAL_BUILD required and every other marker refused;
# - its own cargo target dir (permutation-frontier/target/localnet-nft-sbf,
#   or $PSF_LOCALNET_NFT_TARGET_DIR) and output dir
#   permutation-frontier/target/deploy-localnet-nft-sbf/;
# - program version 0xC804 (the lane's 0x4804 plus the resident bit), so the
#   plain lane's Seasons are refused and its Seasons are refused by the plain
#   lane; the program runs only under program id [0x45; 32].
# A text placeholder is put where cargo-build-sbf would write a program
# keypair, so no key is created. No deploy, key, wallet or network step.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${PSF_LOCALNET_NFT_TARGET_DIR:-$root/permutation-frontier/target/localnet-nft-sbf}"
export PSF_LOCALNET_NFT_SBF_LANE=1
out="$root/permutation-frontier/target/deploy-localnet-nft-sbf"
holder="$out/permutation_frontier-keypair.json"
mkdir -p "$out"
[ -e "$holder" ] || printf '%s\n' "PLACEHOLDER: not a key. Exists so cargo-build-sbf skips program-keypair generation (scripts/build-frontier-localnet-nft-sbf.sh)." > "$holder"
scripts/build-frontier.sh --features localnet-nft-sbf
grep -q '^PLACEHOLDER' "$holder" || { echo "$holder: the keypair placeholder was replaced (a key was generated)" >&2; exit 5; }
so="$out/permutation_frontier.so"
echo "artefact       $so"
echo "program_id     $(printf '45%.0s' $(seq 32)) (bytes [0x45; 32])"
echo "version        0xC804 (0x4804 | resident bit 0x8000, provisional)"
echo "resident_tags  0xE0 CreateResidentPolicy, 0xE1 JoinResident, 0xE2 ResidentAct (provisional, workstream 4)"

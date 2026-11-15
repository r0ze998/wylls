#!/usr/bin/env bash
# Isolated localnet SBF artefact of the version-0x4804 expedition revision
# (feature `localnet-expedition-sbf`). Never deployable.
#
#   scripts/build-frontier-localnet-expedition-sbf.sh
#
# - offline and --locked only: build-frontier.sh passes cargo-build-sbf
#   `--offline --skip-tools-install` for this feature (and cargo --locked),
#   after refusing to start unless the installed platform-tools v1.52
#   rustc and clang exist; CARGO_NET_OFFLINE=true as well. Nothing is
#   fetched, installed or updated (a missing crate or tool fails closed);
# - its own cargo target dir (permutation-frontier/target/localnet-expedition-sbf)
#   and output dir (permutation-frontier/target/deploy-localnet-expedition-sbf/),
#   so the plain build's artefacts are never overwritten;
# - all of build-frontier.sh's checks (SBPF v2, overflow checks, data
#   relocations), with PSF_LOCALNET_EXPEDITION_SBF_BUILD required and every
#   other marker refused; it prints "deployable no";
# - the program runs only under program id [0x45; 32]
#   (`LOCALNET_EXPEDITION_PROGRAM_ID`), refused at runtime otherwise.
# No deploy, key, wallet or network step exists here.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="$root/permutation-frontier/target/localnet-expedition-sbf"
export PSF_LOCALNET_EXPEDITION_SBF_LANE=1
scripts/build-frontier.sh --features localnet-expedition-sbf
so="$root/permutation-frontier/target/deploy-localnet-expedition-sbf/permutation_frontier.so"
echo "artefact       $so"
echo "program_id     $(printf '45%.0s' $(seq 32)) (bytes [0x45; 32])"

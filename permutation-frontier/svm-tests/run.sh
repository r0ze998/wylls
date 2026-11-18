#!/usr/bin/env bash
# Build the Frontier program and the harness probe, then run the program
# tests against those builds (M1 contract §3.5, §12).
#
#   permutation-frontier/svm-tests/run.sh [cargo test arguments]
#   permutation-frontier/svm-tests/run.sh --release -- g01_loaded_ g02_ g03_ g04_ g05_   # Gate W2
#
# Builds (scripts/build-frontier.sh, W2-A): the release .so (checked:
# SBPF v2, overflow checks, no test markers) and the feature builds in
# PSF_FEATURES (default "test-beacon trace oracle rights-test-beacon"; each
# never deployable; rights-test-beacon is workstream 02's option A build)
# into permutation-frontier/target/deploy{,-<feature>}/; the probe
# (probe/, SBPF v2) into target/deploy-probe/. The tests read them through
# PSF_SO, PSF_SO_TEST_BEACON, PSF_SO_TRACE, PSF_SO_ORACLE and PSF_PROBE_SO,
# which this script sets.
#
# PSF_SKIP_BUILD=1   use the binaries already built (or the variables above)
# RELEASE_CHECK=1    G13: no Pending coverage, every program code asserted
# PSF_PROGRAM_ID     base58 id to deploy at (default: a fixed test key)
# The playable lane's devnet build and the localnet land lane (tests/devnet_playable.rs, owner decision B7) are
# built too (scripts/build-frontier-devnet-playable-sbf.sh, scripts/build-frontier-localnet-land-sbf.sh) and read
# through PSF_SO_DEVNET_PLAYABLE and PSF_SO_LOCALNET_LAND.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
deploy="$root/permutation-frontier/target"

if [ "${PSF_SKIP_BUILD:-0}" != 1 ]; then
  if [ ! -x "$root/scripts/build-frontier.sh" ]; then
    echo "scripts/build-frontier.sh is missing (W2-A); set PSF_SKIP_BUILD=1 and PSF_SO to test an existing build" >&2
    exit 1
  fi
  "$root/scripts/build-frontier.sh"
  for f in ${PSF_FEATURES-test-beacon trace oracle rights-test-beacon}; do
    "$root/scripts/build-frontier.sh" --features "$f"
  done
  "$root/scripts/build-frontier-devnet-playable-sbf.sh"
  # the land lane's out dir gets the same kind of placeholder, so cargo-build-sbf writes no keypair there
  mkdir -p "$deploy/deploy-localnet-land-sbf"
  [ -e "$deploy/deploy-localnet-land-sbf/permutation_frontier-keypair.json" ] || printf '%s\n' "PLACEHOLDER: not a key (svm-tests/run.sh)." > "$deploy/deploy-localnet-land-sbf/permutation_frontier-keypair.json"
  "$root/scripts/build-frontier-localnet-land-sbf.sh"
  ( cd "$here/probe" && cargo-build-sbf --tools-version v1.52 --arch v2 \
      --sbf-out-dir "$here/target/deploy-probe" -- --locked )
fi

set_if() { # set_if VAR path: export VAR=path when unset and the file exists
  if [ -z "${!1:-}" ] && [ -f "$2" ]; then export "$1=$2"; fi
}
set_if PSF_SO "$deploy/deploy/permutation_frontier.so"
set_if PSF_SO_TEST_BEACON "$deploy/deploy-test-beacon/permutation_frontier.so"
set_if PSF_SO_TRACE "$deploy/deploy-trace/permutation_frontier.so"
set_if PSF_SO_ORACLE "$deploy/deploy-oracle/permutation_frontier.so"
set_if PSF_SO_RIGHTS "$deploy/deploy-rights-test-beacon/permutation_frontier.so"
set_if PSF_PROBE_SO "$here/target/deploy-probe/psf_probe.so"
set_if PSF_SO_DEVNET_PLAYABLE "$deploy/deploy-devnet-playable-sbf/permutation_frontier.so"
set_if PSF_SO_LOCALNET_LAND "$deploy/deploy-localnet-land-sbf/permutation_frontier.so"
for v in PSF_SO PSF_SO_TEST_BEACON PSF_SO_TRACE PSF_SO_ORACLE PSF_SO_RIGHTS PSF_PROBE_SO PSF_SO_DEVNET_PLAYABLE PSF_SO_LOCALNET_LAND; do
  echo "svm-tests: $v=${!v:-<unset>}"
done
cd "$here" && cargo test --locked "$@"

#!/usr/bin/env bash
# Key-free Node tests: `scripts/ci/node-keyfree.sh <package dir> <test glob>...`
# Runs, from <package dir>, every matching test file that
#   1. is not listed in scripts/ci/node-key-tests.txt (files that generate,
#      derive or sign with a key: left out, never run here), and
#   2. does not name a key API itself, and the list is current (the scan,
#      scripts/ci/scan-node-key-tests.mjs, follows imports into test helpers;
#      a new key-using file fails this script until the list is rewritten),
#   3. the scan examined (`scan-node-key-tests.mjs --covers`: a file outside what the scan
#      reads is refused, exit 4, instead of running unscanned), and
# runs them with scripts/ci/no-keys-guard.mjs preloaded, so a key operation
# reached through an import throws NoKeysGuard instead of using a key.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$1"; shift
list="$root/scripts/ci/node-key-tests.txt"
pat='Keypair\.generate|Keypair\.fromSeed|Keypair\.fromSecretKey|generateKeyPair|generateKey\(|createPrivateKey|subtle\.(sign|generateKey|importKey)|signTransaction|signMessage|\.sign\(|partialSign|ed25519\.|secp256k1\.|nacl|keygen|secretKey|privateKey'
node "$root/scripts/ci/scan-node-key-tests.mjs" --check
# Code the scan never reads (④, 2026-11-08): another tree named by a WS*_ROOT variable, and a Rust binary named by
# RUNEXEC_BIN / RUNEXEC_VIEW_BIN. The static scan and the review digests cover this checkout's JavaScript only, so:
#   - a WS*_ROOT that is not this checkout is refused (exit 6): run from the integrated tree, or audit that tree by hand;
#   - a runexec binary is refused unless <VAR>_SHA256 names it (exit 6): the operator states it is a build of this
#     checkout's audited workstreams/04-execution source; the script checks only that the bytes are the ones named.
for v in $(compgen -e | grep -E '^WS[0-9]+_[A-Z0-9_]*ROOT$' || true); do
  if [ "$(cd "${!v}" 2>/dev/null && pwd -P)" != "$(cd "$root" && pwd -P)" ]; then
    echo "$v=${!v} is not this checkout: the key-test scan did not read that tree (manual audit required; not run)" >&2; exit 6
  fi
done
for v in RUNEXEC_BIN RUNEXEC_VIEW_BIN; do
  [ -n "${!v:-}" ] || continue
  want="$(eval echo "\${${v}_SHA256:-}")"
  have="$(sha256sum "${!v}" 2>/dev/null | cut -d' ' -f1)"
  if [ -z "$want" ] || [ "$want" != "$have" ]; then
    echo "$v=${!v}: a Rust binary the key-test scan cannot read; set ${v}_SHA256 to the sha256 of an audited build of this checkout (have ${have:-none}; not run)" >&2; exit 6
  fi
done
cd "$root/$dir"
run=() unlisted=()
for g in "$@"; do
  for f in $g; do
    [ -f "$f" ] || continue
    if grep -qxF "$dir/$f" "$list"; then continue; fi
    if grep -qE "$pat" "$f"; then unlisted+=("$dir/$f"); continue; fi
    run+=("$f")
  done
done
if [ ${#unlisted[@]} -gt 0 ]; then
  printf 'names a key API but is not in scripts/ci/node-key-tests.txt (not run):\n' >&2
  printf '  %s\n' "${unlisted[@]}" >&2
  exit 3
fi
if [ ${#run[@]} -gt 0 ]; then
  node "$root/scripts/ci/scan-node-key-tests.mjs" --covers "${run[@]/#/$dir/}"
fi
if [ ${#run[@]} -eq 0 ]; then echo "key-free run: 0 files in $dir (nothing matched; node --test is not started, so it discovers nothing)"; exit 0; fi
echo "key-free run: ${#run[@]} files in $dir ($(grep -c "^$dir/" "$list" || true) left out, listed)"
exec node --import "$root/scripts/ci/no-keys-guard.mjs" --test "${run[@]}"

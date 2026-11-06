#!/usr/bin/env bash
# Key-free Node tests: `scripts/ci/node-keyfree.sh <package dir> <test glob>...`
# Runs, from <package dir>, every matching test file that
#   1. is not listed in scripts/ci/node-key-tests.txt (files that generate,
#      derive or sign with a key: left out, never run here), and
#   2. does not name a key API itself, and the list is current (the scan,
#      scripts/ci/scan-node-key-tests.mjs, follows imports into test helpers;
#      a new key-using file fails this script until the list is rewritten), and
# runs them with scripts/ci/no-keys-guard.mjs preloaded, so a key operation
# reached through an import throws NoKeysGuard instead of using a key.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$1"; shift
list="$root/scripts/ci/node-key-tests.txt"
pat='Keypair\.generate|Keypair\.fromSeed|Keypair\.fromSecretKey|generateKeyPair|generateKey\(|createPrivateKey|subtle\.(sign|generateKey|importKey)|signTransaction|signMessage|\.sign\(|partialSign|ed25519\.|secp256k1\.|nacl|keygen|secretKey|privateKey'
node "$root/scripts/ci/scan-node-key-tests.mjs" --check
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
echo "key-free run: ${#run[@]} files in $dir ($(grep -c "^$dir/" "$list" || true) left out, listed)"
exec node --import "$root/scripts/ci/no-keys-guard.mjs" --test "${run[@]}"

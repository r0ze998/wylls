#!/usr/bin/env bash
# Negative and positive fixtures for scripts/check-prize-nft-test-only.sh (⑰, 2026-11-15). Pure: makes small
# synthetic files in a fresh temporary directory (and, for the production-path case, one file in a fresh
# directory under this checkout's git-ignored permutation-prize/target), runs the check, and removes only what
# it created. No build, no key, no network.
#
#   scripts/check-prize-nft-test-only.test.sh
set -euo pipefail
here="$(cd -P "$(dirname "$0")" && pwd -P)"
check="$here/check-prize-nft-test-only.sh"
repo="$(cd -P "$here/.." && pwd -P)"
t="$(mktemp -d "${TMPDIR:-/tmp}/prize-nft-check.XXXXXX")"
prod_fix=""
# Remove permutation-prize/target afterwards only if this test created it (and it is then empty).
target_was_there=0; [ -e "$repo/permutation-prize/target" ] && target_was_there=1
cleanup() {
  rm -rf "$t"
  [ -n "$prod_fix" ] && rm -rf "$prod_fix"
  [ "$target_was_there" = 0 ] && rmdir "$repo/permutation-prize/target" 2>/dev/null
  return 0
}
trap cleanup EXIT
pass=0; fail=0
OUT=permutation_prize.TEST-ONLY-nft-experimental.so

# A synthetic ELF64 header: magic, class, data, machine (u16 at 18), e_flags (u32 at 48); then the strings.
fake() { # fake <path> <class> <data> <machine> <e_flags> <with_strings 0|1> [magic_hex]
  python3 - "$@" <<'EOF'
import sys, struct
p, cls, data, mach, flags, strs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6] == '1'
magic = bytes.fromhex(sys.argv[7]) if len(sys.argv) > 7 else b'\x7fELF'
h = bytearray(64)
h[0:4] = magic; h[4] = cls; h[5] = data
h[18:20] = struct.pack('<H', mach); h[48:52] = struct.pack('<I', flags)
body = b'attempt to add with overflow\0PRIZE claim-nft asset=\0PRIZE nation-nft asset=\0' if strs else b'nothing here\0'
open(p, 'wb').write(bytes(h) + body)
EOF
}
expect() { # expect <name> <want_rc> <cmd...>
  local name=$1 want=$2; shift 2
  set +e; "$@" >"$t/out.txt" 2>&1; local rc=$?; set -e
  if [ "$rc" = "$want" ]; then pass=$((pass+1)); echo "ok   $name (rc $rc)"; else fail=$((fail+1)); echo "FAIL $name: rc $rc, wanted $want"; sed 's/^/     /' "$t/out.txt"; fi
}

mkdir -p "$t/a"
printf 'x' > "$t/a/tiny.so";                         expect "too small" 3 "$check" "$t/a/tiny.so"
fake "$t/a/nomagic.so" 2 1 263 2 1 00454c46;       expect "e_flags+strings but no ELF magic" 3 "$check" "$t/a/nomagic.so"
fake "$t/a/elf32.so" 1 1 263 2 1;                  expect "ELF32" 3 "$check" "$t/a/elf32.so"
fake "$t/a/bigend.so" 2 2 263 2 1;                 expect "big-endian" 3 "$check" "$t/a/bigend.so"
fake "$t/a/x86.so" 2 1 62 2 1;                     expect "x86-64 machine" 3 "$check" "$t/a/x86.so"
fake "$t/a/v1.so" 2 1 263 0 1;                     expect "e_flags 0 (not SBPF v2)" 3 "$check" "$t/a/v1.so"
fake "$t/a/nostr.so" 2 1 263 2 0;                  expect "no overflow/NFT strings" 3 "$check" "$t/a/nostr.so"

# A symlink input is refused, whatever it points to.
fake "$t/a/good.so" 2 1 263 2 1
ln -s "$t/a/good.so" "$t/a/link.so";              expect "symlink input" 3 "$check" "$t/a/link.so"

# A file physically under permutation-prize/target, reached through a symlinked directory, is refused.
prod_fix="$repo/permutation-prize/target/.check-fixture-$$"
mkdir -p "$prod_fix"
fake "$prod_fix/permutation_prize.so" 2 1 263 2 1
ln -s "$repo/permutation-prize/target" "$t/via"
expect "production dir via a symlinked parent" 3 "$check" "$t/via/.check-fixture-$$/permutation_prize.so"
expect "production dir directly" 3 "$check" "$prod_fix/permutation_prize.so"
[ ! -e "$prod_fix/$OUT" ] && { pass=$((pass+1)); echo "ok   nothing written in the production dir"; } || { fail=$((fail+1)); echo "FAIL a file was written in the production dir"; }

# A pre-existing output symlink is refused and its target is left untouched.
mkdir -p "$t/b"
fake "$t/b/permutation_prize.so" 2 1 263 2 1
printf 'victim' > "$t/victim"
ln -s "$t/victim" "$t/b/$OUT";                    expect "output is a symlink" 3 "$check" "$t/b/permutation_prize.so"
[ "$(cat "$t/victim")" = "victim" ] && { pass=$((pass+1)); echo "ok   the symlink's target is unchanged"; } || { fail=$((fail+1)); echo "FAIL the symlink's target was overwritten"; }
# An output that is a directory is refused.
mkdir -p "$t/c/$OUT"; fake "$t/c/permutation_prize.so" 2 1 263 2 1
expect "output is a directory" 3 "$check" "$t/c/permutation_prize.so"

# Positive: a header-valid synthetic file passes and yields a regular-file copy (the check is a header and
# strings check, not a proof of a real build; the real build is the guarded cargo build-sbf).
mkdir -p "$t/d"; fake "$t/d/permutation_prize.so" 2 1 263 2 1
expect "header-valid file accepted" 0 "$check" "$t/d/permutation_prize.so"
if [ -f "$t/d/$OUT" ] && [ ! -L "$t/d/$OUT" ] && cmp -s "$t/d/permutation_prize.so" "$t/d/$OUT"; then pass=$((pass+1)); echo "ok   the copy is a regular file with the same bytes"; else fail=$((fail+1)); echo "FAIL copy"; fi
[ -z "$(ls -A "$t/d" | grep '^\.prize-nft-test-only\.' || true)" ] && { pass=$((pass+1)); echo "ok   no temporary file left"; } || { fail=$((fail+1)); echo "FAIL temporary file left"; }

echo "pass $pass fail $fail"
[ "$fail" = 0 ]

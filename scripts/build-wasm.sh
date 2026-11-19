#!/usr/bin/env bash
# Build frontier-wasm for the browser (M1 contract §9.5, §3.2):
# toolchain 1.95.0, wasm32-unknown-unknown, release (opt-level "s",
# panic "abort", LTO), paths remapped so the bytes do not depend on the
# checkout, output web/frontier/wasm/frontier.wasm + frontier.wasm.sha256.
# Fails when the file is over budget (400 KB raw, 150 KB gzip) or an export
# is missing.
#
#   scripts/build-wasm.sh [--cq | --s1]            build and write the artefact
#   scripts/build-wasm.sh [--cq | --s1] --check    build into a scratch dir; exit 1 unless
#                                                  the committed artefact is fresh (below)
#   ... --check --reference                        as --check, but only a byte-identical
#                                                  build passes (the reference host's gate)
#
# Three modules: frontier.wasm (no feature), frontier-v2.wasm (--cq, the
# conquest rules) and frontier-v3.wasm (--s1, the S1 rules). CI checks all three.
#
# BUILD_WASM_KEEP=<dir> (with --check) copies the module this host built to
# <dir>/<host>-<artefact>, so that CI can upload it for a byte comparison.
#
# The wasm32-unknown-unknown target is an install that waits for the owner
# (O-M1-12). Without it this script changes nothing, prints PENDING-OWNER
# and exits 3; the gate checks for the target before calling it (§12).
#
# Cross-host bytes. The same source and the same rustc 1.95.0 (59807616e)
# build to different bytes on different build hosts: aarch64-apple-darwin
# (where the committed module is built) and the GitHub Linux runner
# (x86_64-unknown-linux-gnu) differ by 38-46 B in every module. The current
# hashes and sizes are in web/frontier/wasm/<artefact>.hosts, not here. The
# cause is not established; it is not the checkout path (remapped) and not
# floating point (the sources use none). So the committed module stays the one
# built on aarch64-apple-darwin, and <artefact>.hosts records the sha256 each
# build host produces from the committed source. --check passes on a host when
# it reproduces the committed module byte for byte, or when it reproduces that
# host's recorded hash (any source change alters it too). A host with no
# record fails and prints the line to add. Rebuilding the module (no --check)
# rewrites this host's line and drops the other hosts' lines, which the next
# CI run reports; copy its line into the file.
#
# What a non-reference host cannot see. A Linux --check only proves "this
# source still builds to the Linux hash somebody recorded". It does not prove
# that the committed module is what the source builds on the reference host:
# PR #69 committed a frontier.wasm (6efaf879...) that differed in 4 bytes from
# what its own source built on the Mac (2132b661...), and the Linux job stayed
# green once the runner's line was recorded. Hence --reference: CI runs it on
# an aarch64-apple-darwin runner, where only byte identity passes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/frontier-wasm"
OUT_DIR="$ROOT/permutation-server/web/frontier/wasm"
TOOLCHAIN=1.95.0
TARGET=wasm32-unknown-unknown
RAW_MAX=$((400 * 1024))
GZ_MAX=$((150 * 1024))
CHECK=0
REFERENCE=0
ARTIFACT=frontier.wasm
FEATURE_ARGS=(--lib)
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --reference) REFERENCE=1 ;;
    --cq) ARTIFACT=frontier-v2.wasm; FEATURE_ARGS=(--lib --features cq) ;;
    --s1) ARTIFACT=frontier-v3.wasm; FEATURE_ARGS=(--lib --features s1) ;;
    *) echo "usage: $0 [--cq | --s1] [--check [--reference]]" >&2; exit 2 ;;
  esac
done
[ "$REFERENCE" = 0 ] || [ "$CHECK" = 1 ] || { echo "build-wasm: --reference needs --check" >&2; exit 2; }

if ! rustup target list --installed --toolchain "$TOOLCHAIN" 2>/dev/null | grep -qx "$TARGET"; then
  echo "PENDING-OWNER: the $TARGET target is not installed for $TOOLCHAIN (O-M1-12); nothing built" >&2
  exit 3
fi

if [ "$CHECK" = 1 ]; then
  TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/frontier-wasm-check.XXXXXX")"
else
  TARGET_DIR="$CRATE/target"
fi

# Reproducible paths: the checkout and the cargo home never reach the bytes.
# integ-W4: `--remap-path-prefix` alone is not enough. permutation-rules is a
# path dependency outside frontier-wasm's workspace, so cargo hashes its
# absolute path into the crate metadata, and two checkouts built different
# bytes (same size, other symbol hashes and layout). The build therefore runs
# through one fixed symlink to the checkout, taken under a lock (mkdir is
# atomic) so that concurrent builds from other checkouts wait.
LINK=/tmp/psf-frontier-wasm-root
LOCK="$LINK.lock"
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  waited=$((waited + 1))
  [ "$waited" -le 900 ] || { echo "build-wasm: $LOCK held for 15 min (remove it if no build is running)" >&2; exit 1; }
  sleep 1
done
cleanup() { rm -f "$LINK"; rmdir "$LOCK" 2>/dev/null || true; [ "$CHECK" = 1 ] && rm -rf "$TARGET_DIR"; return 0; }
trap cleanup EXIT
ln -sfn "$ROOT" "$LINK"
SEP=$'\x1f'
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$LINK=/psf${SEP}--remap-path-prefix=$ROOT=/psf${SEP}--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo${SEP}--remap-path-prefix=$HOME/.rustup=/rustup"
(cd "$CRATE" && cargo "+$TOOLCHAIN" build --locked --release --target "$TARGET" --target-dir "$TARGET_DIR" \
  --manifest-path "$LINK/frontier-wasm/Cargo.toml" "${FEATURE_ARGS[@]}")
BUILT="$TARGET_DIR/$TARGET/release/frontier_wasm.wasm"
[ -f "$BUILT" ] || { echo "build-wasm: no $BUILT" >&2; exit 1; }

RAW=$(wc -c < "$BUILT" | tr -d ' ')
GZ=$(gzip -9 -c "$BUILT" | wc -c | tr -d ' ')
SHA=$(shasum -a 256 "$BUILT" | cut -d' ' -f1)
echo "$ARTIFACT: $RAW B raw, $GZ B gzip, sha256 $SHA"

# Every export of the crate (and alloc, free, memory) must be there.
node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const m = new WebAssembly.Module(readFileSync(process.argv[1]));
  const have = new Set(WebAssembly.Module.exports(m).map(e => e.name));
  const src = readFileSync(process.argv[2], 'utf8');
  const list = src.slice(src.indexOf('exports!(')).match(/^\s+([a-z_]+),$/gm).map(s => s.trim().slice(0, -1));
  const missing = ['memory', 'alloc', 'free', ...list].filter(n => !have.has(n));
  if (missing.length) { console.error('build-wasm: missing exports: ' + missing.join(', ')); process.exit(1); }
  console.log('exports: ' + list.length + ' + alloc, free, memory');
" "$BUILT" "$CRATE/src/lib.rs"

FAIL=0
[ "$RAW" -le "$RAW_MAX" ] || { echo "build-wasm: $RAW B raw is over the 400 KB budget" >&2; FAIL=1; }
[ "$GZ" -le "$GZ_MAX" ] || { echo "build-wasm: $GZ B gzip is over the 150 KB budget" >&2; FAIL=1; }

HOSTS_FILE="$OUT_DIR/$ARTIFACT.hosts"
HOST="$(rustc "+$TOOLCHAIN" -vV | sed -n 's/^host: //p')"
[ -n "$HOST" ] || { echo "build-wasm: cannot read the host triple of $TOOLCHAIN" >&2; exit 1; }
HOST_LINE="$HOST $SHA $RAW"

if [ "$CHECK" = 1 ]; then
  if [ -n "${BUILD_WASM_KEEP:-}" ]; then
    mkdir -p "$BUILD_WASM_KEEP"
    cp "$BUILT" "$BUILD_WASM_KEEP/$HOST-$ARTIFACT"
  fi
  WANT="$OUT_DIR/$ARTIFACT"
  COMMITTED_SHA=$(cut -d' ' -f1 < "$OUT_DIR/$ARTIFACT.sha256")
  if [ ! -f "$WANT" ] || [ "$(shasum -a 256 "$WANT" | cut -d' ' -f1)" != "$COMMITTED_SHA" ]; then
    echo "build-wasm --check: $ARTIFACT.sha256 is stale or $ARTIFACT is missing" >&2
    exit 1
  fi
  # The committed hash must be recorded for the host that built it.
  if ! grep -qE "^[^ #]+ $COMMITTED_SHA " "$HOSTS_FILE" 2>/dev/null; then
    echo "build-wasm --check: no host in $ARTIFACT.hosts records the committed hash $COMMITTED_SHA" >&2
    exit 1
  fi
  # One record per host: a second line for a host would let a stale build pass.
  DUP="$(grep -v '^#' "$HOSTS_FILE" | cut -d' ' -f1 | sort | uniq -d)"
  if [ -n "$DUP" ]; then
    echo "build-wasm --check: $ARTIFACT.hosts has more than one line for: $DUP" >&2
    exit 1
  fi
  if cmp -s "$BUILT" "$WANT"; then
    echo "build-wasm --check: fresh (byte-identical to the committed module on $HOST)"
  elif [ "$REFERENCE" = 1 ]; then
    echo "build-wasm --check --reference: on $HOST the source builds $SHA ($RAW B); the committed $ARTIFACT is $COMMITTED_SHA." >&2
    echo "  The committed module is not what its source builds. Run scripts/build-wasm.sh on the reference host (Mac) and commit the module." >&2
    exit 1
  elif grep -qE "^$HOST $COMMITTED_SHA " "$HOSTS_FILE"; then
    echo "build-wasm --check: $ARTIFACT.hosts says $HOST built the committed module, but this build is $SHA ($RAW B)." >&2
    echo "  The committed module is not what its source builds. Run scripts/build-wasm.sh on the reference host (Mac) and commit the module." >&2
    exit 1
  elif grep -qxF "$HOST_LINE" "$HOSTS_FILE" 2>/dev/null; then
    echo "build-wasm --check: fresh for $HOST (reproduces its recorded hash; the committed module was built on another host, see the note in this script)"
  else
    echo "build-wasm --check: the source builds to bytes that are neither the committed module nor the recorded build for $HOST." >&2
    echo "  If the source changed: run scripts/build-wasm.sh on the reference host (Mac) and commit the module." >&2
    echo "  If this host has no record yet (or the toolchain changed), add this line to web/frontier/wasm/$ARTIFACT.hosts:" >&2
    echo "  $HOST_LINE" >&2
    exit 1
  fi
  exit "$FAIL"
fi

[ "$FAIL" = 0 ] || exit 1
mkdir -p "$OUT_DIR"
cp "$BUILT" "$OUT_DIR/$ARTIFACT"
echo "$SHA  $ARTIFACT" > "$OUT_DIR/$ARTIFACT.sha256"
# This host's record; the other hosts' lines belong to the previous module.
if [ -f "$HOSTS_FILE" ] && grep -qE "^[^ #]+ $SHA " "$HOSTS_FILE"; then
  # Module unchanged: keep every record, refresh this host's.
  { grep '^#' "$HOSTS_FILE" || true; { grep -v '^#' "$HOSTS_FILE" | grep -v "^$HOST " || true; echo "$HOST_LINE"; } | sort; } > "$HOSTS_FILE.new"
else
  { grep '^#' "$HOSTS_FILE" 2>/dev/null || true; echo "$HOST_LINE"; } > "$HOSTS_FILE.new"
  echo "build-wasm: the module changed; $ARTIFACT.hosts now has only $HOST. Add the CI host's line from the next CI run (x86_64-unknown-linux-gnu)." >&2
fi
mv "$HOSTS_FILE.new" "$HOSTS_FILE"
echo "wrote $OUT_DIR/$ARTIFACT"

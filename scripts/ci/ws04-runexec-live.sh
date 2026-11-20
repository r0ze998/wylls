#!/usr/bin/env bash
# Build ④'s native `runexec` and run the tests that need it (2026-11-20, STATE D34). Key-free.
#
#   scripts/ci/ws04-runexec-live.sh            # from the repository root
#
# 1. `cargo build --release --locked --bin runexec` in workstreams/04-execution (its own workspace, lock and
#    target dir; rustc 1.89 per rust-toolchain.toml and a C compiler for the bundled SQLite; no Solana toolchain).
# 2. ④'s own cargo tests (the simulated world; the 9 `tests/gateway.rs` cases stay #[ignore]: their bridge
#    generates test keys and signs, so they belong to the manual key-tests job).
# 3. The store ⑥'s `run view` test reads (WS06_RUN4_STORE): ⑥'s scratch test handoff/ws04-check/ws06_check.rs is
#    copied into ④'s tests/ for one run and removed again (it is not part of ④); the run views it writes must equal
#    ⑥'s committed fixtures/connect/run4-view-*.json.
# 4. The gateway's npm dependencies (npm ci --ignore-scripts), which ⑥'s test 2 imports the gateway contract with.
# 5. ⑥'s key-free Node set through scripts/ci/node-keyfree.sh with WS03_ROOT = WS04_ROOT = this checkout and
#    RUNEXEC_BIN(_SHA256) = the binary just built; test/connect-live.test.mjs must run all 7 tests with no skip.
#
# Network: crates.io and npm only (the tests themselves use loopback; ⑥'s fate server binds an ephemeral port).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
ws04="$root/workstreams/04-execution"
work="$(mktemp -d "${TMPDIR:-/tmp}/ws04-runexec.XXXXXX")"
scratch="$ws04/tests/ws06_check.rs"
cleanup() { rm -f "$scratch"; rm -rf "$work"; }
trap cleanup EXIT

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

echo "== 1. build runexec"
(cd "$ws04" && cargo build --release --locked --bin runexec)
bin="$ws04/target/release/runexec"
echo "runexec $(sha256 "$bin")"

echo "== 2. ④ cargo tests (simulated world)"
(cd "$ws04" && cargo test --release --locked)

echo "== 3. ④'s store on ⑥'s specs (scratch ws06_check)"
[ ! -e "$scratch" ] || { echo "$scratch exists: refusing to overwrite it" >&2; exit 2; }
cp "$root/workstreams/06-creation/handoff/ws04-check/ws06_check.rs" "$scratch"
(cd "$ws04" && WS06_FIXTURE="$root/workstreams/06-creation/fixtures/connect/ws06-runspecs.json" \
  WS06_DB_OUT="$work" WS06_VIEW_OUT="$work" cargo test --release --locked --test ws06_check)
rm -f "$scratch"
for f in "$work"/*.json; do
  cmp "$f" "$root/workstreams/06-creation/fixtures/connect/run4-view-$(basename "$f")"
done
echo "run views equal ⑥'s fixtures ($(ls "$work"/*.json | wc -l | tr -d ' ') files)"

echo "== 4. gateway dependencies"
[ -d "$root/permutation-gateway/node_modules" ] || (cd "$root/permutation-gateway" && npm ci --ignore-scripts --no-audit --no-fund)

echo "== 5. ⑥ key-free set with ③/④ and runexec"
export WS03_ROOT="$root" WS04_ROOT="$root" RUNEXEC_BIN="$bin" RUNEXEC_BIN_SHA256="$(sha256 "$bin")" \
  WS06_RUN4_STORE="$work/ws06-chain.sqlite"
log="$work/ws06.tap"
"$root/scripts/ci/node-keyfree.sh" workstreams/06-creation 'test/*.test.mjs' | tee "$log"
# every connect-live test ran: none of the 7 skipped
live=$(cd "$root/workstreams/06-creation" && node --import "$root/scripts/ci/no-keys-guard.mjs" --test --test-reporter=tap \
  test/connect-live.test.mjs 2>&1 | grep -E '^# (tests|pass|fail|skipped) ' | tr '\n' ' ')
echo "connect-live: $live"
[ "$live" = "# tests 7 # pass 7 # fail 0 # skipped 0 " ] || { echo "connect-live did not run 7/7" >&2; exit 1; }

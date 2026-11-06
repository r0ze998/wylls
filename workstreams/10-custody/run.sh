#!/usr/bin/env bash
# Workstream 10 (custody): runs everything this directory claims and writes
# the logs to results/. No network but crates.io; no chain, no deploy.
#
#   workstreams/10-custody/run.sh            fmt, clippy, tests, demo, mutations
#   CORE=/path/to/checkout run.sh            also checks that CORE's
#                                            permutation-rules custody.rs is the
#                                            kernel here (patches applied there)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/results"
mkdir -p "$out"
cd "$here/custody"

echo "== fmt, clippy" | tee "$out/checks.log"
cargo fmt -- --check 2>&1 | tee -a "$out/checks.log"
cargo clippy --all-targets -- -D warnings 2>&1 | tail -2 | tee -a "$out/checks.log"
cargo build --no-default-features 2>&1 | tail -1 | tee -a "$out/checks.log"

echo "== tests" | tee "$out/tests.log"
cargo test --release 2>&1 | grep -E "^test |test result|Running" | tee -a "$out/tests.log"
cargo test --release --test property -- --nocapture 2>&1 | sed -n '/successful requests/,/^}/p' | tee -a "$out/tests.log"

echo "== demo"
cargo run -q --release --example demo 2>&1 | tee "$out/demo.log"

# Mutations: each deliberately breaks one guarantee; the suite must fail.
echo "== mutations" | tee "$out/mutations.log"
mutate() { # label file old new
  local bak
  bak="$(mktemp)"
  cp "$2" "$bak"
  python3 - "$2" "$3" "$4" <<'EOF'
import sys
p, o, n = sys.argv[1:4]
s = open(p).read()
assert o in s, o
open(p, "w").write(s.replace(o, n, 1))
EOF
  local fails
  fails="$(cargo test --release 2>&1 | grep -cE 'FAILED|panicked' || true)"
  cp "$bak" "$2"
  rm -f "$bak"
  if [ "$fails" -gt 0 ]; then
    echo "caught   $1 ($fails failure lines)" | tee -a "$out/mutations.log"
  else
    echo "MISSED   $1" | tee -a "$out/mutations.log"
    exit 1
  fi
}
mutate "no grantee check" src/lot.rs "    if o.grantee != actor.citizen {" "    if false && o.grantee != actor.citizen {"
mutate "reserve against HELD, not available" src/lot.rs "    if lot.available(bell) < spec.qty {" "    if lot.held < spec.qty {"
mutate "no inbound room reservation" src/lot.rs "    if lot.held + lot.incoming() + qty > lot.quota {" "    if lot.held + qty > lot.quota {"
mutate "SettleCaravan accepts custody caravans" src/model/mod.rs "            if cv.custody == CC::CUSTODY_LOT {
                return Err(Error::CustodyCaravan);
            }
            w.check_arrived" "            w.check_arrived"
mutate "no order expiry" src/lot.rs "    if bell >= o.expires_bell {" "    if bell > o.expires_bell + 1000 {"
mutate "no replay guard on ShipLot" src/model/mod.rs "            w.expect_seq(&a, seq)?;
            let mut l = w.lot(&from)?;" "            let mut l = w.lot(&from)?;"
mutate "forfeiture drops the goods" src/lot.rs "    v.stores[r] = stores;
    v.quota[r] -= lot.quota;" "    v.quota[r] -= lot.quota;"
mutate "custodian may open over capacity" src/lot.rs "    if need > v.cap {" "    if need > v.cap * 2 {"
mutate "ordinary settlement ignores the custody quota" src/lot.rs "        self.cap.saturating_sub(self.quota[r]).max(self.stores[r])" "        self.cap.max(self.stores[r])"
mutate "settlement keeps the reservation" src/lot.rs "    lot.inbound[i] = Inbound::default();
    let s = if here {" "    let s = if here {"
mutate "running totals wrap" src/lot.rs "            lot.in_total
                .checked_add(cargo)
                .ok_or(CustodyError::Overflow)?," "            lot.in_total.wrapping_add(cargo),"
mutate "a return of unused goods counts them in again" src/lot.rs "    lot.held = held;
    lot.consumed -= qty;
    Ok(())" "    lot.held = held;
    lot.in_total += qty;
    Ok(())"
mutate "reconciliation keeps the reservation" src/lot.rs "            let q = lot.inbound[i].qty;
            lot.inbound[i] = Inbound::default();" "            let q = lot.inbound[i].qty;"

if [ -n "${CORE:-}" ]; then
  echo "== core copy of the kernel" | tee "$out/core-sync.log"
  python3 "$here/scripts/core-kernel.py" --check "$CORE/permutation-rules/src/frontier/custody.rs" \
    && echo "permutation-rules/src/frontier/custody.rs is the kernel here" | tee -a "$out/core-sync.log"
fi
echo "ok"

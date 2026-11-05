#!/usr/bin/env bash
# Workstream 10 ⇄ 9 adapter: fmt, clippy, the contract tests over ⑨'s own
# Harness, a longer random run, and mutations (each breaks one guarantee;
# the suite must fail). Logs to results/. Offline once crates are fetched.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/results"
mkdir -p "$out"
cd "$here"

echo "== fmt, clippy" | tee "$out/checks.log"
cargo fmt -- --check 2>&1 | tee -a "$out/checks.log"
cargo clippy --offline --all-targets -- -D warnings 2>&1 | tail -1 | tee -a "$out/checks.log"

echo "== tests" | tee "$out/tests.log"
cargo test --offline --release 2>&1 | grep -E "^test |test result|Running" | tee -a "$out/tests.log"
ADAPTER_SEEDS="${ADAPTER_SEEDS:-2000}" cargo test --offline --release --test interleave -- --nocapture 2>&1 \
  | grep -E "^seeds|test result" | tee -a "$out/tests.log"

echo "== mutations" | tee "$out/mutations.log"
mutate() { # label file old new
  local bak
  bak="$(mktemp)"
  cp "$2" "$bak"
  python3 - "$2" "$3" "$4" <<'EOF'
import sys
p, o, n = sys.argv[1:4]
s = open(p).read()
assert s.count(o) == 1, o
open(p, "w").write(s.replace(o, n, 1))
EOF
  local fails
  fails="$(cargo test --offline --release 2>&1 | grep -cE 'FAILED|panicked' || true)"
  cp "$bak" "$2"
  rm -f "$bak"
  if [ "$fails" -gt 0 ]; then
    echo "caught   $1 ($fails failure lines)" | tee -a "$out/mutations.log"
  else
    echo "MISSED   $1" | tee -a "$out/mutations.log"
    exit 1
  fi
}
L=src/lib.rs
mutate "a deposit from a lot reserves no return room" $L "            t.reserve_return(v, owner, ri, j, amount)?;
" ""
mutate "use of the inputs keeps the reservation" $L "            t.release_if_empty(j, r as u8);
        }
        self.commit(t, key, m);
        Ok(())
    }

    pub fn try_produce" "        }
        self.commit(t, key, m);
        Ok(())
    }

    pub fn try_produce"
mutate "a refund elsewhere keeps the reservation" $L "        if let Place::Hopper(j) = from {
            t.release_if_empty(j, ri);
        }" ""
mutate "a covered return keeps the reservation" $L "                let s = L::finish_inbound(Some(&view), &mut lot, rt, covered)?;" "                let s = L::Settlement { delivered: covered, burned: 0, dest_gone: 0 };
                lot.held += covered;
                lot.in_total += covered;"
mutate "a refund enters a frozen (seized) lot" $L "        usable(&view, &lot)?;
        let mut covered" "        let mut covered"
mutate "a fractional refund enters a lot" $L "        whole(amount)?;
        // A refund" "        // A refund"
mutate "no idempotency key check" $L "        match self.keys.get(&key) {" "        match None::<&Move> {"
mutate "a user's move takes the fullest lot in the vault" $L "        let mut lot = self.lot(v, owner, r).ok_or(CustodyError::Insufficient)?;
        L::spend_ship(" "        let owner = self.lots.keys().filter(|(x, _, rr)| *x == v && *rr == r).map(|(_, o, _)| *o)
            .max_by_key(|o| self.lot(v, *o, r).map(|l| l.held).unwrap_or(0)).unwrap_or(owner);
        let mut lot = self.lot(v, owner, r).ok_or(CustodyError::Insufficient)?;
        L::spend_ship("
mutate "a lot reachable from any facility" $L "        if (vault.p, vault.q) != (at.p, at.q) {" "        if false && (vault.p, vault.q) != (at.p, at.q) {"
mutate "an actor's move may change the owner" $L "            By::Actor(a) if a != owner => return Err(CustodyError::Forbidden.into())," "            By::Actor(a) if a != owner && false => return Err(CustodyError::Forbidden.into()),"
echo "ok"

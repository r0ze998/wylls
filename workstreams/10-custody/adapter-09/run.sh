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
mutate "a use order releases twice for one deposit" $L "        if let Some(l) = self.uses.get(&(job, deposit)) {
            let same" "        if let Some(l) = self.uses.get(&(job, deposit)).filter(|_| false) {
            let same"
mutate "a return is booked as a new arrival" $L "        if L::return_unused(&vault.view(), &mut lot, due).is_err() {
            return 0;
        }" "        let tr = (RETURN_TAG, TRANSIENT_SEQ - 1);
        if L::begin_inbound(&vault.view(), &mut lot, tr, due)
            .and_then(|_| L::finish_inbound(Some(&vault.view()), &mut lot, tr, due))
            .is_err()
        {
            return 0;
        }"
mutate "owed goods drop out of the books" $L "        let owed: i64 = if r == Resource::Ore {
            self.owed.values().sum()
        } else {
            0
        };" "        let owed: i64 = 0;"
mutate "more can come back than was taken" $L "            if back.checked_add(amount).is_none_or(|n| n > used) {" "            if back.checked_add(amount).is_none_or(|n| n > used + used) {"
mutate "an actor's move may change the owner" $L "            By::Actor(a) if a != owner => return Err(CustodyError::Forbidden.into())," "            By::Actor(a) if a != owner && false => return Err(CustodyError::Forbidden.into()),"

# ⑨'s own bridge10 at the pinned commit, on this adapter, in a temporary
# tree (⑨'s code is not copied into this branch, nor patched): the one lot
# table's returns, rests, replays and restarts, checked on ⑩'s side.
echo "== ⑨ bridge10 (872fe6a2) on this adapter" | tee "$out/with-bridge10.log"
pin9=872fe6a2195267415684351126cd9abb6effcd2a
root="$(git -C "$here" rev-parse --show-toplevel)"
git -C "$root" cat-file -e "$pin9^{commit}" 2>/dev/null || git -C "$root" fetch -q origin claude/elegant-bohr-co2uhr
for want in "permutation-rules 9ffca167ec9284f5aeb320003839a12a268a95d5" \
            "workstreams/09-capacity/kernel 9bd610c39980dd3c5b79f4ae1ee3e635443d5394" \
            "workstreams/09-capacity/bridge10 1177f5021ac22977fb2b6f63984dd9bca9e71678"; do
  set -- $want
  [ "$(git -C "$root" rev-parse "$pin9:$1")" = "$2" ] || { echo "$1 tree mismatch at $pin9" | tee -a "$out/with-bridge10.log"; exit 1; }
done
dt="$(mktemp -d)"
trap 'rm -rf "${dt:?}"' EXIT
git -C "$root" archive "$pin9" permutation-rules workstreams/09-capacity/kernel workstreams/09-capacity/bridge10 | tar -x -C "$dt"
mkdir -p "$dt/workstreams/10-custody/adapter-09"
cp -r "$here/../custody" "$dt/workstreams/10-custody/"
rm -rf "$dt/workstreams/10-custody/custody/target"
cp -r "$here/Cargo.toml" "$here/Cargo.lock" "$here/rust-toolchain.toml" "$here/src" "$here/with-bridge10" "$dt/workstreams/10-custody/adapter-09/"
tgt="$(cargo metadata --offline --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
wb="$dt/workstreams/10-custody/adapter-09/with-bridge10"
res="$(cd "$wb" && CARGO_TARGET_DIR="$tgt" BRIDGE_SEEDS="${BRIDGE_SEEDS:-1000}" cargo test --release -- --nocapture 2>&1 || true)"
grep -E "^seeds|^test |test result: .* [1-9][0-9]* passed|FAILED|panicked" <<<"$res" | tee -a "$out/with-bridge10.log"
grep -q "5 passed; 0 failed" <<<"$res" || exit 1
# Mutations of the adapter that ⑨'s own bridge must expose.
wmut() { # label old new
  local f="$dt/workstreams/10-custody/adapter-09/src/lib.rs" bak
  bak="$(mktemp)"; cp "$f" "$bak"
  python3 - "$f" "$2" "$3" <<'EOF2'
import sys
p, o, n = sys.argv[1:4]; s = open(p).read()
assert s.count(o) == 1, o
open(p, "w").write(s.replace(o, n, 1))
EOF2
  local r
  r="$(cd "$wb" && CARGO_TARGET_DIR="$tgt" cargo test --release 2>&1 || true)"
  cp "$bak" "$f"; rm -f "$bak"
  if grep -qE "FAILED|panicked" <<<"$r"; then echo "caught   $1 (through ⑨'s bridge)" | tee -a "$out/with-bridge10.log"
  else echo "MISSED   $1 (through ⑨'s bridge)" | tee -a "$out/with-bridge10.log"; exit 1; fi
}
wmut "a return is booked as a new arrival" "        if L::return_unused(&vault.view(), &mut lot, due).is_err() {
            return 0;
        }" "        let tr = (RETURN_TAG, TRANSIENT_SEQ - 1);
        if L::begin_inbound(&vault.view(), &mut lot, tr, due)
            .and_then(|_| L::finish_inbound(Some(&vault.view()), &mut lot, tr, due))
            .is_err()
        {
            return 0;
        }"
wmut "the rest is paid as if whole" "        let due = self.owed.get(&(v, owner)).copied().unwrap_or(0) / MILLI * MILLI;" "        let due = (self.owed.get(&(v, owner)).copied().unwrap_or(0) + MILLI - 1) / MILLI * MILLI;"
wmut "a payment is not booked as returned" "        *self.returned_total.entry((v, owner)).or_default() += due;" ""
echo "ok"

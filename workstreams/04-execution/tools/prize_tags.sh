#!/bin/bash
# Read-only: which refs add prize tags or Entry fields beyond the base.
cd "$1" || exit 1
for r in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do
  f=$(git show "$r:permutation-prize/src/lib.rs" 2>/dev/null) || continue
  t=$(printf '%s\n' "$f" | grep -E "pub const [A-Z_]+: u8 = [0-9]+;" | grep -vE "INIT_POOL|PAY|TALLY|FINALIZE|SET_SHARES|CLAIM|WITHDRAW_OPS|STATE_|MODE_" )
  e=$(printf '%s\n' "$f" | sed -n '/pub mod entry/,/^}/p' | grep -E "pub const" | grep -vE "MAGIC|SIZE|HDR_MAGIC|BUMP|CLAIMED|POOL|WALLET|AMOUNT|PAID_SLOT|CLAIM_AMOUNT")
  [ -n "$t$e" ] && echo "== $r" && echo "$t" && echo "$e"
done
echo done

# Experimental wide account capture read path

Status: isolated host-side implementation on `559bf553` plus reader guards
`c055c81d`. No deployment, keypair generation, signing, live world mutation,
or live wide-world acceptance run. The tests below use **synthetic account
bytes**, not a game played on a local or public chain.

## Connected

- Herald's feature-gated Fold recognizes wide Province/Holding captures before
  legacy account dispatch. It checks program ownership, exact ABI decoding,
  season, world namespace and the canonical public account address. The zero
  legacy P/Q prefix is never used as identity.
- Captures persist in the normal checkpoint account map and rebuild the derived
  wide index. Wrong-owner, malformed or unsupported replacements are refused
  and preserve the previous capture; only an absent post-state closes it.
- `/h/world/wide/page` lists full coordinates as decimal strings. Its `wide`
  field includes world, coordinate, keep holder, region, opened bell and at
  most 12 captured holdings. Each holding includes site, generation, inventory
  slot and owner Citizen. Raw bytes and archive sequence accompany captures.
- Every wide capture is `captured-unverified`. `postState=transaction` means the
  configured exact local feed; `at-or-after-transaction` means enriched RPC
  state, **not** exact historic state. The `slot` field is the associated
  transaction slot, a lower bound in the latter case, not RPC context slot.
- Wide account changes invalidate the province snapshot, including Holding
  changes and closes. Legacy polling retains its existing stable cursor rule.
- `/h/me` has a separate `wideHoldings` field. Wide inventory slots with no
  captured record say `not-captured`; multiple matches say `ambiguous`. Neither
  becomes a legacy holding at (0,0), nor silently appears as a free slot.
- The read-only recorded-world sheet keeps BigInt coordinates, colors captured
  wide provinces by their reported keep holder, and lists holding counts,
  capture timing and the unverified-history label. It does not invent land,
  alter the normal playable map, send orders, or sign. The parser bounds and
  validates wire fields; it is not a full browser ABI/event verifier.

## Still not connected

The safety guards intentionally reject unsupported PSW1 history in the normal
findex pipeline. This change does **not** lift that gate, silently skip those
records, or make the default writer/keeper/verifier support wide gameplay.
A source must deliver authenticated wide account captures to the Fold; a real
PSW1 archive-ingest implementation and live integration run remain required.
The recorded-world sheet is not yet the normal playable terrain/holding UI.
Closed records, like existing legacy closes, are not retained as tombstones
in the account-only checkpoint; restarting rebuilds present captures only.

## Verification

Run Rust commands from `frontier-node/` (its pinned Rust 1.95 toolchain):

```
cargo test --locked -p herald --features wide-world-experimental --test wide_capture --test wide -- --test-threads=1
cargo test --locked -p herald --test wide -- --test-threads=1
cargo clippy --locked -p herald --features wide-world-experimental --lib -- -D warnings
```

From the repository root:

```
node --test permutation-gateway/test/web-frontier-wide-world.test.mjs
node --check permutation-server/web/frontier/map/widemode.mjs
```

The focused tests cover coordinates beyond 2^53, canonical address/world/owner
rejection, malformed replacement versus close, full raw captures, checkpoint
round trip, holding-driven snapshot changes, explicit missing inventory
captures, strict page parsing and repeated screen open/close. DOM tests use a
small contract harness, **not** browser visual acceptance. No full test suite
was executed because other suites include key generation and signing.

# G1b (client part): one-sided land under a real tie; the rest needs a server contract (2026-11-16, Claude; static, NOT run)

Branch `claude/g1b-land-presence-20261116`, cut from `claude/g1c-land-order-20261116` @ f046b20b (the tie rule it extends).
Nothing was run, syntax-checked or imported; `git diff --check` and reading only.

## Evidence (source)
- Program: every account close is `init::close_to`; its callers close holdings, citizens, clash inputs / days / arrival
  slots, transit slots, capacity jobs / pools, marches, caravans, vaults, custody lots, rights grants, beacon anchors /
  caches, structures, wide targets / transits / provinces / records — **no land record**. `CloseSeason`'s parts
  (`proc/season.rs`) are join shards, province funds and the floats `RingSeed`, `AnchorArchive`, `DefenceClaim` — **no
  land**. FoldLand creates the record once (`init_with_seed`, version 0) and folds it forward (version 1, `nextBell + 1`,
  Lane C's report, rule `land.rs fold`).
- Herald (`fold.rs`): `capture_land_post` keeps a land capture only for this season (`season_of(d) == season_id`) and
  removes it only when the account is absent after a transaction; `envelope` takes `seq` / `slot` from the Province
  capture and adds `land` (with its own `slot`, which the page does not keep) — a land-only change therefore ties.
- So, within one season, a land record does not disappear once it exists.

## Client change (`controller.mjs latestEnvelope`, inside G1c's real-tie branch)
Under the same real tie (seq, slot, bell present on both sides, well-formed, equal) and identity (integer p, q and a BigInt
seasonId, equal), a valid held record (of that province, nextBell in uint32) against an answer with no record (absent)
or none it could read (`null`: version 0, or bytes refused) → the held land is kept, everything else the answer's.

## Counterexamples to "present wins" without those conditions (why it is not unconditional)
- Another season (closed and created again): its first answers carry no land yet — excluded by `seasonId`.
- A NEWER Province (not a tie) without land: kept authoritative — the client cannot tell a herald that has not captured
  the record yet (restart / rebuild) from one that legitimately has none.
- A future program that closes land records: the herald's removal branch would then be right — the tie-only, same-season
  rule bounds the effect to answers that do not move the Province.

## Left for a server contract (NOT implemented)
Ordering one-sided land across a NON-tie needs the answer to say how far its land is folded. Minimal proposal:
`views::province_latest` / `fold.rs envelope` add, beside `land`, a `landTx` (the land capture's `tx` seq — captures
already carry `tx: tx.seq`) and, when there is no capture, `landSeen: <the herald's processed tx head>`; the page then
orders the land part by `landTx` / `landSeen` (strictly increasing archive seq), and G1c/G1b's tie rules become fallbacks.
Owners: herald (server), then `herald.mjs parseEnvelope` (keep the two numbers) and `controller.mjs latestEnvelope`.

## Regression (SOURCE ONLY, not run)
`web-frontier-land-tie-order.test.mjs`: the old "one-sided → the answer" case replaced by: held vs absent / null (kept,
the rest the answer's), first appearance (the answer), non-tie / another season / no tie / invalid held record (the
answer). `web-frontier-land-freshness`'s "a lost record does not come back" uses distinct seqs (non-tie): unchanged.

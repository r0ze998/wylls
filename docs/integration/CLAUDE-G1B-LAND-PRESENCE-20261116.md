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

## Reverse review: five cases, producer → herald → parse → latestEnvelope → drawing (2026-11-16, paper only; NOT run)
Drawing reads what `latestEnvelope` stored: `FS.provinces.get(key).land` (`land.mjs landSummary / landElsewhere`, the
map's `src.landOf`). Each row: can the G1c/G1b rules leave an OLD land on screen?

| case | producer (program) | herald | parse (page) | latestEnvelope | verdict |
|---|---|---|---|---|---|
| 1. the answer without land is the older one | record created once, folded forward; never closed (every `close_to` caller, `CloseSeason` parts) | land capture kept for its season; envelope `seq/slot` from the Province only | absent → no `land`; version 0 → `land: null` | real tie + same identity → held kept (G1b) | **correct**: the held record is the newer |
| 2. the absence is a real removal | **no path found** (no land close/realloc; `CloseSeason` leaves land accounts) | removal branch exists (`capture_land_post`, account absent after a tx) | absent | held kept only while the Province does not move; any seq/slot/bell change → the answer | **not reachable now**; if a future program closed land, the old land would stay at most until the Province's next write (its `resolvedNext` lives in the Province; how often a Province is written per bell was not measured) |
| 3. a late answer after a season switch | a new season = a new id (below) | captures only `season_of == season_id` | the herald is pinned (`app.mjs herald.pin` before play): another season's Province fails `decode` (WrongSeason), the read is refused and nothing is stored (`loadEnvelope`) | not reached | **correct**. No in-page re-pin path found; an unpinned herald is not a play-page path (then the non-tie loop compares across seasons — pre-existing, not this item) |
| 4. abort / recreate | `CloseSeason` (Ended after grace, or Aborted) leaves a **tombstone at the season PDA** (`season_pda(id, bump)`, `resize(TOMBSTONE_SIZE)`): the same id cannot be created again; a new season has a new id → new season address → new land addresses (`land_address = with_seed(season, ld‖p,q)`) | ignores other seasons' land | other `seasonId` | identity differs → no protection | **correct** |
| 5. several folds in one slot | each fold `nextBell + 1`; one writer | captures carry the same `slot` (the page ignores the land `slot`) | `nextBell` read from the bytes | real tie: higher `nextBell` kept (G1c); equal → the answer (same page-visible land) | **correct** |

Also checked: a held valid record against an answer whose land is `null` because its bytes were refused — the herald
serves only its season's land, so with the pin this is a malformed answer; keeping the held record shows the last land
read, never an older one than the page had. No client inconsistency found: **no code change**.

### Not verified (table)
| item | why |
|---|---|
| how often a Province account is written (bounds case 2 if land ever closes) | not read in the keeper/resolution path |
| a herald restart / rebuild serving an envelope before its land capture | server behaviour, not read |
| any of this in a browser or a world | all test runs are paused |
| the server contract (`landTx` / `landSeen`) | proposed only |

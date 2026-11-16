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
| a herald restart / rebuild serving an envelope before its land capture | **settled** (last section): not by one herald's own restart; yes from a herald without `land-preview`, or a read-only checkpoint herald |
| any of this in a browser or a world | all test runs are paused |
| the server contract (`landTx` / `landSeen`) | proposed only |

## The tie contract, settled from source lines (2026-11-16, static; NOT run) — no code change
- **What a `latest` envelope's `seq` / `slot` / `bell` are**: `frontier-node/crates/herald/src/views.rs province_latest`
  (119–123) decodes the captured Province and calls `envelope((p, q), pv.resolved_next)`; `fold.rs envelope` (896–)
  sets `bell` (= that `resolved_next`), `slot: pv.slot` and `seq` = the Province capture's chained `event_head`
  (`pv.head()`). All three are functions of the Province account alone.
- **FoldLand does not write the Province**: `permutation-frontier/src/proc/land.rs fold` (101–152) declares
  `[fee_payer s,w] [season] [province] [land w] [system]`, checks only `land.is_writable`, and reads the Province twice
  (`Ro(&province.try_borrow_data()?)` for `RESOLVED_NEXT`, line 117; `let pd = province.try_borrow_data()?` passed to
  `fold_province(&pd, &mut ld, …)` as input); it folds only bells `b < resolved_next`.
- **The herald keeps an unchanged Province's capture**: `fold.rs` (~633) `if old.as_ref().map(|o| &o.data) == Some(&d)
  { continue; }` — a read-only Province in a FoldLand transaction leaves its capture's `slot`, `tx` and head as they were.
- **Hence**: a land-only change (FoldLand, or ClaimLandYield's header write) always ties on seq / slot / bell, and a land
  record's `nextBell` never passes the Province's `resolved_next` — exactly what `latestEnvelope`'s G1c / G1b rules
  assume. No counterexample found.

### Not verified (table, updated)
| item | state |
|---|---|
| the tie contract (land-only change ⇒ seq/slot/bell unchanged) | **settled** (lines above) |
| how often a Province is written (bounds case 2 if land ever closed) | **settled**: `frontier-abi/src/clash_model.rs finish_bell` (1166–1185) sets `RESOLVED_NEXT = b + 1` (and `roster_epoch + 1` when anything changed), called by `permutation-frontier/src/proc/clash.rs` (904, 923, 1525) as each bell is resolved; opening: `proc/map.rs` 757 / `proc/wide.rs` 861. Each bell's resolution writes the Province, so its capture — and the envelope's seq / slot / bell — moves: a land closure, if one ever existed, could be masked at most until the Province's next bell resolution. How long that is in a given world (the keeper's pace) is not measured |
| a herald restart / rebuild serving an envelope before its land capture | **settled** (last section): not by one herald's own restart; yes from a herald without `land-preview`, or a read-only checkpoint herald |
| any of this in a browser or a world | all test runs are paused |
| the server contract (`landTx` / `landSeen`) | proposed only |

## Herald restart / rebuild / read-only / no land-preview: when "a real tie, held land, answer without land" happens (2026-11-16, static; NOT run)
Source (frontier-node/crates/herald/src):
- `main.rs`: a normal start calls `Ingest::open(cfg, diffs)` and only afterwards binds the listener and runs
  `server::serve`. `runner.rs Ingest::open` (≈146–212) restores the checkpoint (`checkpoint::load_full`), applies every
  archived transaction after it (`for_each_after`; "Catch-up diffs go nowhere: no socket is open yet"), checkpoints, and
  returns. Province and land captures are applied by the same `fold.apply`, so ONE herald never serves a half-rebuilt
  state: a restart alone cannot produce the case.
- `main.rs` `--source read-only` (feature `wide-index-read-experimental`): no ingest; `wide_read.rs load_read_only_fold`
  (298–) serves a checkpoint frozen at its time T — self-consistent, but behind the chain.
- `fold.rs`: the land capture (584 → `capture_land_post`, 879–) and the envelope's `land` (927–928) are both
  `#[cfg(feature = "land-preview")]`: a herald built without it captures and serves no land at all.
Conditions under which the page meets the case (the Province's seq / slot / bell unchanged between the two answers):
1. a herald WITHOUT `land-preview` answers after one with it (another build after a restart), while the Province has not
   been written (no bell resolved) in between;
2. a READ-ONLY herald frozen at T answers after a live one, the land record having been created after T and the Province
   not written since T (possible: FoldLand folds bells behind `resolved_next`, so the record can be created later than
   the Province's last write).
In both, the held record is real chain data, newer than what the answering herald knows: keeping it is correct. A
counterexample would need a record really removed (no program path) or a held record of another world with the same
season id, province and an exactly equal seq/slot/bell (theoretical; a page talks to one herald origin and starts again
for another). Once the Province is written (the next resolved bell), the answer is no longer a tie and the page shows
what that herald serves.

## The server proposal, corrected: last write vs observation watermark
The earlier proposal (`landTx` for a present record, `landSeen` = the herald's processed head when none) **mixes two
quantities**: a last-write position of the record and an observation watermark of the herald. Counterexample: answer A
carries a record with `landTx` 100 from a herald that has seen 500; answer B carries none with `landSeen` 300 from a
herald WITHOUT `land-preview` (condition 1). Ordering by the numbers prefers B (300 > 100) and the land vanishes, though
a land record cannot disappear. Corrected minimal contract (proposal only, NOT implemented):
- every `latest` envelope carries `landPreview: true|false` (whether this herald captures land at all) and
  `landSeenThrough` (this herald's processed archive seq for the answer — a watermark, present with or without land);
  a present record also carries `landTx` (its capture's last-write seq) for diagnostics;
- the page compares land only between answers with `landPreview: true` from the same archive (a herald identity / epoch
  is also needed: archive seqs of different heralds are not comparable), by `landSeenThrough`; an answer with
  `landPreview: false` never removes a held record.
Owners: herald (server), then herald.mjs (keep the fields) and controller.mjs latestEnvelope. Until then the G1c / G1b
tie rules are the client's whole answer, and they keep the held record in both conditions above.

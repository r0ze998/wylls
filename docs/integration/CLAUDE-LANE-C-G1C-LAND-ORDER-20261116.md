# Lane C — G1c: ordering two `latest` envelopes that differ only in their land record (2026-11-16)

Base: Lane C tip `9ae9d7ee`. Branch: `claude/lane-c-g1c-land-order-20261116`. This is a static investigation only. No product code changed and nothing was run.

**Scope:** this covers only G1c. G1b (`/h/me` against the envelope) is a different question and stays open, as in `CLAUDE-LANE-C-G1B-METADATA-20261116.md`.

**The problem.** `controller.mjs` `latestEnvelope(previous, next)` compares `seq`, then `slot`, then `bell`, and returns `next` when they are all equal. The program's `FoldLand` writes the land account and leaves the province untouched. So two `latest` answers for one province can tie on all three and carry different land records. Whichever response lands last is kept, so an older response landing later puts the older land back.

## Every writer of the land account (program, read in full)

| Writer | File | What it writes | Page-visible? |
|---|---|---|---|
| `FoldLand` creating the record | `permutation-frontier/src/proc/land.rs` `fold` (~103–125) | `init_with_seed` plus `write_header` (magic, season, p, q, `yield_bell[12] = resolved_next − 1`). `VERSION` stays **0**. | No: `parseLand` returns null for version 0 |
| `FoldLand` folding | same, loop `for _ in 0..max` (≤ 8 bells) → `frontier-abi/src/land_preview.rs` `fold_province` (295–326) → `write_land` (188–200) | `VERSION = LAND_VERSION` (constant **1**: a layout tag, **not a counter**), `NEXT_BELL`, `VILLAGE`, `OWNER`, `BY`, `COUNT`; on the first fold also `P`/`Q` | **Yes**: every field `parseLand` reads |
| `ClaimLandYield` | `proc/land.rs` `claim` (~139–196) | `write_header` only: magic, season, p, q, `yield_bell[site]` (bytes 219–266) | **No**: `parseLand` reads up to `COUNT` (bytes 158–218) |
| closing | none found: no close or realloc of the land account in `permutation-frontier/src` | — | — |

**The rule's ordering** (`permutation-rules/src/frontier/land.rs`):
- `fold(b)` refuses unless `b == next_bell` (line 236), then sets `next_bell = b + 1` (line 307).
- `fold_province` writes the land only through that path.

**So within one season and one record:**
- `nextBell` is **strictly increasing**, by one per folded bell.
- **At most one page-visible land state exists for each `nextBell`**: the fold of bell `N − 1` from the unique state at `N − 1`.

**The herald.** `fold.rs` `capture_land_post` (909–927):
- It stores each post-state as `Capture { slot: tx.slot, … }`.
- It **removes** the capture when the account is absent after a transaction.
- The envelope then has no `land` (`fold.rs:962–965`).

## Evaluation (with counterexamples)

| Case | Order by parsed `land.nextBell`? | Order by `land.slot`? |
|---|---|---|
| Both have a record, different `nextBell` | **Yes, sound.** The higher one is newer: strict monotonicity, one writer. | Also yes, but the page drops `land.slot` today (`parseLand` reads `key` and `bytes` only) |
| Both have a record, equal `nextBell`, bytes differ | Bytes differ only in `yield_bell` (a claim). **Page-visible fields are identical**, so either choice draws the same | Would separate them; nothing on the page needs it |
| Several land writes in one slot (two FoldLands, or FoldLand + claim) | Still sound: `nextBell` differs whenever a page-visible field differs | **Not sound**: equal `slot` (captures carry `tx.slot`; the archive `tx` seq is not sent) |
| Fold capture at-or-after (`--source rpc`, `exact_post` false) | Still sound: `nextBell` is inside the bytes, so a later fetched state carries its own higher `nextBell` | **Not sound**: the bytes may be newer than their `slot` says |
| Record created (version 0, then folded) | A version-0 record is `land: null` on the page, the same as a refused one. That cannot be ordered against a version-1 record by `nextBell` | — |
| One answer has `land`, the other none (first appearance before vs after; or removal) | **Cannot be ordered**: there is no `nextBell` on the side without land | **Cannot be ordered**: the absent side has no slot |
| Record closed and created again | Would restart `nextBell` at `resolved_next − 1`, and break monotonicity | — |

**About the "closed and created again" row.** I found no path that closes a land record, so this case is **not reachable from the program as read**. The herald's removal branch exists for an absent account. I did not verify season close and abort; that is the boundary of this claim.

### Counterexamples to wider rules

- **"Prefer the side that has land."** If the record were ever removed (the herald handles it; the season-close path is unverified), this would keep a deleted record on screen. Not adopted.
- **"Order by `land.slot`."** It fails for several writes in one slot and for at-or-after captures (rows above). It also needs `herald.mjs` to keep `land.slot`. Not needed when `nextBell` already decides.
- **"Order by `VERSION`."** It is the constant 1 after the first fold. Not usable.
- **"Replace the whole envelope by the land winner."** The two answers can also differ in other accounts that do not move the province `seq` (arrival slots, day, inputs). Returning `previous` whole could throw away a newer arrival slot. The fix below therefore moves **only** `land`.

## Adoptable: minimal diff for `controller.mjs` (main CC's file; not applied)

```diff
 export function latestEnvelope(previous, next) {
   if (!previous) return next;
   for (const field of ['seq','slot','bell']) {
     const a=previous[field], b=next?.[field];
     if (a===undefined || a===null || a==='' || b===undefined || b===null || b==='') continue;
     try { if(BigInt(b)<BigInt(a)) return previous; if(BigInt(b)>BigInt(a)) return next; } catch { /* another comparable field may remain */ }
   }
+  // G1c: FoldLand writes the land record and not the Province, so a slower answer can tie on seq/slot/bell
+  // with an older land record. nextBell only grows (land.rs fold: b == next_bell, then b + 1), and every field
+  // the page reads is written with it, so the higher nextBell is the newer land. Only the land is kept, and
+  // only when both sides have one.
+  const ha=previous.land?.nextBell, nb=next?.land?.nextBell;
+  if (Number.isInteger(ha) && Number.isInteger(nb) && nb < ha) return { ...next, land: previous.land };
   return next;
 }
```

**What the diff covers.** The tie case where both answers carry a parsed record:
- the newer land is kept, and every other newer part of `next` is kept too;
- equal `nextBell` returns `next` (identical page-visible land);
- a non-tie (province `seq`/`slot`/`bell` differ) is unchanged.

**What it deliberately leaves alone.** The one-sided cases (land present against absent, or against `null`) stay as today. That includes the first appearance arriving before an older empty answer.

**Ripple effects (read, not run).**
- `loadEnvelope` stores the returned object, and `protoLand` reads `accepted.proto?.land` (a different field), so it is unaffected.
- `keepFromProvince(accepted.province)` is unchanged.

**Tests to add with it** (pure data, for the controller owner): beside the existing `latestEnvelope` cases in `permutation-gateway/test/web-frontier-controller.test.mjs`, which imports the controller module, so the controller owner should decide whether it may run:
- a tie with `nextBell` 41 held and 40 arriving keeps 41, and keeps next's arrival slots;
- a tie with equal `nextBell` takes `next`;
- a tie where one side has `land: null` or no land takes `next` (unchanged);
- non-ties are unchanged.

## What a full answer would still need (not this diff)

**Ordering the one-sided cases** (a record against no record) needs a fold position on the `latest` envelope: G1b's proposed `foldedThrough` on `views::province_latest`, server side.
- With it, `latestEnvelope` compares `foldedThrough` first and the land rule above becomes a fallback.
- Without it, the one-sided cases cannot be ordered from the bytes at all.

## Who owns what, for implementation

| Piece | File | Owner |
|---|---|---|
| The diff above | `permutation-server/web/frontier/controller.mjs` `latestEnvelope` | main CC (controller) |
| Its tests | `permutation-gateway/test/web-frontier-controller.test.mjs`, or a new pure test that reads `latestEnvelope` as text | main CC, or Lane C on request (a text-read test like `web-frontier-land-freshness.test.mjs`) |
| `parseLand` (`nextBell` already returned; no change needed) | `frontier/land.mjs` | Lane C: **no change required** |
| `parseEnvelope` (`land.slot` not needed for this diff) | `frontier/herald.mjs` | Lane C: **no change required** |
| One-sided cases (`foldedThrough` on `latest`) | `frontier-node/crates/herald/src/views.rs` (server), then herald.mjs/controller | server owner, then Lane C and main CC (G1b) |

## Not verified

- Season close or abort of land accounts (assumed not to happen, since no program path was found).
- How often two loads of one province overlap with a land-only change between them: read from code, not observed.
- No test was run for this report.

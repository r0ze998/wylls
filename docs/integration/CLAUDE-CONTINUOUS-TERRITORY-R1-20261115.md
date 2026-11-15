# Continuous territory (Standing Ground, reduced form): round 1 (Claude, 2026-11-15)

**Branch** `claude/continuous-territory-20261115`, cut from `baa604d2` (the canonical
`codex/wide-conquest-lifecycle-20261109` HEAD). Isolated worktree
`/Users/r0ze/Projects/wylls-continuous-territory-20261115`. The canonical checkout (75 uncommitted
entries) and the environment checkout (112) were not touched: read-only `git status` / `ls` only.

**Opt-in only.** Everything is behind the new cargo feature `land-preview` (permutation-rules and
frontier-abi). With the feature off nothing new is compiled: no default-build code, vector, hash
input, budget or natural-world rule changes. Nothing is bound into any `ruleset_hash`. It is NOT
yet run by the program, the keeper, the herald or the page (see "Not done").

Nothing here is NFT, transfer, session guard, prize, real funds or public issuance.

## Why
The owner wants land that grows as you move and is fought over continuously. Found:
- A village owns only its own tile on-chain (Holding `TILE`; the Province has no per-tile owner).
  The gold land on the map is browser geometry (`map/ownland.mjs`, `WORKED_RADIUS=[1,2,2,3]`);
  the kernel's `Tier::worked_radius` exists but the program never uses it.
- Production depends only on tier (`catalog::base_production`, `arms::base_production`).
- Only keeps (72 turns held) and villages (siege → SettleCapture) change hands. The capture demo
  takes one keep with ×30 compression and test participants; no village land grows.
- The banner rule's prototype ("Standing Ground", `permutation-gateway/screens/claims.mjs`) and the
  arrival-territory preview (`screens/territory.mjs`) exist in the sample world only. The
  prototype's spec files it cites (`PROTOTYPE-SPEC.md`, `CLAIM-RULE.md`,
  `claim-rule-constants.json`) are not in the tree.

## What round 1 adds
1. `permutation-rules/src/frontier/land.rs` (feature `land-preview`): the rule's kernel, pure and
   integer-only, driven by records the program already keeps. Per resolved bell, strictly in order:
   - **Village land** = each holding's worked-radius disc on passable ground (nearer site, then
     lower site index), made anew from the site mirror each bell: a **SettleCapture carries the
     village's land to the captor**, a tier-up widens it, a released village's land falls open.
     Village land is never taken by standing, only by taking the village.
   - **Growth as you move**: a standing host (roster, no pending order, fighting unit, ≥ 100
     troops) that has stood `stand_bells` on an open-or-own tile touching its nation's land (or its
     keep) claims the tile and the open passable neighbours no hostile host stands on or beside.
     March on, stand at the new edge, the land follows.
   - **Taking land**: a hostile host standing on claimed land with no owner's host on or beside the
     tile counts one bell; at `seize_bells` the tile and its undefended claimed neighbours flip.
     A defender beside it or the attacker leaving breaks the count.
   - **Cut-off land** (not joined through own tiles to village land, the keep or a standing host)
     frays and falls open at `fray_bells`.
   - **Heartland**: strangers claim, press and deny nothing (as the keep).
   - **Production**: each holding of nation f in the province gets
     `min(claimed_f × per_tile_bps / villages_f, cap_bps)` on top of its tier's base production
     (`production_with_land`). Land abroad pays nothing in goods.
   - Numbers: `LandParams::PREVIEW` (6 / 72 / 36 bells, 2%/tile, cap 30%) and `LandParams::TEST`
     (2 / 4 / 3) — the test set is for tests and compressed test worlds only.
2. `frontier-abi/src/land_preview.rs` (feature `land-preview`): a separate 256-B land record
   (`PSFLAND1`; the v2 Province has no free room), `province_inputs` reading a real v2 Province's
   bytes (SITES, site mirror, ENTRIES, KEEP, PASSABLE_MASK), `fold_province` and
   `production_with_land` over Province + record.

## Tests (evidence below)
Kernel: village land = radius and follows a capture/tier-up/release; nearer site wins, water never
land; fold strictly in bell order; a host that marches and stands grows land three times; a host
away from its land claims nothing; the keep is a foothold; scouts/small/busy hosts claim nothing;
a hostile host takes undefended land after the count; a defender breaks it; village land never
taken by standing; heartland strangers do nothing; cut-off land frays; a standing host stops it;
production follows land, capped; bad input refused; a long two-nation contest moves land back and
forth; the roster's order does not matter.
ABI: record round-trip and bad magic; reads the real Province fields (scout, pending order);
march → stand → claim → production up → hostile host takes → production down; SettleCapture's
mirror flip carries village land; a refused fold leaves the record unchanged.

RESULTS: _filled in after the guarded run_.

## Not done (open; none is claimed)
1. **The program does not run it.** Plan (round 2): a separate, opt-in instruction `FoldLand`
   (permissionless crank, like FoldOccupancy) with `[payer s] [season] [province r] [land w]`,
   folding `next_bell..resolved_next`, so the resolve's tight budget (RFI 286,224 / 290,000) is not
   touched; a land PDA `pl‖P,Q`; the keeper sends it after each resolve. This touches the keeper's
   duties — the KEEP owner (Opus｜KEEP選択の高速化) must agree first (paths + hashes before any write).
2. **Production is a kernel function, not yet credited.** The holding's accrual reads only the tier
   rate; round 2 needs the land bonus in the settle path (or a separate claim instruction).
3. **The herald and the map do not read it.** The map still draws geometric gold. Round 3: the
   herald serves the record; the map paints owner tiles from it when the preset is on.
4. **No world preset yet** (`--world-preset local-land-test-v1` would be the opt-in lane).
5. Not seen in any world; no SBF build; no Rust on the program side.

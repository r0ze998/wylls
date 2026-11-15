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

RESULTS (all under the unchanged conquest-guard.sh, sha 94baeb7d, one dedicated target; peak 1.5 GiB; free ≥ 26 GiB):
- 16:58 permutation-rules land 18/18; frontier-abi land_preview 8/8; default builds unchanged: rules 175/175, abi 115/115.
- 16:59–17:01 `cargo check -p permutation-frontier --features land-preview`; itest land_lane 3/3; runner
  (localnet-land-play) and herald (land-preview) built; program `cargo build-sbf --features localnet-land-sbf` →
  `permutation_frontier.so` sha256 f2e644420dd8dca4a9c985b995ea599040e09b0e69bc561f3069e625e96a5987 (SBPF v2, overflow
  checks, both localnet markers, no test marker). Warnings only in files not touched here.
- Page (node --test under the no-key guard): web-frontier-land-preview 5/5; unchanged: launcher 40, capture demo 6+3,
  territory-ui 7, board 16, herald 9; web-lang output identical to its baseline (2 old failures in other owners' files).

## Round 2: the program, the runner, the herald, the page, the launcher (commit 3c163208, pushed)
- Tags: PROVISIONAL 0xCD FoldLand / 0xCE ClaimLandYield (ABI-ALLOCATION rev 6 lists 0xCD–0xCF free; no local branch uses
  them; 0xE3–0xE7 were rejected: the resident band's spares). Workstream 4 must allocate before any integration.
- `permutation-frontier` `proc::land` (features `land-preview`, `localnet-land-sbf`); `itest::land_lane` (runner option
  `--land-preview land-preview-v1`, capture demo only; keeper_loop/local_keeper/legacy_march untouched, agreed with the
  KEEP session); herald `land-preview` (land record kept as a capture, served in the province envelope); page `land.mjs`
  (per-tile owner fill, gold outline from the record, "Territory N tiles · production +X%"); launcher
  `--world-option land-preview-v1` (checks the runner's statement and its unshortened numbers).
- Shared files also edited by other lanes in canonical (uncommitted there): herald Cargo.toml and src/fold.rs — merge by
  patch at integration, after the owner's handshake.

## Round 2 world: land1 (TEST-ONLY, ×30 capture demo, one operator, memory-only key)
- Launcher 41960 / world 41964–41968 / desk 41975 (agreed with the KEEP and NFT sessions); 17:01:43 → stopped by pid
  17:34:09 (TTL end would have been 18:02); guard (110 MiB / 21 GiB) never fired (world output ≤ 13 MiB, free ≥ 26.4 GiB).
- On the real page: Join Aster → Hamlet of Toford (province 1,1) → Train 400 → Form a host ×4, each on the next edge
  tile. Claimed land in the home province (herald, GET only): 0 → 3 (17:11:37) → 6 (17:16:40) → 7 (17:20:46) → 9
  (17:24:46); the strip's bonus moved +0% → +0.5% → +1% → +1.16% → +1.5% (9 × 2% ÷ 12 Aster villages there).
- Recording and evidence (not in git): `/Users/r0ze/Projects/wylls-land1-recording-20261115/` — 158 s cut
  (stream copy, cuts only) + untouched originals + runner/herald evidence; its README states every cut and limit.

## Not done (open; none is claimed)
1. **Growth by marching and arriving was not shown in a world.** The kernel/ABI tests cover it (a host's arrival tile is
   just its tile); in land1 the March button opens only in a 3–5 s window per 20-s turn at ×30 (keeper lag 1–2 turns,
   the same in live34), and two looked-at presses missed it. Next: a world at a slower scale, or a page fix that lets a
   march be composed while the province finishes its turn (the form card already has a waiting send).
2. **The credited yield amount** (ClaimLandYield landed 581 times, no program refusal) was not measured against the
   stores; it is tiny at these bonuses. A real-chain test that reads the Holding before/after one claim is next.
3. **Taking another nation's land and cut-off fraying** are unit-tested only; no second player in a world.
4. **No natural-speed world**; ×30 capture demo only. Program not deployable; tags provisional.
5. The strip's "Territory N tiles" is the nation's total over provinces read (test villages included), not the player's.

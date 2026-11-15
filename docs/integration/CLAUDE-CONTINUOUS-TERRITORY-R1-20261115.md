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

## Round 2 world: land2 (TEST-ONLY, ×10 capture demo) — growth by march, arrival and standing
- Same band (both sessions' OK); 17:38:58 → stopped by pid 18:00:47; guard never fired; free ≥ 26.3 GiB.
- On the real page: Form a host (200) on the village tile (no claim) → choose a tile → Hosts → March → "Hills · 3 tiles
  away · arrival turn 10" → Send this order (17:48:27). The host stood on tile 39 from turn 11; tile 39 was already
  Aster's; the turn-17 fold claimed its open neighbour tile 30: claimed land in (2,0) 0 → 1 at 17:59:35; the strip
  moved "Territory 106 · +0%" → "107 · +0.16%".
- Recording (not in git): `/Users/r0ze/Projects/wylls-land2-recording-20261115/` (131.6 s cut, originals, evidence,
  README with every cut).

## Not done (open; none is claimed)
1. **Growth by march is shown once, for one tile** (land2). At ×30 the March button is enabled only 3–5 s per turn
   (keeper lag 1–2 turns, the same in live34); at ×10 it was reachable. A march onto an open tile (not already ours)
   with a larger flower was not recorded.
2. **The credited yield amount** (ClaimLandYield landed 581 times, no program refusal) was not measured against the
   stores; it is tiny at these bonuses. A real-chain test that reads the Holding before/after one claim is next.
3. **Taking another nation's land and cut-off fraying** are unit-tested only; no second player in a world.
4. **No natural-speed world**; ×30 capture demo only. Program not deployable; tags provisional.
5. The strip's "Territory N tiles" is the nation's total over provinces read (test villages included), not the player's.

## Round 3 (2026-11-15 18:00–): canonical integration check and the remaining items
**Integration check (no write to canonical):** canonical HEAD 1dfe410f (75 uncommitted entries untouched). Clean branch
`claude/continuous-territory-integ-20261115` = 1dfe410f + the land commits cherry-picked without conflict, pushed.
Guarded regressions on it (conquest-guard.sh 94baeb7d, one target, peak 2.0 GiB, free ≥ 25 GiB), all pass: rules default
175, rules land 18, abi default 115, abi land 8, permutation-frontier default lib 115, permutation-frontier land check,
herald default lib 65, herald land check, itest land_lane 3. Page (no-key guard): land 5, territory 7, board 16, launcher
40, capture demo 6+3, herald 9, cards 7, pretake-frame unchanged; web-lang = its 2 old failures (not land).
Overlap with canonical's UNCOMMITTED work: only `frontier-node/crates/herald/Cargo.toml` (positional: both lanes add a
feature after `local-play-bootstrap`; keep both) and `herald/src/fold.rs` (my 3 hunks apply at offsets 1/35/35). Those
canonical edits are the Codex expedition lane's (KEEP session confirmed: not its). Order: that lane integrates first,
then the 2 herald hunks are rebased on it; the other 24 files have no canonical uncommitted edits. The KEEP session has
no objection and no planned edits on these paths. Integration itself is the user's decision; tags 0xCD/0xCE still need
workstream 4's allocation.

**Fixed (5d90b749, integ db6eef59):** the territory line now reads only the active village's province:
"Claimed here: N tiles · production +X%" (it used to sum every province read: 104 → 157 when the camera moved).

**Remaining, each with its next step (nothing claimed):**
| item | state | next step |
|---|---|---|
| march onto open ground, multi-tile claim | **shown in land3: 1 → 6** | a ×10 test world, destination an open tile 2+ from the edge; record port/TTL/guard first |
| taking another nation's land back | unit tests only (kernel, ABI) | `--contest-pair` + land option together (untested combination) in a test world, or a real-chain itest with two hosts |
| cut-off land fraying | unit tests only | same two-player world (seize a bridge tile) or itest |
| production credited (amount) | **measured in land3: credited = yield_for, 5 claims × 8 stores** | a real-chain test reading the Holding's stores before/after one claim vs `yield_for` |
| territory total changing with provinces read | **fixed** (above) | — |
| "Its host is on the march · arrives on turn N" after arrival | `map/hostmarks.mjs awayText`, shown while the transit record is unsettled although the host already stands in the destination roster | the march/transit owner's lifecycle; report, do not patch from this lane |

## Round 3 world: land3 (TEST-ONLY, ×10 capture demo, 18:44:54 → stopped by pid 19:18:18)
Preconditions recorded before the start (no world, band agreed with KEEP + NFT, free 25 GiB, guard 110 MiB / 21 GiB, TTL
60 min, cleanup plan); guard never fired; cleanup verified 19:18:28 (0 listeners) and reported to both sessions.
- **Production credit measured on chain** (GET-only script, before/after each ClaimLandYield, settle replicated):
  5 claims × 8 stores, credited = `yield_for` exactly — 0 at 0 bps (2 claims), Food/Wood/Stone/Ore/Gold/Science
  64/48/32/6/24/8 milli at 16 bps (2 claims), 400/300/200/40/150/50 at 100 bps (1 claim), 6 turns each.
- **Growth by march onto open ground**: host 2 marched from the village (sent 19:04:00, arrival turn 19) onto open tile
  59 next to our land; the turn-26 fold claimed 59 + 53, 54, 58, 60: claimed land 1 → 6 at 19:14:59; strip
  "Claimed here: 6 tiles · production +1%".
- Recording (not in git): `/Users/r0ze/Projects/wylls-land3-recording-20261115/` (167.6 s cut, originals, evidence,
  measurement script and output, README with every cut and disclosed press).
- Arrival tag: fixed by the KEEP session in canonical de18bf02 (its lane; not edited here).
- **Two-player retake, static check:** the contest-pair option (two ordinary wallets, memory-only keys, capture demo
  only) and the land option are both peeled by the runner and passed by the launcher; 10 ports fit the band. Feasible in
  the existing safe scope, but taking land needs 72 turns standing undefended: ×10 → 72 min (TTL ≈ 150 min), ×30 → 24 min
  but the March window is 3–5 s. Not run.

## Round 4 (2026-11-15 19:20–): integration branch updated; the two-player retake world is DESIGNED, NOT STARTED
**Integration branch:** canonical 98a80769 (incl. the KEEP session's arrival-tag fix de18bf02) merged into
`claude/continuous-territory-integ-20261115` without conflict (62b1895c, pushed). The merge brings web files only
(hostmarks.mjs, one fmap.mjs line, en-frontier.mjs, a test), so the guarded Rust results of round 3 stand (no Rust file
changed). Page tests on it: away-tag 3 (new), land 5, territory 7, board 16, launcher 40, capture demo 6+3, herald 9,
cards 7, pretake-frame 10; web-lang = its 2 old failures. Canonical's 75 uncommitted entries untouched; the 2 herald
files there unchanged (sha 09b4c5e5 / ecf859e7, the Codex expedition lane's; owner not messageable from here → the
user decides; nothing written).
**New static test:** the launcher accepts `--world-option land-preview-v1` only with the capture demo, alone or with
`--contest-pair contest-pair-v1` (web-frontier-land-preview.test.mjs, 6/6; no key, no process).
**March button while resolving:** proposed to the KEEP session (Hosts-tab March greyed by marchCheck NotResident while
the action bar's March opens its card); it changes when a send control opens, so the KEEP session put it to the user.
No patch prepared here.

### Design: a two-player retake test world (start only on the user's word)
Purpose: show land of one nation taken by another nation's standing host (and, if time allows, a defender breaking the
count), with two ordinary wallets operated by one person, no rule shortened.
- **Launcher:** natural preset + march trial + `--capture-demo capture-demo-v1 --demo-scale 10` +
  `--world-option land-preview-v1` + `--contest-pair contest-pair-v1` + `--world-ttl-minutes 150`, `--herald-output
  compact-v2`. Two pages (two desk contexts p1/p2, each its own memory-only key). No NFT, transfer, session guard,
  prize, real funds or public issuance.
- **Ports:** launcher 41960, world slot 0 = 41964–41968 and the pair's slot 1 relay/herald = 41969–41973, desk 41975;
  all-clear from the KEEP and NFT sessions first; none of them on 41900–41999 during it.
- **Where land can be taken:** heartland strangers do nothing (keep `heartland_safe`), so the land must lie in a
  province of ring ≥ 4. The capture demo opens one such province (land1/land3: (−2,4), keep holder Borealis). P1 needs a
  foothold there (the keep's holder nation, or land next door) — so P1 joins the nation holding that keep, P2 another
  nation. **Unverified until the world runs:** which ring-4 province the demo opens for P1's wedge and its keep holder;
  the plan is abandoned (and said so) if P1 cannot claim there.
- **Timeline at ×10 (≈ 60 s per turn):** start + two joins ≈ 5 min; train/form ≈ 3 min; P1's host marches to the ring-4
  province (route up to ~20+ tiles: several turns) and stands 6 turns → P1 land there ≈ 15–25 min; P2's host marches
  onto P1's claimed land and stands **72 turns undefended ≈ 72 min** → the tiles flip to P2 (seize). Total ≈ 100–110
  min, inside a 150-min TTL. A retake back by P1 would need another 72 turns: not in this world.
- **Done when** (from the herald, GET only, logged with wall time): the land record of that province shows the tiles'
  owner change P1 → P2 at the fold where P2's host has stood 72 turns, and the press counter rising each turn before it
  (`by`/`count` bytes); fails if P2's host is defended, moved or destroyed, or the TTL ends first (reported as not shown).
- **Capacity:** world output measured 9–16 MB per ~33 min → ≈ 45–70 MB for 150 min (< 110 MiB guard); recording ≈ 1.5 MB
  per player per minute → ≈ 460 MB for two players over 150 min: above the desk's 250 MiB cap → record only P2's page
  continuously and P1's at its key moments, or raise the cap to 500 MiB (asked first); free ≥ 21 GiB checked before,
  stop at < 21.1 GiB.
- **Guard / cleanup:** land-guard.py (110 MiB / 21 GiB → SIGINT to my launcher only), TTL 150 min, evidence logger +
  a press/owner logger for the contested province; at the end desk stop/quit, SIGINT launcher by pid, loggers by pid,
  0 listeners verified, both sessions told.
- **Not at ×30:** the hold would be 24 min, but the March window is 3–5 s per turn; no blind presses, so ×10 only.

**Herald land test (new):** `frontier-node/crates/herald/tests/land_capture.rs` (feature `land-preview`): a land record
of this season rides the province envelope byte for byte and leaves with its account; another season, another owner or
a wrong size is dropped. Guarded run 2/2 (conquest-guard.sh 94baeb7d, target 2.2 GiB, free 23.7 GiB). No canonical herald
file touched (the test is a new file; fold.rs/Cargo.toml hunks unchanged).

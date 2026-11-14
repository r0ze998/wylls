# ⑰ NFT prize: local world E2E (transfer → claim through the relay and the English page) — design (2026-11-15)

**Status: design plus two light tools; no world started.** Branch `claude/nft-prize-connect-20261114`.
Local loopback only: no real funds, no public RPC, no public mint, no real wallet. The production prize build
(`scripts/build-prize.sh`) and every authority/fund guard stay as they are. New pass deposits, pass refunds
and pools on continuous worlds stay refused; no undecided rule (refund owner, prize period) is decided here.

## 1. What is new compared with the LiteSVM tests (7/7)

The LiteSVM tests ran the real prize (TEST ONLY SBF), Core and resident programs, but wrote the game's
accounts as bytes. This E2E runs the **real game program** (⑳'s NFT lane), the **real keeper/herald/relay**,
and the **page in English**, so that JoinResident, the Citizen, the link, the season's end and the game's own
CloseCitizen are real, and the claim goes through `POST /f/prize/claim` and the page's 賞金 panel.

## 2. The one explicit fixture (and what it is not)

The prize program refuses every pass deposit (`ResidentDepositsDisabled`). An existing pass Entry can only
stand for one from before that rule, so the E2E places **one Entry per pass** on the loopback chain with
`scripts/prize-nft-fixture-entry.mjs --tamper-fixture-test-only` (frontier-localnet `frontier_setAccount`, only
when the localnet runs with `--allow-tamper`). It writes only the Entry (owner = prize program, unclaimed, no
nation). It does **not** put the pass's fee in the vault or the pool's counters: the prize is funded only by
**real** wallet `Pay` instructions. Every record calls it a TEST ONLY tamper fixture; **it is never reported as
a deposit**. Pure tests: `test/prize-nft-fixture-entry.test.mjs` (5/5: layout, loopback-only, refusals before
any request, refusal of an absent/foreign pool, absent asset, existing Entry; one account written).

## 3. World options (handshake with ⑳ pending)

- **A (preferred if ⑳ agrees): extend `frontier-stack`** so `--nft-pass` can run with `--prize-so <TEST ONLY
  .so>` on a finite season, and pass `--allow-tamper` to the localnet only under an explicit fixture flag. It
  reuses the stack's prize module (test mint, gate, InitPool, faucet) and ⑳'s nft-setup. Cost: one
  `frontier-stack` host rebuild (est. 1+ GiB, guarded). The stack's `--nft-pass` is ⑳'s code (`e2b522fc`):
  ⑳ decides or makes the change.
- **B: drive from outside.** Run ⑳'s `frontier-stack up --nft-pass` unchanged, then deploy and initialise the
  prize program with a separate driver. Blocked today: the stack has no way to pass `--program` or
  `--allow-tamper` to its localnet, so the fixture Entry and the prize program cannot be added without a
  stack change either. So B also needs a small stack change, or a localnet started by hand.

Pins to agree with ⑳ before any world: the commit of `frontier-node/nftpass-bin`, the lane `.so` (runbook
`0227dbe1…` deploy-localnet-nft-sbf vs today's `404633c8…` localnet-conquest-nft-sbf 0xC804), and that the lane
can create a **finite** season (InitPool refuses continuous seasons and `r_max` or the cq `r_max_ceiling` past
17). The relay and page come from **this** branch (the NFT prize routes and the pass panel exist only here;
base `0ebfe040`); ⑳ to confirm no route/ABI drift since then.

## 4. The sequence (two passes, so both stories run in one world)

Keys: local test keys only, in memory or 0600 per-run files, never printed or committed (as ⑳'s runbook).
Wallets: A, B (pass holders), C and D (wallet players who `Pay` and fund the prize).

1. World up (agreed slot, ports base 42100; nothing of ⑳'s 41000 or main's 41980–41999).
2. A mints passes P1 and P2 (real MintResident, mint page or driver).
3. **Fixture:** an Entry for P1 and for P2 (`paidBy` A, generation 0). Recorded as tamper.
4. A joins with P1 and P2 from the English page ("Join with this NFT"): with a pool and an Entry, the page's
   plan is `joinPaid`: a plain JoinResident through the relay's settled x402 path, no fee (real JoinResident,
   real NFT Citizen and link). C and D `Pay` and join normally.
5. Play to the finite end (compressed clock, labelled compressed). Tally and Finalize (real, permissionless).
   **Shares — open choice (§6):** real achievements via `prize-settle.mjs`, which needs the passes to have
   earned points in play, or a TEST ONLY shares ledger posted by the operator's real SetShares. The ledger
   would be labelled; it is not the provisional achievements ledger.
6. RecordResidentNation for P2 (real); the game's **CloseCitizen** for P2's Citizen after `end + 72 h`
   (compressed; real instruction). P2's claim must still work.
7. **P1: A → B** (real TransferResident). On the English page: A sees "not in this wallet now" and no claim
   button; B claims (real ClaimResident via `POST /f/prize/claim`); balances read over RPC; B's second claim
   → "already claimed"; A's old-generation signature → ResidentStaleGeneration in words.
8. **P2: A → B → A** (real, generation 2). B and A's generation-0/1 attempts refused; A's session key refused;
   A claims once at generation 2; then "already claimed".
9. Evidence: every signature and status, account bytes before/after (vault, token accounts, Entries),
   English screenshots of each panel state, one JSON transcript. Then stop and clean up (§7).

## 5. Light tools in this round

- `permutation-gateway/scripts/prize-nft-fixture-entry.mjs`: the fixture (above).
- `permutation-gateway/test/web-frontier-prize-abi-order.test.mjs`: the claim/record account lists agree
  across the program, the page SDK and the LiteSVM test (3/3, negative control).
- To write once ⑳ answers: the E2E driver (steps 2–8 over loopback RPC, relay and page) and the stack change
  if option A.

## 6. Open (owner decisions, not made here)

- Shares in a short test world: real achievements (needs play that earns points) or a labelled TEST ONLY
  shares ledger. The provisional weights stay provisional either way.
- Refund owner, prize period on continuous worlds, wallet ↔ NFT migration: untouched; refunds and
  continuous pools stay refused.

## 7. Stop and cleanup (planned)

Stop with the stack's own `stop_all` (or the driver's). Copy the evidence (transcript, signatures,
screenshots, hashes) to the scratchpad and the doc; then remove only this run's own run dir and its own
targets, with sizes recorded. Never another session's world, ports, run dirs or caches.

## 8. Proven / unproven (now)

Proven so far (host 10/10, LiteSVM 7/7): the claim rules with the real Core/resident programs. **Unproven
until this E2E runs:** the real game program's JoinResident/CloseCitizen with the prize, the relay's claim
route against a chain, the English page's claim flow, and real-chain timing. A deposit stays unproven by
design (refused).

## 9. Review fixes and new tools (2026-11-15)

- **Fixture tool hardened:**
  - `fetch` uses `redirect: 'error'`, so no 307/308 is followed off loopback.
  - The chain's `frontier_status.runId` must equal `--expect-run-id`, taken from the run's manifest, so a fixture can't land in another world.
  - The pool must decode, be the prize program's, sit at `poolAddress(prize, game, season-id)`, name that game and season, and still be Open.
  - The read-back must equal **every byte** written plus owner, lamports and executable.
  - Tests 6/6, including 11 read-back mutations, every one refused.
- **TEST ONLY shares:**
  - `scripts/prize-nft-test-shares-ledger.mjs` (pure) builds a ledger from a given member list.
    - It refuses a non-Final pool, a loser nation, zero or oversized points, duplicates, and a member with neither or both of asset and wallet.
    - It is labelled "not derived from achievements; not a prize allocation".
    - It has no achievement lines and decides no product weight.
  - `scripts/prize-nft-test-shares.mjs` (CLI) posts the root with the operator's **real** SetShares, only on loopback, for the right run and pool, and only with the pool's operator key.
  - Tests 3/3: the page reads each pass's share, and the proof reaches the root, checked with an independent sha256.
  - **Achievements → points stays unproven** by this route, and every record says so.

## 10. Time boundary (designed before any world)

The game's CloseCitizen is allowed only when the chain clock reaches `bell_start(genesis, end_bell) + 72 h`
(`END_GRACE_SECS`; `TooEarly` before; `proc/map.rs season_end_close`). The localnet clock can be compressed
with `frontier_setScale` (0 < scale ≤ 100,000). 72 h at ×30 is 2.4 h of wall time: too long to leave running
unplanned.

Plan (all times compressed and labelled so; never called natural or live time):

1. Play the short finite season at the world's normal test scale. Keep the season short; at most ×30 while
   the keeper drives bells.
2. After Ended: Tally, Finalize, the TEST ONLY SetShares, RecordResidentNation for P2, and every claim that
   needs only the Ended state. None of these needs the 72 h.
3. Only for CloseCitizen:
   - Stop or hold the keeper (no bells to drive after the end).
   - Raise the scale for a bounded window (e.g. ×3,600: 72 h ≈ 72 s of wall time).
   - Send CloseCitizen once `TooEarly` no longer answers.
   - Set the scale back down.
   - Then P2's claim after close.

   This window is recorded with its scale and slots. If the herald/relay misbehave at that scale, the step stops and is reported; it is not forced.
4. **Wall-time limit for the whole world:** at most 45 minutes (main's TTL practice). Past that, stop
   and clean up even if not finished, and record what was not reached.
5. If the window cannot be held safely, CloseCitizen stays at the stand-in level (LiteSVM test 5) and is
   recorded as unproven on a real world. The time rule is not touched.

## 11. Which world: finding and decision memo (2026-11-15, read-only survey)

⑳'s answers: binaries confirmed (`515541c8`, `947da0b9`, stable); its `svm-core/core.rs` is stale; it agreed to
a TEST ONLY `--nft-prize-test-only` stack patch prepared by ⑰ for its review (path + hash first) and to the
tamper fixture under that flag only; NFT-lane pin `0227dbe1` (`404633c8` is the conquest candidate 0xC804);
port base **`claude/nft-candidate-world-r21-20261115` @ `578389cd`** (⑰'s port worktree:
`/Users/r0ze/Projects/wylls-nft-prize-on-world-20261115`, branch `claude/nft-prize-on-world-r21-20261115`). ⑳'s
files there: controller.mjs (localCandidate, loadNfts/loadLocalNfts, residentGenerationNow, actOnce's resident
lines, nft-login, CANDIDATE_NFT_ACTIONS), join.mjs (renderNfts, renderLocalCandidateNfts), holding.mjs,
fresident.mjs, flocalresident.mjs, flocalplay-act.mjs / local-play-act.mjs (resident parts),
local-play-nft-resident.mjs; adoptResident shared.

**Finding.** On `578389cd`, `frontier-stack` has **no** `--nft-pass` (`e2b522fc` lives only on the
nft-pass-mint branch). ⑳'s candidate world is the **local-play launcher + `itest` runner**
(`localnet-expedition-play`, conquest preset, candidate 0xC804, mint page). Its season is finite (the runner
writes an end bell; conquest block `continuous` = 0; ceiling 0), so a pool would not hit `ContinuousSeason`.
But local play has **no prize integration**:
- `local-play-relay.mjs` (365 lines) serves no `/f/prize` route;
- the launcher and runner deploy no prize program and call no InitPool;
- the page's prize panel reads `/f/prize`.

**Two paths (owner/⑳ to choose; no code written in ⑳'s areas yet):**
- **P1, frontier-stack world (nft-pass-mint branch):** finite S1 season, the frontier relay's prize routes
  (already on ⑰'s branch), the stack's prize module. Needs the TEST ONLY flag patch to ⑳'s `--nft-pass`
  stack code, plus one stack host rebuild. Its page is the older frontier play page, not the latest local-play
  candidate page.
- **P2, local-play candidate world (r21):** the latest page, as the user prefers. Needs new implementation:
  - the runner or launcher deploys the TEST ONLY prize `.so` and sends InitPool with the world's season
    authority (the candidate seed in the world dir), under a test-only option;
  - local-play relay prize routes: the pool and pass view, and the claim through the local-play submit path;
  - the page's prize panel wired into local play;
  - tamper is not available as-is, since the runner's localnet is in-process. The fixture Entry would need a
    runner option.

  P2 touches ⑳-owned files (launcher, runner, relay, page) and needs host builds.

**Recommendation:** P2 matches the user's direction (latest candidate page, no old relay/page). It is a
multi-step implementation in ⑳'s areas, so: agree the file split with ⑳ first (⑰ takes the prize-specific
modules: a new `local-play-prize.mjs` relay module and the page's prize panel wiring; ⑳ owns the runner,
launcher and resident hooks), then build in this order: relay module + pure tests → page wiring + fixture
browser test → runner/launcher test-only prize option (⑳ or with ⑳'s review) → host build slot → world.
P1 remains a fallback if P2's runner change is not agreed.

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

## 12. P2 agreed; the port started (2026-11-15)

⑳ chose **P2** (latest candidate world). Split: ⑰ writes `local-play-prize.mjs`, the page's local-play prize
wiring and their tests, **and** the TEST ONLY runner/launcher option (deploy the TEST ONLY prize `.so`, InitPool with
the season authority, the fixture Entry) for ⑳'s review. That option sits behind an explicit TEST ONLY flag, only
with `--lane-candidate`; default runs stay byte-identical; `Lane` / `CandidateOptions` / `launch_lane` keep their
existing behaviour. Base: ⑳'s world branch **`e50b3cc0`** (it now carries the herald's local-play bootstrap and
the candidate exact pair; ⑳'s herald tests 10/10, binary built).

Port branch **`claude/nft-prize-on-world-r21-20261115`** (worktree `/Users/r0ze/Projects/wylls-nft-prize-on-world-20261115`):
- `5ae0667b`: the prize JS (SDK + web copy, relay prize route, view and claim-outcome helpers, settlement,
  TEST ONLY tools, the page's prize model, panel and texts) applied onto `e50b3cc0` with `--3way`, all clean,
  **none of ⑳'s files**. Pure tests on that base: **25/25**.
- `2e40b157`: the proposal for ⑳'s two files, as a patch only (`CLAUDE-NFT-PRIZE-PORT-20-FILES-PROPOSAL-20261115.patch`,
  sha256 `1d8924297284331c…`); not applied. In `controller.mjs` two conflicts are resolved by keeping ⑳'s code
  (the local-play send with its resident hook; the whole `localCandidate` nft-login block) and adding the prize
  side only on the non-local path. In `join.mjs` only `renderNfts` changes; `renderLocalCandidateNfts` is untouched.
  Sent to ⑳ with base blob → proposed sha256 for each.

Next (new files only): `local-play-prize.mjs` (the pool and pass view; ClaimResident prepare → submit in the local-play
style) with pure tests, then the mount line and the runner/launcher option, each after path + hash to ⑳.

## 13. Review fix to the local-play prize relay; runner proposal; ports (2026-11-15)

On the port branch `claude/nft-prize-on-world-r21-20261115`:
- **`83288f69` (review fix).** Same asset, generation and blockhash give the same digest, and `prepare` used to
  reset that ticket, so a sent or in-flight message could be submitted again.
  - Now there is one ticket per digest, never reset: an open ticket returns the same ticket; a reserved, used,
    unknown or expired one is refused, with its signature.
  - Reused from `local-play-relay.mjs`:
    - `fetchRpc`: no redirect, a timeout, a bounded body. Its `{result}` / `{error}` answers are unwrapped
      explicitly; an error or a missing result is a refusal.
    - `singleSigned`, `OPEN_TTL_MS`, `MAX_HISTORY`.
    - The synchronous reservation, and the height read before sending.
    - The signature recorded before sending and kept on an unknown or refused send.
    - Sent tickets are never dropped.
    - Status is strict and pinned to the runner instance.
  - Tests: key-free 7/7 (including `{error}` handling and the real `fetchRpc` with `redirect: 'error'`).
  - **Key-using** `local-play-prize-signed.test.mjs` 6/6: one throwaway in-memory Ed25519 key, in the user's
    scope for this verification, against a mocked loopback RPC. Cases: success, concurrent submits (one send),
    re-prepare while held / after / after unknown, the signature kept on unknown, a refused send, height expiry,
    the reservation given back, and a replaced runner.
  - **Negative control:** with the old reset, 2 of the 6 fail. The key-using file must be listed in
    `scripts/ci/node-key-tests.txt` by the integrator; it is not edited here.
- **`8cbc8d04`:** the TEST ONLY runner/launcher prize option as a proposal
  (`CLAUDE-NFT-PRIZE-RUNNER-OPTION-PROPOSAL-20261115.md`, sha256 `af82b167…`). No code in ⑳'s files changed.
- **Ports:** 42100 was outside the launcher's allowed 41000–41999 band (⑳'s correction; the band is not
  widened). Proposed **41100–41199**; asked main to confirm.
- Still not applied: ⑳'s `controller.mjs` / `join.mjs` (the proposal patch `1d892429…` waits for ⑳'s review).

## 14. Second review round on the local-play prize relay; runner review; ports confirmed (2026-11-15)

Port branch `4c23c545`. Review fixes before any mount:
1. **History race.** After the await on the height read (full history), the digest is checked again and the insert is
   synchronous; a concurrent prepare of the same message can no longer overwrite a ticket the first one created and sent.
2. **Config snapshot.** The validated configuration is a frozen copy of primitives, and the default `fetchRpc` client
   closes over its URL. A later change to the caller's object redirects nothing.
3. **Runner pinned before prepare and send.** A required `runId`, the localnet run id (16 bytes, 32 hex), must be named
   by `frontier_status` before a message is built and again before it is sent. On a mismatch nothing is sent and the
   ticket is invalidated for good.

Tests: key-free 9/9, key-using 8/8 (one in-memory throwaway key, mocked loopback RPC). **Negative controls:** each fix
removed in turn fails exactly its own test. ⑳'s local-candidate login and card tests are 10/10 with the patch (run
without the no-keys guard, since the login test makes the page's key). The prize set is 38/38.
Kept own module instead of ⑳'s `createLocalPlayRelay` `flow`: that relay's config is pinned to the 0x45 Depart program;
both options were acceptable to the reviewer as long as the three conditions hold.

**CI key-test list:** `scan-node-key-tests.mjs` stops on 10 pre-existing stale reviews before writing anything, so the
list cannot be regenerated now. A one-line hand addition for `local-play-prize-signed.test.mjs` is proposed to ⑳, the
list's last editor on that branch, and is not written yet.

**⑳'s runner-option review (af82b167):** shape accepted with conditions:
- the Season authority change under the flag only, with a test that it is unchanged without the flag;
- `allow_tamper` only after deploys and InitPool, stated as `prize_test_only.tamper: true`, and the driver writes only
  prize-owned accounts;
- `[0x50; 32]` asserted distinct from `[0x45]`, `[0x4C]` and `[0x4E]`;
- the launcher refuses the flag without `--lane-candidate` and refuses an unrequested prize line;
- the default first line stays byte-identical, with a test;
- nothing is mounted before mutual review.

**Ports:** main confirmed **41100–41199** (avoid 41904–41907). Current bands: ⑳ 41920 / 41980–41989 / 41996; main
41940 / 41944–41953 / 41961. A world of mine needs its slot and space agreed with main first.

### 14.1 Runner instance pinned too (2026-11-15, port branch `09a21ae4`)

The localnet keeps its `runId` across a WAL reopen or restore (`chain.rs`), and only `status_instance` changes, so `runId`
alone cannot detect a restarted or rewound world (review finding).
- Before a message is built and again before it is sent, the relay now checks **both** the `frontier_status` `runId`
  and the status context's `instance` (`getSignatureStatuses([])`, which the server accepts).
- `cfg.runnerInstance` (64 hex) is required and part of the frozen snapshot. Missing or malformed fails closed. A
  mismatch sends nothing and spends the ticket.

Tests: key-free 10/10, key-using 9/9. **Negative control:** with the run-id-only check, exactly the two new restart
tests fail. Prize set 39/39; key-using plus ⑳'s login/card tests 19/19.

**Boundary, recorded, not claimed:** separate RPC calls lie between the identity check and `sendTransaction`. A runner
swapped in exactly that window is not excluded by this relay; the program's own on-chain checks still apply.
Mount stays on hold until mutual review with ⑳.

## 15. CI key-test line, launcher option, runner fixture choice (2026-11-15)

Port branch:
- **`5193b77a`, CI.** One line for ⑰'s key-using `local-play-prize-signed.test.mjs` in `scripts/ci/node-key-tests.txt`,
  at the exact position the scanner itself writes. That was checked with a temporary scanner copy that skips only its
  stale-review stop; the copy was deleted.
  - The 10 stale reviews are untouched. `scan --check` exits 5 on them on ⑳'s base and here alike, so the key-free CI
    job cannot pass on either branch for that pre-existing reason.
  - The scanner (stale stop skipped) also shows large pre-existing drift on the base list: conservative closure
    exclusions for many tests, including ⑰'s key-free prize tests, and ⑳'s login entry's section. That is left to the
    list's owner. ⑳: OK.
- **`8270a589`, launcher.** `--prize-test-only-so`, only with `--lane-candidate`, absolute and existing, and passed to
  the runner only when asked.
  - A separate first-line check `prizeTestOnlyMetaAgrees`: an unasked key is refused; an asked one must be
    `[0x50; 32]` = `6QWeT6Fp…`, distinct from 0x45/0x4C/0x4E, with pool, mint and vault.
  - `candidateMetaAgrees` is unchanged. Tests 3/3. ⑳'s launcher tests give 67/70 with and without the change, the
    same 3 failing.
- **Runner fixture: ⑳ chose (A).** One exact stdin control line per run, under the flag only (no reader otherwise; a
  byte-identical run).
  - The runner checks the asset is a Core asset of the policy's collection, the Entry address is the prize program's
    derivation, and nothing exists there yet.
  - It writes only that Entry, plus the named vault tokens if part of the fixture, with its own `Chain::set_account`.
  - MEMORY_ONLY and `tamper_rpc: false` stay unchanged.
  - The confirmation line and the first line say TEST ONLY fixture (not a deposit).
  - (B), a shared localnet change, is avoided. Rust is not compiled until a host build slot is agreed.
- **⑳'s head moved to `13ac8f63`.** It adds a candidate-only nft-transfer action, and world-relay TransferResident is
  now default deny. The controller/join patch must be regenerated after merging it into the port branch (merge, no
  force push). The E2E's transfers go through the mint page.

## 16. Merge of ⑳'s head, option (A) spec for review, 0x51 boundary, page local claim (2026-11-15)

Port branch:
- **`e68949fc`:** ⑳'s `13ac8f63` merged in (a merge, no force push).
  - The controller/join patch was regenerated as `git diff 13ac8f63..HEAD` (+190/−7, sha256 `8627a536…`) and sent to ⑳.
  - After the merge: ⑳'s login/card tests plus ⑰'s signed test 23/23; the prize and launcher set 42/42.
- **`80d007cc`:** the exact **option (A)** fixture specification, for review only, not implemented:
  - under `--prize-test-only-so` only, with no stdin reader otherwise and a byte-identical run;
  - one exact stdin line `{asset, paid_by, pay_generation}`, with the Entry address derived by the runner;
  - pool, asset, guard and resident-record checks; `pay_generation` must equal the record's current generation and
    `paid_by` the asset's current owner; the Entry address must be absent;
  - writes the Entry only (no vault tokens), with its own `Chain::set_account`;
  - MEMORY_ONLY and `tamper_rpc: false` unchanged; no wallet, key, arbitrary account or RPC write.

  Rust only after ⑳ and the user agree, and a host build slot.
- **⑳'s 0x51 ABA boundary:** `TransferResident` signs no generation, so a pre-A→B→A signed transfer can be replayed
  within its blockhash lifetime, and the direct chain path is not closable by a relay. The page's transfer is held in
  worlds. ⑰'s claim binds the signed generation, but **re-transfer is recorded as not proven safe**, and the E2E's
  mint-page transfers carry that boundary.
- **`1b7cb922`:** the page's local-play claim in `fprize.mjs` (⑰'s file).
  - `loadPrizeLocal` (`/f/local-play/prize`).
  - `claimPassLocal`: prepare → the wallet signs exactly that message → one submit. Outcomes follow `claimPass`'s
    rules: notSent only before the submit; `already` / AlreadyClaimedByPriorOwner; unknown keeps the signature.
  - Tests 5/5. Not wired into `controller.mjs` yet; that is a patch to ⑳ with the mount step.

Totals on the port branch: key-free prize and launcher 47/47; signed plus ⑳'s login/card 23/23.

## 17. Correction: re-transfer waits for ⑳'s strict resident variant (supervisor, 2026-11-15 03:35)

**Correction of §15 and §16:** "the E2E's transfers go through the mint page" was wrong as a plan. The world relay's
TransferResident is default deny, and routing transfers through the mint page to get around that is **not** allowed.
A→B→A safety is **unresolved on chain** (0x51 signs no generation).

New rule for the E2E:
- **Positive re-transfer steps** (A→B, A→B→A: the old owner refused, the new owner claims) are integrated only after
  ⑳'s **TEST ONLY strict resident variant** has been verified (generation signed, old 0x51 refused), with its artefact
  hash and instruction version pinned. ⑳ is implementing it now; it is unverified.
- Any step that uses the **old 0x51 path** is an **isolated TEST ONLY negative only** (showing the gap), never a
  positive result, and labelled so in the transcript.
- Until then, the E2E's claim path is exercised **without** a re-transfer: the original holder's claim, and the
  claimed / double-claim refusal. The re-transfer stories stay at the LiteSVM level (7/7, real resident program,
  labelled with the 0x51 boundary).

## 18. Option (A) agreed; controller wiring (2026-11-15)

- **⑳ reviewed and OK'd the option (A) specification** (`fef99647…`, port branch `57720414`), including its three
  additions and ⑰'s four tightenings:
  - the launcher reads the asset and owner first (page or mint wallet only);
  - per-check reason codes, with the account set unchanged after every refusal;
  - synthetic funding only;
  - run_id and instance in the line;
  - one shot;
  - memory-only and `tamper_rpc: false` asserted, with RPC setAccount refused;
  - the changed set exactly {the Entry}.

  The Rust goes into a new `itest/src/prize_test_only.rs` with small hooks. Host build slot requested from main and ⑳
  (`cargo test -p itest --features localnet-conquest-play --lib --bins`, est. ~3 GB, unchanged guard) for after ⑳'s
  world 5 and resident proof.
- **`82346ff8`:** the local-play prize wired into `controller.mjs`, only when `localCandidate()`:
  - `refreshPrize` → `loadPrizeLocal` / `loadLedgerLocal`;
  - `claimPass` → ⑳'s `residentGenerationNow` + `claimPassLocal`, a sent claim recorded as pending until the Entry reads
    claimed, never resent.

  Tests: prize set 48/48; ⑳'s controller 19/19 with and without; signed plus login/card 23/23. The ⑳-file patch was
  regenerated (`git diff 13ac8f63..82346ff8`, +199/−8, sha256 `e981a6a9…`). It stays on the port branch until the
  final review.
- Re-transfer stays gated on ⑳'s strict resident variant (§17).

## 19. Option (A) Rust started — source only, not compiled (2026-11-15)

Main OK'd in principle the later host build slot (`cargo test -p itest --features localnet-conquest-play --lib --bins`,
after ⑳'s world 5 and resident proof, one at a time, guard unchanged, target deleted after, re-asked with the order and
df first).

Port branch **`7733b533`**: new `frontier-node/crates/itest/src/prize_test_only.rs` (sha256 `634c7eb86a1c1490…`), gated
like `expedition_play`, plus one gated line in `itest/src/lib.rs`:
- `parse_line`: the exact 5-key control line;
- `OneShot`: the first line closes the channel whatever its outcome;
- `place()`: checks with reason codes (run, pool, asset via the game's policy and `resident_auth::holder`, guard,
  record, generation, paid_by, entry_exists), then the one Entry with `Chain::set_account` and synthetic lamports;
- TEST ONLY confirmation and refusal lines.

**Not compiled, not run.** Unit tests in the module cover parse, one shot and the constants.

Still to write before asking for the build:
- `place()` negative tests over a built fixture: Core asset bytes, policy, resident record;
- the deploy and InitPool step;
- the `--prize-test-only-so` hook in `Options`;
- the stdin reader in the binary, and the first-line keys.

rustfmt-clean (the `lib.rs` rustfmt differences are pre-existing in other modules, as on the base).

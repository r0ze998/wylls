# ⑰ Prize in a continuous world: settlement windows (test USDC, local and devnet only)

Japanese: [X402-PRIZE-EPOCHS.ja.md](X402-PRIZE-EPOCHS.ja.md).

**Status (2026-11-18).** The owner reopened ⑰ on 2026-11-18 at 18:26 JST. This decision supersedes the 14:42 decision "A: no
prize" and the closure note of PR #37. It covers **devnet and local only, with test USDC only**. There is no mainnet and
no real-money USDC. **A real-money prize on mainnet needs a legal review first.** In Japan, collecting entry fees and
paying winners may fall under gambling, premium (景品) or payment-services rules. Nothing here has been deployed. No
SOL was spent and no key was used.

## 1. The problem

The prize program (`permutation-prize`) has exactly one exit for deposits: the game's Season reaches **Ended**, then
someone runs Tally and Finalize, and then SetShares, Claim and WithdrawOps open. A continuous world never ends. The
stack refuses the legacy pool in such a world (`frontier-node/crates/stack/src/config.rs`, `check()`), and so does the
program (`InitPool` → `ContinuousSeason`, `permutation-prize/src/lib.rs` `season_ends`). Without that refusal, every
fee would stay in the vault for good (`X402-PRIZE-CONTINUITY.ja.md` D2, on `origin/preserve/ws17-0c80381d`).

## 2. The design: one pool per settlement window

The design is behind the cargo feature **`epochs`** of `permutation-prize`, which is OFF by default. The default
`.so` has none of the new instructions: it carries no `PRZ_EPOCHS_TEST_USDC_BUILD` marker, and
`scripts/build-prize.sh` checks that.

| | Legacy pool (unchanged) | Epoch pool (new, feature `epochs`) |
|---|---|---|
| PDA | `["pool", game, le64(season)]` | `["epool", game, le64(season), le32(epoch)]` |
| Opens | `InitPool`, finite world only | `InitEpochPool(epoch, end_bell, claim_bells, fee, ops_bps, params_hash)`, continuous world only (`FiniteSeason` otherwise), while `end_bell` is still in the future |
| Fees | until the first Tally | until `genesis_ts + end_bell × bell_secs` (`EpochClosed`) |
| "The end" | Season Ended | the window's `end_bell` (time-based) |
| Count | `Tally` | `EpochTally`: anyone may send it, only after the window's time (`WindowOpen`), any number of transactions |
| Winner | most provinces; a tie is broken by territory bells | most provinces; **a tie is shared equally** (decided by r0ze 21:44, t353u) |
| Shares, claims, operator's part | SetShares, Claim, WithdrawOps, RecordNation | the same instructions, unchanged (signed with the epoch pool's seeds) |
| Unclaimed rest | stays in the vault | `Sweep` (anyone, after `claim_bells` past EpochFinalize) moves it into a **later** window's pool that still takes fees (decided by r0ze 21:44, t353u) |

The account layout is the legacy pool's 640 bytes with the same magic. Bytes 600–640 hold the window: `EPOCH`,
`EPOCH_BELL_SECS`, `EPOCH_GENESIS_TS`, `CLAIM_BELLS`, `KIND` (0 legacy, 1 epoch), `DEADLINE_TS` and `ROLLED_OUT`. These
bytes are zero in every legacy pool. The legacy decoders (`decodePool`, `prize-settle.mjs`) still read an epoch pool.

The numbers are the owner's defaults, unchanged: **25 test USDC per entry, 80% to the prize, 20% to the operator**
(`--entry-fee 25000000`, `--prize-ops-bps 2000`). Defaults that are not owner decisions:

- a window is **2,016 bells**, which is 14 days at 600 s, the owner's season length Y6 (note of 2026-11-24: seasons were
  abolished on 2026-11-23 and Y6 is superseded; the default stays in the code but no longer matches anything. The
  window pools are planned to be replaced by pools of the permanent world goals, which are not built:
  [design 01](../../design/win-conditions/01-proposal.ja.md) §10.1 and §13 B4, Japanese);
- the claim window is **1,008 bells** (7 days).

### 2.1 The snapshot without a freeze

The legacy tally relies on a freeze: no bell at or after `end_bell` is ever resolved. A continuous world keeps
resolving bells, so a keep can change holder before EpochTally reads it.

The game writes `since_bell = b + 1` when it captures a keep in bell `b` (`permutation-rules/src/frontier/keep.rs`,
`k.since_bell = b.saturating_add(1)`). EpochTally takes a Province only after every bell before `end_bell` is resolved
(`resolved_next ≥ end_bell`, else `ProvinceNotFinal`). For such a Province:

- if `since_bell ≤ end_bell`, the current holder is the holder at the end, and the province counts for that nation;
- if `since_bell > end_bell`, the keep was taken after the window closed and before the tally. It counts for nobody.
  This is **provisional**: `VOID_AFTER_CLOSE` in `permutation-prize/src/epoch.rs` `provisional::RULES`. A crank that
  tallies within a bell of the close makes this case rare;
- if `opened_bell ≥ end_bell`, the province was not on the map at the end. It is counted, with no area.

EpochFinalize needs the game's own count, as the legacy Finalize does: the six ProvinceFunds' `provinces_opened`, less
the 7 keepless provinces of rings 0–1. A province opened later must be counted before the window can finalise.

### 2.2 Wiring (local build only, OFF by default)

- **Program:** `scripts/build-prize.sh --features epochs` writes
  `permutation-prize/target/deploy-epochs/permutation_prize.so`. The default build behaves as before (the legacy
  LiteSVM suite passes unchanged against it), but it is not byte-identical: the shared pool-signer code and shifted
  panic line numbers change its hash. Both builds put a
  text placeholder where `cargo-build-sbf` would write a program keypair, so the build is key-free.
- **Stack:** `frontier-stack up --conquest --continuous --prize-so <epochs .so> --prize-epochs [--prize-epoch-bells N]
  [--prize-claim-bells N]`. The stack refuses `--prize-epochs` without `--continuous` and `--prize-so`. It also refuses
  a `.so` without the epochs marker, and a continuous world with `--prize-so` but without `--prize-epochs` (the legacy
  refusal stays). The season setup (`setup::continuous_world_guard`) lets a continuous world carry a join gate only for
  the epoch pools; a season end stays refused. The stack opens window 0 (bells 0 to N) and passes `--prize-epoch 0` to
  the relay.
- **Relay:** `--prize-epoch N` makes `/f/prize` (with a `window` field) and `/f/x402/join` (with `extra.epoch`) use the
  epoch pool, and the SDK's `joinViaX402` derives that window's pool and vault from `extra.epoch` before signing. The relay refuses this flag on
  any cluster other than `localnet` or `devnet`, and with Circle's mainnet USDC mint
  (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- **Devnet dry run:** `scripts/devnet/devnet-profile.json` has a `prize` section with `enabled: false`, a test-mint
  placeholder and a refused list holding the mainnet USDC mint. `node scripts/devnet/dry-run.mjs --with-prize` checks
  the epochs `.so` and adds its deploy and per-window rent to the plan. **It never sends the prize program**: the only
  send steps are the game program's.
- **No mainnet profile sets any of these.** None exists in the tree. The relay and the dry run refuse mainnet by
  cluster and by mint.

## 3. Comparison with open-source settlement designs

| Approach | Where (read 2026-11-18) | How money leaves | Fit for Wylls |
|---|---|---|---|
| **Per-epoch distribution account, merkle root, expiry** | [jito-foundation/jito-programs](https://github.com/jito-foundation/jito-programs) `mev-programs/programs/tip-distribution/src/lib.rs` @ `ce1dfb6b`: one TipDistributionAccount per epoch; `upload_merkle_root` by an authority; `claim` with a proof until `expires_at = epoch_created_at + num_epochs_valid`; then `close_tip_distribution_account` sends the rest to an `expired_funds_account` | Claims, then the expired rest to a configured account | **Closest.** Wylls's SetShares/Claim already is a merkle root plus proofs. The epoch pool adds Jito's two missing parts: a per-period account and an expiry with a sweep. The difference: Jito's leftovers go to a fixed account (the validator), while Wylls rolls them into the next window, so the operator gains nothing from unclaimed prizes |
| **Merkle distributor with clawback** | [jito-foundation/distributor](https://github.com/jito-foundation/distributor) `programs/merkle-distributor/src/instructions/clawback.rs` @ `2cf79f63`: after `clawback_start_ts`, anyone can move the rest to `clawback_receiver` | Claims, then clawback to one receiver | Same shape for one distribution. No periods of its own: a Wylls window would need one distributor each, plus a separate fee vault |
| **Periodic draws with a rolling reserve** | [GenerationSoftware/pt-v5-prize-pool](https://github.com/GenerationSoftware/pt-v5-prize-pool) `src/PrizePool.sol` @ `fedd70f3` (EVM, PoolTogether v5): `drawPeriodSeconds`, `awardDraw` only after the draw closes (`AwardingDrawNotClosed`), contributions accumulate per draw, a `_reserve` carries funds forward | Prizes per draw; what is not won stays in the pool for later draws | The **rollover** idea comes from here: an unclaimed prize stays with the players instead of going to the operator. The randomness, the TWAB odds and the vault shares do not fit: Wylls's winner is decided by the board, not by a draw |
| Streaming payouts (for example [streamflow-finance/rust-sdk](https://github.com/streamflow-finance/rust-sdk)) | token streams with a linear unlock | continuously, to a named recipient | Not a fit: the winner is unknown until the window closes. Streaming a known prize to the winners would be a later add-on on top of Claim, not a settlement |

The choice is **Jito-style per-epoch accounts with an expiry, plus a PoolTogether-style rollover**. It is the smallest
change: four new instructions, and none of the shares, claim or operator code changes.

## 4. Tests

- **Program, host:** `cd permutation-prize && cargo test --features epochs` (9 tests, 3 of them new: the Pay close,
  the account tail, the continuous-season check) and `cargo test` (6, the default build).
- **Program, LiteSVM** (`scripts/build-prize.sh --features epochs` first):
  `cd permutation-prize/svm-tests && cargo test --release --test epoch` (13, the last three being the pre-funding tests; round 3 added the operator-member refusal,
  the per-window entry and the ring-17 limit). These cover the full cycle across two
  windows, the snapshot rule, a tie, refund mode, InitEpochPool's guards, Sweep's guards and the default build refusing
  the epoch tags. A path given in `PRIZE_EPOCH_SO` must exist (CI's key-tests job names it); with the default path
  missing the tests print SKIP and pass. `--test pool` (15, the
  legacy suite) passes against both the default and the epochs build.
- **Stack:** `cd frontier-node && cargo test -p stack --lib` (102, new: `prize_epochs_need_a_continuous_world`,
  `epoch_pools_match_the_program`).
- **Relay and SDK:** `node --test permutation-gateway/test/frontier-prize-epochs.test.mjs` (4). The key-test scan
  classifies this file as a key test, like `frontier-prize.test.mjs`, so push CI does not run it.
- **Devnet dry run:** `node --test scripts/devnet/test/dry-run.test.mjs` (35, 6 of them new).

- **Live play-through (round 2, 2026-11-18, local only):** `frontier-stack up --conquest --continuous --prize-so <epochs
  .so> --prize-epochs --prize-epoch-bells 20 --prize-claim-bells 4` opened window 0 on an in-process localnet. In a
  Playwright browser, one player went Dev Wallet → "Get test USDC" → Join. The paid x402 join landed in the epoch pool:
  1 entry, 25 collected, 20 to the prize, 5 to the operator (test USDC). The join screen named the window's end turn.
  After bell 20, a second player's paid join was refused (`EpochClosed`), and the page said "This prize window no longer
  takes entry fees". Evidence: `~/Projects/wylls-grok-state/evidence/ws17-prize/round2/`.

Not run: EpochTally, EpochFinalize, SetShares, Claim and Sweep on a live localnet (no crank tool yet; LiteSVM covers
them), and anything on devnet.

## 5. Owner decisions (r0ze, 2026-11-18 21:44 JST, t353u: "keep the current defaults")

| # | Question | Decision | Where the code enforces it | Test |
|---|---|---|---|---|
| 1 | Entry per window, or once per world? | **Decided by r0ze 21:44 (t353u): an entry is per window.** | Entry PDA `["entry", pool, wallet]`; Claim needs this pool's Entry | LiteSVM `an_entry_counts_for_its_own_window_only` |
| 3 | A keep taken after the close and before the tally | Not in the decision. The code counts it for nobody, and it stays provisional (`epoch::provisional::VOID_AFTER_CLOSE`) | `epoch_tally` | `keeps_count_as_they_stood_at_the_end_bell` |
| 4 | A tie for first place | **Decided by r0ze 21:44 (t353u): a tie is shared equally.** | `epoch_finalize` → `largest_area` | `a_tie_is_shared_and_a_grown_map_is_counted_whole` |
| 5 | The unclaimed rest | **Decided by r0ze 21:44 (t353u): it rolls into the next window.** The operator's part is untouched | `sweep` | `an_epoch_pays_out_and_rolls_the_rest_into_the_next`, `sweep_guards` |
| 7 | The infinite map (⑭) | **Decided by r0ze 21:44 (t353u): the prize covers maps of ring ≤ 17 only.** | `init_epoch_pool` → `season_rings_fit` (`CeilingPastTally`, `BadParams`) | `epoch_pools_refuse_maps_past_ring_17` |
| 8 | AI residents in money windows (⑤ W4, Q17) | **Decided by r0ze 21:44 (t353u): no AI residents in paid periods.** See §5.1 | on chain: ExcludeWallet, plus Pay and Claim → `OperatorMember`; relay `markOperatorMember`; launcher `AiResidentsInPaidWindow` | `operator_members_cannot_pay_or_claim_in_a_paid_window`, the gateway test "epoch world: an invite join is marked…", the launcher test |
| — | Scope | **Decided: devnet/local test USDC only; mainnet needs a legal review.** | relay `--prize-epoch` (localnet/devnet, mainnet USDC refused), devnet dry run (plan only) | `frontier-prize-epochs.test.mjs`, dry-run tests |
| 2 | Paid joining between windows (no tool opens the next window yet) | Open (not in the decision) | — | live round 2: `EpochClosed` |
| 6 | Window length | Not in the decision; the default is 2,016 bells (14 days, Y6) | `--prize-epoch-bells` | config tests |
| 9 | ⑮ | Unchanged: achievements stay titles and chronicle entries | — | — |

### 5.1 "No AI residents in paid periods": how it is enforced, and its limit

- **On chain (cannot be bypassed by a resident).** Operator-run residents join a gated season by operator invite. These
  are ⑤A operator AI residents, the stack's script bots and the AI fleet, and the join needs the season's **join-gate**
  key. That same key is the only signer of **ExcludeWallet** (tag 12). ExcludeWallet creates
  `["noprize", game, le64(season), wallet]`, an idempotent and permanent mark. An epoch pool's **Pay** and **Claim**
  must name that address, and refuse a wallet that has the mark (`OperatorMember`, 0x117). Leaving the account out is
  refused (`NotEnoughAccountKeys`), and so is naming another wallet's address (`BadAccount`). A wallet that paid
  before it was marked cannot claim.
  **Pre-funding does not dodge the mark** (round 4, verify-pr54 D-9). Anyone can send lamports to any address, the mark's
  included. The program's account creation now takes over a pre-funded address the standard way: it tops up the
  rent, then calls Allocate and Assign under the PDA's signature. So the gate can always write the mark. Only an
  account owned by the prize program with the `WYPRNOPZ` magic counts as a mark. Lamports a griefer sends to a
  human's address are no mark and do not block the human. The same fix stops anyone from blocking the next window's
  pool, its vault or a player's Entry by pre-funding them (D-10).
- **Relay.** In an epoch-pool world, `POST /f/join` with an invite first sends ExcludeWallet for the joining wallet,
  signed by the gate key. It co-signs the Join only after that mark has landed. If the mark fails, the join is refused.
  The relay counts a mark as present only when the account is owned by the prize program and carries the `WYPRNOPZ`
  magic; anything else at the address is marked over. It re-reads the account after sending and refuses the join
  with `MarkFailed` if no real mark is there.
  A human's paid x402 join is unaffected.
- **Launcher.** `local-play-launcher.mjs` has no prize lane. It refuses `--prize-epochs` (`PrizeNotInLauncher`). Combined
  with `--operator-residents` (⑤A, PR #40) or `--external-residents` (⑤B, PR #57), it refuses with
  `AiResidentsInPaidWindow`.
- **Limit (⑤B and any outside AI).** The chain cannot tell an AI from a person. A ⑤B external resident (PR #57) has its
  own wallet and joins like a person: with the paid x402 join in a gated world, or as an admitted address in the
  launcher. So the on-chain rule binds **operator-run** residents, the ones that join by operator invite. An outside
  AI that pays like a person cannot be detected. In the stack, nothing admits ⑤B agents. In the launcher, there are no
  paid windows, and ⑤B with `--prize-epochs` is refused. If ⑤B admission ever reaches a paid-window world, the
  admitting tool must call ExcludeWallet for each admitted address: it knows them, and the gate key is the operator's.

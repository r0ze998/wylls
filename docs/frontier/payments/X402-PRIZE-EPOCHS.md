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
| Winner | most provinces; a tie is broken by territory bells | most provinces; **a tie is shared equally** (provisional) |
| Shares, claims, operator's part | SetShares, Claim, WithdrawOps, RecordNation | the same instructions, unchanged (signed with the epoch pool's seeds) |
| Unclaimed rest | stays in the vault | `Sweep` (anyone, after `claim_bells` past EpochFinalize) moves it into a **later** window's pool that still takes fees (provisional) |

The account layout is the legacy pool's 640 bytes with the same magic. Bytes 600–640 hold the window: `EPOCH`,
`EPOCH_BELL_SECS`, `EPOCH_GENESIS_TS`, `CLAIM_BELLS`, `KIND` (0 legacy, 1 epoch), `DEADLINE_TS` and `ROLLED_OUT`. These
bytes are zero in every legacy pool. The legacy decoders (`decodePool`, `prize-settle.mjs`) still read an epoch pool.

The numbers are the owner's defaults, unchanged: **25 test USDC per entry, 80% to the prize, 20% to the operator**
(`--entry-fee 25000000`, `--prize-ops-bps 2000`). Defaults that are not owner decisions:

- a window is **2,016 bells**, which is 14 days at 600 s, the owner's season length Y6;
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
  `cd permutation-prize/svm-tests && cargo test --release --test epoch` (7). These cover the full cycle across two
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

## 5. Open questions for the owner (the code uses the conservative default)

1. **An entry per window, or one per world?** The code's default is one entry per window: only a wallet with an Entry
   in that window's pool can claim from it. A new player's x402 Pay+Join pays into window 0. A later window has no
   relay route yet, so an existing citizen would send Pay alone.
2. **Does the world stay gated after window 0?** With `--prize-epochs` the season's join gate is set, as with the
   legacy pool. Once window 0 closes, a paid join fails (`EpochClosed`) until the operator opens the next window and
   the relay is pointed at it, and no tool does that yet. The alternative is a free-to-join world where the prize entry
   is opt-in.
3. **A keep taken after the close and before the tally:** count it for nobody (code), or for `last_taken_from`, the
   holder before the last capture (exact only if it changed once)?
4. **A tie for first place:** equal split (code), or the legacy territory-bell tie break? The territory-bell counters
   are cumulative and keep moving in a live world.
5. **The unclaimed rest:** roll it into a later window (code), refund the payers, or give it to the operator? The
   claim window is 1,008 bells by default.
6. **Window length:** 2,016 bells (14 days, from Y6) by default.
7. **The infinite map (⑭):** the tally bitmap covers rings 0–17, so InitEpochPool refuses a season whose
   `r_max_ceiling` is above 17 (`CeilingPastTally`). A prize on an unbounded map needs another count structure.
8. **⑤ W4:** whether AI residents may enter money windows. Today operator AI join by invite, have no Entry and cannot
   claim. This is still open in `GAME-DESIGN.ja.md` Q17.
9. **⑮ is unchanged:** achievements stay titles and chronicle entries with no prize effect. The window winner is still
   the owner's legacy rule: the most provinces at the end.

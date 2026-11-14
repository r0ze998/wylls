# ⑰ NFT prize: TEST ONLY SBF build + LiteSVM runtime tests — design for review (2026-11-15)

**Status: design and source only. Nothing in this document has been built or run.** It is written for
review (user, main, ⑳) before any NFT-enabled SBF build. Branch `claude/nft-prize-connect-20261114`.

## 1. Why, and what it is not

The host tests (`e2e-native/tests/nft_pass_prize.rs`, 10/10 on 2026-11-15) run the prize program as
host code over **stand-ins**: the Core asset and the resident record are written as bytes, and
"TransferResident" is a byte rewrite. `permutation-prize/svm-tests/tests/pool.rs` (15 tests) runs the
real SBF build but only the wallet path.

This adds the missing layer: the **SBF build of the prize program with `nft-experimental`**, run in
LiteSVM next to the **real Metaplex Core binary** and **⑳'s real resident program**, so that the pass's
asset, its guard, the resident record and **TransferResident (generation bump, session clear)** are the
real programs' outputs, not stand-ins.

It is still **not** a chain: LiteSVM in one process, local test keys, no validator, no RPC, no relay,
no page. Passing it is not proof of a real-chain NFT transfer or of the deployed system. What stays a
stand-in is listed in §4.

## 2. Hard boundaries (unchanged by this work)

- `scripts/build-prize.sh` is **not modified**: it still refuses `nft-experimental` (exit 3), a manifest
  default, and an artefact carrying the NFT handlers. The production artefact path
  `permutation-prize/target/deploy/permutation_prize.so` is never written by this work.
- `permutation-prize/Cargo.toml`: `nft-experimental` stays off by default. No feature, dependency or
  profile change.
- The program's refusals stay: tag 8 PayResident → `ResidentDepositsDisabled`; InitPool on a continuous
  world → `ContinuousSeason`; a pass claim in refund mode → `ResidentRefundUndecided`. The tests assert
  them; nothing decides a refund owner or a prize period.
- `svm-tests/Cargo.toml` and `Cargo.lock`: **unchanged** (no `mpl-core` crate; every item used is already
  public in the default build). `pool.rs`: unchanged; its default `PRIZE_SO` (the production path) is
  untouched.
- No real funds, no public mint, no real wallet, no public RPC, no external send. Keys: LiteSVM local
  test keys only (`Keypair::new()` as in `pool.rs`, or `sha256(label)` as in ⑳'s `svm-core`), in memory,
  never written to disk or printed.
- The Core and resident binaries are ⑳'s, **loaded only, never rebuilt**: copied by hash from ⑳'s
  checkout into this session's scratchpad, with ⑳'s OK (2026-11-15). Git-ignored; never published.

## 3. The TEST ONLY build

- **Command**, under `conquest-guard.sh` unchanged (`94baeb7d…`), in a **new dedicated target** in the
  scratchpad (not `permutation-prize/target`), offline/locked:
  `cargo build-sbf --manifest-path permutation-prize/Cargo.toml --features nft-experimental
   --tools-version v1.52 --arch v2 --sbf-out-dir <scratch>/nft-test-only/deploy -- --locked --offline`
  (`cargo-build-sbf` 3.1.9 and platform-tools v1.52 are installed; the guard runs `cargo <args>`).
- **Post-check** `scripts/check-prize-nft-test-only.sh <so>` (new; reads only):
  refuses any path under `permutation-prize/target/deploy`; requires e_flags 2 (SBPF v2), the overflow
  panic strings, and **the NFT handler strings** (`PRIZE claim-nft`, `PRIZE nation-nft`: proves the
  feature is in, the opposite of `build-prize.sh`); then copies it to
  `permutation_prize.TEST-ONLY-nft-experimental.so` beside it and prints its sha256 with the banner
  `TEST ONLY — nft-experimental — NOT DEPLOYABLE (NFT-PRIZE.md §8.3)`.
- The tests read it only from `PRIZE_NFT_SO` (**no default**: a missing variable is a clear panic, never
  a fall-back to the production artefact).

## 4. The runtime tests: `svm-tests/tests/nft_pass.rs`

Every test is `#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]`, so a plain
`cargo test` of `svm-tests` (the production `.so`) is unchanged; they run with
`cargo test --offline --locked --test nft_pass -- --ignored`.

**Real in these tests:** the prize program (SBF, `nft-experimental`, TEST ONLY build); Metaplex Core
(mainnet ELF, `CoREENxT…`); ⑳'s resident program (`947da0b9…`): Core collection with update authority =
the resident program's `collection-authority` PDA, InitConfig (ProgramData upgrade authority = a local
test key), SetMetadata, SetTerms, **MintResident** (asset with Permanent Freeze + Permanent Transfer
delegates), **TransferResident** (owner moves, generation += 1, session cleared), **SetSession**; SPL
Token (LiteSVM's own).

**Stand-ins (labelled in the code):** the game program is not deployed. Its accounts are written as
bytes under a stand-in game id, as `pool.rs` does for Season, Province and Citizen: the resident policy
(`frontier_abi::resident_policy::write_once`, naming the real Core id, the real resident program id, the
real collection and the real guard authority), the NFT Citizen (marked with the asset), and the
`nft-citizen-link`. The NFT Entry is the **synthetic fixture** of the host tests (written as a deposit
would have left it; the program refuses every deposit). CloseCitizen is emulated by removing the Citizen
account (the real game instruction runs only in the host test).

**Tests (7):**
1. `real_mint_then_the_owner_claims_once`: A mints (real); A claims at generation 0 → paid to A's own
   account, Entry `claimed_by = A`, `claim_generation = 0`; a second claim → `AlreadyClaimed`.
2. `a_real_transfer_moves_the_unclaimed_right`: real TransferResident A→B (generation 1); A at 0 →
   `ResidentStaleGeneration`; A at 1 (own account) → `ResidentNotCurrentAuthority`; B at 1 → paid to B.
3. `a_real_buy_back_pays_the_returning_owner_once`: real A→B→A (generation 2); B at 1, A at 0 and 1 →
   stale; B at 2 → not current; A's real session (SetSession at 2) paid to A's account → `BadAccount`,
   to its own account → `ResidentNotCurrentAuthority`; unsigned → `BadAccount`; then A at 2 paid once,
   then `AlreadyClaimed`.
4. `pass_deposits_are_refused_at_dispatch_with_a_real_asset`: tag 8 → `ResidentDepositsDisabled`, no
   Entry created.
5. `a_recorded_nation_survives_the_citizen_closing`: RecordResidentNation (real), Citizen removed
   (stand-in close) → the owner's claim still pays.
6. `without_a_record_a_closed_citizen_cannot_claim`: Citizen removed, no record → `BadAccount`.
7. `refund_mode_refuses_the_pass_claim`: refund mode → `ResidentRefundUndecided` (the rule stays
   undecided).

After **every** refusal: the vault, every token account involved and the whole Entry account are
byte-for-byte unchanged.

## 5. Resources (estimates, not measured) and order

- SBF build target: about 0.3–0.6 GiB. svm-tests host target (toolchain 1.95, LiteSVM, deps at
  `opt-level = 3`): about 1.5–3 GiB. **Asked total: about 3.5 GiB**, each target capped at 4 GiB by the
  guard, and free space must stay at or above 20 GiB. At about 24 GiB free that is tight: if the guard
  stops, the run stops and I report it; no guard change.
- Order: after main's ×10 world is down and a slot is agreed: ① SBF build → post-check → ② `nft_pass`
  `--ignored` (7). The existing `pool.rs` (15) is **not** run here: it needs the production `.so`, which
  only `build-prize.sh` makes and none exists now. One cargo at a time; df to main and ⑳ after each.

## 6. Review questions

1. Is the TEST ONLY build (separate target, separate post-check, `PRIZE_NFT_SO` with no default) separate
   enough from the production artefact?
2. Are the stand-ins in §4 acceptable for this layer, given that the game program's own CloseCitizen and
   JoinResident are covered only by the host test?
3. Resources: is about 3.5 GiB acceptable now, or should it wait for more free space?

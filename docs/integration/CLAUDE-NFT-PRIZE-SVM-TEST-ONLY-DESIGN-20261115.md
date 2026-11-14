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
- **Post-check** `scripts/check-prize-nft-test-only.sh <so>` (new; checks the input, then **writes one file**, the renamed copy; earlier wording "reads only" was wrong):
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

## 7. Preparation done while waiting (2026-11-15; nothing built or run)

- Source: `svm-tests/tests/nft_pass.rs` (7 `#[ignore]` tests, rustfmt-clean, **not compiled**),
  `scripts/check-prize-nft-test-only.sh` (bash -n clean; negative checks: a 1-byte file → "too small",
  a zeroed file → "e_flags 0": both exit 3).
- Static findings applied: the resident program refuses a session expiry more than 30 days ahead
  (`MAX_SESSION_SECS`), so the test reads the Clock sysvar and uses now + 1 h; the sale window uses
  `0 = no limit` for start and end; refund mode is accepted with all-zero totals (as in the host test).
- Binaries copied by hash into the scratchpad with ⑳'s OK: `mpl_core.so` `515541c8…` (810,288 B,
  untrimmed), `wylls_resident_program.so` `947da0b9…` (165,360 B). ⑳'s checkout untouched.
- Run script `scratchpad/rust/run-nft-svm.sh` (sha256 `22b5045a8cffba22…`): A = guarded
  `cargo build-sbf --features nft-experimental` into `target-nft-sbf` + post-check; B = guarded
  `svm-tests` `--test nft_pass -- --ignored` into `target-nft-svm`. It refuses a binary hash mismatch.
- Reported to ⑳: its `svm-core/tests/core.rs` appears stale against `947da0b9` (InitConfig 3 vs 5
  accounts, MintResident 9 vs 10), from reading only.
- Waiting for: review (user, main, ⑳), main's ×10 world down, and a slot (estimate about 3.5 GiB).

## 8. Review fixes (2026-11-15, before any build)

From an independent source review (user):
1. **MintResident's config account is writable.** The current resident program writes `config.MINTED`
   (`mint_resident`), so `AccountMeta::new_readonly(w.config, …)` would have made every setup fail with
   ReadonlyDataModified. Now `AccountMeta::new`. The other resident instructions' writability was re-checked
   against the program header: InitConfig, SetMetadata, SetTerms, TransferResident, SetSession all match.
2. **Post-check paths.** A symlink input is refused. Input and output directories are resolved to physical
   paths (`cd -P` / `pwd -P`) before the production check, so a symlinked parent cannot reach
   `permutation-prize/target`. An output that is a symlink, or not a regular file, is refused. The copy is
   written to a fresh `mktemp` file in the same directory and renamed into place (a rename never writes
   through a link); the output is re-checked just before the rename.
3. **ELF header.** Magic `7f 45 4c 46`, ELF64 (class 2), little-endian (data 1), e_machine 247 (EM_BPF) or
   263 (EM_SBF), then e_flags 2. A file with the right e_flags and strings but no ELF header is refused.
   (Reference: ⑳'s `mpl_core.so` and `wylls_resident_program.so` read class 2, data 1, machine 263.)
4. Wording: the script writes the renamed copy (above).

**Negative fixtures:** `scripts/check-prize-nft-test-only.test.sh` (synthetic files only; no build, key or
network): **17/17 pass**. Refused (exit 3): too small; e_flags and strings without ELF magic; ELF32;
big-endian; x86-64; e_flags 0; no strings; a symlink input; a production-dir file through a symlinked parent;
a production-dir file directly (and nothing written there); an output symlink (its target unchanged); an
output directory. Accepted: a header-valid synthetic file, giving a regular-file copy with the same bytes and
no temporary file left. The test removes only what it created (including `permutation-prize/target`, if it
created it). A header check is not proof of a real build; the real build is the guarded `cargo build-sbf`.

## 9. Space plan after main's note (2026-11-15)

Main: at 23.30 GiB free, a 3.5 GiB run would cross the 20 GiB floor. Guard unchanged; instead:
① runs alone; once the post-check has copied the `.so` out of the target, **only this run's own new
`target-nft-sbf`** is removed. ② starts only at **≥ 24 GiB free** (the run script refuses below that, exit 6,
logged). Nothing else is deleted (no other session's targets or caches; my earlier 345 MiB e2e target is
kept). Order: ⑳'s keeper runs and candidate SBF first (its slot), then ① → ②, one cargo at a time; df to main
and ⑳ after each. Run script sha256 `b242ad5c26698bfd…`. Free at the time of writing: 21 GiB (⑳ running).

## 10. ① run: TEST ONLY nft-experimental SBF build (2026-11-15)

After ⑳'s candidate SBF exited (⑳: free 23.30 GiB, target deleted). Head `8ab9ccec`; guard unchanged
(`94baeb7d…`); run script `b242ad5c26698bfd…`; log sha256 `e08aa181bc84a556…`.

- `cargo build-sbf --manifest-path permutation-prize/Cargo.toml --features nft-experimental
  --tools-version v1.52 --arch v2 --sbf-out-dir <scratch>/nft-test-only/deploy -- --locked --offline`
  (cargo-build-sbf 3.1.9): **rc 0**, 15 s, peak target 122 MiB (no guard stop).
- Post-check: **rc 0**. `permutation_prize.TEST-ONLY-nft-experimental.so`: 139,784 B, sha256
  `1cf41f7bf6f7b661ede57bfc185a5fcee13a8938fb73cbc44f3b7af159336e35`, ELF64 LE, e_machine 263 (EM_SBF),
  e_flags 2 (SBPF v2), overflow checks present, `PRIZE claim-nft` and `PRIZE nation-nft` present. So the
  NFT path **compiles for SBF**. That is all this step shows; nothing has run on it yet.
- This run's own `target-nft-sbf` was removed (124,932 KiB). cargo-build-sbf also writes a
  `permutation_prize-keypair.json` (a program keypair) beside the output; it is unused (the tests give the
  program an in-memory id), so it was removed without being read or printed. Neither file is in git.
- `build-prize.sh` and `permutation-prize/target` were not used or touched.

**② not started:** at the start check, free = 24,412,980 KiB (23.28 GiB) < the 24 GiB threshold
(25,165,824 KiB): **0.72 GiB short**. Removing this session's own 0.34 GiB e2e target would still leave it
0.38 GiB short, so nothing was deleted and the guard is unchanged. df was sent to main and ⑳; the slot was
returned. ② runs when free is ≥ 24 GiB at its start. The 7 tests remain **not run**.

## 11. ② run: the LiteSVM NFT runtime tests — 7/7 (2026-11-15)

Free rose on its own to 24.69 GiB (nothing deleted; confirmed independently by the user, main and ⑳); main
and ⑳ ran no build or world meanwhile. At the start: free 25,892,828 KiB (≥ 24 GiB), no other cargo, guard
`94baeb7d…`, TEST ONLY prize `1cf41f7b…`, Core `515541c8…`, resident `947da0b9…` (all re-hashed). Head
`605e08df`; run script `b242ad5c26698bfd…`; log sha256 `017f7b14a94589c3…`.

`cargo test --offline --locked --test nft_pass -- --ignored` in `permutation-prize/svm-tests` (toolchain
1.95.0, LiteSVM 0.16): **7 passed, 0 failed** (51 s with the build; rc 0; peak target 550 MiB; no guard stop;
free 24.17 GiB after). df and the result went to main and ⑳; the slot was returned.

| test | what ran for real | result |
|---|---|---|
| real_mint_then_the_owner_claims_once | MintResident; ClaimResident at gen 0; second claim | paid once (exact share), Entry claimed_by A at 0; then AlreadyClaimed, nothing moved |
| a_real_transfer_moves_the_unclaimed_right | TransferResident A→B (gen 1, asset owner checked) | A at 0 stale, A at 1 not current (nothing moved); B paid the whole share |
| a_real_buy_back_pays_the_returning_owner_once | TransferResident ×2 (gen 2), SetSession by A | B 1/2, A 0/1 refused; session → A's account BadAccount, → own account NotCurrentAuthority; unsigned BadAccount; all unchanged; A at 2 paid once, then AlreadyClaimed |
| pass_deposits_are_refused_at_dispatch_with_a_real_asset | PayResident with a real asset | ResidentDepositsDisabled, no Entry, no token or counter moved |
| a_recorded_nation_survives_the_citizen_closing | RecordResidentNation; Citizen removed (stand-in) | nation recorded; the owner still paid |
| without_a_record_a_closed_citizen_cannot_claim | Citizen removed (stand-in), no record | BadAccount, nothing moved |
| refund_mode_refuses_the_pass_claim | refund-mode pool | ResidentRefundUndecided, nothing moved |

**What this proves:** the SBF `nft-experimental` prize program accepts the **real** Core asset bytes, the
**real** guard and the **real** resident record, and follows the **real** TransferResident and SetSession
(generation, owner, session). The current-owner, stale-generation, session, destination-binding,
double-claim, deposit-refused and refund-undecided rules hold at runtime, with no movement on any refusal.

**What it does not prove (still stand-ins / not run):** the game program's own accounts (policy, NFT Citizen,
link) and its CloseCitizen and JoinResident (covered only by the host test); a real deposit (the Entry is the
synthetic fixture; deposits stay refused); any real chain, validator, relay, page or wallet; CU limits on a
real cluster; the production `build-prize.sh` artefact and `pool.rs` (not run: no production `.so`).
`target-nft-svm` (550 MiB, this session's own) is kept until main says otherwise.

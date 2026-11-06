# NFT pass entries and prize rights (experimental, 2026-11-07)

**Status.** Implemented in `permutation-prize` behind the Cargo feature
`nft-experimental` (off by default: the new tags are `BadData`), with the
client SDK, the relay routes, the settlement tool, the web page and tests.
Nothing here is built for SBF, run in LiteSVM, deployed, or run on any
chain. The numbers (tags 8–10, errors 0x113–0x11A, the `entry-nft` seed,
the leaf domain 0x02) are **provisional** until workstream 04 fixes them in
the integration (ABI-ALLOCATION-20261106.ja.md, rev 6).

**NOT DEPLOYABLE.** The feature is experimental and must stay off: a pool
that settles in refund mode would hold the passes' fees with no exit until
the refund rule is decided (§8.3). `scripts/build-prize.sh` refuses to
build with the feature, refuses a manifest that makes it a default, and
refuses an artefact that carries the pass handlers; `Cargo.toml` says the
same. Nothing here decides or authorises a refund rule.

## 1. What it does

Every player of the `nft-experimental` game holds an **NFT pass**: a
Metaplex Core asset of the resident program's collection (workstream 20;
`permutation-nft-resident-spike`). The game's own authority check reads, on
every instruction, the pass's live Core owner, its transfer guard and the
resident program's holder generation (`frontier_abi::resident_auth`).

This change makes the prize pool follow the same rule:

- **The entry belongs to the pass.** `PayResident` (tag 8) takes the fee
  from the pass's current owner and writes an **NFT Entry**
  (`["entry-nft", pool, asset]`, 192 B, magic `WYPRNFTE`) that names the
  asset, not a wallet.
- **Unclaimed prize rights follow the pass to its current owner, whoever
  paid and whenever it accrued.** `ClaimResident` (tag 9) pays the pass's
  share to the signer only if that signer is the asset's owner *now*, at
  the generation it signed. A → B: only B claims. A → B → A: only A at
  generation 2; B's old and fresh signatures, and A's first-ownership
  signatures, are refused. After a claim the pass is claimed for good: a
  buy-back gets no second share.
- **The nation is recorded for the pass.** `RecordResidentNation` (tag 10)
  is RecordNation for an NFT Entry: anyone copies the pass's live NFT
  Citizen's nation into the Entry, so the game's cleanup (CloseCitizen,
  anyone, `end + 72 h`) cannot strand the pass's claim.
- **Legacy wallet entries are untouched.** Pay, Claim, RecordNation, the
  wallet Entry (128 B), the refund mode and every amount are unchanged; one
  shares root holds wallet leaves (domain 0x00) and pass leaves (0x02).

## 2. Instructions

| tag | instruction | data | accounts |
|---|---|---|---|
| 8 | PayResident | `generation u32` | `[owner s] [payer s,w] [pool w] [entry w] [owner token w] [vault w] [mint] [token] [system] [policy] [asset] [resident]` |
| 9 | ClaimResident | `generation u32 ‖ nation u8 ‖ points u64 ‖ n u8 ‖ proof 32×n` | `[owner s] [pool w] [entry w] [citizen] [link] [vault w] [owner token w] [mint] [token] [policy] [asset] [resident]` |
| 10 | RecordResidentNation | — | `[pool] [entry w] [citizen]` (no signer) |

`policy`, `asset`, `resident` are the game's JoinResident proof accounts
(read-only here as there). `generation` is the resident program's holder
generation the owner signs; it is compared with the resident record in the
same invocation. `[owner token w]` of ClaimResident must be an SPL token
account of the pool's mint whose owner field is the signer (`BadAccount`
otherwise): the share is paid to the current owner itself, never to an
account it merely names (the wallet Claim is unchanged).

**NFT Entry** (192 B; the first 104 bytes sit where the wallet Entry's do,
with the asset where the wallet is; its size and magic differ, so neither
kind is ever read as the other):

| offset | field |
|---|---|
| 0 | magic `WYPRNFTE` |
| 8 | bump |
| 9 | claimed |
| 10 | nation_recorded |
| 11 | nation |
| 12 | pay_generation (u32) |
| 16 | pool |
| 48 | asset |
| 80 | amount |
| 88 | paid_slot |
| 96 | claim_amount |
| 104 | paid_by (the owner that paid; informational) |
| 136 | claimed_by (the owner that claimed) |
| 168 | claim_generation (u32) |
| 172–191 | reserved (zero) |

**Leaf.** `sha256(0x02 ‖ pool ‖ asset ‖ nation ‖ points)`; a wallet leaf is
`0x00 ‖ …`, a node `0x01 ‖ …`. The settlement tool puts both kinds under one
root; a pass claim never verifies against a wallet-domain leaf of the same
bytes.

**Errors** (prize program, `Custom`): 0x113 ResidentNotSigned, 0x114
ResidentAsset, 0x115 ResidentAccount, 0x116 ResidentUnguarded, 0x117
ResidentStaleGeneration, 0x118 ResidentNotCurrentAuthority (the six
refusals of `resident_auth`, in this program's number space), 0x119
ResidentPolicy (the game's policy is absent, not the game's, or not at its
PDA), 0x11A ResidentRefundUndecided (§8). 0x111 stays free for workstream
08's proposal.

## 3. Security properties (what the program itself enforces)

- **The owner is read from trusted live accounts, never from the caller.**
  The policy must be at `["nft-resident-policy"]` of the pool's game
  program and owned by it (only the game's upgrade authority can create it,
  write-once). The asset must be owned by the policy's Core program, be an
  `AssetV1` of the policy's collection, and carry the transfer guard (frozen
  Permanent Freeze Delegate and Permanent Transfer Delegate of the resident
  program's collection authority), so it can move only through
  `TransferResident`, which bumps the generation. The resident record must
  be at `["resident", asset]` of the policy's resident program and owned by
  it. The signer must equal the asset's owner bytes; `session_allowed` is
  false (a session key never pays or claims).
- **Old owner, old session, replay, double claim.** A signature from before
  a transfer carries the old generation (`ResidentStaleGeneration`); a
  fresh signature of a former owner is `ResidentNotCurrentAuthority`; the
  Entry's `claimed` byte refuses a second claim whoever holds the pass
  (`AlreadyClaimed`); a second PayResident is `AlreadyPaid`.
- **Wrong pass, program, policy, link, world.** The Entry is the PDA of
  the asset named; the policy's address is derived from the pool's game
  program; the NFT Citizen must be at `citizen_by_tag15(resident id)` of
  the pool's season, be the game's account of that season and be marked
  with exactly this asset; the link must be at
  `["nft-citizen-link", season, asset]` of the game, owned by it, and name
  this asset, resident and Citizen.
- **Fail closed.** Without the feature the tags are `BadData`. A pass claim
  in refund mode is `ResidentRefundUndecided` and moves nothing. A wallet
  Claim naming an NFT Entry, a pass Claim naming a wallet Entry, and the
  two nation records crossed are all `BadAccount`.
- **Amounts.** `share_amount`, the winning-nation rule, the proof check and
  the `claimed ≤ prize` bound are the wallet Claim's, unchanged.

## 4. Undecided, therefore not implemented (do not read this as a decision)

- **Refund transfer rules.** Whom a refund follows (the owner that paid or
  the owner now) is undecided. A pass claim in refund mode is refused; the
  pass's part stays in the vault (§8.3 on what that means). Wallet refunds
  are exactly as before.
- **Legacy-to-NFT migration.** No path turns a wallet Entry into an NFT
  Entry or the reverse; no rights move between the two kinds.
- **Assets and history across worlds** (workstream 20's U11). Nothing
  carries over; the NFT Entry is per pool (per season).
- **Operator tooling attributing contribution lines to passes** reads the
  resident mark from the Citizen bytes (`playerOfCitizen`); the ledger ids
  a pass as `pass:<asset>`. Its weights stay provisional as before.

## 5. Where the code is

| area | files |
|---|---|
| program | `permutation-prize/src/lib.rs` (`entry_resident`, `leaf_resident`, `PrizeError` 0x113–0x11A, module `resident`), `Cargo.toml` (feature) |
| SDK | `permutation-gateway/client/src/frontier/prize.mjs` (`entryResidentAddress`, `decodeEntryResident`, `leafResidentHash`, `payResidentIx`, `claimResidentIx`, `recordResidentNationIx`, `recordNationIx`, `paidJoinResidentMessage`, `classifyPaidResidentJoin`, `joinResidentViaX402`); the generated copy `permutation-server/web/sdk/frontier/prize.mjs` |
| relay | `permutation-gateway/src/frontier/routes/prize.mjs` (`GET /f/prize?asset=`, `POST /f/x402/join` with `[prefix, PayResident, JoinResident]` or a plain JoinResident of a paid pass, `POST /f/prize/claim` with ClaimResident) |
| settlement | `permutation-gateway/scripts/prize-settle.mjs`, `src/frontier/achievements.mjs` (`playerOfCitizen`, `pass:<asset>` ids, pass leaves) |
| web page | `permutation-server/web/frontier/fprize.mjs` (`loadPrize` with `asset`, `payAndJoinResident`, `claimPass`, `passShareOf`, `passClaimModel`), `screens/prize.mjs` (`renderPass`), `controller.mjs` (`claimPass`, `paidJoinPass`, the `nft-login` paid path, `prize-claim-pass`), `fi18n.mjs` and `lang/en-frontier-play.mjs` (texts) |
| registry | `workstreams/04-execution/contracts/registry.txt`, `e2e-native/tests/registry.rs`, `error_codes.rs` |
| tests | §6 |

## 6. Tests, by execution class

Written by the author; the author executed none. The supervisor reported:
prize `cargo check` (both feature sets) passes, `nft_pass_prize` compiles,
the pure prize unit tests pass 8/8, and `resident_auth`'s literal-byte tests
pass 2/2. No key is generated, derived or signed in any test below.

**Pure (safe to execute now: no key, no address derivation of any kind).**

- `permutation-prize/src/lib.rs` unit tests: the NFT Entry layout, the leaf
  domain (sha256 over literal bytes; no address is derived), the error band,
  beside the existing ones.
- `permutation-gateway/test/web-frontier-prize-pass.test.mjs`: the page's
  pass claim model and the 賞金 panel's pass section over literal objects
  and strings; exact points at the u64 boundary; the pending / unknown /
  failed records and their wallet and generation; the claim operation's
  identity guard; the wallet panel unchanged; the English texts.

```sh
(cd permutation-prize && cargo test --lib && cargo test --lib --features nft-experimental)
(cd permutation-gateway && node --import ../scripts/ci/no-keys-guard.mjs --test test/web-frontier-prize-pass.test.mjs)
```

**Address-deriving (compile- or syntax-check only until a run is
approved: they derive PDAs and with-seed addresses at run time, no key).**

- `workstreams/04-execution/e2e-native/tests/nft_pass_prize.rs` (9 tests):
  the real prize program (host build, `nft-experimental`) and the real game
  program's CloseCitizen, over literal-byte fixtures (policy, Core asset
  with the guard registry, resident record, NFT Citizen, link; a transfer
  rewrites the asset's owner and bumps the generation as TransferResident
  does). Covers: PayResident (owner, generation, session, unsigned,
  unguarded, once, after the tally); the share following A → B; a transfer
  before settlement; A → B → A with the session key; wrong pass, policy,
  link, world, Citizen mark, guard, resident record, proof, nation; wallet
  and pass entries never standing for each other, a wallet-domain leaf of
  the asset; RecordResidentNation and the claim after the game's
  CloseCitizen; the loss without a record; refund mode refusing the pass
  and keeping the wallet refund.
- `workstreams/04-execution/e2e-native/tests/registry.rs`, `error_codes.rs`
  (the tables; `registry.rs` derives nothing but shares the crate).
- `permutation-gateway/test/frontier-prize-resident.test.mjs`: the SDK's
  addresses, decoders, leaf, builders, the paid-JoinResident message and
  classifier.

```sh
(cd workstreams/04-execution/e2e-native && cargo check --locked --tests)      # compile only
(cd workstreams/04-execution/e2e-native && cargo test --locked --no-run)      # build the test binaries, run nothing
node --check permutation-gateway/test/frontier-prize-resident.test.mjs        # syntax only
# approved run, later:
(cd workstreams/04-execution/e2e-native && cargo test --locked --test nft_pass_prize --test registry --test error_codes)
(cd permutation-gateway && node --import ../scripts/ci/no-keys-guard.mjs --test test/frontier-prize-resident.test.mjs test/web-sdk.test.mjs)
```

**Key-using (manual key-tests job only).**

- `permutation-gateway/test/frontier-prize.test.mjs` (existing file,
  `Keypair.generate`): three relay route tests appended: `GET
  /f/prize?asset=`, the x402 `[prefix, PayResident, JoinResident]` path
  and `POST /f/prize/claim` with ClaimResident, over the scripted chain.

Static checks that derive nothing: `cargo fmt` (not run by the author),
`cargo clippy --features nft-experimental -- -D warnings` in
`permutation-prize`, `node scripts/ci/scan-node-key-tests.mjs --check`,
`node permutation-gateway/scripts/sync-web-sdk.mjs --check`, and the lang
completeness scan `test/web-lang.test.mjs` (it reads sources; it does not
derive addresses).

## 7. The web page (experimental)

The page already holds the pass played (`FS.resident`: asset, NFT Citizen,
proof accounts, generation; set by the existing NFT choice on the join
screen) and the wallet's passes (`FS.nfts`). No new selector was added.

- **Reads.** While a pass is played, `refreshPrize` reads the pool with
  `?asset=`; the relay answers the pass's NFT Entry and NFT Citizen
  (`FS.prize.pass`). The ledger marks the pass's own lines as "you"
  (`pass:<asset>`).
- **Entry.** On the join screen, "Join with this NFT" in a season with a
  pool pays the fee and joins in one signed transaction
  (`paidJoinPass` → `payAndJoinResident` → SDK `joinResidentViaX402`:
  `[prefix, PayResident, JoinResident]`), for the generation read fresh
  from the relay right before signing. The pass accounts are derived in the
  SDK from the 402's season, never taken from the answer. Without a pool
  the former invite path is unchanged.
- **Claim.** The 賞金 panel shows a pass section only for a pass player
  (`renderPass`; the wallet panel is as before). The claim button appears in
  exactly one state (`passClaimModel`: shares posted in shares mode, a
  share for the pass in the published ledger, the pass still reported in
  this wallet, the Entry unclaimed). `claimPass` then re-reads the pool and
  the ledger, re-reads the generation, re-evaluates the model, builds one
  ClaimResident signed by the wallet for that generation, posts it to
  `/f/prize/claim`, checks the relay's answer is its fee payer's signature
  of the same message, and tracks it. The program judges the owner again on
  chain; the page never decides it.
- **Stale completions.** Every write of `claimPass` after an await is
  guarded by the operation's identity (`claimOpOf` / `claimOpLive`): the
  page's **pass epoch** (`FS.passEpoch`, counted up on every wallet change,
  NFT login and logout, so A → B → A or a logout and login is a new epoch
  and an old operation never comes back to life), the wallet that signs,
  the pass played and, once known, the signed generation (a transfer seen
  by another action meanwhile makes the operation stale). A stale
  completion, success or failure, is dropped and never written. The record
  also carries the wallet, and the model ignores a record of another
  wallet. `paidJoinPass` and the NFT login write nothing once another
  wallet is connected.
- **Failed versus unknown.** `claimOutcome` classifies every attempt:
  `failed` only before the POST (relay info, build, signing, the
  pre-signing check: `notSent: true`) or when the chain proved the failure
  (`track` says failed). A refused or lost answer after the POST, a changed
  relay answer, an `already` whose Entry is not claimed, an expired or
  unconfirmed track are all `unknown`: shown as unconfirmed with the
  signature, never called failed or unsent, and never offered for
  resubmission by the page; the relay's own pending lookup answers the
  next attempt.
- **Pending and unknown.** The pending claim (`FS.prizePass`) is keyed by
  asset and signed generation. A pending or unknown outcome is kept
  whatever the generation and shown as unconfirmed with its signature,
  never as failed or unsent, until the Entry reads claimed (then landed);
  "back to the wallet's resident", another pass, or a failed attempt of an
  earlier generation drops the record.
- **An earlier claim reported by the relay (`already`).** The relay then
  answers with the earlier transaction's signature, which signs another
  message: the page does not check it against the message it just built
  (that would always fail), treats this message as not sent, and re-reads
  the pass's Entry; only an Entry that reads claimed is success, otherwise
  the outcome is recorded as unknown. (The relay itself answers `already`
  only after reading the finalized Entry; the page's re-read is at the
  relay's confirmed commitment.)
- **Exact points.** Ledger points are kept as exact u64 bigints from the
  ledger (a JSON number only if it is a safe integer, else a decimal
  string; anything else gives no share) through the model, the estimate
  and the ClaimResident data; the page never rounds them through `Number`.
- **Refund.** In refund mode the panel explains that a pass's refund is
  undecided and offers nothing; the program would refuse it anyway
  (`ResidentRefundUndecided`).
- **Not done.** The relay's claim route does not create the owner's token
  account; a new owner who never held test USDC must get one first (the
  faucet does, on the local chain). No session key for passes (as before).

## 8. Audit of this change (2026-11-07)

### 8.1 Where a claim is paid to (fixed)

`ClaimResident` now binds `[owner token w]` on chain: it must be an SPL
token account (owned by the token program, 165 B) whose mint is the pool's
and whose owner field is the signer; anything else is `BadAccount`, before
any transfer. So the pass's current owner is paid to itself only, and a
compromised adapter cannot redirect the claim. The relay pins the same
account (the signer's ATA of the mint) and the page builds it. The legacy
wallet `Claim` is unchanged (its destination is still the signer's choice).
Fixture tests: another owner's token account and a non-token account are
refused (`nft_pass_prize.rs`, the wrong-account test).

### 8.2 The nation record and the Citizen

`RecordResidentNation` copies the nation only from the live NFT Citizen at
`citizen_by_tag15(resident id)` of the pool's season, owned by the game,
marked with exactly the Entry's asset; a different nation is refused once
recorded. It rests on the game writing a Citizen's nation once (at Join),
as RecordNation does; a future nation-changing instruction would need to
invalidate records (workstream 16's F5). After CloseCitizen the claim uses
the record **and still requires the link**; the game has no instruction
that closes a link today. If one is added, a recorded pass claim after
both closes would be refused (fail closed, the share stranded), so that
instruction must be designed with this in mind.

### 8.3 Fee acceptance and the refund mode (risk)

`PayResident` accepts fees whenever the wallet `Pay` would. If the pool
later settles in **refund mode** (no eligible member of the winning
nation), the pass's part of the prize has **no exit**: `ClaimResident`
refuses (`ResidentRefundUndecided`), `Claim` cannot read an NFT Entry,
`WithdrawOps` moves only the operator's part. The funds stay in the vault
until a program change decides the rule. The wallet refund is unaffected.
This is deliberate (nothing is decided silently) but it means: **the
feature is not deployable; do not enable `nft-experimental` on any pool
until the refund rule is decided.** The build script enforces it
(`scripts/build-prize.sh` exits 3 on the feature, on a manifest default, or
on an artefact carrying the `PRIZE pay-nft` / `claim-nft` / `nation-nft`
log strings). Options, for the owner to decide, none implemented: refund
to the current owner at claim time (the right follows the pass, like
shares); refund to `paid_by` (the payer); refuse `PayResident` entirely
until decided (no lock, no pass entries); an operator-set pool flag
choosing one of these before SetShares.

### 8.4 Other points checked

- The NFT Citizen's season is checked (`game_account` with the pool's
  season id), so a pass's Citizen of another world never passes.
- `PayResident` does not require the pass to have joined; a paid pass
  without a Citizen and without a record cannot claim in shares mode
  (as a wallet that only paid cannot), and the settlement tool uses the
  Entry's recorded nation as a fallback only when a Citizen existed and was
  recorded.
- The relay x402 classifier does not re-derive the pass's Citizen or link
  (the game program refuses a wrong one at run time; the SDK derives them
  from the season); the claim route re-derives every pass account from the
  policy on chain and refuses any other.
- The page refuses to offer a claim it already knows would fail, but
  never decides ownership: a stale page sends a stale generation and the
  program answers `ResidentStaleGeneration`, shown in words.

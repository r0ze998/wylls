# Lane C — design A: a lot that may still receive a return does not close (2026-11-17)

- **Base:** `claude/canonical-candidate-20261116` @ `d16048aa`.
- **Branch:** `claude/lane-c-lot-returns-a-20261117`.
- **Approval:** the owner approved design A on 2026-11-17, relayed by the coordinator: while unused ore or a fraction may still come back, the lot cannot close.

**What this branch is.** An unadopted implementation inside the two previews, `custody-preview` and `capacity-preview`. The default S1 build is untouched: it still refuses these tags.

**Not done.** The preview is not enabled, and no ABI number, version or ruleset hash is fixed. Nothing was migrated, recreated or discarded. No new owner, destination, permissionless claim, seizure split, D3 or two-source rule was added.

**Nothing was run:** no test, syntax check, build, import, world or server.

## Files changed

| File | Change |
|---|---|
| `permutation-rules/src/frontier/custody.rs` (kernel) | `Returns { tracked, pending, rest }` on `Lot`, kept in the 16 B `RSV`: tag `RTA1`, a u32 count, an i64 rest. `open` makes a tracked lot. `empty` also needs `tracked && pending == 0 && rest == 0`. `balanced` adds `0 ≤ rest ≤ CONSUMED` and "untracked ⇒ 0/0". New `begin_use`, `end_use` and `pay_rest`. The owner's own `spend_ship` pays back a gathered rest once there is room. Decode is strict: tag, all zero (untracked), else not a lot. Encode refuses an untracked lot that carries returns before writing any byte |
| `permutation-frontier/src/proc/capacity.rs` (preview handlers) | `Link.count` is kept in the link's first byte: 0 not fed, 1 fed and not counted, 2 pending, 3 released. DepositToJob's first feed calls `begin_use`. ClaimJob runs `settle_lot`, which replaces `pay_owed`: whole units back, then **one release** when the job is final with less than a unit owed (`end_use`), else `pay_rest`. RetireJob also refuses a job that is still `Pending` |
| `permutation-frontier/src/capacity_runtime_tests.rs` | The existing lot test's tail now expects design A: rest 500 on the lot, the job released once, and allowed to retire. A new `capacity_link_count_states` test. **Written, not run** |
| `permutation-rules/tests/custody_returns.rs` (new) | 8 kernel cases. **Written, not run** |

**Not changed, and needed at adoption** (workstream 4 and the owner):
- `frontier-abi`'s layout still names the bytes `RSV`;
- `CUSTODY_VERSION` and `RULESET_HASH_V4` are not bumped, although the kernel's meaning changed;
- no record kind is logged for a release or a rest payout;
- V26 replays CloseLot, ShipLot and WithdrawLot through this kernel, so its expected post-states follow, but its history check sees the lowered `CONSUMED` without a record. ⑩ already accepts returns as unverifiable.

## How the requirements are met

| Requirement | How |
|---|---|
| D2: the original owner keeps unused ore | It goes back only into the same lot (`return_unused`, `pay_rest`). No new destination or owner |
| Pending | A job is counted once at its first feed (`begin_use`) and released once (`end_use`, `pending −= 1`). A second release is `State`, with nothing changed |
| Milli fractions | A finished job's rest (0 ≤ rest < 1000) is gathered on the lot and stays `CONSUMED`. Whole units go back when there is room. **Never rounded or dropped** |
| Close safety | `empty` needs `pending == 0` **and** `rest == 0`, so neither the owner nor the keeper can close a lot that is waiting. The same holds for a forfeited lot |
| Old RSV zero | Read as **untracked**, never as "no pending returns". An untracked lot never closes, cannot count a job, and cannot release or pay a rest. Writing it keeps it untracked |
| Old open jobs (link byte 1) on a lot now tracked at the same address | DepositToJob is refused (`NotImplemented`). In ClaimJob the debt stays in the job, unchanged: the two lots' books never mix (fail-closed) |
| Lots already closed | Not touched. Their jobs keep their debt, which is not erased |
| Refusals change nothing | Kernel: `end_use` and `pay_rest` work on a copy; `spend_ship` restores its entry state if the payout fails; encode validates before writing. Program: `settle_lot` changes the caller's `link` and the lot account only after every step (and the write) succeeded |
| Full lot | Owed whole units, and a gathered rest, stay until there is room. The owner's own withdrawal makes room and pays them back in the same step |
| Seized lot | `end_use` and `pay_rest` are `Forfeited` and the count stays. A forfeited lot with a pending count does not close. **What a seizure does to pending returns is still undecided** |

## Counter-review (paper; nothing run)

| Case | Result |
|---|---|
| `spend_ship` rest payout fails (corrupt rest > CONSUMED) | Lot restored to its entry state, `Err(Quantity)`. Kernel case `a_failing_rest_payout_leaves_the_send_undone` |
| `settle_lot`: `return_unused` succeeds, then `end_use` fails with an error other than `Forfeited` | The caller's `link` and the lot account are unchanged: copies are committed last |
| `encode` with an untracked lot carrying returns | `None`, with not a byte written |
| Overflow: a rest above 1000, below 0, or `i64::MAX`; a rest above CONSUMED | `Quantity`, unchanged |
| Double release, or a second ClaimJob after release | `State` in the kernel. In the handler, an early return with nothing read or written |
| Reopen at the same address | A lot with a pending count is never empty, so it never closes and cannot be reopened under a counted link. A counted link therefore always names the same instance |
| Existing host test `capacity_whole_units_go_back_into_the_lot_unconsumed` | On paper it keeps its numbers. The one unit goes back, `end_use(0)` releases, and it retires |

## Still needs a decision (not taken)

1. **A rest below a unit that never fills up keeps the lot open forever.** For example, 250 milli. Truncation is not allowed, so the final disposal of a sub-unit rest is the owner's choice: round up, keep it, or pay it elsewhere.
2. Who may trigger the return once a job is final. Today only the user's ClaimJob can, so M depends on B claiming.
3. Seizure: where a forfeited lot's pending returns and rest go.
4. Workstream 4: naming the RSV fields; `CUSTODY_VERSION` and the V4 hash; record kinds for release and rest payout; V26's history treatment; the ⑨/⑩ numbers already listed.
5. Migration of any existing custody/capacity world. None was verified to exist. Old lots and jobs are fail-closed until a migration with proof is approved.

## Falsification pass 2 (2026-11-17, on `5ce1ed2f`; static, nothing run)

### Found and fixed

| Finding | Fix |
|---|---|
| **Source:** `custody_returns.rs` `feed` passed `l` (a mutable reborrow) and `l.nonce` to `set_order` in one argument list. Function arguments get no two-phase borrow, so that does not compile (E0503) | `let nonce = l.nonce;` first |
| `settle_lot` used unchecked `returned +=`. `permutation-frontier` builds with overflow checks, so a wrap would panic (the transaction aborts) instead of returning a refusal | `checked_add`, then `CapError::Overflow`; the link and the lot are still not written |
| No case for counter overflow | New kernel case `counting_past_the_counter_is_refused_unchanged`: `pending = u32::MAX` and `rest = i64::MAX` are refused unchanged |

### Read and found consistent

**One release per job.**
- The release happens only at `Count::Pending` and goes to `Released`.
- A second ClaimJob returns early (`due == 0`, no release, not `Pending`) and reads nothing.
- The kernel refuses a release at `pending == 0` (`State`).

**Owners and generations cannot mix.**
- The lot's address includes `owner_tag` and the vault generation, so a link only ever names that owner's lot of that generation.
- A `Pending` link cannot outlive its instance: a lot with a count is never empty, so it never closes or reopens.
- An old link (byte 1) on a tracked lot is refused on deposit, and left untouched on claim.
- A `Released` link never touches a later lot at the same address.
- **Not verified:** whether a citizen tag can pass to another wallet (shared with design B's question).

**Literals.**
- Every `Lot { … }` sets `returns`: `open`, `decode`, and the round-trip test.
- `Link` is built only in `link_of` and by `Link::default()`, and `Count` derives `#[default] None`.
- No other crate builds either struct; only `custody.rs` and `proc/capacity.rs` do.

**Atomicity, the pure kernel versus the handler.**
- **Pure kernel.** These are all-or-nothing on their own, with no reliance on a rollback:
  - `begin_use`: a single write, after its checks;
  - `end_use` and `pay_rest`: they work on a copy and commit at the end;
  - `spend_ship`: it restores its entry state if the payout fails;
  - `encode`: it validates before writing;
  - `decode`: it does not mutate.
- **Handler (ClaimJob, DepositToJob).** These write several accounts in sequence:
  - ClaimJob writes the lot, then the vault, job, link and pool;
  - DepositToJob writes the lot, then the job, link and pool.

  A failure after the first write relies on the Solana transaction being rolled back, as these handlers did before design A. `settle_lot` itself (lot and link) changes nothing on its own errors.

### The sub-unit rest that keeps a lot open (the owner's intent is undecided; nothing changed)

**Smallest unit.**
- Every lot operation is in whole units (`whole()`: `deposit`, `ship`, `consume`, `return_unused`, `pay_rest`).
- The general stores of a vault and of a Holding, and a caravan's cargo, are milli.

**How a rest arises.**
- A job's unused ore is `hopper − ORE_PER_ARM × settled`, and `settled` (arms, milli) grows with time.
- So the rest is a non-whole number of units whenever `settled` is not a multiple of 500 milli.
- That is the common case: the existing host test's 15,250 arms leave 500 milli.

**Adopted paths that could give it back.** None. Both previews are unadopted. Inside them, only `return_unused` and `pay_rest`, both whole units.

**Consequence.** A lot whose gathered rest never adds up to a whole unit never closes. Its vault quota and rent stay with it. No goods are lost.

**Options (one for the owner):**
1. **Keep it as is:** the lot stays open until rests add up. Fail-closed and nothing lost, but it can be permanent.
2. **(Recommended) the owner waives at close:** M's own CloseLot may give up a rest below one unit, logged as a loss of its own. The system never rounds; only the owner can choose it, and it changes no destination and no one else's rights. Needs a CloseLot data flag and a loss or record kind (④).
3. **Pay the rest to M elsewhere** (M's home Holding, exact in milli). A new destination that moves goods out of the province, against D6.
4. **Prevent it at the source:** a lot-fed job counts lot ore as used in whole units. A ⑨ settlement rule change, and B would effectively pay for the fraction.

### Boundaries this branch does not cross (unchanged)

- **Bytes not allocated:** the 16 RSV bytes (tag `RTA1`, pending, rest) and link bytes 2 and 3 are this branch's proposal. The ABI still says `RSV`.
- **Kernel meaning changed, version not bumped:** `CUSTODY_VERSION` and `RULESET_HASH_V4` stay as they were.
- **No record kinds:** none for a release or a rest payout.
- **V26:** its history check does not know about either.
- **Existing worlds:** whether any custody or capacity world exists is **not verified**, and no migration was done. Old lots and jobs are fail-closed.
- **Nothing run:** no test, syntax check or build. The two regression sources and the edited host tests are paper cases; whether they compile and pass is not shown.

## The sub-unit rest: four options compared (2026-11-17; static only, nothing implemented)

**The approved rule stays as it is:** no close until every return is in, fractions included. Whether a rest that never adds up may keep a lot open forever is the owner's open question. Nothing below is implemented.

### Facts the comparison rests on (`d16048aa` + this branch)

| Fact | Where |
|---|---|
| A lot stores its owner's full Citizen key `OWNER_CITIZEN` [32]. Its `OWNER_TAG` is `addr::citizen_tag(citizen key)`, written when the Citizen is created and never reassigned. The tag and the key name the same account; the owner is not a 64-bit tag alone | rules `custody.rs` Lot; `proc/citizen.rs:448` |
| A Vault stores `OWNER_CITIZEN`, `STATE`, `GEN`, `CAP`, milli `STORES` and `CUSTODY_QUOTA`. SeizeVault overwrites the owner and does `GEN += 1` | `proc/caravan.rs` ~628–631 and 1856–1864 |
| `capacity.rs` `user_vault` + `UserVault::put` are an existing, exact milli credit into a vault. They check the canonical address, `STATE_LIVE`, `OWNER_CITIZEN == given key` and the province, then `STORES + CUSTODY_QUOTA ≤ CAP`, else `Custody`. Today they are used only for the **job's user B** (ClaimJob) | `proc/capacity.rs` ~372–447 |
| WithdrawLot checks that M owns the destination (`named_place`, `NotOwner`), but moves **whole units by caravan** (`whole()`: wear, raids) | `proc/custody.rs` 852–941 |
| `Holding::credit` is an exact milli credit to a village (used today by RecordFacilityLoss for the captor) | `proc/capacity.rs` `lose` |

### The four options

| | 1. Keep (as is) | 2. Waive (not approved) | 3. Exact milli to M's live Vault in the lot's province | 4. The lot itself holds and pays out milli |
|---|---|---|---|---|
| The owner's goods | Kept on the lot's books; nothing lost | M gives up less than 1 unit, logged as a loss | Paid in full, in milli, to M's own general stock in the same province (D6 kept) | Paid in full: held as milli, and withdrawn exactly |
| Lot closable | Only when rests add up to whole units, **possibly never** (quota and rent stay) | Yes, with M's consent | Yes, once paid, if such a Vault exists and has room. Otherwise it stays as in option 1 | Yes, after an exact final withdrawal |
| Owner proof | Not needed | M signs CloseLot | `vault.OWNER_CITIZEN == lot.owner` (full key), `STATE_LIVE`, canonical address, `(p, q) == (lot.p, lot.q)`. The same checks as `user_vault` with `lot.owner` in place of the signer. **A seized Vault fails** (its owner is the captor), so it never pays someone else | M signs the withdrawal (as WithdrawLot) |
| Destination missing, full or stale | — | — | No Vault, a seized or closed one, or `Custody` (full): **refused, and the rest stays on the lot unchanged**. A retry pays once: the lot's rest goes to 0 in the same instruction as the credit | Caravan arrival rules: wear and raids on the way; a destination gone at arrival is `DestinationGone` (a loss) |
| Double payment | — | — | Prevented: `rest −= x` and the Vault `+= x` in one instruction. On the lot's books, `CONSUMED −= x` and `OUT_TOTAL += x` (it left to the owner's place, like a withdrawal) | Ordinary withdrawal books |
| New contract (④ and the owner) | None | CloseLot data flag; loss or record kind; V26 | **One** owner-signed step that takes the lot plus M's Vault, for example an optional account on CloseLot: "pay my sub-unit rest to my Vault here". A record kind for the payout, and V26 learning it. No new account kind, destination type or permission beyond M acting on M's own goods. The checks and the credit reuse `user_vault`/`put` | ⑩'s whole-units contract is relaxed: `whole()` in ship/withdraw (and orders?), the lot's invariants, caravan cargo and wear in milli, V26 replay. **The largest change** |
| Reuse of existing code | Full | Partial | **High**: `user_vault`-style checks and `UserVault::put` exist; the lot side is a small kernel step like `pay_rest` | Low |
| Risks | Permanent lock-ups | M loses up to 0.999 per lot | M may have **no Vault in that province** (max 3 per citizen); then there is no exact path and option 1 applies. The goods become ordinary vault stock, open to raids and seizure like any stock (the normal rule) | Fractions on the road (wear in bps of milli), and every custody path changes |

### Recommendation (for the owner to choose)

**Option 3, with option 1 as its fallback.**
- It returns the exact amount to the original owner, in the same province, into M's own Vault.
- It is proved by the full Citizen key the lot already stores.
- It needs no new destination type or permission beyond M's own signed close.
- It reuses the existing exact milli credit.
- When M has no live Vault there, or it is full, the rest simply stays and the lot stays open (today's approved behaviour). Nothing is lost or sent to anyone else.
- Option 4 would rework ⑩'s whole-units contract.
- Option 2 makes M bear a loss and is not approved.

### The question for the owner

> When a storage's last leftover is less than one unit, may its owner, on closing it, have that exact leftover put into their own storehouse in the same province (recommended; if they have none there, or it is full, the storage simply stays open as now), or should the storage stay open until leftovers add up to a whole unit, however long that takes?

**Boundaries unchanged.** Nothing implemented. No ABI, version, hash or record kind is fixed, no permission or destination was added, no world was verified and no migration was done, and nothing was run.

## Final consistency pass (2026-11-17, on `e00e66ba`; static, nothing run, no code changed)

**Result: no implementation mistake found.** The paths were read through the program handler, the kernel and the order of writes.

| Path | Read | Result |
|---|---|---|
| CloseLot: open lot by its owner, open lot by the vault's owner, forfeited lot by anyone | Rules `close` checks `lot.empty(bell)` **before** it branches on state, so all three entries need `tracked && pending == 0 && rest == 0`. The handler `close_lot` only reads the lot and vault, then calls the kernel | consistent |
| ClaimJob without the lot pair, then again with it | First claim: the refund goes into `link.owed`, the link is written and the lot is not touched. Second claim: `cap::claim` is `Already`, and `settle_lot` pays the whole units and then releases once (`fin` holds). The lot cannot close in between (`pending > 0`) | consistent |
| ClaimJob with the pair of a lot the link does not name | `settle_lot` refuses (`BAD_ACCOUNT`) before reading it | consistent |
| CancelJob, then ClaimJob | Cancel touches neither the link nor the lot. The later claim refunds into owed, then releases | consistent |
| RecordFacilityLoss, then ClaimJob | `lose` touches neither links nor lots. Under D4 the captor's share is out (`refunded` and `claimed = settled`), so `fin` holds at the next ClaimJob, which releases the count with what is still owed (if any) | consistent |
| RetireJob / RetireGrant / RetirePool | RetireJob refuses `owed != 0` or `Pending`. RetireGrant needs no job left. RetirePool needs `occ` empty, so a pool cannot outlive a pending job | consistent |
| Resource, owner and generation mixing | DepositToJob checks `l.resource == resource` (and only ore is enabled). The lot address binds `owner_tag` (derived from the full Citizen key) and the vault generation. A `Pending` link always names its own instance. Old links are refused on tracked lots | consistent |
| Double release | Only `Pending` releases, and it becomes `Released`. The kernel refuses `pending == 0` | consistent |

**Where a pending count can stay forever.** These are not implementation mistakes; each depends on a decision already open.
1. **The job's user never claims.** Only B's ClaimJob releases ("who may trigger", open).
2. **B has no live vault of B's own in the facility's province.** ClaimJob needs one (`user_vault`, `proc/capacity.rs:815`) even when nothing goes into it, so the release cannot run. Allowing a claim without that vault changes ClaimJob's account list: an ABI change that belongs to the same "who may trigger" decision. Not changed.
3. **The lot's vault was seized.** `end_use` is `Forfeited` and the count stays. That is seizure, which is undecided.
4. **A gathered rest below one unit.** That is the sub-unit question, waiting for the owner's answer.

**Limits (unchanged).**
- No test, syntax check or build was run, so the sources and edited host tests are unproven.
- Not adopted: the ABI RSV and link bytes, the version and hash, record kinds, V26.
- Existing worlds not verified, and no migration done.

**This audit is complete for design A.** No safe independent fix remains on this branch without a new decision.

## Test evidence (2026-11-17; one run, by the coordinator, after an independent audit and approval)

**What ran.** Only the kernel regression source, once, at HEAD `43e963d3`:

```
cargo +1.89.0 test --offline --locked -p permutation-rules --test custody_returns --target-dir <dedicated target> -j 1
```

**Source pinned:** `permutation-rules/tests/custody_returns.rs`, SHA-256 `808682e59aaf1547d746a0df08966ad05cf6ccb8cdd900c0a2be26ad4f4cfaec`. Re-checked read-only by Lane C before this note.

**Result:** 9 passed, 0 failed, 0 ignored, 0 filtered. Build 13.30 s, tests 0.00 s.
- The 9 are the 8 cases of the first commit plus `counting_past_the_counter_is_refused_unchanged`.
- This also shows the source compiles, so the borrow fix in `feed` holds.

**Conditions:**
- Registry archive checksums matched the lock, with 1,542 files extracted.
- No network, no keys, no world.
- The dedicated target used 188,424 KiB.
- No code or `Cargo.lock` changed, and nothing was staged.

**Still not verified:**
- the program side: `proc/capacity.rs` handlers and the edited host tests in `capacity_runtime_tests.rs`, which need the `capacity-preview` + `custody-preview` build;
- any integration with other branches;
- ABI adoption: RSV fields, link bytes, version and hash, record kinds;
- V26;
- any migration, or whether an existing world exists.

**The open decisions are unchanged:** the sub-unit rest, who may trigger a return, seizure.

## The sub-unit rest goes home, exactly (2026-11-17; branch `claude/lane-c-lot-rest-home-20261117`, from `7333967e`)

**Approval** (the owner's answer "うん", relayed by the coordinator): when the owner acts, the fraction goes back exactly to their own storehouse in the same province. With none there, or a full one, it is held and the lot does not close.

**Scope of this commit.**
- **Kernel only:** one pure function, `custody::pay_rest_home`, plus a new regression source `permutation-rules/tests/custody_rest_home.rs`. It is a separate file, so `custody_returns.rs` keeps its audited SHA-256.
- **Not touched:** the program handlers, dispatch, ABI tags, error codes (only existing `CustodyError` variants are used), record kinds, version and hash, V26, and migration.
- **Not run.** New test runs wait for the coordinator's own pre-audit and approval.

### What `pay_rest_home(lot_vault, lot, owner, home)` does

| Point | Rule |
|---|---|
| Original owner's authentication | `owner` acts by wallet (`WalletRequired` for a session key, which is stricter than WithdrawLot's kernel) and `owner.citizen == lot.owner` (the full 32-byte Citizen key), else `NotAuthorized` |
| Lot | Must be usable: open, its vault live and of its generation, else `Forfeited`. A seized lot's rest is the seizure question, undecided. It must be tracked; an old untracked lot gets `State` (fail-closed) |
| Destination | `home.live`, else `Forfeited`. `home.owner == lot.owner` (full key; a seized home is the captor's), else `NotAuthorized`. Same `(p, q)` as the lot and not the lot's own tile, else `Order`. No other owner, destination type or permission exists |
| Room | `STORES + x + CUSTODY_QUOTA ≤ CAP`, so others' lots in M's vault keep their reserved room; else `Capacity` |
| Exact milli | Whole units of the gathered rest first go back into the lot (`pay_rest`): whole units stay in custody. Only `x = rest % 1000` goes home, exactly. Nothing is rounded or dropped |
| Books | Lot: `REST −= x`, `CONSUMED −= x`, `OUT_TOTAL += x` (left to the owner's own place, like a withdrawal), so `IN_TOTAL = HELD + OUT_TOTAL + CONSUMED + FORFEITED` holds. Home: `STORES += x` |
| Missing, full or stale | Every refusal leaves the lot and `home` unchanged, so the rest stays held and the lot stays open (`empty` needs `rest == 0`) |
| Double payment | The rest falls by `x` in the same step as the credit; a second call finds nothing below a unit, pays 0 and changes nothing |
| Atomicity (pure function) | Every check runs before any write. The lot is worked on a copy and committed last, and `home.stores` is written only on success. A refusal after the lot's whole-unit return (for example `Capacity`) undoes that return too |

**Paper cases in `custody_rest_home.rs` (not run):**
- 250 milli exactly home, then the lot closes, with a second call paying 0;
- full home, others' quota counted, closed home, seized home, another province, the lot's own tile: all `Err` and unchanged;
- keeper, grantee or a stranger, a session key, another owner's vault, the lot's vault seized, an untracked lot: all refused and unchanged;
- 1,250 gathered gives 1 unit back to the lot and 250 home, and a refusing home undoes both.

### The dispatch contract still to decide (④ and the owner): one concrete candidate

**Candidate.** An owner-only step that takes `[fee_payer s] [season] [citizen (the owner, by wallet)] [lot_vault r] [lot w] [home_vault w]`. Two ways to carry it:
- (a) an optional trailing `home_vault` on **CloseLot (0xCB)**: pay home, then close if empty, in one instruction;
- (b) a separate tag, which **④ allocates**. *(Corrected 2026-11-17: 0xCF is not free; rev 7 reserves it for the land preview. See "The carrier, wired as a preview" below.)*

**The handler would:**
- authenticate the owner with `player_as(Auth::Wallet)`;
- read the lot (`lot_of`), its vault (`vault_of_lot`) and the home (`vault_view`: present, canonical address);
- call `pay_rest_home`;
- write the lot (`put_lot`) and the home (`put_vault`).

A failure after the first write relies on the Solana transaction rollback, as every multi-account custody handler does. `pay_rest_home` itself is all or nothing.

**Also needed before adoption:**
- a record kind for the payout, so V26 can replay it (otherwise its history check sees `CONSUMED` lowered and `OUT_TOTAL` raised without a record);
- the version and hash (`CUSTODY_VERSION`, `RULESET_HASH_V4`);
- the ABI naming of the RSV bytes.

**Not decided here.** Still open: who may trigger a job's return, seizure, ClaimJob's need for B's vault, and any migration or existing world.

## The accounts side of the rest home: an unwired helper (2026-11-17; static, nothing run)

`custody_rest_home.rs` (4 kernel cases) was refused at the safety review and waits for the owner's own confirmation. It was **not run**, here or by any other route.

### What was added

`proc/custody.rs` `pay_rest_home_accounts(p, pl, citizen, lot_vault, lot, home)`, `pub(crate)`, `#[allow(dead_code)]`.

**Not dispatched:** no tag, no account-list ABI, no record kind. It uses only the existing readers and writers: `lot_of`, `vault_of_lot`, `vault_view`, `put_lot` and `put_vault`.

| Point | How |
|---|---|
| Original owner, by wallet, full Citizen key | `pl` must come from `hold::player_as(.., &Auth::Wallet)` on the same accounts. The kernel refuses a session key (`WalletRequired`) and any actor whose Citizen key is not the lot's `OWNER_CITIZEN` |
| Canonical address, season | The lot via `lot_of` (`present_v2` for this season, `expect_key` against its seeds). The lot's vault via `vault_of_lot` (canonical for the lot's tile; absent is `LotForfeited`). `home` via `vault_view` (present, this season, canonical) |
| Live, generation, owner, same province, not the lot's tile, room | The kernel (`pay_rest_home`): a seized home has the captor as owner and fails; `STORES + x + CUSTODY_QUOTA ≤ CAP` |
| Account aliasing | The three accounts must be distinct (`BAD_ACCOUNT`) before anything is read |
| Missing, full, stale | A kernel refusal means no write at all: the rest is held and the lot stays open |
| Double payment | The second call finds nothing below a unit, pays 0 and writes nothing |
| Atomicity | **Corrected 2026-11-17** (the earlier line said the second write "can fail only on a short account", which was wrong: `try_borrow_mut_data` can fail too). **Pure kernel:** `pay_rest_home` is all or nothing on its own copies. **Two-account helper:** every read and check first; then the mutable borrow of each account it will write (the lot if it changed, `home` if paid) is taken **before either write**, so a borrow failure leaves both untouched (since the follow-up commit); then the writes. A write can still fail after the borrows, but only on an offset outside the data (`Lot::encode` checks the length before its first byte; `put_vault_data` writes the offsets `vault_view` just read). Any failure after the first write makes the instruction fail, and **the runtime discards every account change of the transaction**: the helper relies on that rollback for the two writes together, as every multi-account handler here does |
| Record | **None logged**: no record kind exists. Until ④ allocates one, V26 cannot verify the payout |

**Regression source, written, not run.** The tail of `capacity_runtime_tests.rs` `capacity_lot_ore_feeds_a_job_and_what_it_does_not_use_goes_back`:
- after the job retires, M (by wallet, through the real `player_as`) passes the lot's own vault as home and is refused, with the lot unchanged;
- passing M's own live vault on another tile of the province pays exactly 500 milli, leaves the lot balanced, and puts 500 milli in M's vault;
- a second call pays 0 and writes nothing.

### The carrier, for ④ and the owner (not adopted)

| | (a) Optional trailing `home` on CloseLot (0xCB) | (b) A separate owner-only tag (*corrected: not 0xCF, which rev 7 reserves for land; see below*) |
|---|---|---|
| Accounts | Today CloseLot is a fixed 7 accounts with an empty body (`check_accounts_v2(Ix2::CloseLot, a, None)`). It would become 7 or 8: **an existing instruction's public account list changes** in `frontier-abi` v2 tags, the generated `abi-v2-tags.mjs`, and the vectors | `[signer wallet] [payer] [season] [citizen w] [lot_vault r] [lot w] [home w]`, empty body. CloseLot is unchanged |
| Behaviour | Pay home, then close if empty, in one instruction. A missing or full home refuses the whole close and keeps the rest (the approved behaviour). The keeper's close cannot use it (the kernel needs the owner) | Pay home only. The owner then closes with today's CloseLot, in the same transaction or a later one |
| Clients and verifier | Every CloseLot builder and V26's CloseLot replay must learn the optional account and the payout | V26 learns one new instruction. Existing clients are untouched |
| ④'s agreement | Changing an allocated instruction's account list | Allocating a free tag (*corrected: not 0xCF*) |
| Both need | A record kind for the payout; V26 replay and history; `CUSTODY_VERSION` and `RULESET_HASH_V4`; ABI names for the RSV bytes |
| Recommendation | — | **(b)**: no existing instruction or client changes, and the payout is its own replayable step |

**Not decided or done here.** No tag, no account list, no record, version or hash; no dispatch wiring; no migration. The open questions are unchanged: who may trigger a job's return, seizure, and ClaimJob's need for B's vault.

## Kernel test evidence and an atomicity correction (2026-11-17)

**Evidence.**
- **The approval:** the owner explicitly approved ("うん") one run of the four ⑨/⑩ rest-home kernel cases, using no keys, no network and no real world. The coordinator ran them once, after a re-review, at `0a70925e`:

  ```
  cargo +1.89.0 test --offline --locked -p permutation-rules --test custody_rest_home --target-dir <dedicated target> -j 1
  ```

- **Result:** 4 passed, 0 failed, 0 ignored, 0 filtered. Build 2.16 s, tests 0.00 s.
- **Source:** `permutation-rules/tests/custody_rest_home.rs`, SHA-256 `6ec91abd1fde143c00e49fec2a426d305a5db9ae3413c812f1e1f7b45df2bda6`. Lane C re-checked it read-only: the same at `0a70925e` and at `782cb047`.
- **Conditions:** the dedicated target used 192,476 KiB. Afterwards there was no code or `Cargo.lock` diff, nothing was staged, and the 25 media deletions were unchanged.
- **Scope:** this covers **the kernel function only**. The account helper `pay_rest_home_accounts` and its host-test lines were **not** part of the run; they remain unrun.

**Atomicity correction (code and doc).**
- **The problem:** the helper's earlier description said its second write could fail only on a short account. That was inaccurate: `try_borrow_mut_data` can fail too.
- **The minimal fix:** within the existing contract (no ABI, dispatch or permission change), the helper now takes **every write borrow before writing any account**. `put_vault` was split, and `put_vault_data` writes on data already borrowed, with `put_vault`'s behaviour unchanged.
- **The precise contract** is in the helper's doc comment and in the corrected table row above:
  - **pure kernel:** all or nothing on its own;
  - **two-account helper:** a borrow failure means nothing written. Any later failure relies on the runtime's rollback of the transaction.
- **Unrun regression lines** in `capacity_runtime_tests.rs`: with `home`'s data held by a read borrow, the call fails, and the lot and `home` are both unchanged.

## The carrier, wired as a preview (2026-11-17; static, nothing run)

### Correction: 0xCF is not free

Rev 7 of `ABI-ALLOCATION-20261106.ja.md` (line 248) reserves 0xCF as the land preview's spare: "土地の試験の予備（使わない）", and `land_preview.rs` keeps it reserved. My earlier rows said 0xCF was free. They are corrected above.

### The tag check (read-only)

**Occupancy, from the code:**

| Use | Tags |
|---|---|
| v2 table | 86 tags (0xB0–0xBE, 0xC0–0xCC, and below) |
| Reserved | 0x53, 0x80–0x91, 0xA4, 0xA8–0xAF, 0xBF |
| ② rights | 0xD0–0xD5 |
| Wide draft | 0xD6–0xDF and 0xEE |
| ⑳ resident | 0xE0–0xE7 |
| ⑪ extension | 0xE8–0xED |
| ⑨ capacity | 0xF0–0xFD |
| Land | 0xCD–0xCF |
| Unknown-tag tests / test only | 0xFE / 0xFF |

So **0xEF is the only free value in the high bands**: rev 3 lists 0xEE–0xEF as free, and the wide draft took only 0xEE. It is not an M1 tag either.

**Across all 75 local branches** (fixed-string search, branch by branch), 0xEF appears only as an "is not in this band" probe:
- `frontier-abi/src/capacity.rs:666`;
- `world_index/wide_ix.rs:2552`;
- the same lines inside ⑨'s patches.

It also appears in the ledger's "free" row. Nothing assigns it. Those probes stay true, because only a separate opt-in build routes it.

Remote branches not present locally were not searched (no fetch); they are **unknown**.

### What was added (preview only, not adopted)

| File | Change |
|---|---|
| `permutation-frontier/Cargo.toml` | Feature `custody-rest-home-preview = ["custody-preview"]`. Off in every default and deployable build: `scripts/build-frontier.sh` refuses unknown features. **The tag is provisional and unallocated**; there is no version bit and no ABI row |
| `permutation-frontier/src/lib.rs` | One cfg-gated arm before the v2 tags, as the land preview does: `data[0] == 0xEF` goes to `proc::custody::pay_lot_rest_home`. A default build refuses the byte as an unknown tag |
| `permutation-frontier/src/proc/custody.rs` | `REST_HOME_PREVIEW_TAG = 0xEF` (gated). `pay_lot_rest_home(p, a, d)`: the data must be exactly the tag (`BadData`), then exactly `[signer] [payer] [season] [citizen] [lot_vault] [lot w] [home w]` (`TooManyAccounts`), the lot and home writable (`BAD_ACCOUNT`), then `player_as(Auth::Wallet)`, then `pay_rest_home_accounts`. **CloseLot is unchanged**: the owner closes with it afterwards. `rest_home_payload` (36 B: the lot's raw key, the milli paid, the home's p/q/tile, its owner's tag) is **prepared and not emitted**: no record kind exists |
| `permutation-frontier/src/capacity_runtime_tests.rs` | Lines that compile only in the rest-home build, through the real dispatch. **Written, not run.** Data after the tag is `BadData`. Six accounts is `TooManyAccounts`. A non-writable home, the lot's vault as home, and B instead of M are refused, with the lot and home unchanged. After the payment, a dispatch call is `Ok` and pays and writes nothing |

### Static falsification (read)

**Who and where.** The owner acts by wallet: `player_as` authenticates the Citizen and the wallet, and the kernel refuses a session key (`WalletRequired`) and any actor whose Citizen key is not the lot's.

**Which accounts.**
- The lot and home are read at their canonical addresses for this season, and the lot's vault is canonical for the lot's tile.
- The home must be live, of the owner (a seized one is the captor's), in the same province, not the lot's tile, and have room counting `CUSTODY_QUOTA`.
- The three accounts must be distinct.

**Refusals and repeats.** A missing, full or stale home leaves the lot and home unchanged; the rest is held and the lot stays open. A double payment pays 0.

**Atomicity, in two layers.**
- The kernel is pure and all or nothing on its own.
- The helper takes both write borrows before writing either, so a borrow failure leaves both unchanged. It then relies on the runtime rollback only for a failure between its two writes.

**No crosstalk with other bands.** The arm sits after the capacity arm and before land and the v2 tags; 0xEF is in no other band.

**Combinations:**
- `capacity-preview` and the rest-home preview can coexist: the version is `PROGRAM_VERSION_CUSTODY | 0x1000`, unchanged by this feature.
- `wide-world-experimental` with `custody-preview`: a combination not checked.

### For V26 and records (prepared, **not** wired to replay)

V26 treats any custody instruction in a custody season as UNVERIFIABLE at best, and any unknown tag as such. So until ④ allocates a tag and a record kind, a world using 0xEF **cannot verify**. That is honest, and no production replay is pretended.

**The differences needed at adoption:**
1. A record kind for the payout, with `rest_home_payload` as its body.
2. V26 replay: run `pay_rest_home` on the recorded lot and home states (the kernel is already pure), and check `REST`, `CONSUMED`, `OUT_TOTAL` and the home's `STORES`.
3. V26 history: accept the lowered `CONSUMED` and raised `OUT_TOTAL` only together with that record.
4. The tag in the v2 table, or as a recognised band, plus the generated `abi-v2-tags.mjs`.
5. `CUSTODY_VERSION` and `RULESET_HASH_V4`, and the RSV field names.

**Not changed:** the default and deployable builds, CloseLot, the ABI tables, V26, migration. There is still no waiver, no other recipient, nothing permissionless, B's vault is still required, and nothing about seizure.

**Nothing was run.** Only the kernel 4/4 evidence exists, from the coordinator's earlier run.

## Isolation correction: the carrier exists only in host unit tests (2026-11-17; static, nothing run)

### What was wrong

**At `c971b81e`:**
- The 0xEF arm was compiled whenever the feature `custody-rest-home-preview` was on: in host builds, and in SBF if someone passed the feature.
- It had **no program-version bit and no world identity**, so a build with the feature would accept existing custody-preview seasons at the same version.
- Its only barrier was `scripts/build-frontier.sh` refusing the feature name. That is not isolation.

### What changed

| Place | Change |
|---|---|
| `lib.rs` dispatch arm | `#[cfg(all(test, feature = "custody-rest-home-preview"))]`. Only a host unit-test build of the crate has the arm. Every other build (host library, server or keeper dependencies, SBF), with any feature combination, has no arm, so 0xEF reaches `frontier_abi::v2::ix::tag_of` and is refused as an unknown tag |
| `lib.rs` top | `#[cfg(all(target_os = "solana", feature = "custody-rest-home-preview"))] compile_error!(…)`. An SBF build with the feature does not compile |
| `proc/custody.rs` | `REST_HOME_PREVIEW_TAG` and `pay_lot_rest_home` are `cfg(all(test, feature))`. `pay_rest_home_accounts` and `rest_home_payload` stay compiled in custody-preview builds but are unused there (`allow(dead_code)`); no non-test path calls them |
| `Cargo.toml` | The feature's comment now says host-unit-test-only, with no version bit and no world identity: never deployable, never against a world |

**Why not `compile_error!` on `not(test)`.** `cargo test` also compiles the library without `cfg(test)` (for integration tests and doctests), so such a guard would break every test build. Instead the items do not exist outside `cfg(test)`. That gives the same guarantee with no build breakage.

### Combinations checked by reading

| Build | Result |
|---|---|
| Default | No custody module, so no arm |
| `custody-preview` alone, host or SBF | No arm; 0xEF unknown |
| `custody-rest-home-preview`, host, not test | No arm; 0xEF unknown |
| `custody-rest-home-preview`, SBF | Does not compile |
| `custody-rest-home-preview`, host unit tests | The arm exists, against hand-built accounts in the test harness only. No world, RPC or keys |
| With `capacity-preview`, `land-preview`, `wide-world-experimental`, `rights-experimental`, `nft-experimental` | Same as above: the arm needs `test`. 0xEF is in none of their bands |
| `localnet-*-sbf` lanes | They do not enable custody-preview, and SBF refuses the feature anyway |

### Boundary regression source (`proc/custody.rs` `mod rest_home_boundary`; WRITTEN, NOT RUN)

- `the_tag_is_unknown_to_the_v2_table`: `tag_of(&[0xEF])` is an error.
- `without_the_feature_the_dispatch_refuses_0xef` (only without the feature): `crate::dispatch(.., &[0xEF])` is an error.
- `the_carrier_is_compiled_into_host_unit_tests_only` (a source pin):
  - `lib.rs` has the `cfg(all(test, ..))` arm and the SBF `compile_error!`;
  - those are the only two mentions of the feature there;
  - `custody.rs` has no feature-only `cfg`, and exactly two `cfg(all(test, ..))` items;
  - `Cargo.toml` declares the feature over `custody-preview`.
- `the_prepared_payload_is_36_bytes_in_order` (see below).

### The prepared payload, falsified statically (`rest_home_payload`; not emitted)

| Point | Finding |
|---|---|
| Type and length | `[u8; 36]` = the lot's raw key (15: p, q, tile, vault generation, owner tag, resource) + `paid` i64 (8) + home p i16, q i16, tile u8 (5) + home owner tag u64 (8). The total is fixed, with no variable part |
| Owner | The home's `OWNER_TAG` is written from the same Citizen key (`addr::citizen_tag`) as the lot's `owner_tag`, and the kernel has already required `home.owner == lot.owner` (full key). So the two tags in the payload are equal by construction: redundant, and an extra check for V26 |
| Double payment | A record would be emitted only when `paid > 0`. The second call pays 0, so no second record |
| Unknown state | An untracked lot, a seized lot or home, a closed home, a full home: the kernel refuses before any payload exists |
| Not emitted | There is no record kind, so the lot's event chain is not advanced by this step. V26 sees no record |

### Prepared for adoption (not adopted, not wired)

These come on top of the earlier list (record kind, V26 replay and history, ABI table, generated JS, `CUSTODY_VERSION`, `RULESET_HASH_V4`, RSV names). Before this could leave host tests:
1. **④ allocates the tag**: 0xEF or another; the probes in `capacity.rs` and `wide_ix.rs` would then need a different "unused" value.
2. **A world identity:** a program-version bit, or the custody version bumped, so older custody seasons are refused.
3. **A record kind**, with `rest_home_payload` as its body.
4. **V26** learns the instruction and the record.
5. **Only then** remove `test` from the arm's cfg, and replace the SBF `compile_error!` with the usual marker for a non-deployable build.

None of these steps was taken.

## Falsification of the host-test carrier and the account helper (2026-11-17; static, nothing run)

### Found and fixed: whole units given back into the lot were invisible to the prepared record

**The gap.**
- `pay_rest_home` first calls `pay_rest`. When the gathered rest holds whole units and the lot has room, they go back into the lot (`HELD += whole`, `CONSUMED −= whole`, `REST −= whole`) **even when nothing goes home (`paid = 0`)**.
- The prepared 36 B payload had only `paid`, and "record only when `paid > 0`" would have left that change unreplayable by V26.

**The fix (the prepared design only; nothing emitted, no ABI or record adopted):**
- `pay_rest_home_accounts` now returns `RestHome { whole, paid }`. `whole` is derived exactly as `REST before − REST after − paid`, checked to be ≥ 0 (`BAD_ACCOUNT` otherwise).
- `rest_home_payload` is now **44 bytes**: the lot's raw key (15) ‖ `whole` i64 ‖ `paid` i64 ‖ home p, q, tile (5) ‖ home owner's tag (8).
- A record is due when **`whole > 0` or `paid > 0`**.
- V26 replay with it would be: `HELD += whole`, `CONSUMED −= whole + paid`, `OUT_TOTAL += paid`, `REST −= whole + paid`, and the home's `STORES += paid`.

**The kernel `pay_rest_home` is unchanged**, so `custody_rest_home.rs` keeps SHA-256 `6ec91abd…bda6` and its 4-passed evidence still applies.

**Unrun regression source:**
- `capacity_runtime_tests.rs` now expects `RestHome { whole: 0, paid: 500 }`, then `{0, 0}`.
- A new hand-written state with rest 1,250 (books kept balanced) gives `{ whole: 1000, paid: 250 }`, with `HELD +1000`, `CONSUMED −1250`, `OUT_TOTAL +250`, `REST 0`, a balanced lot, and the home at 750.
- The dispatch call after that is `Ok` with nothing written.
- `rest_home_boundary` checks the 44-byte layout for `{1000, 0}` and `{0, 250}`.

**The same visibility gap exists elsewhere, already recorded under design A.** `pay_rest` also runs from the owner's `spend_ship` and from ClaimJob's `settle_lot`, which lower `CONSUMED` without a record. That is design A's open V26 item, not this carrier's.

### Read and found consistent

| Point | Finding |
|---|---|
| Signer, session | `hold::player_as(Auth::Wallet)` goes through `citizen::player_as` and then the shared `ap::player_prologue(.., session_ok = true)`, the same prologue as every player instruction. A session sets `by_session`, and the kernel's `wallet()` then refuses (`WalletRequired`) |
| Owner | The kernel requires the actor's Citizen key, and the home's owner key, to equal the lot's `OWNER_CITIZEN` (full 32 B) |
| Same province, canonical, live, generation | `lot_of`, `vault_of_lot` and `vault_view` check presence, season and canonical address. The kernel checks the lot is usable (open, its vault live and of its generation) and the home is live, in the same `(p, q)`, not the lot's tile, with room including `CUSTODY_QUOTA` |
| Alias | The three accounts must be distinct, before any read |
| Read-only | `lot_vault` is never written. The handler requires the lot and home to be writable. The helper itself does not check writability: it is reached only through the handler (test builds) and the host tests |
| Borrow failure | Every write borrow is taken before either write, so nothing changes |
| Old state | An untracked lot (RSV zero) gets `State`; nothing is written |
| Paying again | `{0, 0}`: no borrow, no write |
| Whole plus fraction | Fixed above. With a full lot, `pay_rest` keeps the whole units (`Capacity` is swallowed), only the fraction goes home, and the lot stays open while `REST ≥ 1` unit |

## The candidate host-test commands, audited read-only (nothing run; for the coordinator's own approval)

**The tests and where they live:**
- `map_growth_runtime_tests` is `#[cfg(all(test, feature = "program"))]` in `lib.rs`.
- Its child `capacity` (`capacity_runtime_tests.rs`) is `#[cfg(feature = "capacity-preview")]`.
- The two lot tests in it are `#[cfg(feature = "custody-preview")]`.
- `proc::custody::rest_home_boundary` is `#[cfg(test)]` in the custody module (needs `custody-preview`).

**Run A, with the carrier:**

```
cargo +1.89.0 test --offline --locked -p permutation-frontier --lib \
  --features capacity-preview,custody-rest-home-preview \
  --target-dir <dedicated target> -j 1 -- --exact \
  map_growth_runtime_tests::capacity::capacity_lot_ore_feeds_a_job_and_what_it_does_not_use_goes_back \
  map_growth_runtime_tests::capacity::capacity_link_count_states \
  proc::custody::rest_home_boundary::the_tag_is_unknown_to_the_v2_table \
  proc::custody::rest_home_boundary::the_carrier_is_compiled_into_host_unit_tests_only \
  proc::custody::rest_home_boundary::the_prepared_payload_carries_whole_and_paid_in_44_bytes
```

**Run B, without the carrier** (the boundary in the other cfg): `--features capacity-preview,custody-preview`, with the same names plus `proc::custody::rest_home_boundary::without_the_feature_the_dispatch_refuses_0xef`. Both lot tests then skip their dispatch blocks.

**Audit of those commands:**

| Point | Finding |
|---|---|
| Build scripts | None in `permutation-frontier`, `frontier-abi` or `permutation-rules` (no `build.rs`). No `[dev-dependencies]` |
| Dependencies | `solana-program =4.0.0`, `ark-ff`/`ark-ec`/`ark-bls12-381 =0.5.0`, `borsh =1.6.1`, and the two path crates. `--offline --locked` needs them already in the local registry; **not checked** |
| What the tests touch | In-process only: `set_syscall_stubs`, a serial `Mutex`, in-memory logs, `set_test_clock`, hand-built `AccountInfo`s. No `std::fs`, network, `std::process`, `env::var` or key generation (wallets and keys are fixed byte arrays). `include_str!` reads three source files at compile time |
| Write targets | The dedicated `--target-dir` only |
| Keys, network, real world | None |
| Feature combinations | `capacity-preview` + `custody-preview` (+ rest-home) is allowed: no `compile_error!`, since only rights or NFT with capacity conflict. Host only; SBF is not involved |
| Size and time | **Not measured.** This builds `solana-program` and the ark crates, more than the `permutation-rules`-only runs (188–192 MiB targets); no figure is claimed |
| Whether they compile and pass | **Unknown.** All of this is unrun source |

## Repair: an existing test module deleted by mistake in `22b613b1`, restored (2026-11-17; static, nothing run)

**What happened (my error).**
- In `22b613b1` I replaced the prepared payload function with a text slice, from its doc comment to the doc comment of `rest_home_boundary`.
- The existing `#[cfg(test)] mod tests` of `proc/custody.rs` sat between those two points: `custody_record_widths`, the key and payload width checks of the nine custody `CQ_SPECS` records.
- So the slice deleted it. Nothing elsewhere replaced it.

**Repair.**
- That block only (32 lines) was copied back from `513f8409`, verified byte-identical, and placed where it was: after the payload function, before `rest_home_boundary`.
- No file was restored or checked out whole.

**Review of every line this branch removes relative to the candidate `d16048aa`.** Every removal is intended:

| File | What is removed, and why |
|---|---|
| `capacity_runtime_tests.rs` | The old lot-test expectations, replaced by design A's (rest on the lot, released once, retires) and `balanced(bell)` |
| `proc/capacity.rs` | The link's 0/1 byte, `pay_owed` (replaced by `settle_lot`) and the owed-only retire check, all design A |
| `proc/custody.rs` | `put_vault`'s `Rw` line, split into `put_vault_data` with the same behaviour |
| `rules custody.rs` | The old `empty` doc line, the `layout` import list (gained `Returns`), and the length-only check in `encode` (it now also refuses an untracked lot with returns) |

There are no other deletions: the report, `Cargo.toml`, `lib.rs` and the two kernel test files only add.

**Regression source added (unrun).** In `capacity_runtime_tests.rs`, a helper case with **`whole > 0` and `paid = 0`**:
- a rest of exactly 2,000 milli, written by hand with the books balanced;
- it gives `RestHome { whole: 2000, paid: 0 }`;
- the lot is written (`HELD +2000`, `CONSUMED −2000`, `REST 0`, balanced) although nothing goes home;
- the home's bytes are unchanged (not written);
- the dispatch call afterwards writes nothing.

This is the case for which a record would be due on `whole` alone.

**Test candidates (read-only audit, unchanged otherwise).** Add `proc::custody::tests::custody_record_widths` to both run A and run B, to show the restored module, for example:

```
-- --exact proc::custody::tests::custody_record_widths …
```

Its body is the same as at `513f8409` and the candidate, and needs only `custody-preview`. Nothing else in the audit changes: no build scripts, no dev-dependencies, in-process stubs only, no file, network or key side effects, writes to the dedicated target only. Registry availability for `--offline`, size and time are **not checked**.

Nothing was run or compiled.

## Host-test pre-audit (2026-11-17; read-only: nothing built, compiled or run, no download)

**Scope.** Only resolution and reads: `cargo tree` / `cargo metadata` with `--offline --frozen`, file hashes, source reads, and `clang --version`. Nothing was downloaded, installed or built.

### Toolchain, configuration, environment

| Item | Finding |
|---|---|
| Toolchain | `rust-toolchain.toml` pins `1.89.0` (profile minimal, rustfmt and clippy). `cargo 1.89.0 (c24e10642)`, `rustc 1.89.0 (29483883e)`, host `aarch64-apple-darwin` |
| Repo `.cargo/config.toml` | Only `[build] target-dir = "permutation-chain/target"`, which the command's `--target-dir` overrides |
| User cargo config | None (`~/.cargo/config.toml` absent). Credentials were not read |
| Environment | No `CARGO*`, `RUST*`, `RUSTC*`, `RUSTFLAGS`, `CC`, `CXX`, `AR`, `CFLAGS`, `SOLANA*`, `SBF*` or `BPF*` variable is set |
| C compiler (for `cc`) | `/usr/bin/clang` and `/usr/bin/cc`: Apple clang 21.0.0, arm64-apple-darwin |
| `Cargo.lock` | SHA-256 `87459163…7bc9`, identical to the candidate `d16048aa`. Not changed |

### Dependency closure and its integrity

- **Resolution.** `cargo tree -p permutation-frontier -e normal,build,dev --target aarch64-apple-darwin --offline --frozen` resolves **170 packages**, the same set with the carrier on (`capacity-preview,custody-rest-home-preview`) and off (`capacity-preview,custody-preview`). Only `permutation-frontier`'s own feature list differs; `frontier-abi` and `permutation-rules` get `capacity-preview,default` in both.
- **Registry crates (167).** All from `registry+https://github.com/rust-lang/crates.io-index`, and **every one checked**:
  - each local archive in `~/.cargo/registry/cache` has a SHA-256 equal to the `Cargo.lock` checksum;
  - every file in every archive (**4,692 files**) is byte-identical to the extracted copy in `~/.cargo/registry/src`.
  - Problems: none. Mismatches: 0.
- **Path crates (3):** `permutation-frontier`, `permutation-rules`, `frontier-abi`.

### Build scripts in the closure (18)

**Two compile C or assembly through `cc` with the system clang:**
- `blst 0.3.17`: probes `clang --version` (and `clang-cl` only on MSVC-type targets), then builds its C and asm. It reads only `CARGO_CFG_*`, `CARGO_ENCODED_RUSTFLAGS`, `CC`, `BLST_TEST_NO_STD` and `CARGO_MANIFEST_DIR`.
- `blake3 1.5.5`: builds its NEON C for aarch64. It reads `TARGET` and `CARGO_CFG_TARGET_ENDIAN`.

**The other sixteen** are `ahash`, `borsh`, `bv`, `curve25519-dalek`, `generic-array`, `libc`, `memoffset`, `num-traits`, `paste`, `proc-macro2`, `quote`, `radium`, `serde`, `serde_core`, `thiserror` and `zerocopy`. Their only processes are `rustc` version or feature probes. `libc` also names `freebsd-version` and `emcc`, for other target OSes only.

**Common to all 18:**
- Writes: only under `OUT_DIR` (`private.rs`, a probe subdirectory), inside the target directory.
- Network: none. Every `http(s)://` match is in a comment.

### The candidate commands (to be approved by the coordinator; not run)

**Run A, with the carrier:**

```
cargo +1.89.0 test --offline --locked -p permutation-frontier --lib \
  --features capacity-preview,custody-rest-home-preview \
  --target-dir <new dedicated dir> -j 1 -- --exact --test-threads=1 \
  map_growth_runtime_tests::capacity::capacity_lot_ore_feeds_a_job_and_what_it_does_not_use_goes_back \
  map_growth_runtime_tests::capacity::capacity_link_count_states \
  proc::custody::tests::custody_record_widths \
  proc::custody::rest_home_boundary::the_tag_is_unknown_to_the_v2_table \
  proc::custody::rest_home_boundary::the_carrier_is_compiled_into_host_unit_tests_only \
  proc::custody::rest_home_boundary::the_prepared_payload_carries_whole_and_paid_in_44_bytes
```

**Run B, without the carrier:** `--features capacity-preview,custody-preview`, the same six names plus `proc::custody::rest_home_boundary::without_the_feature_the_dispatch_refuses_0xef`.

**Where the names come from:**
- `map_growth_runtime_tests`: `#[cfg(all(test, feature = "program"))]` in `lib.rs`; `capacity`: `#[cfg(feature = "capacity-preview")]`; the two lot tests: `#[cfg(feature = "custody-preview")]`.
- `proc::custody::tests` and `rest_home_boundary`: `#[cfg(test)]` inside the custody-preview module.

### Effects, space and identity

| Item | Finding |
|---|---|
| Writes | The new dedicated `--target-dir` only, plus build scripts' `OUT_DIR` inside it. The test code has no `std::fs`, `std::net`, `std::process` or `env::var` (read in `map_growth_runtime_tests.rs`, `capacity_runtime_tests.rs` and `proc/custody.rs`). `include_str!` reads three source files at compile time |
| Keys, network, real world | None. Wallets and keys are fixed byte arrays. `set_syscall_stubs` runs in-process, with a serial `Mutex`, in-memory logs and `set_test_clock`. No RPC, validator, world, launcher or browser |
| Space | 51,951,604 KiB free now (floor 21 GiB). The earlier kernel-only target `wylls-test-target-custody-43e963d3` is 191,548 KiB. **This build's size is not measured**: it adds `solana-program`, the ark crates, `blst` and `blake3` |
| Not the refused tests | `web-frontier-build-walls-items.test.mjs` and `web-frontier-muster-province-full.test.mjs` are JavaScript files under `permutation-gateway/test`, run by Node (`node --test`, `package.json`), checking the web page. The candidates are Rust unit tests of the `permutation-frontier` library, run by `cargo test --lib --exact`. They share no file, runner, language or purpose, and no step of these commands invokes Node or those files |

### Final static check of the target sources (read)

- **Closures:** captures in scope (`program`, `b`, `pl`), and no conflicting borrows of `t`.
- **Slice coercions:** `RefMut`/`Ref` to `&mut [u8]` / `&[u8]` (`encode`, `to_vec`, slice comparison) all hold.
- **Names:** `RestHome` and `rest_home_payload` reach `rest_home_boundary` through `use super::*`.
- **Source pin:** still 2.
- **The restored `mod tests`** is identical to `513f8409`.

**No defect found, so no code changed.** Whether these compile and pass is **unknown until run**.

## Host-test evidence (2026-11-16, about 17:40 UTC; the coordinator's single runs; not re-run)

**What ran.** The pre-audit's Run A and Run B, once each, at HEAD `47ff0bd7`:

```
env -u RUST_LOG cargo +1.89.0 test --offline --locked -p permutation-frontier --lib \
  --features <A or B> --target-dir <dedicated: wylls-test-target-rest-home-47ff0bd7> -j 1 \
  -- --exact --test-threads=1 <the 6 (A) / 7 (B) exact names listed in the pre-audit>
```

- `RUST_LOG` was the only variable present and was unset for the runs. No other override.
- Both use the exact names listed in the pre-audit above. B adds `without_the_feature_the_dispatch_refuses_0xef`.

| Run | Features | Build | Result | Test time | Exit |
|---|---|---|---|---|---|
| A (carrier on) | `capacity-preview,custody-rest-home-preview` | 50.95 s | **6 passed**, 0 failed, 0 ignored, 0 measured, 121 filtered out | 0.01 s | 0 |
| B (carrier off) | `capacity-preview,custody-preview` | 4.70 s | **7 passed**, 0 failed, 0 ignored, 0 measured, 121 filtered out | 0.00 s | 0 |

**Conditions:**
- No warnings in the tool output.
- No change to `Cargo.lock`, the sources or the config. Nothing staged, and the 25 media deletions unchanged.
- The dedicated target used 656,960 KiB.
- Each session was seen to finish with exit 0. `pgrep` could not list processes (its service was absent), so **"no process left behind" is not claimed**.

**Sources pinned, identical before and after** (SHA-256; Lane C re-checked them read-only at `47ff0bd7`):

| File | SHA-256 |
|---|---|
| `permutation-frontier/src/lib.rs` | `da9106becda1ef14010997a866171b874585257b2b0f3c76bd0fd31f59acc873` |
| `permutation-frontier/src/capacity_runtime_tests.rs` | `c7c6e639e2125eec0b54d3df36afd324177888b373c10c893d151eba2592a984` |
| `permutation-frontier/src/map_growth_runtime_tests.rs` | `4b9767cddc250502ecf49996f4b7c0c3d5165c25753fdb1c50548a4da99a7a8f` |
| `permutation-frontier/src/proc/custody.rs` | `99bc4d0e7f242516726c1cdb09021d6a44cb4f4b8e58d898d5bae048b1151fb9` |

**What this shows:**
- design A's lot test (released once, retires, rest on the lot);
- the link states;
- the restored custody record widths;
- the rest-home helper (exact 500; whole 1,000 + 250; whole-only 2,000; the borrow failure; alias; paying again);
- through the host-test dispatch: 0xEF's shape refusals and the no-op;
- the 0xEF boundary in both builds;
- the 44-byte payload.

**Limits.**
- Hand-built accounts and syscall stubs on the host only.
- **Not verified:** a real world, SBF, signatures, the formal ABI, a record kind, V26, migration, integration.
- Nothing here is adopted.

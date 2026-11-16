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
- (b) a separate tag. `0xCF` is the only free tag in the 0xC_ band (allocation rev 7), and **④ allocates it**.

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
| Atomicity | The kernel is all or nothing. Every read and check happens before the writes. The lot is written only if it changed, then `home` only if something was paid. Those are **two accounts**: `put_vault` can fail only on a short account, which `vault_view` already ruled out, and any failure after the first write is undone by the **transaction rollback**, as in every multi-account handler here. The pure function does not rely on it; the helper's second write does |
| Record | **None logged**: no record kind exists. Until ④ allocates one, V26 cannot verify the payout |

**Regression source, written, not run.** The tail of `capacity_runtime_tests.rs` `capacity_lot_ore_feeds_a_job_and_what_it_does_not_use_goes_back`:
- after the job retires, M (by wallet, through the real `player_as`) passes the lot's own vault as home and is refused, with the lot unchanged;
- passing M's own live vault on another tile of the province pays exactly 500 milli, leaves the lot balanced, and puts 500 milli in M's vault;
- a second call pays 0 and writes nothing.

### The carrier, for ④ and the owner (not adopted)

| | (a) Optional trailing `home` on CloseLot (0xCB) | (b) A separate owner-only tag (0xCF is the free tag in the band, per rev 7) |
|---|---|---|
| Accounts | Today CloseLot is a fixed 7 accounts with an empty body (`check_accounts_v2(Ix2::CloseLot, a, None)`). It would become 7 or 8: **an existing instruction's public account list changes** in `frontier-abi` v2 tags, the generated `abi-v2-tags.mjs`, and the vectors | `[signer wallet] [payer] [season] [citizen w] [lot_vault r] [lot w] [home w]`, empty body. CloseLot is unchanged |
| Behaviour | Pay home, then close if empty, in one instruction. A missing or full home refuses the whole close and keeps the rest (the approved behaviour). The keeper's close cannot use it (the kernel needs the owner) | Pay home only. The owner then closes with today's CloseLot, in the same transaction or a later one |
| Clients and verifier | Every CloseLot builder and V26's CloseLot replay must learn the optional account and the payout | V26 learns one new instruction. Existing clients are untouched |
| ④'s agreement | Changing an allocated instruction's account list | Allocating 0xCF (rev 7 lists it free) |
| Both need | A record kind for the payout; V26 replay and history; `CUSTODY_VERSION` and `RULESET_HASH_V4`; ABI names for the RSV bytes |
| Recommendation | — | **(b)**: no existing instruction or client changes, and the payout is its own replayable step |

**Not decided or done here.** No tag, no account list, no record, version or hash; no dispatch wiring; no migration. The open questions are unchanged: who may trigger a job's return, seizure, and ClaimJob's need for B's vault.

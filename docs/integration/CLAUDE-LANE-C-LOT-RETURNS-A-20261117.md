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

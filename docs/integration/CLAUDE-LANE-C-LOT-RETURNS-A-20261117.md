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

# ④ executor and store: claim → intent → send → record → restart → reconcile, checked; one fix (2026-11-17)

**Branch:** `claude/ws04-reconcile-limit-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `8c7f4de1`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged.

**Static change, NOT run:**
- **Not done:** no `cargo`, test or build.
- **Spent:** the earlier one-run approval (`gateway_facts`) is used up and was not reused.

**Provenance:** the executor and store are ④'s own code. What they read and send goes through ports: here the simulated world, or the gateway port's MOCK bridge. **No real chain.**

## The chain, against the executor's own contract (`executor.rs:1-32`, `store.rs:6`, `RUNBOOK.ja.md` §5)

| Step | Source | Holds? |
|---|---|---|
| **Claim** | `Store::claim`: takes or extends a lease; a take-over (another owner, or after expiry) **bumps `lease_epoch`** | yes |
| **Write-ahead intent** | `executor.rs:792-808`: the attempt (`Op::AttemptIntent`, its prepared bytes) is written **in the same transaction as the state change**, with `unless_cancelled`; `if !transition(..) { return Err(Fault::Stale) }`. **A stale or cancelled write sends nothing.** | yes |
| **CAS on every write** | `Store::transition`: `WHERE version = ? AND lease_owner = ? AND lease_epoch = ?` (plus `cancel_requested = 0` / sole-owner-send when asked), in one `IMMEDIATE` transaction. A failed op returns before `commit`, and the dropped transaction rolls back. | yes |
| **Send → record** | `send_and_record`: the row is reloaded after the intent; the send's answer is recorded through the same CAS. **The answer is never taken as the outcome** (`Accepted` → *Submitted*; `Unknown` → stays *Requested*; a refusal is decided only once the bytes are past validity). | yes |
| **Lease lost between send and record** | the record is stale (`Done(false)`); the attempt stays `intent`/`unknown` in the store. The next holder decides it by `status`, and may re-send **the same journalled bytes** (`undecided`, `:906-909`). | yes, and it is the documented limit: **bytes already signed can still be sent after a hand-over or a cancel. Unchanged.** |
| **Restart** | the same identity with a valid lease continues (`tests/common` `restart`); another identity bumps the epoch. Open attempts are decided by `status`, never re-signed. | yes |
| **Fee reconciliation** | `reconcile_fees` → `Store::attempts_to_reconcile(now, 16)` → `status` → `settle_attempt` | **defect, fixed below** |

**What is not claimed:** network exactly-once. No ownership, deadline, authentication or asset rule is new.

## The defect: fee reconciliation starved by rows that never pass validity

**The contract:** `RUNBOOK.ja.md` §5: "期限だけで「課金されていない」と判断しない。各 tick で、有効期間を過ぎた `superseded` と、手数料が未報告の `landed`／`failed` を status で照合する（`reconcile_fees`）".

**What the code did** (`store.rs` `attempts_to_reconcile`, at `8c7f4de1`):
- it selected the candidate rows `ORDER BY id LIMIT 16` **in SQL**;
- **only then** did it keep those past `valid_until` in Rust.

**Why that fails:**
- On the gateway path, `valid_until` is `u64::MAX` (`gateway.rs` `prepare`: not known), so such a row **never** passes validity.
- Once 16 such candidates (for example `superseded` gateway attempts) sit first in `id` order, every call returns nothing. **No later attempt is reconciled again, ever.**
- **Who is affected:** `GatewayPort` keeps the facility step on the simulated chain (`sim.prepare`, slot-based `valid_until`) **in the same store** as its gateway ship attempts. So the facility attempts' fees stay unsettled, and `fees()` keeps them `unconfirmed` for good.

**The fix:**
- `LIMIT` is no longer applied in SQL. Rows are read in the same order, with the same `WHERE`, kept if past validity, and the read **stops once `limit` such rows are collected**.
- `limit == 0` returns nothing, as before.
- **Unchanged:** the statuses selected, the order, the validity rule, `settle_attempt` and `reconcile_fees`.
- **The cost:** one tick reads candidate rows until 16 qualify. Candidates are only `superseded`, or `landed`/`failed` without a fee; any row past validity ends the scan early.

## Regression (written, NOT run): `workstreams/04-execution/tests/reconcile_limit.rs`

**How:** it uses only `Store`, in its own SQLite file (`db_path`), and inserts attempt rows directly (`Store.conn`; the table has no foreign key). No executor, network, key or bind.

| Case | What is checked |
|---|---|
| `never_expiring_rows_do_not_starve_later_ones` | 20 `superseded` rows with `valid_until = u64::MAX`, then one `superseded` and one `landed` (no fee) past validity: both are returned (before the fix: none) |
| `limit_counts_returned_rows_and_filters_are_unchanged` | 20 past-validity `superseded` rows: 16 returned, oldest first, all past validity. An unexpired row, a `landed` row with its fee known and an `expired` row are never returned. `limit` 100 gives the 20; `limit` 0 gives none. |

**Running it needs its own approval:** a `cargo` build like `gateway_facts`', plus this test file. It needs no bind.

## Counter-review (once)

- **The reconciled rows** are still decided by `status`, never by time alone (the runbook's rule).
- **`settle_attempt`** runs outside the run CAS, as before. It only sets a fee status on rows that no run waits on (`superseded`, or `landed`/`failed` without a fee). The fix changes which rows it is offered, not what it writes.
- **Gateway attempts themselves** (`u64::MAX`) are still never reconciled by this path, as before. Their fee is the relay's (`fee: 0`).

## Hand-over (Lane D)

- **Unit:** `claude/ws04-reconcile-limit-20261117` on `8c7f4de1`.
- **Paths:**
  - `workstreams/04-execution/src/store.rs` (M)
  - `workstreams/04-execution/tests/reconcile_limit.rs` (A)
  - `docs/integration/CLAUDE-WS04-RECONCILE-LIMIT-20261117.md` (A)
- **Not run:** anything.

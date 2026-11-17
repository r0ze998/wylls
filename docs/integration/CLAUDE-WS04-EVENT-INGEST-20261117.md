# ④ executor: event ingest (record → wake → cursor) across failures and restarts (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `4ba3970e`. Read with `git show` only.

**Not done:** no `cargo`, test or build. The two-case run approval (`reconcile_limit`) is spent and not reused.

**Verdict:** **no defect within the existing guarantees, so no code change.**
- A wake can be lost, but only a wake: the record is kept, and every open run is looked at again on its own bounded schedule.
- Events are hints and evidence; states change only from canonical reads in `step` (`executor.rs` `ingest` doc).

## The path (`executor.rs` `ingest`; `store.rs` `record_event`, `wake_subject`, `wake_all`, `cursor`, `set_cursor`)

1. `after = cursor("events")`; `chain.events(after, 256)`. **A failed read ingests nothing this tick.**
2. **A gap:** an alert, then `wake_all(now)`.
3. **For each record:**
   - `record_event` inserts it with `INSERT OR IGNORE` by id, committed on its own.
   - **If new**, its subject (a caravan key, or the facility key) is woken with `wake_subject` (`next_check = MIN(next_check, now)`), or everything with `wake_all`.
   - **If already known**, nothing.
4. `set_cursor("events", page.next)` keeps `MAX(value, next)`, so the cursor never goes back.

These are separate statements, not one transaction.

## Failure and restart cases

| Case | What happens | Lost? |
|---|---|---|
| **A duplicate or out-of-order record** | the id is already stored, so it is ignored; the cursor is `MAX`, so it never goes back | nothing |
| **A gap** | an alert, and `wake_all`: every open run is looked at now | nothing |
| **The DB fails after `record_event` and before or during the wake** | `ingest` returns the error; the cursor is not advanced. Next tick (or after a restart) the same page is read; the record is a **duplicate**, so **its wake is skipped** | **the wake only.** The record itself is stored, and `settle_seen`/`raids_seen` read the stored table. |
| **The DB fails after some records and wakes, before `set_cursor`** | the same page is read again; stored records are duplicates; wakes that already happened stand; a wake that failed is lost | the failed wake only |
| **A restart in between** | the same as above: the cursor, the records and the runs' `next_check` are all durable | the failed wake only |

## Why a lost wake does not lose a run (bounded delay)

**A wake only pulls `next_check` earlier.** No non-terminal run waits for a wake alone: every `Next::Wait` in `decide` is bounded.

| Where (`executor.rs`) | Wait |
|---|---|
| `:687`, `:1089` | `now + poll` |
| `:1096` | `now + 1` |
| `:945` (`undecided`, in-flight attempts) | at most `now + poll`, or `valid_until + 1` when sooner |
| `:1450` (in transit) | `arrive_slot.max(now + 1).min(now + 4 * poll)` |
| `:591` | `u64::MAX`, **terminal runs only** (`Fulfilled`, `Partial`, `DeliveredUnverified`, `Failed`, `Cancelled`, `Expired`) |

**Also bounding it:** port errors move `next_check` to `now + poll` (`step`).

**So:** a run whose wake was lost is stepped again **at the latest about `4 × poll` slots later** (with the default `poll` = 2, about 8 slots). It then reads the canonical side and the stored records. **No notification or result is lost; it can be late.** Arrival is never concluded from an event alone.

**Not invented:** no new event identity (the id stays the key), no clock, trust or ownership rule, and no transactional ingest (that would be a design change of ④'s owner's, for timing only).

## Hand-over

- **No code unit this round.** This report is the only file on `claude/ws04-event-ingest-review-20261117` (on `4ba3970e`).
- **Earlier this round:** the `reconcile_limit` run report (2/2 passed) is on `claude/ws04-reconcile-limit-run-20261117` (`18521af2`).

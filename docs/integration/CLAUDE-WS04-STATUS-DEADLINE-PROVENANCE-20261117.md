# ④ execution: the status read, the cancel deadline and provenance (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `51daba36`. Read with `git show` and `git grep` only.

**Not done:** no test, `cargo`, import, syntax check, world, runner, HTTP, RPC, signing or money.

**What it reads:**
- **④:** `src/executor.rs` (`undecided`, `wait_in_flight`, the preflight branch), `src/gateway.rs` (`prepare`, `status`), `src/store.rs` (attempts past validity), `src/ports.rs` (`Prepared`), `src/sim.rs`, `src/view.rs`; and `src/acts.rs`, already covered and not repeated.
- **The readers:** ⑤ `run-receipt.mjs` and `status-query.mjs`, ⑥ `connect/caravan.mjs`.

**Verdict:** **no defect within ④'s contract, so no code change.**
- **No path promotes a deadline or chain evidence it does not have:** an unknown, unread, other-signature or Duplicate case never becomes this run's own confirmed deadline or chain proof.
- **Slots and block heights are never compared with each other.**
- **Two points are for ④'s owner** (§3).

## 1. Where a deadline comes from, and in which unit

| Path | `Prepared.valid_until` | Unit | Used for |
|---|---|---|---|
| **sim** (`sim.rs:772`) | `slot + validity` | **slot** (`ports.rs:194`: "the last slot the request may land in") | `store.rs:730` (attempts past validity: `valid_until < now`, both slots), `sim.rs:793/860` (Pending while `slot <= valid_until`), `executor.rs:860` (a refused send is decided only after `valid_until + 1`) |
| **the agent wallet's gateway** (`gateway.rs:488`) | **`u64::MAX`** ("the gateway picks the blockhash when it sends; not known here") | none: not known | never past by slot. The decision comes only from the wallet's read-only fate (`gateway.rs:569-615`): `landed`/`failed` at finalized; `expired` (proven) or `not-sent` → `Absent`; `pending` → wait; `unknown` → `Unavailable`; anything else is an error. |

**So:** the gateway's `lastValidBlockHeight` (a **block height**) is parsed (`gateway.rs:198`) but is **not** put into `valid_until` (a **slot**). Nothing converts one into the other, and no slot comparison can end a gateway attempt early. **No timestamp-to-slot or height-to-slot conversion exists or is added.**

## 2. Status and provenance on the gateway path (`gateway.rs` `status`)

| The wallet's answer for the attempt's key | Run status | Promotion? |
|---|---|---|
| refused, or failed with `sent: false` known | `Absent` | no: nothing left (the wallet's own evidence) |
| failed with no signature, older gateway | `Unavailable` | no: held |
| signed: fate `landed`/`failed` (finalized) | `Landed`/`Failed` (via the sim's placement of that signature) | **chain evidence comes from the wallet's finalized fate,** not from the run's own reading. That is ④'s adopted design (module doc: "decides only at finalized"). |
| signed: fate `expired` or `not-sent` | `Absent` | the wallet's proof (lifetime past, history covering it) |
| fate `pending` / `unknown` / `unqueryable` / anything new | `Pending` / `Unavailable` / error | no |
| no answer recorded, within the lookup grace / after it | `Pending` / `Unavailable` | no |

**A Duplicate** (the wallet's `failed` + `Duplicate` with the earlier signature S, for a seq action):
- the attempt's `signed()` is S, the fate follows S, and a finalized S is counted as this attempt's landing;
- the wallet's own rule says a seq Duplicate is "these exact bytes … already left in an earlier submission", **the same transaction**. So the effect counted is exactly this attempt's content.
- **Whether the earlier submission's send may count as this run's is the open ownership question** shared with ③ and ⑬. It is not decided here. The **effect** is not misattributed: the same bytes are the same effect.

**The cancel deadline** (`executor.rs:885-940`):
- `until = max(valid_until)` over the undecided attempts; on a cancel request, `CancelPhase::AwaitingSigned { until }` is recorded once (`wait_in_flight`);
- **the sim path:** a slot, consistent with the rest;
- **the gateway path:** `u64::MAX`, which reads as "may still land; no known end". It **never** completes a cancel early, and completion waits for the attempt's own decided status.

## 3. For ④'s owner (not changed here)

1. **`u64::MAX` as "unknown" leaks into the run view.**
   - **Where:** on the gateway path, `cancel_phase: {AwaitingSigned: {until: 18446744073709551615}}` and `attempts[].valid_until` (`view.rs:52`).
   - **Who sees it:** JSON readers in JavaScript (⑥ `connect/caravan.mjs:397` passes `cancel_phase` on) parse it as `18446744073709552000`.
   - **Why it is not a defect:** it is conservative, never an early end.
   - **What is open:** an undocumented sentinel. Making it `null` (or leaving `until` out) changes the view's shape (`p04-run/0.1`, `CancelPhase` serde), which is ④'s contract to decide.
   - **Not done:** putting the gateway's `lastValidBlockHeight` there instead would mix a block height into a slot field.
2. **Duplicate ownership** (above): the owner's question, shared with ③ (Lane D) and ⑬.

## 4. Static counter-review (once)

- **`store.rs:730`'s past-validity scan:** with `u64::MAX`, gateway attempts are never listed as past validity, so nothing re-decides them by slot.
- **`executor.rs:860`:** a refusal with bytes waits until `valid_until + 1`. For the gateway that is `u64::MAX.saturating_add(1)`, which equals `u64::MAX`: it is decided by the fate (`status`), not by time. A preflight `Refused` (no bytes) is decided at once, as designed.
- **Readers that treat `until` as a block height** (⑤ `status-query.mjs:77`, from the act receipt) read the **act** receipt's `lastValidBlockHeight`, not the run view's slot `until`. They are separate fields, and neither is converted.

**Executed:** nothing. **Not connected:** any real chain. The gateway path's chain is the agent wallet tests' scripted chain behind the test bridge (`gateway.rs` module doc).

**Next, one concrete step:** ④'s owner decides whether `AwaitingSigned.until` and `attempts[].valid_until` on the gateway path should stay `u64::MAX`, or become `null` under a raised view version.

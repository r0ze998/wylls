# ⑬ resident: a SendFailed that may have left keeps its key (2026-11-17)

**Branch:** `claude/ws13-sendfailed-same-key-20261117`, from the canonical candidate `claude/canonical-candidate-20261116` at `d16048aa` (`resident.mjs` there is blob `46d0063e`, the same as at `73f4984b`).

**Static change, NOT run, NOT integrated:**
- **Not done:** no test, old or new; no import, syntax check, model, HTTP, RPC, authentication, signing or world.
- **Not run in any form:** ⑬'s guard tests and the other refused items (H, G, walls, muster).
- **Not traced:** dependency closures and runnability.
- **Not touched:** C and D files.

**Background:** the reading is `docs/integration/CLAUDE-WS13-RESIDENT-UNQUERYABLE-BOUNDARY-20261117.md` §5 (integration branch, `73f4984b`).

## Files

| File | Change |
|---|---|
| `workstreams/13-citizens/resident/resident.mjs` | `#run` only: a `fromSubmit` flag, and the `mayHaveLeft` branch |
| `workstreams/13-citizens/test/sendfailed-may-have-left.test.mjs` | new, **written, not run** |
| `docs/integration/CLAUDE-WS13-SENDFAILED-SAME-KEY-20261117.md` | this report |

## The defect

- **Before this change**, `#run` treated as ambiguous only `status: 'unknown'` or code `Transport`.
- **Every other answer that was not `sent`** went to `#retryOrFail(code)`.
- **`SendFailed` is in `TRANSIENT`** (`resident.mjs:55`), so it became `attempts + 1`: a **new key `key#aN`**.

**What the agent wallet means by `SendFailed`** (`permutation-gateway/src/frontier/agent/gateway.mjs`):

| Case | Answer | Did it leave? |
|---|---|---|
| The send threw after the signature was recorded | `#run` `:714`: `failed`, `SendFailed`, `sendFacts(signed)` = `sent: true`, `signature`, `lastValidBlockHeight`, `slotFloor` | **may still land** (`contract.mjs:162-168`) |
| The same key, saved without a final response; or an older key with an unverified send | `:558, :560`: `SendFailed` 409, with the prior `signature` | **possibly** |
| An exception before sending | `:708`: `failed`, `SendFailed`, `sent: false` | no |
| State not writable; request journal full | `:549`; `ledger.mjs:237`: `SendFailed` 503 | no |

**Why this broke a rule:** a new key after the first two cases can execute one intention twice. That contradicts ④'s `EXECUTION-CONTRACT-20261106` §1 (only `not-sent` and `expired` allow a new attempt, quoted at `resident.mjs:69-74`) and ⑬'s `08-retention-contract` R4 (an unknown result is never a reason to resend).

## The change (`#run`, `resident.mjs:495-532`)

```js
let fromSubmit = false;          // set when this call submitted (status had no answer)
...
const duplicate = res.error?.code === 'Duplicate' || res.duplicateOf != null;
const ownSignature = typeof res.signature === 'string' && res.signature !== '';
const mayHaveLeft = fromSubmit && res.status !== 'sent' && !ambiguous && !duplicate
  && (res.sent === true || ownSignature || (res.error?.code === 'SendFailed' && res.sent !== false));
if ((res.status === 'sent' || ambiguous || mayHaveLeft) && !recordedBefore) this.#countAction(it);
...
else if (mayHaveLeft) Object.assign(it, { state: 'sent', lastError: res.error?.code ?? 'MayHaveLeft' });
else this.#retryOrFail(it, res.error?.code ?? 'Unknown');
```

**The order of the branches, unchanged except for the new one:**
1. `sent`;
2. ambiguous (`unknown`, or `Transport` without fate `failed`);
3. **may have left (new)**;
4. otherwise `#retryOrFail`, as before.

**What does not change:**
- **Answers from a status read** (`fromSubmit` false): ④'s readings, including a final `failed`, `not-sent` or `expired`, are taken exactly as before. Nothing already decided becomes unknown.
- **Definite refusals** (`refused` with a code, no `sent: true`, no signature): unchanged. `BucketEmpty` and `QuotaExceeded` stay transient; any other code fails.
  - The test world's refusals (`world/testworld.mjs:115-126`) and the `ws04-run` port's (`resident/ports/ws04-run.mjs:134-141`) carry neither `sent` nor a signature.
- **`SendFailed` with `sent: false` and no signature:** still transient (a new key after the backoff), because nothing left.
- **`sent: false` with a signature** is contradictory: it is treated as may-have-left.
- **Duplicate** (`error.code === 'Duplicate'` or `duplicateOf`): unchanged. It still goes to `#retryOrFail('Duplicate')`, so it ends `failed` with no resend. Its signature is another send's; it is **not** recorded as this line's send and not taken as evidence of success (see "Left open").

**What a may-have-left line becomes:**
- `state: 'sent'` under its existing `sendKey`;
- `lastError` = the code (`SendFailed`), or `MayHaveLeft` when the answer has none;
- **no `it.signature`**: a signature is recorded only for a `sent` answer, as before;
- `#reconcile` reads the key's fate:
  - `landed` → landed;
  - `failed`, `not-sent` or `expired` → `#retryOrFail`, as for any sent line, with cancel and revocation taken into account;
  - `unknown`, `unqueryable` or an exception → held, then `unresolved` after a day.
- **`#reconcile`'s resubmit** (`:630`) needs `lastError === 'Transport'` and a status of `null`. For every answer the contract allows, a may-have-left line's `lastError` is `SendFailed` or `MayHaveLeft`, so it is read, not resubmitted. **Corrected (see the last section):** an answer outside the contract with code `Transport` would keep `lastError: 'Transport'` and could be resubmitted under the same key.

**Unchanged:**
- **Counting:** `#countAction` stays once per `sendKey` (the `counted` guard).
- **The rest:** `#reconcile`, `cancelAction` and `#applyRevocation` (these test `lastError === 'Transport'` only for `intended` lines, and a may-have-left line is `sent`); retention; both ports; the send authority (`submit`'s request fields).

## The regression (`test/sendfailed-may-have-left.test.mjs`, written, NOT run)

**Harness:** the same as `transport-uncertain.test.mjs` (`helpers.mjs` `small`/`run`). The first two status reads are hidden (`null`), so the first tick shows `#run`'s result. The answers are made-up wallet shapes (`FAKE-SIG-*`); nothing is signed.

| Case | Expected |
|---|---|
| `SendFailed`, `sent: true`, signature (the send reached the test world) | `sent`, same key, attempts 1, `lastError` SendFailed, no `signature`, counted once; after 8 ticks one key submitted in total, and `landed` |
| `SendFailed`, signature, no `sent` field (409 shape) | the same |
| `SendFailed`, no `sent`, no signature | the same |
| `SendFailed`, `sent: false`, no signature (did not reach) | `intended`, attempts 2, not counted (unchanged) |
| `SendFailed`, `sent: false`, with a signature | `sent`, same key, attempts 1 |
| `Duplicate` with `duplicateOf` and signature | `failed`, not counted (unchanged) |
| `refused` `BucketEmpty` / `ActionNotAllowed` | `intended` / `failed` (unchanged) |

**About running it:** its import closure includes `world/harness.mjs` and the resident, which is the same family as ⑬'s other tests. Whether and how it may be run is the owner's decision. It was not run and not traced here.

## Not hidden

- **No production `send` is connected for ⑬.** `ws04ActsPort` takes `send(req)` from its caller, and the only `send` in the tree is the test stack's (`test/stack.test.mjs:91-101`).
- **How a real caller turns the wallet's HTTP 409/503 into a result** is not decided by any contract. If it throws, the line is `Transport` (ambiguous), as before. If it returns `{status: 'failed', error: {code: 'SendFailed'}}` without `sent: false`, the line is now held under its key.
- **This change protects the answer shapes the wallet itself returns.** It does not establish the assembly.

## Left open (not changed here)

1. **Duplicate of a seq action (SendCaravan).**
   - **The wallet's advice:** "follow it, do not resend" (`gateway.mjs:695-704`).
   - **What ⑬ does:** ends the line `failed`, with no resend, and never follows the earlier signature's fate.
   - **Not changed here:** whether ⑬ should follow it, and whether an earlier signature may count as this line's own effect. Lane D is looking at the same question for ③. ⑬ must not upgrade it to this line's success evidence before that answer.
2. **A status reading of `not-sent`** (④ `fateOfReceipt` → `status: 'refused'`, no code) reaches `#retryOrFail('Unknown')` and ends `failed`. It does not get a new key, even though ④ allows a new attempt. This is unchanged and conservative: no double send, at most a missed retry.
3. **ws04-run port:** a `StoreError` or `Spawn` from `accept` is thrown, which makes it `Transport`, ambiguous: read back under the same key. Unchanged.

## Static counter-check after the change (read only, nothing run)

1. **Every way into `#run`** (`resident.mjs:593` `#reconcile`, `:616` resubmit, `:740`, `:990` enact) reaches the new branch only through `submit`.
   - A `status` answer that is not null skips `submit`, so `fromSubmit` stays false and the old path applies.
   - A resubmit re-enters with the same `sendKey`, which is unchanged.
2. **The answer contract:** ⑬'s `ActionResult` is the agent wallet's shape (`resident/ports/execution.mjs:1-12`; `03-contracts.ja.md:33-39`).
   - In the wallet, a `failed` that carries a signature is either this request's own send after signing (`sent: true`, may land) or a Duplicate's other send (excluded).
   - No `failed` with a signature means "executed and failed". A definite chain failure comes only from a status reading (④'s `failed`), which this branch does not judge.
3. **The other answer producers in ⑬:**
   - the test world (`world/testworld.mjs:115-144`: `refused` without signature, or `sent`);
   - `ws04-run` (`:134-143`: `refused` without signature, `sent`, or a throw);
   - `ws04-acts` (`BadKey` `refused`, or the caller's `send`).
   None of them yields `sent: true`, a signature on a non-`sent` answer, or `SendFailed`, so their behaviour is unchanged.
4. **`Transport` with fate `failed`** (`ambiguous` false): it has no `sent` and no signature, so `mayHaveLeft` is false and `#retryOrFail('Transport')` applies, as before. Whether it should be ambiguous too is not changed here.
5. **A replayed wallet answer** (`replayed: true`) of an earlier `SendFailed` + `sent: true` has the same shape, so the same key is held. A replayed `sent` is unchanged.
6. **Counting:** `recordedBefore` needs `landedBell`, which wallet answers do not carry, so a may-have-left answer is counted once for its key. A later `landed` reading for that key adds nothing (`counted` guard).
7. **CI:** `.github/workflows/ci.yml` runs on push, and the commit message carries `[skip ci]`. `gh run list` for this branch shows no run.

## Correction: an out-of-contract `Transport` answer can reach the same-key resubmit

**The claim corrected:** the comment in `#run` and the paragraph above said a may-have-left line is "not Transport", so it is only read back. That holds for the answers the contract allows, but not for every answer.

**The case:**
- A submit answer `{status: 'failed', error: {code: 'Transport'}, fate: 'failed', signature}` is not ambiguous, because of the old rule's `fate !== 'failed'` guard.
- It *is* may-have-left (it has a signature), and `lastError` copies the code: `'Transport'`.
- `#reconcile` can then take it into the same-key resubmit (`:630`): status `null` (no record), `unclear >= 3`, within retention, no cancel, fewer than `maxRetries` resubmits.

**Reachable? No, not for any producer the contract defines:**
- **The answer contract:** ⑬'s `ActionResult` (`resident/ports/execution.mjs:11-12`; `03-contracts.ja.md:33-39`) gives `submit` no `fate`. `fate` belongs to `status` answers, and `#run` judges those with `fromSubmit` false, outside the new branch.
- **The only `Transport` in ⑬** is the resident's own catch (`resident.mjs:504`: `status: 'unknown'`, no fate, no signature). That is ambiguous first, so it never reaches the new branch.
- **The other producers:** the agent wallet's error codes have no `Transport` (`contract.mjs` `ERR`). The test world, `ws04-run` and `ws04-acts` never answer with it (a `grep` at `b18a0f10`).
- **The `fate !== 'failed'` guard** dates from the first commit of the rule (`f637c7a5`). It is defensive, and its real use is a status answer.

**Safe even if a caller's `send` produced it anyway:**
- The resubmit uses **the same key** (`#run` with `attempts` unchanged), which R1/R2 and the wallet's never-deleted request record make idempotent.
- It never creates a new key, it is counted once (`counted` guard), it is blocked by a cancel request (`!it.cancelRequested`), and it needs ④ to say there is **no record** of the key. With `ws04-acts` that means never registered, so never sent (R5).
- A decided `failed` is still honoured: `#reconcile` reads the key's own fate and takes `failed` to `#retryOrFail`, as before. This happens one reading later, never as `unknown`.

**Decision:** there is no contract-backed inconsistency, so **no code change**. Only this report is corrected, and the `#run` comment's "not Transport" is to be read as "not Transport for any answer the contract allows". A tighter wording of that comment can go with any later code change. It would need to say: the new branch's `lastError` is the answer's own code; with an out-of-contract `Transport`, the same-key resubmit applies.

**Regression, written and not run** (`test/sendfailed-may-have-left.test.mjs`, two added cases):
- **The out-of-contract answer, with "no record" for 8 reads, over 16 ticks:** every submit of the action is under its first key, the attempts stay 1, and it is counted once.
- **The same answer with a cancel after the first tick:** this action is not submitted again, and the key, the attempts and the count are kept.

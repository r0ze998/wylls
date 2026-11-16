# ⑬ resident: `unqueryable` and exceptions at the send boundary, against R1/R2/R5 (2026-11-17)

**Scope:** a static reading of ⑬'s business code only. All files were read at `844fc371` with `git show`:
- `workstreams/13-citizens/resident/ports/ws04-acts.mjs` (`fateOfReceipt`, `ws04ActsPort`);
- `resident/resident.mjs` (`#run`, `#reconcile`, `#retryOrFail`, `cancelAction`, `#applyRevocation`);
- `08-retention-contract.ja.md` (R1–R5) and `WORK-20261106b.ja.md`;
- ④ `src/acts.rs` (`refresh`, `receipt`);
- the agent wallet `permutation-gateway/src/frontier/agent/gateway.mjs` (`action`, `#run`, `actionFateView`, `sendFacts`) and `ledger.mjs` (`requests`).

**Not done:**
- No test, import, syntax check, model, HTTP, RPC, signing or world; no product change.
- This is **not** a substitute for the held items: refused group G (③ `game.mjs`, seal-worker), ⑬'s guard tests, or any dependency closure, runner or runnability check. None of those was looked at.
- C and D files were not touched.

**Excluded:** the refused commit `17f4cca4` is not on this branch.

**Correction to `CLAUDE-WS04-ACT-READVIA-PROVIDER-20261117.md` §5 ④-1:** it said ⑬'s `toWs13Status` throws on `unqueryable`. ⑬ does not use that helper (`ws04-acts.mjs:13-14`; `WORK-20261106b.ja.md:24`). ⑬'s own `fateOfReceipt` throws `Unqueryable` for `unqueryable` and for any state it does not know (`ws04-acts.mjs:25-27`). The conclusion is unchanged: ⑬ never reads `unqueryable` as an answer.

## 1. The adapter (`ws04-acts.mjs`)

| Call | ④ answers | ⑬'s port returns | Contract |
|---|---|---|---|
| `status(key)` | receipt with a known state | `{ok, status, fate, ws04, signature?, fateError?}` (`registered` read as `pending`) | R4: `unknown` stays `unknown` |
| `status(key)` | receipt `state: "unqueryable"`, or a state not in the known set | **throws `Unqueryable`** | R5: a temporary inability is an exception |
| `status(key)` | `NoRecord` (exit 3) | **`null`** ("never registered: never sent") | R5: null only when no record |
| `status(key)` | any other client error (spawn, store) | **throws `Unqueryable`** | R5 |
| `submit(req)` | — | `register` (source `resident`), **then** `send(req)` under the same key. A key over 128 characters is refused before anything. | — |

**Is `null` really "never sent"?** Yes. `submit` awaits `register` before calling `send` (`ws04-acts.mjs:60-61`), so a key ④ has no record of was never handed to `send`, provided it went through this port. ④ never deletes an act row (`acts.rs` `RETENTION_BELLS = None`; `08-retention-contract` R1 at `:40`).

## 2. `#run` (`resident.mjs:480-517`): what an exception becomes

```
try { res = await status(sendKey) } catch { res = null }        // :496
if (!res) { submit(same sendKey) … catch → {status:'unknown', error:{code:'Transport'}} }   // :497-503
```

**A `status` exception here is not taken as proof that nothing was sent.** The line goes on to submit **the same key** (`sendKey` is `key`, or `key#aN` for attempt N; it is not changed at `:496-503`). The comment at `:494-495` gives the grounds: "the same key never executes twice (08, R1/R2)".

**Does the same key really never execute twice? Checked at the wallet:**
- `POST /f/agent/action` looks up `ledger.request(agentId, key)` first (`gateway.mjs:556-561`), and an in-flight request with the same key joins it (`:550-554`). A prior with the same request hash returns the recorded result with `replayed: true`. A different hash gets `IdempotencyConflict`. A prior with no final response, or an older key with an unverified send, gets `SendFailed` 409, so nothing new is built.
- `ledger.requests` entries are **never deleted**. The only writes are `ledger.mjs:275, 604, 615`, and there is no `delete`. At 2,000 keys the wallet fails closed, refusing new sends (`:45, 237`), rather than forgetting a key.
- So R1 (the same answer for the same key and body) and R3 (a forgotten key is never executed) hold for this port in practice. The port's `retentionBells: Infinity` (R2) rests on ④'s registry, and the wallet's own request record also keeps every key.

**A `submit` exception** becomes `status: 'unknown'`, code `Transport`. The line is marked `sent` (`lastError: 'Transport'`) and counted, then read by `#reconcile`. It is never retried as a new key.

## 3. `#reconcile` (`resident.mjs:591-623`): what an exception becomes

```
try { s = await status(it.sendKey) } catch { s = { fate: 'unknown', unavailable: true } }   // :596
```

- **A thrown status** (`Unqueryable`, or the registry unavailable) falls through to "no definite answer": `unclear` is incremented and the next read is backed off. **It is never resent.**
- **The resubmit branch (`:613-618`)** needs `s === null` (④ has no record), `lastError === 'Transport'`, the retention window, no cancel request and fewer than `maxRetries` resubmits. A thrown status is never `null`, so **an exception never reaches resubmit.**
- **When resubmit does happen,** it re-enters `#run` with the same `sendKey` (`it.state = 'intended'`, `attempts` unchanged). It is the same-key retry, not a new key.
- **New keys (`#a2`, …)** come only from `#retryOrFail`. In `#reconcile` that is reached only for ④'s `failed` (final, `fateError`) or `expired`/`not-sent` (`NOTHING_HAPPENED`, final). **Never from `unknown`, `unqueryable` or an exception.**
- **After a game day** without an answer, the line becomes `unresolved` and is reported in `owed()`.

## 4. The four moments, when `status` is `unqueryable` or throws

| Moment | Journal line | What happens | Safe? |
|---|---|---|---|
| **First attempt** | `intended`, never submitted | `#run`: the throw → `null` → `submit(key)`, which registers (idempotent) and then sends. If `register` itself throws, `send` is not called. The line becomes `sent`/`Transport` (counted; nothing left). `#reconcile` then reads `null` once ④ answers, and after `UNCLEAR_BEFORE_RESUBMIT = 3` unclear reads resubmits **the same key**. | **Yes.** Same key. A registered-but-unsent act reads `unqueryable` from the wallet (`actionFateView`: "no action under this key is retained") and is submitted under the same key: the intended retry. |
| **Restart** after a crash between submit and save (`#crashAt('after-submit')`) | still `intended` on disk | `#run`: the throw → `null` → `submit(key)` with the same key. The wallet replays the recorded result (`replayed: true`), or answers `SendFailed` 409 when the prior has no final response. | **Same key: yes.** But the `SendFailed` answer can lead to a new key (§5). |
| **After a send** | `sent` | `#reconcile` only: the throw → held, backed off, never resent. `#run` does not run for `sent`. | **Yes.** |
| **After a cancel** | `cancelRequested` set | `cancelAction`: an `intended` line that may have been sent (`Transport` with a `sendKey`) becomes `sent`, read only. `#reconcile`: the throw → held. Resubmit is blocked by `!it.cancelRequested`. A failed or not-happened fate ends as `cancelled` with no new attempt. | **Yes.** |
| **(Revocation)** | — | `#applyRevocation`: a maybe-sent `intended` line becomes `sent` (read only); others become `revoked`. | **Yes.** |

## 5. A real inconsistency: `SendFailed` is retried as "transient" under a new key

**Where:** `resident.mjs:55` puts `SendFailed` in `TRANSIENT`. In `#run`, `ambiguous` is only `res.status === 'unknown'` or code `Transport` (`:510`). Any other non-sent answer goes to `#retryOrFail(code)` (`:515`). With `SendFailed`, that is `attempts + 1`: a **new key `key#a2`**, sent once the backoff has passed.

**What the wallet means by `SendFailed`** (`gateway.mjs`):

| Case | Wallet answer | Did something leave? |
|---|---|---|
| An exception after the signature was recorded (`sending`) | `status: 'failed'`, `error.code: 'SendFailed'` (`refused()` for a non-RouteError, `:629`), **`sent: true`, `signature`, `lastValidBlockHeight`** (`sendFacts(signed)`, `:714`); the contract says it "may still land" (`contract.mjs:162-168`) | **Possibly: it may land** |
| An exception before sending (RPC down while building) | `status: 'failed'`, `SendFailed`, `sent: false` (`:708`) | No |
| The same key with a saved request but no final response, or an older key with an unverified send | `SendFailed` 409 (thrown, `:558, 560`), with the prior `signature` | **Possibly** |
| Wallet state not writable, or the request journal full | `SendFailed` 503 (`:549`; `ledger.mjs:237`) | No |

**The effect:** in the first and third rows the earlier attempt may still land, and `#run` starts a new key for the same action. That is two executions of one intention. It contradicts:
- ④'s rule that only `not-sent` or `expired` allow a new attempt (`EXECUTION-CONTRACT-20261106` §1, quoted at `resident.mjs:69-74`);
- ⑬'s own R4 (an unknown result is never a reason to resend).

**This is the one path found where an error answer is treated as "nothing happened".**
- **What happens next:** the `#a1` key is left with no journal line of its own. `it.sendKey` moves to `#a2`, so `#reconcile` never reads `#a1` again.
- **What it is not:** it is not the intended same-key retry, which is safe (§2).

**Not decided by contract, and therefore not changed:** how a caller's `send(req)` turns the wallet's HTTP 409/503 into a result. ⑬'s only `send` today is the test stack's (`test/stack.test.mjs:91-101`), and the real wiring is the caller's.

### Minimal fix candidate (not made)

In `#run` (`resident.mjs:510-515`):
1. Treat an answer that may have left as ambiguous: `res.sent === true`, or a `signature` (or `duplicateOf`) present, or `SendFailed` without `sent === false`.
2. Do it the same way as `Transport`: keep **the same `sendKey`**, set `state: 'sent'`, and let `#reconcile` read ④'s fate.
3. Keep `SendFailed` with `sent === false` as transient: it is proven that nothing left.

**Acceptance:**
1. A wallet answer with `sent: true` or a signature never leads to a new key. The line is `sent` under its existing key, and `#reconcile` decides from ④'s fate (landed, failed, `NOTHING_HAPPENED`).
2. A new key still comes only from `not-sent`/`expired`, from ④'s final `failed`, or from a pre-send answer with `sent: false` or a code that proves no send (`BucketEmpty`, `QuotaExceeded`).
3. Counting: a maybe-sent answer is counted once per key (`#countAction`), as `Transport` is today.
4. No change to `#reconcile`'s resubmit rules, cancel, revocation, retention or the adapter.
5. Any regression is written, not run, until approved.

**Owner:** workstream 13. Its guard tests stay held, so the fix is a candidate only.

### Related, also not changed: `Duplicate` of a seq action (SendCaravan)

- **The wallet:** answers `status: 'failed'`, code `Duplicate`, `sent: null`, `duplicateOf` and `signature` ("follow it, do not resend", `gateway.mjs:695-703`).
- **`#run`:** sends it to `#retryOrFail('Duplicate')`. `Duplicate` is not transient, so the line ends `failed`, with no resend.
- **The problem:** the earlier send's fate is never followed, so a delivery that does land is recorded as failed.
- **The candidate:** treat it with the same rule as above, ambiguous under the same key.

## 6. Summary

**Safe by contract, with source grounds:**
- every path where `status` throws or reads `unqueryable`, at the first attempt, after a send, after a cancel, and at revocation;
- the same-key submit at a restart.

The grounds are R5 (exception, not `null`), `null` only for ④'s `NoRecord` with `register` before `send`, and the wallet's never-deleted per-key request record (R1/R3).

**An exception never becomes evidence of not-sent.**

**One real inconsistency** (§5): the wallet's `SendFailed`, which can mean signed and may still land, is retried under a new key. **A fix candidate and its acceptance conditions are given; nothing is changed.**

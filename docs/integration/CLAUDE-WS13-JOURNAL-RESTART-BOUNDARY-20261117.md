# ⑬ resident: journal persistence across restarts, around the send and the cancel (2026-11-17)

**Scope:** a static reading of ⑬'s business code only. Read at `b48b4cc9` (this branch; its `resident.mjs` includes the may-have-left change):
- `workstreams/13-citizens/resident/resident.mjs` (constructor, `save`, `#intent`, `#enact`, `#duties`, `#run`, `#reconcile`, `cancelAction`, `#applyRevocation`, `#crashAt`);
- `resident/ports/ws04-acts.mjs`;
- `permutation-gateway/src/config.mjs` `createStateStore`;
- the agent wallet's `actionFateView`;
- ④ `acts.rs` `refresh` and `receipt`.

**Not done:**
- No test, import, syntax check, model, HTTP, RPC, signing or world.
- Out of scope: signing keys, dependency closures, guard tests, the runner and runnability.
- Not touched: C, D and `receipt-port.mjs`.

**Verdict:**
- **No restart window found that makes a wrong new attempt, or a resend after an acknowledged cancel.**
- **No code change.**
- Three findings (§4) are written up as decisions or blockers, not fixed.

## 1. What is persisted, and how

- **The file:** the whole resident state lives in one JSON document, `state.json`: journal lines with `state`, `attempts`, `sendKey`, `counted`, `lastError`, `cancelRequested` and `unclear`; plus `counters` (the day's `actions`), the agent ledger and the cursors.
- **The write:** `createStateStore.save` writes it **atomically**: a temporary file opened `wx` 0600, fsync, rename, then a directory fsync (`config.mjs:257-275`). A line and the day's counter are therefore always on disk together, or neither is.
- **Every intent is saved before its first `#run`:**
  - `#enact` writes all intents, then `save()`, then `#crashAt('after-intent')`, then runs them (`resident.mjs:1003-1007`);
  - `#duties` writes the return intent and `save()` before `#run` (`:755-757`).
- **What `#run` changes after a submit** (`sendKey`, `state: 'sent'`, `counted`, `lastError`, `attempts` via `#retryOrFail`) is in memory until the tick's closing `save()`.
- **`sendKey` is derived, not invented:** it is `key`, or `key#aN` from the persisted `attempts` (`:487`). A restart that has lost the in-memory changes recomputes the same key.

## 2. The restart boundaries

| Crash point | On disk | After restart | Wrong new attempt or count? |
|---|---|---|---|
| **Before the send** (after the intent is saved, before `submit`) | `intended`, `attempts` n, no `sendKey` | `#run`: the same `sendKey` → `status`. ④ has no record → `null`. If registered but the wallet has nothing, ④ reads `unqueryable` → the port throws → `null`. Then `submit` **under the same key**. | **No.** Same key. Nothing was counted before. |
| **Between `register` and `send`** (inside `submit`) | the same | ④ has the act. With a gateway read, the wallet has no entry (`actionFateView`: `unqueryable`, `retained: false`) → the port throws → `null` → `submit` under the same key. With a **store-only** read, `registered` → the port answers `status: 'sent', fate: 'pending'` → the line is `sent`, never sent; see §4-1. | **No new key.** Store-only can leave the line open (§4-1). |
| **Just after the send, before the save** (`#crashAt('after-submit')`, or a real crash) | still `intended`, `attempts` n | `#run`: the same `sendKey` → `status`. If ④ or the wallet has the answer, it is taken from the reading (`fromSubmit` false: `sent` with the registry's signature, or `refused` for `not-sent`). Otherwise `submit` under the same key → the wallet **replays** its recorded answer (`gateway.mjs:556-561`) → the same branch as before the crash (`sent`, ambiguous, or may-have-left). | **No.** Same key, and **counted once:** the earlier `#countAction` increment was not saved either, because it sits in the same atomic document. |
| **After `#retryOrFail` made `attempts` n+1, before the save** (a transient refusal) | `intended`, `attempts` n | `#run` with the **old** key → `status`. The wallet remembered the refusal; a `failed` without a signature reads `not-sent` → ④ `not-sent` → `refused` → `#retryOrFail('Unknown')` → `failed`. | **No double send.** At most a missed retry (conservative). |
| **During `cancelAction`** (after `cancelRequested` is set, before its `save()`, while awaiting `port.cancel`) | `cancelRequested` not on disk | The line is read as before the cancel. `cancelAction` never returned, so the cancel was **not acknowledged**. | See §4-3. |
| **During a revocation** (`#applyRevocation` before the tick's save) | not applied | `#stopReason` reads the revocation again from the agent ledger (the same state file) and applies it again. | **No.** |

**The may-have-left line** (`sent`, `lastError` `SendFailed`/`MayHaveLeft`, no signature) is persisted like any `sent` line. After a restart it is only read: `#run` runs only for `intended`, and `#reconcile`'s resubmit needs `lastError === 'Transport'` and a `null` status.

**A cancelled line** (`cancelRequested` saved):
- `#reconcile`'s resubmit is blocked (`!it.cancelRequested`);
- `failed`, `expired` and `not-sent` end as `cancelled` with no new attempt (`noMore`);
- `cancelled` ends as `cancelled`.

## 3. Against the contracts

- **R1:** the same key gives the same answer, and is not executed twice.
  - Every restart path re-uses the persisted `attempts`, so it re-uses the same key.
  - The wallet keeps every key's request record (`ledger.requests`, never deleted).
- **R4:** an unknown result is never a reason to resend.
  - No restart path turns `unknown`, `unqueryable` or an exception into a new key.
  - New keys come only from `#retryOrFail` on a submit's definite refusal or proven not-sent, or from ④'s final `failed`/`not-sent`/`expired` in `#reconcile`.
- **R5:** `null` only when there is no record.
  - The port answers `null` only for ④'s `NoRecord`, and `submit` registers before sending.
- **The adopted cancel contract** (`cancelAction` doc, `resident.mjs:664-670`): once marked and saved, a line that did not take effect ends `cancelled` with no new attempt; a landed one stays landed; an unknown one stays held. Persistence keeps this for every acknowledged cancel.

## 4. Findings: decisions and blockers, not fixed

### 4-1. A send lost before the wallet is never resubmitted with `ws04-acts`, and with store-only reads never even times out

**What `#reconcile`'s same-key resubmit needs:** a status of `null` ("no record") after a `Transport` (`:630`). With `ws04-acts`, `submit` registers first, so ④ always has a record. `null` cannot appear after a send attempt.

**A `send` that threw before reaching the wallet therefore stays open:**
- **with gateway reads:** the wallet has no entry → `unqueryable` → the port throws → `unknown` → held, then `unresolved` after a game day (`owed()` reports it);
- **with store-only reads:** `registered` → `pending` → `#reconcile` `continue`s before the unclear and unresolved timer (`:622`). **The line stays `sent` indefinitely**, and it is never reported as unresolved.

**What this is:** safe in the direction of R4 (no double execution), but a liveness gap.

**Why it is not decided here:**
- The wallet's own rule is that `retained: false` is "not known here, never not sent" (`gateway.mjs` `actionFate` doc), so ⑬ cannot conclude that nothing was sent.
- Whether a `registered` act that the wallet never received may be resubmitted under its key, and whether ⑬'s port must read through the gateway, is for ④ and the owner to decide.

**A blocker for a real connection:** the production assembly must give ⑬'s acts client a gateway port, so that store-only `registered` cannot hold a line open forever. Or the `pending` branch needs a timer, which is a design change.

### 4-2. A Duplicate is handled differently before and after a restart

**Without a restart:** a Duplicate answer (`failed`, code `Duplicate`, `duplicateOf` and a signature) goes to `#retryOrFail('Duplicate')` and ends `failed`.

**After a crash before the save:**
- `#run` reads `status` first.
- The wallet recorded the Duplicate with the **earlier send's signature** in its facts, and `actionFate` follows that signature's chain fate.
- ④ records it, so the line can become `sent` → `landed` on **another send's landing**.

**The upshot:** a path difference, not a double send. The same answer ends `failed` or `landed` depending on whether the process restarted.

**Not decided:** whether an earlier send's signature may count as this key's effect. That is the question Lane D is investigating for ③, and ⑬ must not upgrade it before that answer. This is **decision material only.**

### 4-3. The cancel mark is saved after `port.cancel`, not before

**The order in `cancelAction`** (`:671-686`), for a line that is sent or may have been sent:
1. set `cancelRequested`;
2. `await port.cancel`;
3. set `state: 'sent'` for a maybe-sent `intended` line;
4. `save()`.

**A crash during the await loses the mark:**
- The cancel was **not acknowledged**: `cancelAction` did not return.
- Under the adopted contract the line then behaves as uncancelled. A later `failed`, `expired` or `not-sent` reading can lead to a new attempt.
- ④'s `cancel` is `NotSupported` (no effect). The test world's withdrawal, if it took effect, is read back as `cancelled`.

**Hardening candidate, not made:** a `save()` right after setting `cancelRequested`, write-ahead like the intents. It is not made because the contract covers acknowledged cancels only, and repeated hardening is out of scope. It is noted for the owner.

**A related point, depending on the caller:** for a maybe-sent `intended` line, `state` moves to `sent` only after the await. A tick running at the same time could `#run` it during that await. `#run` does not check `cancelRequested`, but it re-uses the same key. ⑬ has no production assembly that runs `cancelAction` and `tick` concurrently.

## 5. What blocks a real connection (not hidden)

1. **No production `send` or assembly:** `ws04ActsPort(acts, {send})` gets its `send` from the caller. The only one in the tree is the test stack's (`test/stack.test.mjs:91-101`).
2. **How the acts client reads (gateway or store-only)** is the caller's choice and decides §4-1. The assembly must pass a gateway port.
3. **The Duplicate attribution** (§4-2) waits on the answer for ③ (Lane D).
4. **⑬'s guard tests and their family stay held.** This branch's regressions (`sendfailed-may-have-left.test.mjs`) are written, not run.

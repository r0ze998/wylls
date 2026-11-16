# ⑬ resident: a Duplicate after a restart — where the marker is lost, and what the producers would need to give (2026-11-17)

**Scope:** a static reading of the path status → ④ act receipt → ⑬ `fateOfReceipt` → journal, for a Duplicate answer. All files were read at `5d02c791` (this branch):
- the agent wallet: `permutation-gateway/src/frontier/agent/gateway.mjs` (`#run` Duplicate branch, `actionFate`, `actionFateView`) and `ledger.mjs` (`recordAction`);
- ④ `workstreams/04-execution/src/acts.rs` (`refresh`, `receipt`);
- ⑬ `resident/ports/ws04-acts.mjs` (`fateOfReceipt`, `status`) and `resident/resident.mjs` (`#run`, `#reconcile`).
- Lane D's ③ fix `4cdf4ae2` was read only for comparison and **not copied**.

**Not done:**
- No test, guard, dependency closure, runner, import, syntax check, network, signing or world.
- Not touched: C, D and ③ `receipt-port`.

**Verdict:**
- **The misattribution path is real** (§2), but **⑬ cannot tell the case apart:** ④'s receipt does not carry the Duplicate marker (§3).
- Per the brief, ⑬ does not guess, refuse everything, or invent a trust rule. **No code change.**
- §4 names the producer fields that are missing, and the ⑬ change that would follow once they exist.

## 1. Without a restart (today, unchanged)

- **The wallet's answer:** for a seq action (SendCaravan), `{status: 'failed', error: {code: 'Duplicate'}, sent: null, duplicateOf: <earlier signature>, signature: <the same>, lastValidBlockHeight, slotFloor}` (`gateway.mjs:695-704`). Its advice: "follow it, do not resend".
- **⑬ `#run`:** the answer comes from `submit` (`fromSubmit`), and the may-have-left branch excludes it (`duplicate`). So `#retryOrFail('Duplicate')` runs, and since `Duplicate` is not transient, the line ends **`failed`**, uncounted and never resent.

## 2. With a restart between that answer and the save: the earlier send becomes this key's

**What the wallet records** (`refused(e, FAILED, [], facts)` → `ledger.recordAction`, which spreads the entry as given, `ledger.mjs:521-525`):

`{type: 'action', key, status: 'failed', code: 'Duplicate', sent: null, duplicateOf: S, signature: S, lastValidBlockHeight, slotFloor}`

where **S is the earlier send's signature.**

**What the wallet answers** at `GET /f/agent/fate`, through `actionFate` → `actionFateView(entry, fateOf(S))` (`gateway.mjs:181-192`):
- `base` keeps `status: 'failed'` and **`code: 'Duplicate'`**;
- because `entry.signature` is set, `facts` is `{sent: true, signature: S, …}`, which **replaces the entry's `sent: null`**;
- **`duplicateOf` is not carried;**
- `state` is **S's chain fate** (for example `landed`).

**What ④ keeps and shows:**
- **Kept:** `refresh` stores the whole answer as `facts` (`acts.rs`, `f = v.clone()`), `code` and `status` included.
- **Shown:** `receipt` outputs `state`, `final`, `signature`, `signedAt`, `lastValidBlockHeight`, `slotFloor`, `commitment`, `why`, `lastReadError`, `conflict`, `cancel`, `next`, `newAttemptAllowed`, plus the registration fields.
- **Not shown:** `code`, `status` and `duplicateOf`. The registry's own source has no `duplicate` or `code` anywhere, at this base or on any local or remote branch searched.

**What ⑬ then does:**
- `fateOfReceipt` gives `{ok: true, status: 'sent', fate: 'landed', signature: S, ws04: {…}}` (`ws04-acts.mjs:25-36`).
- The journal line is still `intended` after the restart, so `#run` reads `status` first (`fromSubmit` false). `res.status === 'sent'` makes the line `sent` with **`it.signature = S`**, and it is **counted** (`#countAction`).
- `#reconcile` then reads `landed`, and the line becomes `landed`.

**The result:** after a restart, another send's landing is recorded as this key's success, signature included. Without the restart, the same answer ends `failed`. **Reachability** needs a crash between the answer and the tick's save (`#crashAt('after-submit')` is that window) and a SendCaravan Duplicate. No double send is involved.

## 3. Why ⑬ cannot decide it from what it receives

- **The marker never reaches ⑬:** in ④'s receipt (§2), `signature` is S and `state` is S's fate, with no field saying the act was a Duplicate.
- **⑬ has no other source:** ⑬'s port reads only ④'s registry (`ws04ActsPort` has `register` and `status`; no wallet read).
- **Lane D's ③ fix (`4cdf4ae2`) keys on the wallet fate's `code: 'Duplicate'`.** ③ reads the wallet's fate directly (`game.actFate`), but ⑬ does not, so that approach cannot be copied.
- **Inferring it** (for example, a signature unknown to the journal, or every `landed` reading after a restart) would be a new trust rule. Refusing every post-restart `sent` reading would break the normal lost-answer recovery. **Neither is done.**

## 4. What the producers would need to give (not decided here)

Any change here belongs to the owners:

| Producer | Today | Needed |
|---|---|---|
| **The wallet**, `actionFateView` (`gateway.mjs:181-192`) | for a Duplicate entry: `sent: true`, `signature: S`, the state of S; `duplicateOf` dropped | carry `duplicateOf` from the entry (it is there), and keep the entry's `sent: null`. It must not assert `sent: true` for a send this key did not make. |
| **④**, `acts.rs receipt` (`p04-acts/0.1`) | `code`, `status` and `duplicateOf` are kept in `facts` but not output | output the wallet's `code` (and `duplicateOf` once the wallet gives it). A shape change: `receiptVersion` raised, under ④'s ownership. |

**The adopted contracts these would meet:**
- **⑬'s execution contract** (`resident/ports/execution.mjs:8-12`, `03-contracts.ja.md:33-39`): `status` returns `ActionResult & {fate}`, and `ActionResult` has `error: {code}`. A status answer may therefore say `error.code: 'Duplicate'` without a new ⑬ field.
- **The wallet's own Duplicate rule** ("Nothing of THIS request left … not `not-sent`", `gateway.mjs:695-704`) and ④'s `next`/`final` rules are unchanged by passing the marker through.

**The ⑬ change once the marker exists** (minimal, not written now because the field does not exist):
1. In `fateOfReceipt`, a receipt whose `code` is `Duplicate` (or that carries `duplicateOf`) is answered as `{ok: false, status: 'failed', error: {code: 'Duplicate'}, duplicateOf}`, with **no `signature` and no `sent` fate.**
2. `#run`'s status path then reaches `#retryOrFail('Duplicate')` and ends `failed`, as without a restart.

**Acceptance:**
1. With and without a restart, a Duplicate ends the same way.
2. S is never stored as `it.signature`, and never counted as this key's send.
3. No resend.
4. The rules for `landed`, `failed`, `pending`, `unknown` and `unqueryable` readings without the marker are unchanged.

**Whether the earlier send's effect should count for this line** (when the earlier send was this resident's own earlier attempt of the same intention) is the same open question Lane D has for ③. It is not decided here, and S is not upgraded to this key's success.

## 5. What stays as it is

- ⑬ `resident.mjs` and `ws04-acts.mjs`: unchanged. The may-have-left change on this branch already excludes Duplicate on the submit path.
- Sending rules, authority and the cancel contract: unchanged.
- **This gap joins the other real-connection blockers** in `CLAUDE-WS13-JOURNAL-RESTART-BOUNDARY-20261117.md` §5: no production `send` or assembly; the gateway-or-store-only read choice; the Duplicate marker in ④'s receipt and the wallet's fate view.

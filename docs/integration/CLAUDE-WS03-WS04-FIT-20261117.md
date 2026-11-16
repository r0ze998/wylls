# ④'s run view and ③'s receipt port: which ④ surface fits ③, item by item (2026-11-17)

**Scope:** a static fit table between what ④ provides and where ③'s receipt port takes it in. Blobs were read with `git show` only.
- **③ read at:** `4bd8eebf` (this branch).
- **④ read at:** `src/acts.rs`, `src/view.rs`, `src/model.rs`, `src/store.rs`, `src/executor.rs`, `clients/acts.mjs`, `clients/runs.mjs` and `docs/EXECUTION-CONTRACT-20261106.ja.md`, at the same base.
- **Candidates read:** ②'s tip `2300b4f4` (Lane D, read only); the pushed candidate `claude/ws03-registry-correlation-20261117` at `eaf2b97d` (on `d16048aa`, not integrated).
- **Not done:** no test, import, syntax check, RPC, HTTP or world, and no product edit. The one write was an in-memory `git merge-tree --write-tree`: it writes objects only, with no ref, index or checkout.
- **Excluded:** the refused held-mapping commit `17f4cca4` is not part of this branch and is referred to by hash only.

**Follows:** `CLAUDE-WS03-RECEIPT-CONSUMERS-20261117.md` (§4 there compared ③'s mock with ④'s *run* view).

## 0. The deciding fact: ③'s operation is a ④ act, not a ④ Run

**Adopted on both sides:**
- **④:** `docs/EXECUTION-CONTRACT-20261106.ja.md:58, 93-100` and `src/acts.rs:1-22` say that an agent's single game action sent through the agent wallet (③'s MCP call, ⑤'s autopilot) is registered as an **act** in ④'s run store. Its receipt is `p04-acts/0.1`, read with `runexec act status|list` through ④'s own `clients/acts.mjs`.
- **③:** `18-ws04-seven-states.ja.md:25` adopts exactly that: ③ imports ④'s `clients/acts.mjs`.
- **The wiring:** `bin/wylls-mcp.mjs:15-17, 41-47` (`WYLLS_MCP_WS04_ACTS`) and `server.mjs` `register` and `consult`.

**The run view is for something else:**
- ④'s **run view** (`view.rs`: `held_reason`, `cancel_phase`, `in_flight`, `fees`, `outcome`) belongs to ④'s **own executor Runs**: making and caravan runs from a `RunSpec`, accepted by `clients/runs.mjs` `run accept` after a pass-holder check.
- ⑥ (`connect/caravan.mjs`) and ⑬ (`resident/ports/ws04-run.mjs`) read that view. ③ does not, and no adopted document says it should.

**So the question decides itself from adopted text:**
- **The injection point** for ④ in ③'s receipt is the act receipt, already stored as `op.ws04Act` and shown as `ws04.act` and in the cancel phase.
- **The run view is not ③'s provider.** Making ③'s sends into ④ Runs would be a **new specification**: a new intake, a pass-holder check, and ④ executing instead of the wallet. It is out of scope here and not proposed.

## 1. Fit table

Classes:
- **A**: decided by adopted text (grounds given).
- **M**: the real provider does not supply it.
- **O**: needs a real decision by the owner or the contract owner.

| Item | ④ act receipt `p04-acts/0.1` (provider) | ③ today (`server.mjs` `consult`, `receipt-port.mjs`) | Class and grounds |
|---|---|---|---|
| **Version / type** | `receiptVersion: "p04-acts/0.1"` | stored (`ws04Act.receiptVersion`), shown, not checked | **A.** ③ shows ④'s version beside ④'s fields; adopted ③ text pins no other. Refusing an unknown version would be a new rule; it is noted for ④/③ in §3 and not decided here. |
| **State** | `registered`, then `not-sent`, `landed`, `failed`, `expired` (final), `pending`, `unknown`, `unqueryable`; `final`; `next` (done / new-attempt / wait / hold / read-again); `newAttemptAllowed` | the wallet's own fate (`game.actFate`) moves the operation (`applyFate`). The registry's state, final, next and newAttemptAllowed are recorded and shown, and never move the operation. | **A.** Both read the same `GET /f/agent/fate` (`acts.rs:1-12`, `clients/acts.mjs:5-7`). ③ deciding from the wallet directly and showing ④'s reading is the adopted split (`18-ws04-seven-states`). |
| **Held** | no `held_reason` for acts. Result unknown is `state: "unknown"` with `next: "hold"` ("never send again"). | `ws04View.held_reason` is ③'s own (a mock name). The registry's `next: hold` is passed through in `ws04.act`. | **A** for acts: ④'s held signal for an act is `next: "hold"`, and ③ already carries it. `held_reason` naming for ③'s other holds is **O**, and only matters if ③ ever reports as a Run (§0). |
| **Debug text** | none (acts carry `why`, `lastReadError`, `conflict` as data) | `readError` is scrubbed text | **A.** `format!("{why:?}")` is the run view's `held_reason` only (`executor.rs:538`), not part of the act receipt. Nothing for ③ to parse. |
| **Cancel** | `cancellable: false`; `cancel` is one of three: `{stage: "before-sign", result: "NotSent", until: null}`; `{stage: "sent", result: "Irrevocable", until: {lastValidBlockHeight}, phase: "Completed" or "AwaitingSigned"}`; `{stage: "signed-unsent", result: "NotSupported", why}` | `ws04CancelPhase` takes ④'s `cancel.until` and attaches **this** request's signature, whichever signature ④'s receipt was about. `consult` does not keep the receipt's `signature`, `idempotencyKey` or `source`. | **A, with one real defect,** already fixed on the pushed candidate `eaf2b97d` (§2). The rule is ③'s adopted one, pinned by `test/lost-answer.test.mjs:156-161`: `until` is the lifetime of this request's own signature, null without it. The relay path already obeys it (`receipt-port.mjs`, the lifetime is used only when it names `op.gateway.signature`); the registry path does not. |
| **Unknown** | `state: "unknown"` (may have landed); `unqueryable` (could not ask, says nothing); a failed read keeps the last facts and sets `lastReadError` | the wallet's fate decides (`applyFate`). A failed registry read becomes `ws04Act.readError` but **moves `at`**, and a stale `readError` survives a later successful read. | **A, defect** in freshness only, also fixed on `eaf2b97d`: `at` is the last read that answered, `readErrorAt` is separate, and a stale error is dropped on success. ④'s own rule is to never erase what was known (`acts.rs:14-19`). |
| **Fees** | none in the act receipt (④'s `FeeBook` is per Run, `view.rs` `fees`) | `feesOf` from the relay's patch 0007 `chain.fee`; category only otherwise, never `released` without proven absence | **M.** ④'s act provider has no fee field. ③'s source stays the relay (patch 0007). A fee in `p04-acts` would be ④'s addition, not ③'s choice. |
| **Provenance** | `source` (`mcp`), `agentId`, `idempotencyKey`, `registeredSlot`, `runId` (the caller's), `signature`, `signedAt`, `commitment`. No chain, simulator or read-mode field. | `run4Id`, `runId`, `registeredAt`. Not kept: `source`, `idempotencyKey`, `signature`. | **A** for the missing three: ④ supplies them and ③'s cancel rule needs the signature. They are kept on `eaf2b97d`. Saying **whether the registry's facts come from a chain or a simulator** is **M**: ④'s receipt names none. Upgrading `receipts.real` (mock → ④'s ledger) is **O** and not decided here. |
| **Outcome / arrival** | none (an act ends at `landed`; the caravan's road is not the act's) | ③'s own herald tracking (`track`, `arrivalOf`, `ws04View.outcome`) | **A.** Arrival is outside the act receipt by ④'s definition. ③'s tracking stays the source. |

## 2. The real defect, and its existing fix

**The defect:**
- At `4bd8eebf` (and at `d16048aa`, and in ②'s `2300b4f4`), `ws04CancelPhase` returns ④'s `cancel.until` stamped with `op.gateway.signature`. That happens even when ④'s receipt was about another signature: a Duplicate's earlier send, or a wallet record that contradicts the answer this server received.
- It also happens when ④'s receipt has `signature: null`.
- ③ cannot tell these cases apart, because `consult` drops the receipt's `signature` and `idempotencyKey`.

**Shown as:** another send's deadline, presented as this send's (a cancel `until` for the wrong bytes).

**Who sees it:** anyone reading the `ws04-mapped` cancellation (the owner page after a revocation) or the receipt's `ws04.act`. Under the default `local` port nothing changes, since `ws04CancelPhase` is not called.

**The fix already exists, pushed and not integrated:** `claude/ws03-registry-correlation-20261117`.
- **`952977b5`:**
  - `consult` refuses a receipt naming another key (`Inconsistent`, as a failed read);
  - it keeps `signature`, `idempotencyKey` and `source`;
  - it keeps `at` as the last answer and adds `readErrorAt`;
  - `ws04CancelPhase` uses ④'s `until` only when ④'s signature is non-null, the operation is not a Duplicate, and the signature equals this request's (or this server has none yet).
- **`eaf2b97d`:** the same `consult` rules as two pure helpers in `receipt-port.mjs` (`ws04ActAfterRead`, `ws04ActAfterFailedRead`).
- **Tests:** `test/ws04-cancel-own-signature.test.mjs` and `test/ws04-act-read.test.mjs`, **written, not run.**

**Against ②'s tip `2300b4f4`** (in-memory `merge-tree`, objects only):
- **One conflict, in `server.mjs`**, between adjacent import lines. ② changed line 11 (`ports.mjs`: `+ resultUnknown`), and the candidate changed line 12 (`receipt-port.mjs`: `+ ws04ActAfterRead, ws04ActAfterFailedRead`).
- **The other hunks are apart:** ② at `listOps` (751), the candidate at `consult` (606).
- **`receipt-port.mjs`:** ② does not touch it. The candidate's hunks (`feesOf`/helpers at 121, `ws04CancelPhase` at 149) are apart from the refused held-mapping lines (`ws04View`, 86-90). They are noted only so that a later intake of either does not collide.

## 3. What the owner or a contract owner really has to decide (O), and what is not asked

**O1. Whether `receipts.real` may ever be true.**
- The question is whether "④'s ledger" means the act registry ③ already reads. Today `receiptPortFor` refuses a real adapter, and every receipt says MOCK.
- This is the mock → real upgrade and is not decided here.
- It also needs ④ to say what its receipt rests on: a chain, a simulator, or a store only, which today's act receipt does not say (M).

**O2. Only if ③'s sends are ever made into ④ Runs:**
- `held_reason` names for ③'s holds;
- the run view's cancel shape;
- the Debug-string `held_reason`.

Today, by §0, they are not ③'s.

**Not asked (decided by adopted text, §1):**
- that the act receipt, not the run view, is the injection point;
- that the wallet's fate moves the operation and the registry's reading is shown;
- `next: hold` as an act's held signal;
- the cancel `until` only for this request's own signature;
- the read freshness;
- fees from the relay;
- arrival from ③'s tracking.

**Noted for ④ and ③, not decided:** whether ③ should refuse a `receiptVersion` other than `p04-acts/0.1`.

## 4. The smallest safe next diff, and its acceptance conditions

**The diff:** take `claude/ws03-registry-correlation-20261117` `eaf2b97d` (two commits, `952977b5` then `eaf2b97d`, over `d16048aa`: 6 files, namely 2 docs, `receipt-port.mjs`, `server.mjs` and 2 tests) into ③ **after** ②'s line.
- **The import conflict:** resolve it by keeping both lines:
  - `import { MockGrantPort, STATES, TERMINAL, resultUnknown } from './ports.mjs';`
  - `import { LocalReceiptPort, assertReceiptPort, ws04ActAfterRead, ws04ActAfterFailedRead } from './receipt-port.mjs';`
- **Nothing else.**
- **Who does it:** `server.mjs` is in Lane D's editing area. By the one-integrator rule, Lane D or the integrator does the intake, with paths and hashes handed over first. This lane did not do it.

**Acceptance (all static unless the owner approves a run):**
1. **The base:** ②'s tip at intake time (today `2300b4f4`) plus `eaf2b97d`.
   - The only `server.mjs` change outside `consult` is the import line.
   - `receipt-port.mjs` gains the two helpers and the `ws04CancelPhase` guard, and nothing in `ws04View`.
   - `git diff --check` is clean.
2. **The rules in `ws04CancelPhase`:**
   - ④'s `until` is used only when `ws04Act.signature` is non-null, `gateway.duplicateOf` is unset, and `gateway.signature` is unset or equal.
   - Otherwise the relay-lifetime path applies, unchanged.
   - No path attaches a signature that ④'s receipt did not name.
3. **The rules in `consult`:**
   - A receipt with another `idempotencyKey` is never applied.
   - `at` moves only on a read that answered.
   - `readError` and `readErrorAt` are dropped on such a read.
   - The receipt's `signature`, `idempotencyKey` and `source` are kept.
4. **Unchanged:**
   - the default `local` port's receipts;
   - `applyFate` (the wallet decides);
   - `register`;
   - `runStatus`;
   - grants;
   - every send path.
   Nothing new is sent, signed or read beyond the existing `runexec act status`.
5. **Tests:** `ws04-cancel-own-signature.test.mjs` and `ws04-act-read.test.mjs` stay **written, not run**. Their import closure (`receipt-port.mjs` → `ports.mjs`; `node:` builtins) is the same class as the group P tests, and a run needs its own approval.
   - `test/ws04-acts.test.mjs` uses ④'s real `runexec` binary (a build) and is not part of acceptance here.
6. **Separate:** the refused held-mapping commit `17f4cca4` is neither required by this diff nor included in it.

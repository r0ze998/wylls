# ③ MCP: consult's registry-read update rules as pure helpers (2026-11-17)

Same independent branch `claude/ws03-registry-correlation-20261117`, on top of `952977b5` (remote equal and clean).
Follows `CLAUDE-WS03-REGISTRY-CORRELATION-20261117.md`.

**Static refactor, NOT run, NOT integrated.** Nothing was executed — before or after the split: no test old or new,
node syntax check, import, scanner, fixture, relay, world or runner; the two guard-refused frontier tests were not run
in any form. Commands: source reads, file edits, `git diff --check`, git save/push.

## What moved

`workstreams/03-composability/mcp/src/receipt-port.mjs` gains two pure functions (no I/O, no imports beyond the file's
existing `./ports.mjs`, which imports nothing):

- `ws04ActAfterRead(prev, receipt, {key, at})` → `{ok: false, code: 'Inconsistent', message}` for another key's
  receipt, else `{ok: true, act}` (run4Id, receiptVersion, state, final, next, newAttemptAllowed, cancel, retention,
  conflict, signature, idempotencyKey, source, at; earlier readError/readErrorAt dropped; other fields kept).
- `ws04ActAfterFailedRead(prev, readError, at)` → everything kept, `readError`, `readErrorAt`; `at` untouched.

`src/server.mjs` `consult` calls them (`server.mjs:609` and `:612`, imported at `:12`) in place of the inline code. The
I/O stays in `consult`: `register`, `acts.status`, the error text (`scrub` is the server's closure, so the helper gets
the finished string).

## Equivalence with 952977b5 (paper)

| Case | Before (inline) | After |
|---|---|---|
| another key | `throw Error('the registry answered for another key (…)')`, code `Inconsistent` → catch | helper returns that code and message; consult throws the same `Error` → the same catch |
| answered | object literal of 16 fields over `kept` | the same literal, same fields and order, in the helper |
| failed (status or register threw) | `{...prev, readError, readErrorAt: at}` | the same, in the helper |

No other line of `consult`, and nothing in `register`, `applyFate`, `track`, `get_run_status`, auth, budget, sending,
retry/hold rules, chain provenance or the ABI changed.

## Regression source (written, NOT run)

`workstreams/03-composability/mcp/test/ws04-act-read.test.mjs` R1–R6: another key refused; a receipt without a key
applied; signature/key/source/at kept; stale readError dropped and unset fields kept; a failed read keeps the last
answering `at`; success → failure → success. Imports `receipt-port.mjs` only. Each assertion traced by hand.
Together with `ws04-cancel-own-signature.test.mjs` (G1–G6) the two halves of the rule — what consult stores, and what
`ws04CancelPhase` shows from it — are covered without `createWyllsMcp`. Not covered without the harness: that `consult`
calls the helpers in that order (read here from the source).

## Remaining body connections under adopted contracts (candidates, with grounds)

None found that can be connected without a decision. Candidates:

1. ③ `get_operation_status` / `ws04View.act`: shows `ws04Act.state` as the registry states it, even when
   `ws04Act.signature` differs from `op.gateway.signature`; `ws04CancelPhase` now refuses that receipt's deadline, but
   the state is still shown. Ground: the same own-signature rule (`lost-answer.test.mjs:156-161`, `applyFate`'s
   Inconsistent hold). Needs a call on how to surface it (a flag beside the state vs. holding the operation — the latter
   is a retry/hold change).
2. ⑤ RunReceipt receipt-level `cancel.until` (`run-receipt.mjs` `cancelPhase` computes it, does not store it) and
   top-level `run4Id` (no contract names a per-run ④ id): receipt-shape decisions (branch
   `claude/ws05-runreceipt-from4-20261116`, `fc43eb72`).
3. ④'s act receipt naming its read mode (wallet / test bridge / store only) and chain: a ④ contract change (main).
4. ③ `get_run_status` listing other senders' acts: an authorization / cross-sender visibility decision.

## Checks NOT run (all open)

`test/ws04-act-read.test.mjs` (new), `test/ws04-cancel-own-signature.test.mjs`, and every existing ③ test
(`ws04-acts`, `ws05-shared-registry`, `lost-answer`, `ws04-mapping`, `receipt-port`, `keyfree/**`); no syntax check,
import or guard scan.

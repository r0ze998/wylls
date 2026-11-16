# ③/⑤ connection: ④'s act-registry receipt fills ⑤'s RunReceipt `from4` act fields (2026-11-16)

Branch `claude/ws05-runreceipt-from4-20261116`, from candidate `claude/canonical-candidate-20261116` at `d16048aa`
(local and origin equal when branched). Independent of the Lane D branches (R3 `490b446d`, R4 `6cf044cf`, R5
`04b0eb43`, R6 `30ee58bb`), which are untouched.

**Statically implemented, NOT run, NOT connected end to end.** Nothing was executed: no test (old or new), node
syntax check, product import, scanner, fixture, relay, world or `runexec`. The only commands were `grep`/`sed`/`cat`/
`git` reads, file edits, `git diff --check`, and git save/push. The two guard-refused tests
(`web-frontier-build-walls-items`, `web-frontier-muster-province-full`) were not run in any form.

## Files compared (candidate source, read only unless marked)

- ③ `workstreams/03-composability/mcp/src/server.mjs`, `tools.mjs`, `ports.mjs`, `receipt-port.mjs`
- ⑤ `workstreams/05-ai-participation/model-api/src/run-receipt.mjs` (**edited**), `run-receipt.conformance.mjs`,
  `autopilot.mjs` (**edited**), `acts-port.mjs`, `acts-registry.mjs`, `fate-reader.mjs`, `status-query.mjs`,
  `reconcile.mjs`; `src/participate.mjs`
- ④ (read only, owned elsewhere) `workstreams/04-execution/clients/acts.mjs`, `clients/acts.test.mjs`,
  `docs/EXECUTION-CONTRACT-20261106.ja.md`
- ⑤ docs `model-api/ACTS-REAL-5.ja.md`, `FATE-ACTS-5.ja.md`; tests `model-api/test/citizen.test.mjs`,
  `acts-fate.test.mjs` (read only)

## What is already connected (source, not README)

| Link | Where | State |
|---|---|---|
| ③ `send_caravan` takes an optional `runId`; a requestId is fixed to its runId (`IdempotencyConflict` otherwise) | `server.mjs:167-183`, `tools.mjs:63` | implemented |
| ③ registers each send in ④'s act registry (`source: 'mcp'`, `runId ?? op.id`) before sending; `op.ws04Act` keeps run4Id | `server.mjs:241-257` | implemented (needs an `acts` client at start) |
| ③ `get_operation_status` reads the registry status into `op.ws04Act` (state, final, next, newAttemptAllowed) | `server.mjs:601-608` | implemented |
| ③ `get_run_status(runId)`: this connection's operations of the run plus the registry's `list(runId)` → `status` per act (≤ 50) | `server.mjs:726-746` | implemented |
| ③ receipt in ④'s vocabulary carries `act: op.ws04Act`; cancel `until` from the registry | `receipt-port.mjs` `ws04View`, `ws04CancelPhase` | implemented (MOCK-labelled port; ④'s ledger adapter absent by design) |
| ⑤ acts port: REAL (`fourActsPort`, ④'s client) / SUBSTITUTE (`localActsPort`), every answer tagged `connection` | `acts-port.mjs` | implemented |
| ⑤ autopilot registers before send, then reads status per act into `rec.acts` and items (`run4Id`, `fateState`) | `autopilot.mjs:138-141`, `#readActs` | implemented |
| ⑤ status answer for ③ by registry / fate / GET /f/tx, seven states kept apart | `status-query.mjs` | implemented |
| **⑤ RunReceipt `from4` act fields from ④'s registry receipt** | `run-receipt.mjs` `attachAct` | **missing until this branch** |

The missing link was recorded by ⑤ itself: `model-api/ACTS-REAL-5.ja.md:70` ("RunReceipt の `from4` の欄 … ④の
`toP05Act()` で埋められます。⑤の RunReceipt にはまだつないでいません"). The contract is ④'s
`EXECUTION-CONTRACT-20261106.ja.md` §7.3 ("RunReceipt の `from4` の欄は `toP05Act(receipt)`") with the mapping in
`clients/acts.mjs:106-113`; ⑤ already consumes the same `p04-acts/0.1` receipt through `acts-port.mjs`. Before this
change the registry receipt reached `rec.acts` but `receipts.attachAct` got only the participate item, so the
RunReceipt's `acts[].fate` stayed `unknown`, `signedAt`/`cancellable` null, and `cancelPhase` could not give `until`.

## The change (⑤ only)

1. `run-receipt.mjs`
   - `ACT_FROM4_FIELDS`: the `acts[]` fields with `from4: true` (derived from `RECEIPT_FIELDS`, today
     `acts[].signedAt`, `acts[].cancellable`).
   - `actFrom4(receipt)`: the field-for-field mapping of ④'s `toP05Act` (run4Id, idempotencyKey, source, signature,
     signedAt, fate = state, commitment, cancellable = false, cancel {stage, result, until}), plus `connection`/`port`.
     Written out, not imported: ⑤'s tree does not carry ④'s files (`acts-port.mjs` loads ④'s client by path).
   - `attachAct(…, registry = null)`: with a registry receipt, fills idempotencyKey, source, signedAt, fate (④'s state),
     cancellable, `lastValidBlockHeight` (from `cancel.until`, which `cancelPhase` already reads) and keeps
     `from4 {connection, port, run4Id, commitment, cancel}`. A receipt for **another signature** fills nothing and is
     kept as `from4.mismatch` (the same rule as `txStateFromActs`). Without `registry` the act is built exactly as before.
   - `close`: the act fields are removed from `missingFrom4` only when **every** act carries a `connection: 'real'`
     receipt without mismatch. A substitute (⑤'s copy of the contract) never clears them.
   - `refreshFates` without a fate reader no longer lets GET /f/tx (the weaker read, whose `expired` is not a proof)
     overwrite a fate that came from the registry. With a fate reader the behaviour is unchanged.
2. `autopilot.mjs`: `#readActs` also collects each status receipt by requestId (an optional `Map`); the receipt loop
   passes it as `registry` to `attachAct`. No change to registration, sending, the lease, the Citizen fence, budget
   stops or the capability stop.

Not changed: auth, store, budget/cost control, keys, signing, sending, session guard, ABI, ③'s server, ④'s files, any
runner, list or guard.

## Regression source (written, NOT run)

`workstreams/05-ai-participation/model-api/test/receipt-from4.test.mjs`, six cases F1–F6 (fill; unchanged without a
receipt; mismatch; real vs substitute in `missingFrom4`; refreshFates keeps the registry fate; conformance). Imports only
`run-receipt.mjs` and `run-receipt.conformance.mjs`, which import nothing else; registry receipts are hand-written
objects in ④'s shape. Not added to any reviewed list. Paper run against the code: each assertion traced by hand
(F6 needed a `decisionKey` on `open`, since `checkShape` rejects a null one; added).

## Self-review (paper)

- `citizen.test.mjs:124-140` (autopilot without `acts`): `registry` is null, so `fate 'unknown'` → `'landed'` after
  `refreshFates` with the stub's GET /f/tx, and `missingFrom4` equal to the full list, both still hold.
- `acts-fate.test.mjs` A8 calls `attachAct` without `registry`: unchanged.
- `checkActs`: a sent act's `idempotencyKey` may now come from the registry when the relay history read-back misses;
  `close` still overwrites it from the history when found (same `<source>:<requestId>` value).
- A registry state outside the seven (`registered`, never read) is kept as written; `cancelPhase` treats it as open
  (not landed/failed/expired), the same as `unknown`.

## Still not connected / waiting for approval (not implemented, no spec invented)

- RunReceipt top-level `run4Id` ("④'s own Run id"): ④'s registry gives per-act ids (`act-…`) and ⑤ registers under
  `p05-autopilot:<agentId>`; no contract names a per-run ④ id. Left null.
- Receipt-level `cancel.until`: `cancelPhase` returns `until` (now computable from registry facts) but does not store it
  in `r.cancel.until`; changing that is a receipt-shape decision. Left.
- ③ `get_run_status` answers for the MCP connection's own runs; reading ⑤'s autopilot run (`p05-autopilot:…`, source
  `ai`) through ③ would need a cross-source read decision (auth/scope). Not touched.
- ④'s run ledger adapter for ③'s receipt port (`receiptPortFor` throws for it by design) and ④'s real `runexec` where
  ⑤ runs (`ACTS-REAL-5` §5): unchanged.

## Checks NOT run (all open)

- `model-api/test/receipt-from4.test.mjs` (new), `citizen.test.mjs`, `acts-fate.test.mjs`, `acts-port.test.mjs`,
  `acts-runexec.test.mjs`, `multiprocess*.test.mjs`, ③ `mcp/test/**`, ④ `clients/acts.test.mjs`: not run.
- No node syntax check of the edited files; no import of them.
- No key-free guard scan of the new test's import closure (the closure was read by hand: two files, no imports).

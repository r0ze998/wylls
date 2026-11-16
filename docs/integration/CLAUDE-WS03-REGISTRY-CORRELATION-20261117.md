# ③ MCP: ④-registry receipt correlation — "this send's deadline" only for this request's own signature (2026-11-17)

Branch `claude/ws03-registry-correlation-20261117`, from candidate `claude/canonical-candidate-20261116` at
`d16048aa` (local and origin equal). Independent of the ⑤ branch `claude/ws05-runreceipt-from4-20261116`
(`fc43eb72`, untouched) and of every Lane D branch.

**Static implementation, NOT run, NOT integrated.** Nothing was executed (no test old or new, node syntax check,
import, scanner, fixture, relay, world or runner); the two guard-refused frontier tests were not run in any form.
Commands: source/history reads, file edits, `git diff --check`, git save/push.

## Files

- Edited (③): `workstreams/03-composability/mcp/src/server.mjs` (`consult`), `src/receipt-port.mjs`
  (`ws04CancelPhase`); new `test/ws04-cancel-own-signature.test.mjs`.
- Read only: ③ `src/server.mjs` (`register`, `applyFate`, `get_run_status`), `src/ports.mjs`, tests
  `lost-answer.test.mjs`, `ws04-acts.test.mjs`, `ws04-mapping.test.mjs`, `ws05-shared-registry.test.mjs`,
  `keyfree/{registry-busy,run,integration,harness}`; ④ `src/acts.rs`, `clients/acts.mjs` (main's).

## The inconsistency (source)

- ③'s own rule, pinned by `test/lost-answer.test.mjs:156-161`: "AwaitingSigned.until is the recorded lifetime of this
  request's own signature, null without it"; "a lifetime without the signature is not used". The relay path follows it
  (`receipt-port.mjs:132`: the lifetime is used only when it names `op.gateway.signature`). `applyFate` holds an
  operation `Inconsistent` when the wallet's record names another signature, and never adopts a Duplicate's earlier
  signature (`server.mjs` `applyFate`).
- The registry path did not: `ws04CancelPhase` (`receipt-port.mjs:131`, before) returned ④'s `cancel.until` with
  `signature: op.gateway?.signature ?? null` attached, whatever signature the registry's lifetime belonged to — and it
  could not tell, because `consult` (`server.mjs:606`, before) kept the receipt's run4Id, state, cancel, retention and
  conflict but **not** its `signature`, `idempotencyKey` or `source` (④'s receipt has all three, `acts.rs:268-291`).
  So a receipt for another signature (a Duplicate's earlier send; a record that disagrees with the answer received) or
  one with `signature: null` was shown as this send's deadline, with this send's signature.
- `consult` also kept a stale `readError` beside a later successful read, and moved `at` on a failed read, so the last
  answer looked fresher than it was.

## The change (③ only)

1. `consult`: a receipt naming another key is not applied (recorded as `readError: Inconsistent …`); on a read that
   answered, `signature`, `idempotencyKey`, `source` are kept and an earlier `readError`/`readErrorAt` is dropped; on a
   failed read `readError` + `readErrorAt` are set and `at` (the last read that answered) is left as it was.
2. `ws04CancelPhase`: the registry's `until` is used only when the stored registry `signature` is non-null, the
   operation is not a Duplicate, and this server has no signature yet or the same one; then `until.signature` is the
   registry's and `until.readAt` is when the registry answered. Otherwise the existing relay-lifetime rule applies
   (or `until: null`).

Unchanged: `register`, `applyFate`, the retry/hold rules, `get_run_status`, auth, scopes, budget, sending, ABI. An
operation stored before this change (no `ws04Act.signature`) falls back to the relay rule until its next `consult`
refreshes it. The registry answering (`connection: 'real'` on ⑤'s side, any ④ client here) is not chain evidence: ④'s
receipt names no chain, cluster, simulator or read mode (wallet, test bridge, or store only), and nothing here claims one.

## Paper review against existing tests

- No existing test asserts the registry branch of `ws04CancelPhase` (no test contains `ws04 act registry (runexec`).
- `lost-answer.test.mjs:108-111, 156-161` (no registry receipt): unchanged answers (repeated as G6).
- `ws04-acts.test.mjs:65-71` reads `ws04Act.run4Id/state/next/newAttemptAllowed/cancel.until` directly: still set.
- Registry stubs: `ws05-shared-registry.test.mjs:139` returns no `idempotencyKey` (the key check is skipped);
  `keyfree/registry-busy.test.mjs:21-24` returns the registered key; ④'s real receipt and ⑤'s substitute return the
  registered key. No path that worked is refused by the new key check on paper.
- No test pins `ws04Act.at` or `readError`.

## Regression source (written, NOT run)

`test/ws04-cancel-own-signature.test.mjs`, G1–G6 (own signature used; another signature not used; no signature not
used; lost answer uses the registry's; Duplicate never; existing answers without a registry). Imports
`receipt-port.mjs` → `ports.mjs` only (`ports.mjs` imports nothing). `consult` itself has no new unit regression: it
lives inside `createWyllsMcp`, whose tests need the relay/world harness — reviewed on paper only.

## Decision points reported, not changed

- `get_run_status` lists every act the registry holds under a run id, other senders' included (`server.mjs:731-746`,
  notes "other senders' included, each with its source"): an authorization / cross-sender visibility decision. Not touched.
- Whether ④'s act receipt should state its read mode and chain (a ④ contract change, main's).
- Whether ③ should hold an operation `Inconsistent` (as `applyFate` does) when the registry's signature disagrees, rather
  than only not showing its deadline: a retry/hold-rule change, not made.

## Next independent slices (adopted contracts, not started)

- ③ `get_operation_status` could show the same own-signature check on `ws04Act.state` (today shown as the registry
  states it, beside `fate`, which `applyFate` already correlates) — presentation only; needs a call on where the
  mismatch is surfaced.

## Checks NOT run (all open)

The new test, `lost-answer.test.mjs`, `ws04-acts.test.mjs`, `ws04-mapping.test.mjs`, `ws05-shared-registry.test.mjs`,
`receipt-port.test.mjs`, `keyfree/**`; no syntax check, import or guard scan.

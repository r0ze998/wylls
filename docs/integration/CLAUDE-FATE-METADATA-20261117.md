# fate.mjs: a finalized transaction without result metadata is `unknown` (2026-11-17)

Scope: one conservative classification fix in `permutation-gateway/src/frontier/agent/fate.mjs`, one new pure test,
this note. No schema, field, state name or feature added. No funds operation, no transaction, no network.

## Defect (reproduced by the coordinator)

`fateOf` with injected reads: status `value: [null]`, finalized block height 11 > `lastValidBlockHeight` 10,
`getTransaction` → `{slot: 4, meta: null}` returned `landed`. The old line was
`tx.meta?.err ? failed : landed`, so a missing `meta` (or a `meta` without `err`) counted as "no error".
The installed web3.js `connection.ts` declares the transaction response's `meta` nullable (coordinator: lines
1174/1193/1223), so this is a real producer shape. Contract
`workstreams/04-execution/docs/EXECUTION-CONTRACT-20261106.ja.md` §1: `landed` = finalized **and** no error;
`unknown` must stay undecided, never guessed.

## Change (`fate.mjs`, the `if (tx)` branch only)

| `getTransaction` at finalized (past lifetime, no status) | before | after |
|---|---|---|
| `meta.err === null` | landed | landed (unchanged) |
| `meta.err` truthy (object or string error) | failed | failed (unchanged) |
| `meta` null / missing / no `err` / `err: undefined` | **landed** | **unknown**, `commitment: 'finalized'`, `queryFailed: false` |
| `meta.err` falsy non-null (`false`, `0`, `''`; not a web3.js shape) | landed | unknown |

The found-transaction branch returns before the `fullHistory` / `getFirstAvailableBlock` checks, so a found
transaction can never become `expired`, also with `fullHistory: true` (that was already the control flow; the test
pins it). The status path (`getSignatureStatuses`: `st.err` truthy → failed, else landed when finalized), the
lifetime check, the read-failure answers and the whole absent-transaction expiry rule are untouched. The header
comment's `unknown` line now names the new case.

## Callers (static reading only; nothing imported or run)

| caller | how it uses the answer | effect of `unknown` instead of false `landed` |
|---|---|---|
| `gateway.mjs` `actionFate` → `actionFateView` (l.818–825, 181–192) | `state = queryFailed ? 'unqueryable' : f.fate` | ordinary action view says `unknown` (with `commitment: 'finalized'`, `queryFailed: false`), not a false success. Per contract §7.2 callers `hold` and do not resend |
| `gateway.mjs` `reconcile`, holds (l.838–846) | landed → `settle`; failed/expired → `release`; unknown → `markUndecided` | the priced hold is neither spent nor refunded: stays `sending` (reserved) and is marked for the operator (`ledger.markUndecided`, l.475–488) |
| `gateway.mjs` `reconcile` withdrawals → `#finishWithdrawal` (l.847–855, 506–521) | landed → `finishWithdraw`; failed → `failWithdraw`; unknown → `markUndecided` | the withdrawal stays `sending` (`pendingWithdraw`), marked for the operator; not recorded as withdrawn, not given back |
| `gateway.mjs` `withdraw` → `#await` → `#finishWithdrawal` (l.485–486, 523–530) | `#await` loops while `pending` or `unknown`; after its tries returns `'pending'` | keeps reading until metadata arrives or tries run out; `'pending'` leaves the withdrawal `sending` for `reconcile` |
| `custody.mjs` `fate` / `status` (l.201–208) | thin wrappers over `fateOf` (status returns `.fate`) | same answer passed through; no logic of its own |
| deposit: `gateway.mjs` `#reconcileDepositSend` (l.443–453), `sponsorDeposit` (l.428–432), `reconcile` deposits (l.857–870) | landed → `deposit()` → `custody.verifyDeposit` then `finishDepositSend`; failed/expired → `finishDepositSend`; otherwise nothing | **actual relation:** this path was already protected — `verifyDeposit` (custody.mjs l.138) throws `DepositPending` on `!tx.meta` before any credit, so the old false `landed` led to a thrown `DepositPending` (reconcile: caught → `depositPending`), no credit and no `finishDepositSend`. Now the fate is `unknown`: no `deposit()` call, the send stays `pending`, `sponsorDeposit` throws `DepositPending`, `reconcile` counts `depositPending`. Same money outcome, one fewer read. Residual, not changed (out of scope): `verifyDeposit` l.139 treats `meta.err === undefined` as no error; it runs its own `getTransaction`, also after a status-path `landed` |

Recovery: `markUndecided` keeps the item `sending` and does not block `settle` / `finishWithdraw` / `failWithdraw`
(ledger l.376–394, 490–516), so the next `reconcile` whose read carries `meta.err` decides it normally. The
operator mark (`undecided`, one history line, one `operatorCosts` line) remains on the record after recovery as
before for any unknown.

## Test: `permutation-gateway/test/agent-fate-metadata-regression.test.mjs`

Imports `node:test`, `node:assert/strict` and `../src/frontier/agent/fate.mjs` (which has no imports) only.
Reads are injected async fakes; no SDK, socket, key, storage, timer or process. Covers: `meta` null / missing /
without `err` / `err: undefined` × `fullHistory` false/true → `unknown` (commitment finalized, queryFailed false,
no `getFirstAvailableBlock` call); the coordinator's exact case; `err: null` → landed; object and string errors →
failed; a later read with metadata recovers to landed / failed; status path, lifetime, read-failure and absent-tx
expiry answers unchanged.

**Independent verification (2026-11-17 UTC): 15/15 passed**, zero failures/skips, repeated independently by the parent.
Both JavaScript files passed syntax checks; the tracked source passed whitespace validation. The implementation CLI
had Read/Edit/Write only and did not execute tests. Existing `agent-wallet-*fate*` tests were deliberately not run
(they generate keys / use custody). Only this new pure fixture was executed:

```sh
cd permutation-gateway && node --test test/agent-fate-metadata-regression.test.mjs
```

## Limitations

- Static caller review only; gateway/custody behaviour above is read from source, not executed.
- The status-path rule (`st.err` truthy → failed, else landed) is unchanged by instruction; it relies on
  `getSignatureStatuses` always carrying `err`, which web3.js types as `TransactionError | null`.
- A permanently metadata-less node keeps such items `unknown` (operator decides), as for any other unknown.
- Not committed or pushed (no shell in this session).

# ⑤ RunReceipt: correlation and provenance review of the from4 connection (2026-11-17)

Same independent branch `claude/ws05-runreceipt-from4-20261116`, on top of `e3c40e38` (remote equal and clean before
this round). Follows `CLAUDE-WS03-WS05-RUNRECEIPT-FROM4-20261116.md`.

**Static implementation, NOT run, NOT integrated.** Nothing was executed (no test old or new, node syntax check,
import, scanner, fixture, relay, world or runner); the two guard-refused frontier tests were not run in any form.
Commands: source/history reads, file edits, `git diff --check`, git save/push. No candidate, shared or canonical change.
Edited: `workstreams/05-ai-participation/model-api/src/run-receipt.mjs` and its new test source only. ④ (main) and
⑨/⑩ (C) were read only.

## What the ④ receipt can and cannot prove (source)

- ④'s act receipt `p04-acts/0.1` (`workstreams/04-execution/src/acts.rs:268-291`) has: receiptVersion, run4Id,
  runId, agentId, idempotencyKey, source, registeredSlot, state, final, signature, signedAt, lastValidBlockHeight,
  slotFloor, commitment, why, lastReadError, conflict, cancellable (always false), cancel, retention, next,
  newAttemptAllowed. **No chain, cluster, genesis, simulator, or read-mode field.**
- `source` is the sender (`ai | mcp | browser | resident`, `clients/acts.mjs:20`), not where the act ran.
- ④'s client reads the state three ways (`clients/acts.mjs:46-79`): the wallet's `GET /f/agent/fate`, ④'s **test
  bridge** (`bridge: true`, `/fate?key=`), or **the store alone** (no `gatewayPort`: `registered` or the last recorded
  read). The receipt is the same shape in all three.
- ⑤'s `fourActsPort` tags `connection: 'real'` because it uses ④'s client (`acts-port.mjs:26-29`); ⑤'s
  `loadFourActsPort` defaults `gatewayPort` to null (store only).
- Conclusion: `connection: 'real'` = ④'s client and registry answered. It is not evidence that a chain executed the act,
  and `commitment: 'finalized'` / `state: 'landed'` there may come from a test bridge or a local/simulated gateway.

## Findings and fixes (⑤ only)

| # | Where (before) | Problem | Fix |
|---|---|---|---|
| ① a | `close`: `history.find(x => x.key.endsWith(':' + requestId))` | Any source's entry ending in the requestId matched, first one wins; on this branch it could overwrite the exact key the registry gave (`ai:…`) with another source's (`mcp:…`), and the game-hold lookup then used that key. | `historyEntryOf`: with a registry key (no mismatch), **only that exact key**; without one, the suffix match is kept (⑤ may not know the relay's prefix) but **two different keys are `historyAmbiguous`, neither is picked**. |
| ① b | same | A history entry carrying another `signature` (the relay records it: `permutation-gateway/src/frontier/agent/gateway.mjs:690-691`) could be matched. | Entries with a different signature are never matched. |
| ① c | `attachAct` (this branch) | A registry receipt was trusted for any key. | Filled only when `idempotencyKey === <source>:<requestId>`; otherwise `from4.mismatch: another key`. |
| ② a | `refreshFates`, fate-reader path | No signature comparison: a fate read for another signature replaced `fate`, `signedAt`, `lastValidBlockHeight` (unlike `txStateFromFate` / `txStateFromActs`). | A read for another signature changes nothing; kept as `fateRead.mismatch`. |
| ② b | same | `signedAt: f.signedAt ?? null` erased known facts when a later read lacked them (④'s registry keeps them). | Known facts kept when the read lacks them. |
| ② c | same | A later read could change a final state the registry gave (④: finals never change). | For a registry-derived act, a final state is kept; a contradicting read (not `unqueryable`) is kept as `fateRead.conflict`. A final from GET /f/tx is NOT locked (that read does not distinguish finality). |
| ③ a | `close` (this branch) | `missingFrom4` act fields were cleared for any real port, even when ④ returned null (store-only / failed read → `signedAt` null). | Cleared per field only when every act is real, unmismatched, and every **signed** act has a value for it. |
| ③ b | `from4` (this branch) | Nothing said the registry is not chain evidence. | `from4.chain: null` and `from4.chainWhy` (`REGISTRY_CHAIN_NOTE`) on every registry-derived act. `missingFrom4` documented as "which registry supplied the field", never chain proof. |

Not changed: auth, store, budget, keys, signing, sending, session guard, ABI, ③, ④, any runner/list/guard. The receipt's
existing shape is unchanged; added fields sit only on acts (`from4.chain`, `from4.chainWhy`, `historyAmbiguous`,
`fateRead`), the first two inside the `from4` object this branch introduced.

## Behaviour on paths that existed before this branch (paper)

- Without a registry and without a fate reader (`citizen.test.mjs:124-140`, `:180-195`): close uses the suffix match as
  before unless two keys match or the entry carries another signature (one entry per key there); fates via GET /f/tx as
  before. Assertions on `fate`, `missingFrom4` (full list) and `cancelPhase` still hold on paper.
- `acts-fate.test.mjs` A8 (fate reader, stub signature `sigA` = the act's): the read applies as before; `signedAt` from
  the read (prior null).
- Behaviour change on old paths, stated: (a) an ambiguous history now leaves `idempotencyKey` null (a sent act then
  fails `checkActs` "not found in the relay history" — the correct signal); (b) a mismatched fate read no longer
  overwrites; (c) a read lacking facts no longer nulls them.

## Regression source (written, NOT run)

`workstreams/05-ai-participation/model-api/test/receipt-from4.test.mjs` F1–F12 (F7–F12 new: wrong key, exact-key close
against another source, signature-mismatched history, ambiguous history, mismatched fate read, final kept + facts kept,
real registry without signedAt). Imports `run-receipt.mjs` and `run-receipt.conformance.mjs` only; both import nothing
else (checked with grep). Each assertion traced by hand against the code.

## Open decision points (not implemented)

- Whether ④'s act receipt should name its read mode (wallet / bridge / store) and the chain or cluster: a ④ contract
  change (main). Until then ⑤ cannot tell them apart and says so.
- Whether an ambiguous history should also withhold the game hold (today: no key → hold shown as none).
- Receipt-level `run4Id` and storing `cancel.until` on the receipt (unchanged, see the previous report).

## Checks NOT run (all open)

The new test, `citizen.test.mjs`, `acts-fate.test.mjs`, `acts-port.test.mjs`, `acts-runexec.test.mjs`,
`multiprocess*.test.mjs`, ③ `mcp/test/**`, ④ `clients/acts.test.mjs`; no syntax check, import or guard scan.

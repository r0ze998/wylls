# ③ MCP: one Duplicate handler for the answer, the wallet's fate and the older wallet's record (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, commit after `1352bb4b`, built with a temporary git index (no branch switch;
the worktree's checkout stays on the ⑤ branch; the owner's 25 deleted media and 19 untracked files untouched). It
implements §1 of `CLAUDE-WS03-DUPLICATE-LOST-ANSWER-20261117.md`.

**Static, NOT run, NOT integrated; no device or client.** Nothing was executed (no test, syntax check, import, scanner,
server, world, browser or runner; no HTTP, RPC, signing or send).
- **Refused work:** the guard-refused frontier tests and `17f4cca4` were not touched.
- **Not taken:** `eaf2b97d` and the `receipt-port.mjs` "unqueryable B" change. Both stay follow-ups.

## Change (`mcp/src/server.mjs` only)

- **`isDuplicate(op)`:** an operation is a Duplicate when `op.gateway` **has** `duplicateOf`, whose value may be null
  (the relay named no earlier signature).
- **`markDuplicate(op, link, duplicateOf, {by, why, recoveredFrom})`:** the answered Duplicate's lines, moved
  unchanged.
  - Sets `gateway.signature = null` and `gateway.duplicateOf`, and deletes `lifetime`.
  - Another of this server's operations holding that signature → `definite('DuplicateOfOperation')` (its hold given
    back).
  - Otherwise, a `requested` op goes through `uncertain` (grant counted once, `accepted`) and is held `Duplicate`.
  - It is never stepped twice, and an existing hold is never replaced.
- **Answered path** (`resume`): calls `markDuplicate` with the same arguments, `by` and `why` as before.
- **`applyFate`:** when `f.code === 'Duplicate'`, the op has no own signature and is not yet a Duplicate (the answer
  was lost), `markDuplicate(f.signature)` runs **before** the branch that adopts a recorded signature. The existing
  Duplicate branch then applies: only P's proven `failed` or `expired` decides; `landed` decides nothing.
- **`recover`** (older wallet, `GET /f/agent`): when `rec.entry.code === 'Duplicate'`, `markDuplicate(entry.signature)`
  runs before its adoption branch.
- **`recover`, `applyFate`, `track`:** the three checks that read `op.gateway?.duplicateOf` as truthy now use
  `isDuplicate`.

**Not changed:**
- **Rules:** permissions, sending, retries, cancellation, grant rules.
- **Paths:** the non-Duplicate paths; the relay-answered Duplicate with a named signature.
- **Other files:** `resultUnknown`, receipts, tools, instructions, every other file.

## Static refutation

| Case | Before | After |
|---|---|---|
| lost answer + record `Duplicate` naming P, P lands | P adopted as `gateway.signature`; `caravan.mine`; `processing` (also via `/f/tx` or a herald `CARAVAN_SENT` signed by P) | held `Duplicate`, `signature null`, `duplicateOf P`; `track` stops at `isDuplicate`: no herald evidence, no `/f/tx`, no `mine` |
| P is another ③ operation's signature | both claim the caravan (counted twice) | `DuplicateOfOperation`, this one's grant given back (counted once) |
| P proven never to land / failed at finalized | `NotLanded` / `TransactionFailed` as "this request's own" | the same codes, through the Duplicate branch (`of: 'duplicateOf'`), as the answered Duplicate |
| repeated `get_operation_status` / `list` → status | — | `isDuplicate` → `markDuplicate` is not called again: no second `grantConsume`, no new step; `hold()` is a no-op for the same code; nothing releases the hold except P's proven end |
| same-requestId `send_caravan` after the loss | `consult` adopted P, then `track` | `consult` → `markDuplicate` → `accepted`, so `send` goes to `track`: no POST (`NotResent` / `resume` not reached) |
| Duplicate with **no** signature (relay gave none: the wallet records `{sent: null}`; its fate is `unknown` with `code: 'Duplicate'`) | answered: `duplicateOf: null` was falsy, so later reads fell through; the `unknown` fate replaced the `Duplicate` hold with `ResultUnknown`, and `track` went on to herald evidence | `isDuplicate` keeps it held `Duplicate`; no signature is ever adopted |
| signature known only later | not possible from the wallet (the record for the key is fixed) | if a record named one later with `code: 'Duplicate'`, `isDuplicate` is already true: it is never adopted; `same` is false, so nothing decides |
| op already `accepted` (an earlier uncertain path) when the Duplicate record is read | — | not stepped again; an existing hold (e.g. `ContextChanged`) kept; `duplicateOf` recorded |
| own signature known (answer arrived `sent: S`) and the record names P | `Inconsistent` hold | unchanged (the new branch needs no own signature) |

**The one intended behaviour change:** answered Duplicates whose `duplicateOf` is null now stay held `Duplicate`.
Before, a later `unknown` fate turned them into `ResultUnknown`, and herald evidence was searched. Existing tests
pin only named-signature Duplicates (`keyfree/ws05-contract.test.mjs:27-81`). Every
`DuplicateOfOperation` / `recoveredFrom` pin still matches on paper (`fate.test.mjs:152`,
`keyfree/integration.test.mjs:122`, `lost-answer.test.mjs:65,105,121`, `play.test.mjs:258`), since those paths carry
no `code: 'Duplicate'`.

## Regression source (written, NOT run)

`mcp/test/keyfree/duplicate-lost-answer.test.mjs`:
- **U1:** lost answer + Duplicate record, P lands → held, never mine, counted once, repeated reads unchanged.
- **U2:** the same requestId → not re-posted.
- **U3:** P is this server's own operation → `DuplicateOfOperation`, counted once.
- **U4:** P proven never to land → `NotLanded`.
- **U5:** server source text: one decision point, order before adoption, no truthiness check left.

U5's patterns were matched against the new source in Python (paper check): all hold. U1–U4 were reasoned through the
code only.

**Dependencies and side effects:**
- **U1–U4** use the existing key-free harness (`test/keyfree/harness.mjs`): the real `AgentGateway` / `AgentLedger`
  and `actionFateView` / `fateOf` from `WS03_GATEWAY_ROOT`, a keyring that throws on signing, and a scripted send,
  node and herald. This is the same class as `ws05-contract.test.mjs`, not ports-only. They skip without `HAS_FATE`.
- **U5** reads `server.mjs` as text.
- **What the file does:** no network, process, key, signature or file write, except what the harness's in-memory
  stores do.
- **Guard:** a new file under `test/keyfree/` may need the key-test scanner's review before
  `scripts/ci/node-keyfree.sh` accepts it. That is not this lane's to change.

## Follow-ups (not done here)

- **`eaf2b97d` intake** (three-line import + `consult` hunk). It does not overlap these hunks.
  - Its `ws04CancelPhase` tests `!op.gateway?.duplicateOf`.
  - With this change a no-signature Duplicate has `duplicateOf: null`, so that guard would let a registry `until`
    through. At intake it should read `!Object.hasOwn(op.gateway ?? {}, 'duplicateOf')`, in main's
    `receipt-port.mjs`, after the handshake.
- **`receipt-port.mjs` unqueryable option B:** see the earlier report.
- **Provider gaps** (wallet, main's): `actionFateView` returns `sent: true` and no `duplicateOf` for a Duplicate entry;
  ④'s receipt has no `code`.

## Not verified

- No run of any test (new or existing), no syntax check, import or merge.
- Reachability (byte-identical sends plus a lost answer) is reasoned from the code.
- No ChatGPT or Claude Code client was used.

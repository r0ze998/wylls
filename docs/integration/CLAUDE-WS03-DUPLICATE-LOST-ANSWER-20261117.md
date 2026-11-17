# ③ MCP: a Duplicate whose answer was lost is adopted as this request's own send; and an `unqueryable` registry receipt is not a fresh read (2026-11-17)

**Investigation and report only.** No code was changed. Nothing was merged, run, imported or syntax-checked, and
nothing went over HTTP, RPC, auth, signing or send.
- **Read at:** Lane D tip `3b056cfe` (code identical to `684c53b6`); `eaf2b97d`; main's report `844fc371`.
- **Gateway files:** read only; they are not Lane D's.
- **Not touched:** `17f4cca4` (refused), the refused tests and runners, worlds, ⑤ `fada02f9` / `6cd7a788` and C's files.

## 1. G4 residual: the lost answer of a Duplicate — a real path past the deadline display

### The chain, from the code

1. **Wallet writes** (`permutation-gateway/src/frontier/agent/gateway.mjs`):
   - `SendCaravan` is the only `SEQ_ACTIONS` member (`:67`). A relay `Duplicate` for it is not rebuilt (`:679`); it
     gets `e.duplicateOf = {signature: <the earlier transaction's>, lastValidBlockHeight, slotFloor}` (`:683`).
   - The catch (`:696-703`) releases this request's hold and calls
     `refused(e, FAILED, [], {sent: null, duplicateOf: P, signature: P, lastValidBlockHeight, slotFloor})`.
   - `refused` records the history entry (`:631`) as `{key, status: 'failed', code: 'Duplicate', sent: null, duplicateOf:
     P, signature: P, …}`.
2. **Wallet reads** (`actionFate` `:820-824` → `actionFateView` `:181-193`):
   - The entry has a signature, so its fate is read (`fateOf` / custody), and the answer is
     `{retained, key, status: 'failed', code: 'Duplicate', sent: true, signature: P, lastValidBlockHeight, …, state:
     <P's fate>}`.
   - **`duplicateOf` is not returned; `sent: true` is.**
3. **③ reads** (`mcp/src/game.mjs actFate` `:116-124`): passed through, with `source` and `at` added.
4. **③ applies** (`mcp/src/server.mjs applyFate`):
   - The Duplicate branch runs only when `op.gateway.duplicateOf` is already known, i.e. only when the POST's answer
     arrived (`:346-362`).
   - Otherwise, with `f.signature && !op.gateway?.signature`, P is adopted: `op.gateway.signature = P`, `sent: true`,
     `recoveredFrom: 'agent wallet GET /f/agent/fate'`. A `requested` op is then `grantConsume`d, marked `uncertain`
     and moved to `accepted`.
   - Then `f.state === 'landed'` → `op.caravan.mine = {by: "this request's own signature landed…", signature: P}` →
     **`processing`** (`:568-573`).
   - `failed` / `expired` of P fail it as this request's own (`TransactionFailed` / `NotLanded`).
   - `op.fate.code` keeps `'Duplicate'` but nothing reads it.
5. **Older wallets** (no fate route, `f === null`): `recover` (`:506-530`) reads `GET /f/agent` (`game.agentRecord`,
   whose `entry` carries `code`, `game.mjs:145`). It adopts `entry.signature` = P the same way, ignoring
   `entry.code === 'Duplicate'`. Then `track` follows P by `game.txStatus` → `caravan.mine` (`:625-632`).
6. **Herald path:** once P is "ours", a `CARAVAN_SENT` signed by P is taken as this request's (`:457-462`).
7. **④ registry:** ④ stores the wallet's answer as facts; its receipt has `signature: P` and `cancel.until` = P's
   lifetime, and **no `code`** (`acts.rs receipt`). On `eaf2b97d`, `ws04CancelPhase` then sees
   `gateway.signature === ws04Act.signature === P` and no `duplicateOf`, and shows P's `until` as this request's.
   - That is the G4 display; the decisive defect is step 4.

### Reachability (not refuted; not demonstrated by a run)

All four are needed:
- (a) another request built **byte-identical** `SendCaravan`. The same Citizen seq (`PlanStale` passes while the
  first has not landed: `server.mjs:208`), the same fields, the same cached blockhash and the same randomly drawn fee
  payer (`gateway.mjs:651-655`). For example: two ③ plans for the same caravan sent in quick succession, or ③ and ⑤'s
  autopilot sending the same caravan;
- (b) the relay answered `Duplicate` to this request, but **the answer to ③ was lost** (transport error or timeout:
  `requested` + `unknownSince`), so `duplicateOf` was never learned;
- (c) the wallet's history still retains the entry (the fate route), or the 50-line view shows it (older wallet);
- (d) a later `consult` / `track` (`get_operation_status`, `list` → status, a same-requestId `send_caravan`) reads it.

**Effect if reached:**
- This operation claims the earlier transaction's caravan as its own (`caravan.mine`, `processing`, later `completed`)
  and consumes its grant.
- If the earlier transaction is another ③ operation, the same caravan is **counted twice** — the case
  `DuplicateOfOperation` exists to prevent.
- Nothing is re-sent (the same-requestId contract holds); the error is attribution and counting.

### Smallest fix (proposed, not made; in Lane D's `server.mjs` only)

Treat the wallet's own record `code === 'Duplicate'` exactly like an answered Duplicate:
- **`applyFate`:** before the adoption branch, when `!op.gateway?.signature && !op.gateway?.duplicateOf &&
  f.code === 'Duplicate'`:
  - set `op.gateway.duplicateOf = f.signature ?? null`, with `signature: null` and `recoveredFrom: 'agent wallet fate
    (code Duplicate)'`; delete `op.lifetime`;
  - then run the **same** handling as the answered path (`:349-362`): `DuplicateOfOperation` when another of this
    server's operations holds that signature, else `uncertain` + hold `Duplicate`;
  - then fall into the existing `duplicateOf` branch, so only P's proven failure or expiry decides.

  The answered path's lines become one shared helper, so both paths say the same.
- **`recover`:** the same when `rec.entry?.code === 'Duplicate'`.
- **Unchanged:** sends, retries (`NotResent`, same requestId), grants for answered paths, `resultUnknown`, receipts,
  `eaf2b97d`'s helpers. With `duplicateOf` set, `eaf2b97d`'s `ws04CancelPhase` guard already excludes the registry's
  `until`, so G4 closes with it.
- **Never:** take signature ownership from the registry (④'s receipt has no `code` and cannot tell).

**Acceptance (static):**
1. A fate or record with `code: 'Duplicate'` never sets `op.gateway.signature`, `op.caravan.mine` or `processing`
   for this request.
2. It is `DuplicateOfOperation` or held `Duplicate`, as the answered path.
3. Without `code: 'Duplicate'`, every existing path is byte-for-byte the same.
4. Regression source, written and not run: lost answer + Duplicate fate {landed, failed, expired, pending}, with and
   without another operation holding P; and the older-wallet record path.

**Provider-side gaps (main's / the wallet's, reported only):**
- `actionFateView` returns `sent: true` for a Duplicate entry, and does not return `duplicateOf`.
- ④'s receipt carries no `code`.

**Not verified:** whether (a) happens in practice (pool size, blockhash cache window); no run.

## 2. `unqueryable` from ④ is not a fresh read (main's ③-2, `844fc371` §5)

**Fact:** `eaf2b97d`'s `ws04ActAfterRead` treats every receipt that arrived as "a read that answered". It moves `at`,
drops `readError`, overwrites `state` and `next` (`unknown`/`hold` → `unqueryable`/`read-again`), and does not keep
④'s `lastReadError` or `why`.

④'s rule is that `unqueryable` says nothing about the act (`acts.rs next_step`; on a failed read ④ keeps the old facts
and sets `lastReadError`).

| Option | `at` | prior `state` / `next` / `cancel` | ④'s texts | Note |
|---|---|---|---|---|
| A (main's candidate) | kept | **replaced** by `unqueryable` / `read-again` | `lastReadError`, `why` kept as text; `readErrorAt` | the hold signal is lost at ③ too (display only: ③'s decisions use the wallet fate, not `ws04Act`) |
| **B (recommended)** | kept | **kept** (the last answering read's) | `registryUnqueryable: {lastReadError, why, at}` as raw text, never parsed; `readError: 'Unqueryable (the registry could not read the wallet)'`, `readErrorAt` | the same as `ws04ActAfterFailedRead`, plus ④'s texts; a later answering read drops both |

**B in `ws04ActAfterRead`:** after the key check, if `a.state === 'unqueryable'`, return
`ws04ActAfterFailedRead(prev, fixed label, at)` plus `registryUnqueryable`.
- The key check still applies first (another key → `Inconsistent`).
- A first-ever `unqueryable` keeps whatever registration stored.
- Finals are not affected: ④ never turns a final into `unqueryable`.

**Acceptance:**
1. `at` moves only on a receipt whose state is not `unqueryable`.
2. The prior `state`, `next`, `cancel` and `signature` are unchanged by an `unqueryable` receipt.
3. ④'s `lastReadError` and `why` are kept verbatim (scrubbed like other errors) and never parsed.
4. The next non-`unqueryable` read drops them.
5. The rest of `eaf2b97d`'s acceptance holds.

**Owner caution:**
- **Where the edit lands:** `ws04ActAfterRead` lives in `receipt-port.mjs`, main's file by the ownership rules this
  lane works under. `844fc371` names Lane D as owner of ③-2.
- **Before any write:** the canonical paths and hashes are handed to main, and the edit waits for main's word.

**readVia:**
- ③ has none at either tip (main's ③-1 candidate).
- ⑤'s `fada02f9` (producer) and `6cd7a788` (consumer) stay on their own lines, and are not reimplemented here.
- A `readVia` says how the caller built ④'s client (`gateway` / `store-only`). It is neither an observation time nor
  chain finality.

## 3. Updated intake premise

- **Lane D tip:** `3b056cfe` (docs after `684c53b6`). `eaf2b97d` intake is still as in
  `CLAUDE-WS03-REGISTRY-INTAKE-PLAN-20261117.md`: the three-line import block plus the `consult` hunk; no other
  conflict.
- **§1 fix and `eaf2b97d`:** the §1 fix touches `applyFate`, `recover` and the answered Duplicate lines (`server.mjs`
  ~346-362, ~506-590), all outside the `consult` hunk, so the two can be taken in either order. With both, G4 is
  closed by `duplicateOf`.
- **§2 option B:** sits on top of `eaf2b97d` (`receipt-port.mjs`). It is to be taken with or after it, by whoever
  owns `receipt-port.mjs` after the handshake.
- **Order suggested:** §1 (attribution and counting) first; then `eaf2b97d` + §2 B together.

## Not verified

- No test, syntax check, import, merge or run.
- Reachability condition (a) is reasoned from the code only.
- No client (ChatGPT or Claude Code) was used.

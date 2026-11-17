# ③ MCP: taking eaf2b97d (registry correlation) onto 684c53b6 — static comparison and the smallest intake diff (2026-11-17)

Report only. **No merge, cherry-pick, product edit, test, import, syntax run, HTTP, RPC, connection, auth, signing or
send.** Both tips were read with `git show` / `git diff`; nothing was integrated. No ChatGPT or Claude Code client was
used. Main, the candidate and other trees were not changed.

## Fixed tips (remote checked before writing)

| Name | Tip | On |
|---|---|---|
| Lane D ③ flow | `claude/ws03-chatgpt-flow-20261117` @ `684c53b6` | `d16048aa` (14 commits) |
| registry correlation | `claude/ws03-registry-correlation-20261117` @ `eaf2b97d` | `d16048aa` (`952977b5`, `eaf2b97d`) |
| main's fit report | `f9376faa` (docs only) | — |

- `17f4cca4` (main's refused held mapping) is **not an ancestor** of `eaf2b97d` (`git merge-base --is-ancestor`); it
  is neither needed nor included.
- `f9376faa` is not an ancestor of `eaf2b97d` either; it is a report that names `eaf2b97d`.

## The adopted entry

③'s operation is a ④ **act**: receipt `p04-acts/0.1`, read with `runexec act status`
(`04-execution/src/acts.rs receipt()`, `clients/acts.mjs status`). It is not ④'s run view (`view.rs`), which belongs
to ④'s own executor Runs (`f9376faa` §1).

The receipt's fields as the provider builds them (`acts.rs` ~252-291):
- **Always present:** `receiptVersion`, `run4Id`, `idempotencyKey` (the registered key), `source`, `state`, `final`,
  `cancel`, `retention`, `next`, `newAttemptAllowed`.
- **From the wallet's fate for that key, may be null:** `signature`, `signedAt`, `lastValidBlockHeight`, `commitment`,
  `why`, `lastReadError`, `conflict`.
- **`cancel`:** `{stage:'sent', result:'Irrevocable', until:{lastValidBlockHeight}, phase}` once sent. The receipt
  names **no chain, cluster, simulator or read mode**.

Consumers of the same receipt:
- ③ (`server.mjs consult` → `ws04Act`; `receipt-port.mjs ws04CancelPhase`).
- ⑥ (`06-creation/src/connect/caravan.mjs:342-350`, which refuses another `receiptVersion`).
- ⑤ (`acts-registry.mjs`, rule-for-rule mirror) and ⑬ (`clients/acts.mjs toWs13Status`).

## What eaf2b97d changes (6 files)

`receipt-port.mjs` (+29/−4):
- **`ws04ActAfterRead(prev, a, {key, at})`:** refuses a receipt whose `idempotencyKey` is non-null and differs from
  `keyOf(op)` (`Inconsistent`, not applied). Otherwise it keeps the receipt's `signature`, `idempotencyKey` and
  `source`, sets `at` to this read, and drops `readError`/`readErrorAt`.
- **`ws04ActAfterFailedRead(prev, err, at)`:** keeps everything known; sets `readError` and `readErrorAt`; leaves `at`
  (the last read that answered) as it was.
- **`ws04CancelPhase`:** uses the registry's `cancel.until` only when all three hold:
  - `ws04Act.signature` is non-null;
  - `gateway.duplicateOf` is unset;
  - `gateway.signature` is unset or equal to it.

  It then attaches **the registry's** signature, `source: 'ws04 act registry (runexec act status)'` and
  `readAt: ws04Act.at`. Otherwise the existing relay-lifetime path applies, unchanged.

`server.mjs` (+8/−4): the import line, and `consult`'s registry block calls the two helpers.

Two tests (written, not run): `ws04-act-read.test.mjs` (R1–R6) and `ws04-cancel-own-signature.test.mjs` (G1–G6).
Two reports.

## Against Lane D's 684c53b6

| D change | Reads `ws04Act`? | Interaction |
|---|---|---|
| `resultUnknown` (ports.mjs; `hold`, `uncertain`, `unknownSince`) | no | none: a held operation whose registry says `landed` stays result-unknown — right, the registry is not chain evidence |
| `receiptOf` `next` / notes (unknown, lost answer, recovery) | no (passes `ws04Act` through as data) | receipts now also carry `ws04Act.signature`, `.idempotencyKey`, `.source`, `.readErrorAt`; no text calls them proof |
| `list_operations` (`hold`, `resultUnknown`) | no | none |
| `prepare` `confirm` / `confirm.mjs` | no | none (prepare is before any act) |
| tool descriptions / `SERVER_INSTRUCTIONS` | no | none; same-requestId contract untouched (send's `consult` → wallet fate decides; the registry block never feeds `applyFate`) |

`receipt-port.mjs` is **unchanged** between `d16048aa` and `684c53b6` (0-line diff), so `eaf2b97d`'s version applies
whole. It imports only `MOCK_RUN_RECEIPT`, `receiptOf` and `cancellationOf` from `ports.mjs`; all three still exist
at `684c53b6`, and `ports.mjs` still imports nothing.

## Conflicts

- **Only the import neighbourhood in `server.mjs`.** D replaced line 11 and added line 12 (`confirm.mjs`); `eaf2b97d`
  replaced the next line (`receipt-port.mjs`). The hunks are adjacent, so a three-way merge is expected to stop there.
  Not run here: no merge or merge-tree.
- **Differs from `f9376faa` §4:** that report resolved two lines on `2300b4f4`; at `684c53b6` the `confirm.mjs` line
  sits between them.
- **`consult` hunk** (base ~603; ~602 on D): D did not touch lines 590–615 → clean. D's other `server.mjs` hunks
  (prepare ~134, listOps ~751) are far from it.
- **Tests and docs:** new paths on both sides, no overlap.

## The exact intake diff (proposed, not applied)

On `684c53b6`, take `eaf2b97d`'s six files, with `server.mjs`'s import block resolved to:

```js
import { MockGrantPort, STATES, TERMINAL, resultUnknown } from './ports.mjs';
import { AGENT_PRICE_NOT_READ, prepareNotice } from './confirm.mjs';
import { LocalReceiptPort, assertReceiptPort, ws04ActAfterRead, ws04ActAfterFailedRead } from './receipt-port.mjs';
```

and `consult`'s registry block exactly as on `eaf2b97d`:

```js
        const r = ws04ActAfterRead(op.ws04Act, a, { key: keyOf(op), at });
        if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
        op.ws04Act = r.act;
      } catch (e) { op.ws04Act = ws04ActAfterFailedRead(op.ws04Act, `${e?.code ?? 'Error'}: ${scrub(e?.message)}`, at); }
```

| File | Take |
|---|---|
| `mcp/src/receipt-port.mjs` | `eaf2b97d`'s blob as is (D unchanged from base) |
| `mcp/src/server.mjs` | D's + import resolution + `consult` hunk |
| `mcp/test/ws04-act-read.test.mjs`, `mcp/test/ws04-cancel-own-signature.test.mjs` | `eaf2b97d`'s |
| `docs/integration/CLAUDE-WS03-REGISTRY-CORRELATION-20261117.md`, `…-ACT-READ-HELPERS-20261117.md` | `eaf2b97d`'s |

**Who:** `receipt-port.mjs` and its dedicated tests are main's (Lane D does not edit them). The intake is therefore
main's or the one integrator's, after the paths and hashes are handed over; Lane D did not do it.

## Worked cases (from the code; not executed)

| Case | Input | ws04Act after consult | ws04CancelPhase | Verdict |
|---|---|---|---|---|
| version omitted | receipt without `receiptVersion` | applied, `receiptVersion: null` | as below | existing compatibility kept (③ does not refuse; ⑥ does) |
| key omitted | `idempotencyKey` absent/null | applied (R2) | — | kept for an older ④ or a stub |
| key mismatch | `idempotencyKey: 'ws03:lnk_b:req-9'` | not applied; `readError: "Inconsistent: the registry answered for another key (ws03:lnk_b:req-9)"`, `readErrorAt` = now, `at` = last answering read | previous `cancel` (if any) still used, `readAt` old | right; the message names the other key to this connection (registry under the same agentId — minor, noted) |
| signature equal | gateway `S`, registry `S`, until 900 | `signature: 'S'` | `until {900, signature S, source ws04 registry, readAt}` | used (G1) |
| signature mismatch | gateway `S`, registry `T` | `signature: 'T'` kept | registry until **not used**; relay lifetime if `lifetime.signature === 'S'`, else `null` | right (G2) |
| registry names none | `signature: null` | kept null | relay path | right (G3) |
| gateway absent (lost answer) | gateway none, registry `S` | `signature: 'S'` | registry's `until` with `S` | used (G4) — see residual below |
| Duplicate | `gateway.signature: null`, `duplicateOf: 'P'`, registry `P` | kept | registry not used; relay path → `until: null` | right (G5): never the earlier send's lifetime |
| read failure | `register`/`status` throws (`StoreError`, `Spawn`, …) | all kept; `readError`, `readErrorAt`; `at` unchanged | the last answered `cancel` with its old `readAt` | right (R5) |
| failure → success | then a read answers | `readError`/`readErrorAt` dropped; `at` new | fresh `readAt` | right (R4, R6) |
| registry `landed`, wallet `unknown` | — | `ws04Act.state: 'landed'` | — | op stays held by the wallet's fate; registry not promoted to chain evidence |

**Residual (not fixed, display only):** a lost answer (no gateway signature, so `duplicateOf` is never learned)
whose send the wallet actually answered `Duplicate`. If ④'s receipt for this key then names the earlier send's
signature, G4 shows that signature's `until`. It is labelled with the registry's signature and source and its
`readAt`, feeds only the cancellation view, and changes no state or decision.
- **Whether ④'s fate for a duplicated key can name another request's signature:** not verified here (④'s receipt
  has `conflict` and `why`, not a duplicate flag).
- **Owner of the question:** ④.

**readVia:** not present in ③ at either tip; it is ⑤'s field (main reads its provider). Neither `source` nor any
read tag is finality: the registry answering, its `source: 'mcp'` and a "gateway"-style read tag say who recorded or
read it, not that a chain confirmed it.

## Acceptance conditions (static, for whoever takes it)

1. **The base is `684c53b6`** (or Lane D's tip at intake), plus the six files above.
   - Outside `consult`, the only change to `server.mjs` is the **three-line** import block.
   - `receipt-port.mjs` equals `eaf2b97d`'s blob.
   - `git diff --check` is clean.
2. **`ws04CancelPhase`, `consult` and the "unchanged" list** are exactly as `f9376faa` §4 (2)–(4) states:
   - signature non-null, no `duplicateOf`, gateway signature unset or equal;
   - another key is never applied;
   - `at` only on an answered read;
   - `applyFate`, `register`, `runStatus`, grants and every send path are unchanged.
3. **D's behaviour unchanged:** `resultUnknown`, `receiptOf`'s `next` and notes, `list_operations`, `prepareNotice` and
   `confirm`, tool descriptions and `SERVER_INSTRUCTIONS` are byte-identical to `684c53b6`.
4. **Tests stay written, not run:**
   - `ws04-act-read`, `ws04-cancel-own-signature`, and D's `instructions-flow`, `prepare-confirm`,
     `unknown-result-display`, `list-result-unknown`, `recovery-codes` and `action-not-allowed-advice`.
   - Any run needs its own approval, through `scripts/ci/node-keyfree.sh`; its `--check` refused earlier with exit 5.
5. **`17f4cca4` and its held fix:** not taken, not republished, not renamed.

## Not verified

- No merge was attempted, so the conflict prediction is from the hunks only.
- No test, syntax check or import ran; ④'s `runexec` was not run.
- The G4 residual (above) is open.
- How a client shows `ws04Act` is unchecked; no ChatGPT or Claude Code client was used.

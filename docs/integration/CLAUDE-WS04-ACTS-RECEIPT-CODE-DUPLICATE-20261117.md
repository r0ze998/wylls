# ④ act receipt carries the wallet's `code`; ⑬ reads a Duplicate as a Duplicate (2026-11-17)

**Branch:** `claude/ws04-acts-receipt-code-20261117`, from the canonical candidate `claude/canonical-candidate-20261116` at `d16048aa`. Both edited files have the same blob there as at `b88794bb`: `acts.rs` `37fb6fc2`, `ws04-acts.mjs` `536adaac`.

**Static change, NOT run, NOT integrated:**
- **Not done:** no test, old or new; no `cargo`, import, syntax check, runner, HTTP, RPC, signing or world.
- **Not touched:** ③, `receipt-port` (reserved for Lane D) and Lane C's area.
- **Not run in any form:** ⑬'s guard tests and the other refused items.

**Background:** `CLAUDE-WS13-DUPLICATE-RESTART-PRODUCER-GAP-20261117.md` (`b88794bb`, on `claude/ws13-sendfailed-same-key-20261117`).

## Where the Duplicate information is lost (traced, all at `d16048aa`)

| Step | What it has | What it drops |
|---|---|---|
| **Wallet `#run`, Duplicate of a seq action** (`gateway.mjs:695-704`) → `ledger.recordAction` (spreads the entry) | `status: 'failed'`, `code: 'Duplicate'`, `sent: null`, `duplicateOf: S`, `signature: S` (S = the earlier send's) | — |
| **Wallet `actionFateView`** (`:181-192`) at `GET /f/agent/fate` | `status`, **`code: 'Duplicate'`**, `signature: S`, the state of S's chain fate | `duplicateOf`; and `sent: null` becomes `sent: true` |
| **④ `acts::refresh`** | stores the whole answer as `facts`, `code` included (a failed read keeps it) | — |
| **④ `acts::receipt` (`p04-acts/0.1`)** | `state`, `signature` (S), `commitment`, `why`, … | **`code`, `status`** |
| **⑬ `fateOfReceipt`** | `status: 'sent'`, `fate` (S's), `signature: S` | — |
| **⑬ `#run` (status path, after a restart) / `#reconcile` (a lost reply)** | the line becomes `sent`/`landed` with `it.signature = S` | — |

**Without a restart or a lost reply,** ⑬ gets the Duplicate answer itself and ends the line `failed` (`#retryOrFail('Duplicate')`; Duplicate is not transient).

## Every reader, and how it treats a new field

**Wallet fate view readers:**
- ③: `game.actFate` → `server.mjs` `applyFate`;
- ④: `refresh` (stores all);
- ⑤: `fate-reader`, `acts-registry`;
- the web client: `fagent.mjs`, `statusview.mjs`;
- the wallet's tests.

**Act receipt readers:**
- ③ `consult` and `runStatus` (picks fields; `runStatus` passes registry rows through to its answer);
- ④ `clients/acts.mjs` (`toWs13Status` and `toP05Act` pick fields);
- ⑤ `acts-port` (spreads the receipt and adds its own fields) and `run-receipt` `actFrom4` (picks fields);
- ⑬ `ws04-acts` (picks fields).

**No reader checks for an exact key set:**
- Every test assertion on these objects picks named fields: `permutation-gateway/test/agent-wallet-*.test.mjs`, `04-execution/clients/acts.test.mjs`, `tests/act_cli.rs`, `03 …/ws04-acts.test.mjs`, `ws05-shared-registry.test.mjs`, `05 …/acts-fate.test.mjs`, `acts-runexec.test.mjs`.
- ⑤'s `run-receipt.conformance.mjs` checks ⑤'s own `RECEIPT_FIELDS`, not ④'s receipt.
- No `additionalProperties` or unknown-field rejection applies to them (③'s `additionalProperties: false` is on tool *inputs* only).

**Version precedent:** ④ added `next` and `newAttemptAllowed` to this receipt (`b82fafa8`) and kept `receiptVersion: "p04-acts/0.1"`. Adding a field under the same version therefore follows ④'s own practice. ④'s contract (`EXECUTION-CONTRACT-20261106.ja.md` §3.3, §7) states no other rule.

**Effect on readers that do not know `code`:**
- ③'s `runStatus` rows and ⑤'s `acts-port` answers will show one more field, `code`, as data.
- No reader decides anything on an unknown field.
- ③'s `consult`, ④'s client helpers, ⑤'s `actFrom4` and ⑬ (before this change) do not read it.

## The change

1. **④ `src/acts.rs` `receipt`:** adds `"code": f["code"]`. This is the gateway's code word for this key's entry, as already recorded by `refresh` (null when absent), plus one row in the module's field table.
   - `receiptVersion` is unchanged.
   - Nothing is interpreted in ④: no state, `next`, `final` or `cancel` rule changes.
2. **⑬ `resident/ports/ws04-acts.mjs` `fateOfReceipt`:** a receipt with `code: 'Duplicate'` **and a signature** (the earlier send's) is answered as the Duplicate failure the wallet gave this key's submit: `{ok: false, status: 'failed', fate: 'failed', fateError: 'Duplicate', error: {code: 'Duplicate'}, duplicate: true, ws04: {…, code}}`, **with no `signature`**.
   - **The order:** `unqueryable` and unknown states are still thrown first.
   - **A Duplicate without a signature** (refused before signing: a non-seq action out of rebuilds, which reads `not-sent`) keeps today's handling.
   - **What follows in ⑬, unchanged code:**
     - `#run`'s status path: `status: 'failed'`, not ambiguous, then `#retryOrFail('Duplicate')`, which ends `failed`;
     - `#reconcile`: `fate: 'failed'`, then `#retryOrFail(it, 'Duplicate')`, which ends `failed` (or `cancelled`/`revoked` under `noMore`).
   - This is the same end as the answer itself: no resend, not counted as landed, and S never stored as this line's signature.

**What `fate: 'failed'` means here:** it is ⑬'s journal word for "this line ends without effect of its own", the end it already reaches from the answer. It does **not** claim that S failed on chain. S's state stays visible as `ws04.state`.

**Not changed, and not decided:**
- **The wallet's `actionFateView`** (it drops `duplicateOf` and says `sent: true` for a Duplicate entry). That is a change of meaning, not an addition: a proposal for the wallet's owner. ⑬ does not need it once `code` is there.
- **Whether the earlier send's effect may count for this line** (if it was this resident's own earlier attempt). It is the same open question as Lane D's for ③. Here it is **not** upgraded: S is never this key's success.
- **⑬'s may-have-left change** (`claude/ws13-sendfailed-same-key-20261117`) is independent. Both touch only different files: `resident.mjs` there, `ws04-acts.mjs` here.

## Regressions (written, NOT run)

| File | Cases |
|---|---|
| `workstreams/04-execution/tests/acts_code.rs` | a Duplicate fate answer → the receipt has `code: "Duplicate"`, the same `receiptVersion`, the same state and signature, and the store-only receipt also has it; a plain send → `code` null; a failed read after a Duplicate reading keeps `code` (state `unqueryable`) |
| `workstreams/13-citizens/test/ws04-acts-duplicate.test.mjs` (pure: imports `ws04-acts.mjs`, which imports nothing) | Duplicate + signature in states landed, pending, unknown and failed → a Duplicate failure without a signature; Duplicate without a signature (`not-sent`) → as before; no code or `SendFailed` → as before; `unqueryable` + Duplicate → still throws |

## Still open, and blockers

- **Running:** these regressions, and ⑬'s family, need their own approval. ⑬'s guard tests stay held.
- **Taking in the ④ change** is for ④'s owner and the integrator: a shared file (`acts.rs`, Rust) and a new receipt field. Paths and hashes are in the commit.
- **The wallet's `actionFateView` proposal:** carry `duplicateOf`, and keep `sent: null` for a Duplicate entry.
- **⑬'s production `send` and assembly are still not connected,** and the gateway-or-store-only read choice still decides the lost-send liveness gap (`CLAUDE-WS13-JOURNAL-RESTART-BOUNDARY-20261117.md` §4-1).

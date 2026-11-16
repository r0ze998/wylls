# ③ MCP: intake candidate — eaf2b97d on 4cdf4ae2, own-signature-only registry deadline, unqueryable kept as a failed read (2026-11-17)

**New independent candidate branch** `claude/ws03-registry-intake-20261117`, one commit on Lane D's
`claude/ws03-chatgpt-flow-20261117` @ `4cdf4ae2`. It was built with a temporary git index, with no branch switch and
no merge or cherry-pick command; the six files were assembled from blobs.

**Not touched:**
- main, the canonical candidate and other trees;
- `claude/ws03-chatgpt-flow-20261117` and `claude/ws03-registry-correlation-20261117` (both unchanged);
- the owner's 25 deleted media, the 19 untracked files, and the worktree's HEAD and index.

**Ownership:** main handed the edit ownership of `receipt-port.mjs`'s correlation helpers, cancel guard and
unqueryable scope to Lane D.

**Static, NOT run, NOT integrated, no device.** Nothing was executed: no test, syntax check, import, scanner, server,
world, browser or runner, and no HTTP, RPC, auth, signing or send. `17f4cca4` is an ancestor of neither tip
(checked); neither it nor its held `ws04View` change is included.

## 1. eaf2b97d taken (its six files)

| File | Taken as |
|---|---|
| `mcp/src/receipt-port.mjs` | `eaf2b97d`'s blob (unchanged on `4cdf4ae2` since `d16048aa`), then §2–§3 below |
| `mcp/src/server.mjs` | `4cdf4ae2`'s, plus `eaf2b97d`'s two hunks (see below) |
| `mcp/test/ws04-act-read.test.mjs`, `mcp/test/ws04-cancel-own-signature.test.mjs` | `eaf2b97d`'s, then updated (§2–§3) |
| `docs/integration/CLAUDE-WS03-REGISTRY-CORRELATION-20261117.md`, `…-ACT-READ-HELPERS-20261117.md` | `eaf2b97d`'s, unchanged (G4 there is corrected by this report) |

**`server.mjs`'s two hunks:**
- **The import line:** the `ports.mjs` (`resultUnknown`) and `confirm.mjs` lines stay; the `receipt-port.mjs` line
  gains the two helpers.
- **`consult`'s registry block:** compared line for line with `eaf2b97d`'s diff, it is the same. Then `scrub` is
  passed (§3).

**Unchanged from `4cdf4ae2`:** `applyFate`, `markDuplicate`, `isDuplicate`, `recover`, `send`, `resume`, grants,
`prepare`, `confirm.mjs`, `resultUnknown`, `ports.mjs`, `tools.mjs`.

No conflict other than the import line, as predicted.

## 2. Registry deadline: this server's own signature only

`ws04CancelPhase` uses ④'s `cancel.until` only when **all** of these hold:
- the registry receipt names a signature;
- **this server holds a signature of its own** (`op.gateway.signature`) and it is the same one;
- the operation is not a Duplicate. A Duplicate is marked by `Object.hasOwn(op.gateway, 'duplicateOf')`, which also
  covers a Duplicate that named no signature (`duplicateOf: null`, kept that way since `4cdf4ae2`).

Otherwise the existing relay-lifetime rule applies unchanged, and without an own signature it gives `until: null`.

**Why G4 is corrected:**
- **What `eaf2b97d` did:** it used the registry's signature and deadline when the server had none (a lost answer).
- **Where that signature comes from:** the wallet's record for the key. That record names an earlier send's
  signature when the request was a Duplicate the server never learned of. It can also arrive while the wallet's own
  fate read failed (`game.actFate` → `unqueryable`) and the registry still answered.
- **The rule:** ③'s adopted rule (`lost-answer.test.mjs:156-161`) is "the lifetime of this request's own signature,
  null without it". A registry answer alone does not prove ownership.

**What it changes:** display only (the owner's view, the revoked connection's cancellation). No state, send or retry.

## 3. Unqueryable receipt kept as a failed read (option B)

`ws04ActAfterRead(prev, a, {key, at, scrub})`:
1. **The key is checked first**, for every receipt: another key → `Inconsistent`, not applied.
2. **When `a.state === 'unqueryable'`:**
   - everything known is kept: the last answering read's `state`, `next`, `cancel`, `signature`, `source` and `at`;
   - it is recorded as a failed read: `readError = WS04_UNQUERYABLE` (a fixed text) and `readErrorAt` = this read;
   - `registryUnqueryable: {lastReadError, why, at}` keeps ④'s own texts verbatim through the server's `scrub` (the
     same boundary as every other error text). They are never parsed.
3. **A first-ever unqueryable** keeps only what registration stored. No `at` appears, so no answering read is made up.
4. **The next answering read** drops `readError`, `readErrorAt` and `registryUnqueryable`, and sets `at`.

**Not changed:** ④'s receipt shape, its trust, chain provenance, `source` and `readVia` (none is chain evidence).
Finals are untouched: ④ never turns a final into `unqueryable`. No `readVia` wiring was added, and ⑤'s branches are
not taken.

## Static checks (paper only)

- **G1–G6 (`ws04-cancel-own-signature`):**
  - G4 now expects `null` without an own signature (also with a relay lifetime alone).
  - G5 adds `duplicateOf: null`, and `duplicateOf` present beside a signature.
  - G1, G2, G3 and G6 hold on paper.
- **R1–R9 (`ws04-act-read`):**
  - R7 covers prior state/next/cancel/signature/`at` kept, the marker, the time, the scrubbed text and null kept.
  - R8 checks the key first.
  - R9 checks that a first-ever unqueryable invents nothing and that the next answer clears it.
  - R1–R6 are unchanged.
- **Existing pins:**
  - `keyfree/integration.test.mjs:94` reads ③'s `ws04Act.state`/`next` = `unknown`/`hold` from an answering read
    (unaffected); `:97`/`:101` are ⑤'s and ③'s fate, not `ws04Act`.
  - `ws04-acts.test.mjs:67-71` reads `ws04Act` fields from answering reads.
  - `lost-answer.test.mjs:108-111,156-161` has no registry receipt or an own signature.
  - None pins the old G4 behaviour.

## Test safety (dependencies read only)

`ws04-act-read.test.mjs` and `ws04-cancel-own-signature.test.mjs`:
- **Imports:** `node:test` and `node:assert/strict`, plus `../src/receipt-port.mjs`, which imports only `./ports.mjs`,
  which imports nothing.
- **What they touch:** plain objects only. No network, process, key, signature, file read/write or timer.
- **Guarded run:** `scripts/ci/node-keyfree.sh workstreams/03-composability/mcp 'test/<file>'`, when a run is approved.
  Its `--check` refused earlier (exit 5, stale review), which is not this lane's to change.

## For whoever integrates

- **Base:** `4cdf4ae2` + this commit.
- **`server.mjs`:** it differs from `4cdf4ae2` only in the import line and `consult`'s registry block (with `scrub`).
- **`receipt-port.mjs`:** `eaf2b97d`'s plus §2–§3.
- **Hygiene:** `git diff --check` clean.

## Not verified

- No test (new or existing) was run; no syntax check, import or merge was done.
- How ④'s real `runexec` emits `unqueryable` receipts was read from `acts.rs`, not observed.
- No ChatGPT or Claude Code client was used.

# Original boundary and conquest history (2026-11-09)

## Delivered scope

The original Frontier recorded-world history now reads the earlier closed
original-origin expedition receipts and wide conquest lifecycle receipts:

- PS2/146: Depart and SettleOrigin.
- PS2/147: Reveal and Gather, with exactly zero chain links.
- PS2/148 + PSW1/25: paired member settlement.
- PS2/145: original source debit/credit, explicitly a source reference rather
  than evidence that a resident host exists.
- PSW1/18–24: declaration, debit, Resolve, failed/lapsed settlement, capture,
  credit and table closure.
- PSWC: separate sidecar closure, no kind byte, no entity identity or chain.

`wideexpeditionhistory.mjs` checks canonical body layouts, operation hashes,
original/wide address families, public derived addresses, identity summaries,
optional fields and exact tails. It does not authenticate historical inputs,
replay economics or establish current balances/ownership. Page-local pairs must
have opposite roles and matching exact commitment bytes in the same captured
transaction. An absent part remains an unpaired observation, including page
boundaries. A lone lapse/capture target may also be a legitimate operation with
no source credit when the canonical source was absent or stale. Receipt shape
cannot distinguish that case from a missing credit log, so it remains unverified
and is not labelled a proven burn, refund or complete history. Declaration debit
pairs and the target for every observed source are still required by the full
transaction reader. Table/sidecar closure does not become a fake Province or host.

The Japanese/English original UI renders these records without instructions,
signing, send controls or terrain inferred from event coordinates. Source debit
and credit identity sequence zero is not treated as proof of a host. Corrupt
reads clear stale rows. Existing resident, economy, garrison, recorded-map and
wide-operation-review behavior is retained.

## Actual native log anchor

`frontier-node/crates/fclient/tests/fixtures/original_boundary_v1.bin` is 14,638
bytes, SHA256:

`48e97269e39672bee2f19b7c692a8dca95b608f050c45e2e932922b4de9e47d5`

Its bounded BTRCv001 envelope contains program address, season address and 51
successful native invocation Clock/log captures, totaling 56 receipt bodies.
These are the actual outputs of the existing unsigned, synthetic-initial-state
continuous original departure → original Resolve → SettleOrigin → proof Reveal
→ Gather → wide Resolve → settlement → declaration → siege Resolves → FreeCity
capture → voluntary resident Dissolve → Resolve → original reserve Return test.
The repeated idempotent Gather is retained. Failed/refused calls are not recorded.

The native test records logs only after successful official-runtime writeback;
no intermediate gameplay outcomes are injected. The one-time create-new exporter
was removed. Its permanent assertion compares the whole trace byte-for-byte to
`include_bytes!`, with no writer or environment override. Consumers read this
immutable fixture without executing native handlers or reproducing proof recovery.

This envelope is not a signed transaction, authenticated ledger, RPC archive,
full-season replay, deployment or proof that every possible route works. The
synthetic initial economy/anchors and the voluntary-resident return limit from
the earlier native report still apply. Reverse sealed return remains separate.

## Verification

Five exact new tests in `web-frontier-wide-expedition-history.test.mjs` passed:

1. All 56 native receipt bodies reach the original history parser unchanged.
2. Every truncation and selected malformed hashes/addresses/identities/tails
   are refused; bytes without an authenticated expected value are not claimed
   to be verified just because they are included in a record.
3. Settlement and conquest matching is transaction-local/page-local, with
   duplicate roles, conflicting bells and repeated ordinals refused.
4. All conquest stages and PSWC have separate non-host schemas, including
   synthetic coverage for stages absent from this capture-return trace.
5. Actual Herald client + original mode with injected GET-only fixtures and a
   minimal DOM: three pages, source-reference labels, language change, close/
   reopen, corrupt-read clearing/recovery and no executable action controls.

The following exact seven suites passed **57/57** under the existing no-key
Node guard:

```
node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test \
  permutation-gateway/test/web-frontier-wide-expedition-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-resident-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-economy-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-garrison-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-capture.test.mjs \
  permutation-gateway/test/web-frontier-wide-focus.test.mjs \
  permutation-gateway/test/web-frontier-wide-world.test.mjs
```

These are parser and DOM-contract tests, not a browser visual acceptance run.
No keys, signing, actual transactions, real network, SBF/deployment or CI were
used. The exact native function
`proc::wide::expedition_gather::exec::lifecycle_tests::contiguous_original_boundary_capture_and_resident_home_return`
also passed after exporter removal, including complete immutable trace parity and
the shared resident ABI role tables. Three pre-existing unused-code warnings remain.
The typed reader/index/Herald selections passed 17 tests, and keeper selections
passed 37 tests, including the same actual 51-invocation/56-receipt trace. Their
scope is documented in `docs/frontier/WIDE-ORIGINAL-EXPEDITION-READ.md` and
`docs/frontier/world-index/original-expedition-observer.md`. Rust checks used
locked/offline dependencies, the existing native target, two jobs and disabled
incremental compilation. Builds were serialized and disk headroom checked.

## Remaining execution and trust boundaries

The separate typed index must explicitly enable the expedition reader; old or
incompatible index modes fail closed rather than report an empty success. No
existing user index was migrated or opened during these isolated tests.

Receipt display and cross-part matching do not authenticate the original entity
chains, source completeness, declared ownership, conquest economics or historical
Resolve evidence. The previous detached resident transition checker remains a
conditional supplied-input check, not full-season PASS. Public handlers/gates,
transaction submission, wallet signing, deploy and live-game activation are not
changed by this reader work.

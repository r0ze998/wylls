# Original-game resident history reader (2026-11-09)

## Scope

The original Frontier page's existing **recorded-world history** now consumes
private-candidate PS2/149 and PSW1/26 resident Dissolve/Return observations from
the separately configured typed index. This is not a new demo, game simulator,
wire instruction, deployment, or activation of the closed execution paths.

`map/wideresident.mjs` validates the exact canonical body, version/action,
original source versus wide standing family, full host reference, canonical
original Holding and wide Province addresses, nonzero/distinct recipients,
outcome ranges and units, operation digest, and exact ordered chain-tail shape.
The original Citizen is retained as an account address, not interpreted as a
wallet. Original sequence-zero hosts remain valid identities.

The existing scoped/paginated history reader checks raw-body/metadata agreement.
Only opposite receipt parts within the same captured transaction and current
page are marked as matching, after all body bytes except family headers and
chain tails agree. A part on another page is explicitly unpaired here. Pairing
is not authentication or a claim that the source is complete.

The Japanese and English original UI show original home/site/generation/host
sequence, standing province, logged bell, milli-troops and whole returned reserve
separately. These are recorded outcomes, never current balances. Resident rows
cannot enter the generic wide-host operation review. No instruction is built,
no signing/submission occurs, and history does not create map terrain or holdings.
Invalid/mismatched reads clear stale rows and remain errors, not empty history.

## Evidence

Six new exact tests in
`permutation-gateway/test/web-frontier-wide-resident-history.test.mjs` cover:

- Both families and actions, full original identity, units and no executable UI.
- Same-transaction matching, duplicate/conflicting parts and page boundaries.
- Every truncation, excess bytes, tails, versions, digest, recipients and metadata.
- Coordinates beyond 2^53, u64 chain sequences and mixed-family refusal.
- The actual herald client and original mode through injected GET-only reads and
  a minimal DOM contract in both languages, including stale-error recovery.
- Both immutable actual native Dissolve/Return fixture receipts, byte for byte.

Native fixture inputs are public synthetic account state and actual output from
the existing guarded capture-to-return test, not live-chain data. The UI does
not rerun native handlers, generate fixtures or validate economic replay.

Pinned source fixtures:

- `frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/dissolve_v1.bin`
  SHA256 `0d46cd2d175c57c947af8e67f14f2d002e18c9e7e7d47fb4a944e98023f39a84`
- `frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/return_v1.bin`
  SHA256 `6f22a8e606852e52d87f66e0f2452fd00c6a26aa42716a2fc874feb4643d7da3`

The six exact suites below passed **52/52** with the existing no-key Node guard:

```
node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test \
  permutation-gateway/test/web-frontier-wide-resident-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-economy-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-garrison-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-capture.test.mjs \
  permutation-gateway/test/web-frontier-wide-focus.test.mjs \
  permutation-gateway/test/web-frontier-wide-world.test.mjs
```

These are parser and DOM-contract tests, not browser visual acceptance. Imports
and executed tests use public hashing/address arithmetic, fixed literal or
immutable fixture bytes and fake fetch only. No keys, signing, private material,
real transactions, real network reads, SBF, deployment or CI were used.

## Remaining boundaries

This reader does not verify prior account chains, authorization, Resolve history,
economic effects, current ownership or full-season provenance. The detached
native-output verifier is a separate conditional checker. Source coverage stays
`unknown`; capture verification stays `unverified`.

A read pipeline configured for these receipts is required. An unconfigured or
older index remains an error rather than an empty success. Earlier expedition
and conquest receipt kinds are not implicitly enabled by recognizing these two
resident kinds. Public original-origin resident dispatch and live-account
transaction construction remain absent. This work therefore does **not** make
the original boundary-cross/capture/return flow playable in a deployed game.

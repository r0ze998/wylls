# Original resident wire-to-handler integration

## Bounded change

The existing isolated original-resident draft contract now has a private runtime decoder in `wide_expedition_resident::execute_draft`. It requires exactly 60 bytes and one complete prefix: Dissolve `[0xDA, 0xFF, 1, 7]` or Return `[0xDC, 0xFF, 1, 12]`. It checks the existing eight-/six-role account table before reading Season position 2/1, derives scope only from the actual runtime program and Season account key, and uses the existing context-bound `DraftCommand::decode`.

The resulting action and full original host are passed to the unchanged authenticated Dissolve or Return handler. No decoded host, context, authorization, outcome, prepared plan or receipt is supplied by an external caller. Existing minimum privilege semantics remain intact; nominal-read `Acc::Any` roles are not newly required to be readonly.

This is not public admission. `WideCommand`, v2 and `ResidentAct` still reject both proposed operations. The top-level program dispatcher still returns BadData, and `EXPEDITION_ENABLED` remains false. No operation allocation, opcode/parser change, feature flag or deployment is added.

## Evidence

The existing continuous capture-return test now serializes the real 60-byte Dissolve and Return proposals through the official native runtime ABI and calls the private decoder. Existing signer, writable, generation, capture-lock, overflow and raw Leave/retirement-marker refusal cases use the same wire entry instead of directly supplying a host argument.

New disposable runtime contexts cover all truncated lengths, an appended byte, each envelope field, host version, wrong world, a canonical wide-family host, a valid opposite action with the wrong role count, missing/extra roles, a wrong Season role and a wrong program parameter. Public dispatch refusal is also exercised. After every expected refusal the test returns success only to permit official writeback, then compares every output account and asserts no logs or CPIs. Probe histories are discarded and never enter the successful gameplay trace. The wrong-program case proves parameter/context rejection, not execution under another deployed program.

All four exact contiguous lifecycle functions passed, with no failures or ignored tests. They continue to cover outward departure/proof/Gather/combat, retreat, capture and resident reserve return. This reruns the same four functions from the preceding checkpoint; it is not four additional independent test functions. Compile-only and execution used the installed Rust 1.95 native toolchain, offline locked dependencies, aarch64-apple-darwin, two jobs, CARGO_INCREMENTAL=0 and serial tests. Three pre-existing dead-code warnings remain.

The immutable fixtures are byte-identical and all parity assertions passed:

- BTRC `original_boundary_v1.bin`: `48e97269e39672bee2f19b7c692a8dca95b608f050c45e2e932922b4de9e47d5`.
- BRES Dissolve: `0d46cd2d175c57c947af8e67f14f2d002e18c9e7e7d47fb4a944e98023f39a84`.
- BRES Return: `6f22a8e606852e52d87f66e0f2452fd00c6a26aa42716a2fc874feb4643d7da3`.

The paired PS2/149 and PSW1/26 receipts still commit the existing 56-byte host input with action separately bound. The new 60-byte transport envelope is deliberately not substituted into receipt hashing. Economic effects, chains, full original identity, actual Resolve requirement and whole-unit reserve rounding are unchanged. No fixture was regenerated.

## Remaining boundaries

This only completes private wire consumption for current-generation, voluntary original-host resident return. Captured previous sources, retired/redirected Leave, stranded cleanup and reverse sealed marches remain unsupported. The original-to-wide resolved settlement still has no public command codec/router, and its bad-seal/nonmember and winning camp-loot paths remain refused. These are separate incomplete paths, not evidence that a whole gameplay release is ready.

No activation, live RPC, sealing, new key material, signing, transaction submission, SBF/bank execution, deployment or CI occurred. No locks, ABI tables, workflow or review metadata changed. Only existing published test proof material is used by the unchanged outward portion of the native lifecycle.

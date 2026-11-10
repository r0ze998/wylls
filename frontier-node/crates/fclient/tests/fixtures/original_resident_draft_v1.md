# Original resident draft parity vectors

`original_resident_draft_v1.json` fixes public inputs and expected private draft
bytes, account roles, effective privileges, and content digests for Rust and web
consumers. It contains no keys or signatures and does not admit an instruction.

The two `native-role-snapshot` cases were extracted from existing immutable
`verify/tests/fixtures/wide_expedition_resident/{dissolve,return}_v1.bin` archives.
Their SHA-256 hashes are recorded in each case. Program, Season, full host,
standing, owner, wallet, payer, account addresses and flags come from the archive
header, paired receipts, and before-account snapshots. The Rust test separately
checks these fixed values against those archives. Neither the Rust draft builder
nor the web builder generated the expected values.

The 60-byte proposal is the ABI's four-byte private prefix (`da ff 01 07` for
Dissolve, `dc ff 01 0c` for Return), followed by the archive's 56-byte host. The
native handlers received typed arguments; these vectors do not claim that the
proposal wire was executed. Existing public parsers continue to reject it.

Two explicitly labeled `public-contract-variant` cases cover additional scope:

- `dissolve_actor_payer_alias` makes payer equal actor, with writable privileges
  unioned at both ordered account positions.
- `return_full_width_standing` uses `(9007199254740993, -2)`, beyond JavaScript's
  exact Number range. Its canonical key and public with-seed addresses were
  computed independently using integer geometry and SHA-256. It is not a native
  account-state or execution fixture.

Expected digests were computed independently with Python's standard SHA-256
over the following concatenation. All lengths are unsigned 32-bit little-endian;
addresses are decoded 32-byte public addresses, not their base58 text.

```text
ASCII("PSF-ORIGINAL-RESIDENT-DRAFT-v1")
program[32]
season[32]
canonical_standing_key[50]
LE32(command_length = 60)
command[60]
LE32(role_count)
for each role, in account order:
    LE32(UTF8(role_name).length)
    UTF8(role_name)
    address[32]
    signer[1]       // 0 or 1
    writable[1]     // 0 or 1
```

The content digest binds the full proposal scope, including standing and payer,
which are absent from the command bytes. It does not bind the inspection request
or account snapshot: those retain their separate request/snapshot digests. It
does not prove source authenticity, authorization, readiness, or execution.
`public_dispatch_available` and `admitted` remain false.

The exact Rust test target is `fclient --features wide-records-experimental
--test wide_resident_draft`. It uses public-address construction and immutable
bytes only; no RPC, process spawning, signing, or transaction construction.

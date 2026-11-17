# Original-origin resident native fixtures

These two immutable files were captured from the actual successful private
Dissolve and Return handlers during the continuous original departure, boundary
combat, Free-City siege/capture and original-reserve return test. They are not
expected outputs produced by the independent verifier.

- `dissolve_v1.bin`: 35,324 bytes; SHA256
  `0d46cd2d175c57c947af8e67f14f2d002e18c9e7e7d47fb4a944e98023f39a84`.
- `return_v1.bin`: 34,195 bytes; SHA256
  `6f22a8e606852e52d87f66e0f2452fd00c6a26aa42716a2fc874feb4643d7da3`.

The native lifecycle now reconstructs these bytes from actual before/after
World snapshots and emitted receipts and asserts exact `include_bytes!` parity.
The one-time create-new-only exporter was removed immediately after capture.
No exporter, update environment flag or network path remains in the test.

## Encoding

All integers are little-endian. Fields, in order:

1. Eight-byte magic `BRESv001`.
2. Action u8: 1 Dissolve, 2 Return.
3. Program 32 bytes, Season 32 bytes, full original host reference 56 bytes.
4. Pre-handler Clock timestamp i64 and slot u64.
5. Role count u8: 8 for Dissolve, 6 for Return.
6. All before roles, then all after roles, in exact invocation order.
7. Receipt count u8, exactly 2. Each has u32 length and body bytes: first PS2/149,
   then PSW1/26. Prefixes are asserted by the native producer, not stored here.

Each role encodes address32, owner32, presence/signing/writable/executable flags
(one byte each, 0 or 1), lamports u64, data length u32 and exact data bytes.
Role privileges are synthetic effective runtime flags, not verified signatures.
Absence means System-owned with empty data, independent of lamports.

## Limits

This is unsigned native execution using official account serialization and the
already audited System CPI adapter. Initial Season, founding, stock, opening,
issuance and beacon account provenance are synthetic. Published public proof
vectors and permitted symmetric recovery were used upstream. No private key,
new keypair, signing, transaction submission, RPC, SBF or public activation was
used. These bytes do not prove chain freshness, signer authentication, bank
rollback, historical prerequisites or an entire season. The new verifier proves
only conditional transition consistency over supplied invocation snapshots.

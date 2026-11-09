# Original outbound public vectors, version 1

`original_outbound_v1.json` is an immutable synthetic public codec fixture produced by the Rust integration test `original_expedition_depart_draft`. Normal tests only read it with `include_bytes!` and compare it to canonical Rust output. There is no fixture writer, environment-controlled exporter or regeneration hook in the committed test.

## What it checks

- `plain`: three 136-byte `WidePlain` examples, including original ring 128 to wide ring 129, an original issuer different from the current original origin, and a negative boundary. `program` and `season` are base58 public addresses. All coordinate strings are exact signed decimal integers. `host` and `hostHex` are the same full 56-byte reference in lowercase hex.
- `geometry`: exact `WideTile` results past the JavaScript safe-integer range in both signs and an empty geometry-only path. `steps` excludes the initial tile. `accountKeys` lists the destination first followed by other first-entered provinces, matching the canonical path-account convention. No unknown terrain, land opening, cost or arrival timing is inferred.
- `genericPlain`: a full-width wide-host plaintext for generic codec parity. It is not an eligible original-outbound request.
- `depart`: three current 369-byte `ExpeditionDepart` envelopes and nine ordered canonical roles, including both legal alias pairs and a distinct issuer/current origin. Signer/writable flags are the union of requirements for aliased addresses. SystemProgram is the canonical zero address. Other zero/program substitutions and cross-role aliases are refused.

The commit and seal are explicit public literal shape bytes: commit is 32 copies of 0x31, seal is 0x80 followed by 263 zero bytes. They are deliberately **not an encrypted seal**, and do not bind the plaintext examples. No private key, salt, IBE ciphertext construction, encryption, signature, transaction, RPC, runtime or account write is involved. Byte lengths prove only shape.

## Boundaries

The new `fclient::original_expedition_depart_draft::Draft` derives a proposed Citizen from an explicit wallet, and derives the original Holding, standing Province, issuer home Province and owned external bridge address from full public inputs. It does not accept substituted account addresses or imply wallet/session/NFT authorization. A host may stand in another original Province. Identity conversion does not prove that a generation or sequence was ever issued.

The current ABI decoder recognizes the 369-byte envelope. The public expedition dispatch remains closed, and ResidentAct admission refuses the wrapper. A draft exposes `admitted() == false`, `public_dispatch_available() == false` and `seal_verified() == false`. It does not construct a Solana Instruction, Message or Transaction, verify live accounts, select a free slot, prove account ownership, check locks/economics, or create an executable order.

A separate identity-only test reads the existing immutable `original_boundary_v1.bin` native emitted log and checks its full host/origin and Citizen/Holding/Province/bridge addresses against this resolver. That archive does not expose all nine account-role snapshots or departure wire bytes. Therefore it is **not** evidence of native nine-role or wire execution parity. The JSON fixture provides canonical codec parity only. Native lifecycle handlers and export hooks are unchanged.

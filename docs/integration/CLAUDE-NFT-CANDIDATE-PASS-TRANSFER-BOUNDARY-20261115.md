# The pass's transfer from the game page (candidate lane): built, tested, HELD in worlds — the 0x51 ABA boundary

LOCAL TEST CANDIDATE only ([0x4C; 32] / 0xC804; not an allocation). The ABI is not changed here.

## What exists (world branch)

- A pure page builder for the resident program's own TransferResident (`flocalresident.mjs`, `localTransferIx` / `localTransferMessage`). It is byte for byte the program's builder (`permutation-nft-resident-spike/src/resident-ix.mjs` `transferResidentIx`): keys, signer/writable flags and data `[0x51]` (test).
- The relay path: the resident schema with `name: TransferResident`, `fields: {to}`. Before its one send, on one read, it checks:
  - the policy;
  - that the asset's **current** Core owner is this wallet;
  - that the record's generation equals the **stated** one;
  - that the recipient is not this wallet.
  It then rebuilds the bytes with the policy's collection, compares them, and verifies the signature. Refused in tests:
  - a holder that sold the pass;
  - a stale stated generation;
  - itself (before any read);
  - another collection;
  - the conquest lane.
- The page: the NFT card's form and the `nft-transfer` action. Both are pinned like `nft-login`: wallet, world, relay, asset and viewer, re-checked after every await and inside the send. Controller tests:
  - one send, after which the page plays its own Citizen again;
  - a wallet switch sends nothing.

## The boundary (independent review, 2026-11-15)

The signed guarantees differ by instruction:

| Instruction | What the owner signs | What the program checks |
|---|---|---|
| 0xE2 ResidentAct / 0xDD WideResidentAct | the holder **generation** (in the data) and the order | the live Core owner, the transfer guard, **the signed generation equals the record's** |
| 0x51 TransferResident | data `[0x51]` only: **no generation** | the owner's signature and current ownership |

How the gap opens:
1. A signs a transfer at generation 0 and holds it unsent.
2. A→B→A happens (generation 2).
3. The old bytes are sent stating `generation: 2`.
4. The relay sees the current owner A and the stated generation equal to the record's, and sends them. The bytes are identical.

Its limits:
- **Blockhash lifetime:** about 151 slots from the blockhash the old transaction used. After that the chain refuses it (`BlockhashNotFound`).
- **Relay replay barrier:** the same digest is refused only if this relay already saw it (`seen`, per relay process). A digest that never reached this relay is new to it.
- **Direct chain path:** anyone holding the signed bytes can send them straight to the RPC. The program checks only the owner's signature for 0x51, so a relay rule cannot close this path.

Reproduced as a **todo test** (`KNOWN GAP …` in `frontier-local-play-nft-resident.test.mjs`). It asserts the wanted refusal and reports that the relay sends it today.

## Proposed fix (not implemented; for review)

1. **Relay-bound transfer blockhash.**
   - A new context request names the asset. The relay reads the record and issues the blockhash, keeping `(blockhash → asset, generation read)`.
   - A transfer submit is accepted only on a blockhash this relay issued for that asset, whose bound generation is the record's generation now.
   - The old generation-0 transaction above is then refused: its blockhash was not issued for generation 2, or was not issued by this relay at all.
   - This closes the relay path.
2. **Direct chain path:** it stays bounded by the blockhash lifetime until the resident program's TransferResident binds a generation. That would be an ABI change, **not decided here**.
3. Until 1 is implemented and reviewed, the page's transfer is **held in worlds**: the form and the action need `passTransfer: true` on the local-play identity, and no launcher sets it.
   - The old owner refused / new owner acts after a re-transfer is therefore **not proven in a world yet**.
   - The relay mock tests (a sold pass refused with `LocalActResidentNotHolder`) remain the evidence for the refusal side.

Nothing here claims old transfers are all invalid, or that the transfer path is finished.

## The direct-chain design proof (TEST ONLY; written, NOT built or run yet)

The relay path is now **default deny**: no relay a launcher or the relay server builds serves TransferResident (`13ac8f63`). Only an isolated test opts in. That closes nothing on the chain itself, which is what the program change below is for. Two variants are kept strictly apart:

| Build (feature) | 0x51 TransferResident | 0x54 TransferResidentAt {gen u32} | Closes the direct-chain A→B→A? |
|---|---|---|---|
| default (none) | as today | unknown → BadData | no |
| **compatible** `signed-transfer-test-only` | still served | the signed generation must equal the record's (else StaleGen 1004) | **no**: an old 0x51 held across A→B→A still lands |
| **strict** `transfer-requires-generation-test-only` | **refused (BadData)** | as compatible | **yes**, at the cost of every 0x51 client (a compatibility decision for the owner; not made here) |

- Code: `program/Cargo.toml` features and `program/src/lib.rs` `transfer_resident_at`. It is a feature-gated wrapper: it checks `check_resident`, then the signed generation against the record, then calls the unchanged `transfer_resident`, so the default build's code path is untouched.
- Proof: `svm-core/tests/signed_transfer.rs`. All tests are `#[ignore]` and run against three isolated builds plus the untrimmed Core ELF. They cover:
  - the default build refuses 0x54 and keeps 0x51;
  - 0x54 at the current generation moves the owner, bumps the generation and clears the session (all four session fields);
  - a wrong signed generation is refused and nothing changes;
  - an old 0x54 signed at generation 0 is refused after A→B→A, and nothing changes;
  - the compatible variant still lets an old 0x51 through, while the strict variant refuses it.
- Every refusal is checked strictly:
  - the program's error code;
  - every NON-fee account (asset, record, collection, collection authority, config, recipient) unchanged in existence, lamports, owner and data;
  - the fee payer changed by nothing but the signature fee.
- Further negatives: a truncated or oversized 0x54, the owner not signing (Auth), a non-holder (NotOwner), and another asset's record as the proof (BadAddress).
- Build-and-prove script: `resident-signed-transfer-proof.sh` (sha256 `2c0e3c92`). It pins the three variants' features and sha256 in a manifest, re-checks them right before the LiteSVM run, and compares the deployed candidate `947da0b9` before and after (it must be unchanged). It writes isolated artefacts with recorded hashes and features to the scratchpad, never over `program/target/deploy` (the candidate's `947da0b9` stays).
- **Not adopted, not deployed, not used in any world.** Adoption, and the choice between compatible and strict, wait for review. The setup is adapted from ⑰'s `nft_pass.rs`, which is cited in the file.

## The design proof RAN (2026-11-15, agreed slot, unchanged guard)

Script `resident-signed-transfer-proof.sh` (sha256 `7751ccb4`), world branch `f6470288` plus the svm-core lock commit:

| Isolated artefact (scratchpad `resident-signed-transfer/`) | Features | Bytes | sha256 |
|---|---|---|---|
| `resident-default.so` | default | 165,360 | `4e17befc76ed2687f1b2424b55064a5b2e20ee12975e3d8b7583b27cf9357fac` |
| `resident-compat.so` | `signed-transfer-test-only` | 166,104 | `96b24b6285f37295315e419f786772fffe4d0a56cc537c0bca8092dc938fa069` |
| `resident-strict.so` | `transfer-requires-generation-test-only` | 166,000 | `13496748bdf456209197cd02f21f0cc9e1f797b2341054ce49b6dcb7576b34ee` |

- Core: the untrimmed mainnet ELF `515541c8…`, checked by hash before the run.
- **The deployed candidate** (`wylls-nft-pass-20261114/…/program/target/deploy/wylls_resident_program.so`) is present and `947da0b9…` **before and after**: unchanged and never written.
  - The first attempt pointed at a path where it does not exist, and the check tolerated that. That is now a hard failure: `deployed_ok` needs the file present with that exact hash, and its self-test refuses a missing path and wrong bytes.
- **Result:** `cargo +1.95.0 test --offline --locked --test signed_transfer -- --ignored`: **6 passed, 0 failed, 0 ignored, 0 measured, 0 filtered**. All 6 tests are named in the log, and the verdict needs exactly that plus LiteSVM exit 0 and the deployed hash unchanged. Its self-test refuses 9 injected failures and accepts 1 good case (10/10).
- **What it shows (TEST ONLY; nothing adopted):**
  - the default build refuses 0x54 and keeps 0x51;
  - 0x54 at the current generation moves the owner, bumps the generation and clears the session (all four fields), in both variants;
  - a wrong signed generation is refused (StaleGen) and every non-fee account is unchanged (existence, lamports, owner, data), with the fee payer changed by the fee only;
  - truncated or oversized 0x54, an owner not signing, a non-holder, and another asset's record are refused, with nothing changed;
  - **A→B→A: an old 0x54 signed at generation 0 is refused**;
  - **the compatible variant still lets an old 0x51 through** (the boundary stays open); **only the strict variant refuses it**.
- **Not established here:**
  - The default build made from this tree hashes `4e17befc…`, not the deployed candidate's `947da0b9…`. Either the program source changed since `BUILD-RECORD.json` (v0.26) or the build path enters the binary. So these tests do not prove anything about `947da0b9` itself.
  - Adoption, and compatible versus strict, remain the owner's decision. The world relay's TransferResident stays default deny.
- The first LiteSVM attempt failed offline (`light-poseidon 0.4.1` not cached). The lock was pinned to the cached `0.4.0` (plus `either 1.18.0`) in its own commit. No network fetch, no new crate.

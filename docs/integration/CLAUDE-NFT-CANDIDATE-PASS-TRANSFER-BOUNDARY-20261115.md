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

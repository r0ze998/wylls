# Private keyless march host

This example executes a fixed route through the program's real host dispatcher, on private account images. It never submits a transaction. The optional Train mutates the march's own holding; the existing economy demo remains a separate process/session.

See `docs/frontier/map-growth/LOCAL-MARCH-DEMO-PROTOCOL-20261108.md` for the exact bounded stdio protocol. Build with Rust1.89, offline/locked, feature `local-march-demo`, example `local_march_demo`, isolated target `.local/wide-march-demo/target`. It has no command-line options and reads only stdin at runtime.

## Evidence and limits

- Route `(129,0,2) → (129,0,1) → (129,0,0) → (129,-1,34)`, one player host, one staged hostile resident.
- Initial images and public order metadata are compiled in from `fixtures/`. SHA256SUMS records their provenance. No post-action images are replayed.
- The destination has been precomputed through bell19 using real Resolve before initial export, then the session clock starts at origin bell6. This is a fixed scenario with a precomputed destination, not a globally synchronized whole-world simulation from inception.
- Initial stock, Season configuration, enemy resident, B/C residents left at origin, and synthetic non-arrival beacons are explicit fixtures. Public fixture seal material offers no secrecy.
- Public arrival beacon signatures are checked with native BLS math. Transaction actor/payer signer flags are simulated; no private key is created, derived or used, and nothing is signed.
- Departure, origin settlement, anchor/reveal/seed, Gather/hostile Resolve, transit settlement, Dissolve and Return execute live handlers. Phase commands advance only named fixed simulated times.
- Every command stages a copy, checks each handler's receipt kind and wide chain links, then renders/bounds the candidate response before committing account state and revision. Failed commands emit no successful new receipts.
- The runtime constrains account identities, alias consistency, writable sets, allocation sizes, lamport conservation, accepted logs and System CPI instructions. These checks are not an independent verifier of every writable byte or kernel outcome.
- System Transfer/Allocate/Assign/AllocateWithSeed are emulated locally. Unknown targets/operations/signers fail closed. No validator/RPC/network transport exists in the example.
- Owned buffers have bounded capacity and no intentional leaks. The unsafe account adapter deliberately emulates the SDK runtime ABI, including padding, owner assignment and realloc/close. Passing native tests does not establish independent Rust alias-model/Miri soundness. It is not SBF, compute-budget or live-runtime validation.
- Feature opt-in is a host-library capability, not a cryptographic restriction to this executable. Default, ordinary wide, economy-only and deployment protections are retained; Solana/test-beacon feature combinations are compile-time refused.

## Focused validation

The exact example tests cover full flow with and without Train, pending-departure troop projection, invalid phase/syntax/stale revision, insufficient payer, settlement commitment mismatch, a mid-phase refusal after Seed/Gather writes, oversized response rollback, account alias mismatch, unknown signer, and scope cleanup. They run individually using `--exact --test-threads=1`, not unrelated key-bearing suites.

Observed fixed scenario: 300000 initial milli-troops, one engagement, 297633 arrival survivors; Return credits297 whole troops. Initial reserve600 becomes610 after optional Train and907 after return. Without Train final reserve897. Escrow20500 during transit returns to0; open transits returns to0. These values are observed results, not hardcoded output snapshots.

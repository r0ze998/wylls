# Wide reader and current core integration

Base: `c1e8137e2446a9c1e83e41fc6c74900a5090fe03` (parent `3ad0bcdbaa649e7ca6537511da824db42fe0f080`). Merged wide prerequisites: `647dfadf50b12de91bfe5bd9bb6735086f807ffc`. Common ancestor: `a636671b72d09c039eb3fad53668e1c130cd56ab`.

The merge had no conflicts. Herald's fold and server combined automatically; their captured-account observation hooks and experimental read-only routes were reviewed. Verify, findex and the resident processor have no difference from the current core base. The WS09 runner exit-status fix is included.

## Executed checks

- frontier-abi world_index: 50 passed.
- JS wide-world, herald, map, words and language under no-keys guard: 62 passed.
- Herald wide routes over recorded data: 3 passed.
- Verifier history: 16 passed, including missing ranges and unknown source refusal.
- Verifier V27: 7 passed; V28: 5 passed, including canonical proof accounts.
- WS09 runner Python regression: 2 passed.

These are selected tests, not the entire repository. Fixed recorded inputs and literal bytes were used; public PDA calculations are allowed, but no keypairs were generated/derived and no signatures were made. No browser, CI, production deployment or chain transaction was run.

## Remaining scope

The wide surface is read-only and only displays captured land. The writer still cannot create playable land outside ring 128. Exact coordinates, reported routes and travel quotations are prerequisites, not land ownership or an executed march. No existing asset layout, prize eligibility or default keeper activation changed.

The user confirmed that outer nations should mix instead of forming wedges. The exact distribution texture remains a versioned candidate; generation work is separate from this merge.

## Generation candidate follow-up

`364e7f7b` adds the reviewed wide terrain and nation-placement candidates. On this integrated tree, terrain 9/9, world_index 57/57 and the real legacy map-growth dispatcher 6/6 passed. The legacy dispatcher still refuses growth beyond 128: this result is regression protection, not a successful wide writer. An orbit-balanced outer-placement comparison avoids assigning different repeated terrain classes to nations at rings divisible by six; it is not activated as a Season rule. See WIDE-GENERATION.md for the exact limitations.

Herald library clippy and the default-build disabled-route test (1/1) also passed on the integration baseline. Browser/visual acceptance remains unperformed. No keypair generation, derivation or signing occurred.

## Wide land writer draft (2026-11-07, native validation recorded below)

`WIDE-LAND-WRITER.md` adds the versioned identity and transition models of the wide write path (`frontier-abi` `world_index::{land, holding, march, wide_ix}`) and five draft handlers behind the new program feature `wide-world-experimental` (band 0xD6–0xDA, program-version bit 0x4000, both provisional). The wide ring seed's request and verified consume are real writes with the deployed OpenRing/ConsumeRingSeed gates; opening a wide province, claiming a wide site and departing a wide host each run preliminary checks and then refuse `NotImplemented` at a named gate (undecided keep-holder/Free City/camp/region rules, undecided claim rule, unallocated host identity). A wide province is the whole Province v2 layout plus a trailer; a wide holding occupies one of the Citizen's three deployed slots through a marker tested against legacy slot allocation and home entitlement. No deployed layout, kernel, verifier, history check, vector or default build changed. The native review corrected malformed-state handling and test defects; see the dedicated note for results and limits.

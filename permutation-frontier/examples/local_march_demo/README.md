# Private keyless village-and-march host (protocol v2)

This example executes the village economy and a fixed march through the program's real host dispatcher, on private account images, in ONE serialized session. It never submits a transaction. Harvest, the fixed Farm Build (item 0) and the fixed Train (unit 0, 10 troops) act on the same holding and citizen bytes that Depart, SettleDeparture, SettleTransit, Dissolve and Return write, under one revision and one simulated clock. The separate `local_economy_demo` (Season 11 fixtures) is unchanged and remains its own baseline.

See `docs/frontier/map-growth/LOCAL-MARCH-DEMO-PROTOCOL-20261108.md` for the exact bounded stdio protocol (v2). Build with Rust 1.89, offline/locked, feature `local-march-demo`, example `local_march_demo`, isolated target `.local/wide-march-demo/target`. It has no command-line options and reads only stdin at runtime.

## Evidence and limits

- Route `(129,0,2) → (129,0,1) → (129,0,0) → (129,-1,34)`, one player host, one staged hostile resident.
- Initial images and public order metadata are compiled in from `fixtures/` (unchanged in v2). SHA256SUMS records their provenance. No post-action images are replayed.
- **One clock, phase steps only.** Economy commands run at the instant the last phase step left and never move the clock. The clock moves only through the fixed phase steps (bell 6 → 8 → 21 → 22 → 23 → 25). There is no free time advance.
- **Horizon (unchanged blocker).** The destination was precomputed through bell 19 using real Resolve before initial export; the session starts at origin bell 6. Every response reports both provinces' `RESOLVED_NEXT` from their bytes. This is one holding on one clock, not a synchronized whole-world simulation. The current initial fixture lacks the caches/anchors and arrival material a general synchronized run would need. The existing fixture/export path uses signing and cannot be used for that expansion under this task. Alternative keyless construction/reuse paths have not yet been evaluated.
- Initial stock (1,900 of each resource), Season configuration, enemy resident, B/C residents left at origin, and synthetic non-arrival beacons are explicit fixtures. Public fixture seal material offers no secrecy.
- Public arrival beacon signatures are checked with native BLS math. Transaction actor/payer signer flags are simulated; no private key is created, derived or used, and nothing is signed.
- Departure, origin settlement, anchor/reveal/seed, Gather/hostile Resolve, transit settlement, Dissolve, Return, Harvest, Build and Train execute live handlers.
- Every command stages a copy, checks each handler's receipt kind and wide chain links, then renders/bounds the candidate response before committing account state, clock, counters and revision. Failed commands emit no successful new receipts.
- Economy commands are additionally judged: every image other than the citizen and holding byte-identical (lamports included); citizen changed only in bucket/action stamp; holding changed only in chain header, state (provisional → final only), tier, flags, owner-action stamp, the kernel block and, for Train, `reserve[0]` by exactly 10; the receipt recomputed from the complete before/after bytes; the holding chain walked. Transit, escrow, host identity and the wide trailer are therefore untouched by the economy.
- At most 8 economy commands per simulated instant (`INSTANT_BUDGET`, a demo transport budget, not a rule). Without a time control, an emptied action bucket at `ready` or `settled` would otherwise refuse Depart or Dissolve permanently.
- The runtime constrains account identities, alias consistency, writable sets, allocation sizes, lamport conservation, accepted logs and System CPI instructions. These checks are not an independent verifier of every writable byte or kernel outcome of the march handlers.
- System Transfer/Allocate/Assign/AllocateWithSeed are emulated locally. Unknown targets/operations/signers fail closed. No validator/RPC/network transport exists in the example.
- Owned buffers have bounded capacity and no intentional leaks. The unsafe account adapter deliberately emulates the SDK runtime ABI, including padding, owner assignment and realloc/close. Passing native tests does not establish independent Rust alias-model/Miri soundness. It is not SBF, compute-budget or live-runtime validation.
- Feature opt-in is a host-library capability, not a cryptographic restriction to this executable. Default, ordinary wide, economy-only and deployment protections are retained; Solana/test-beacon feature combinations are compile-time refused.

## Focused validation

Observed for v2 (supervisor runs, 2026-11-08):

- Offline locked build passed; all 21 example tests, each selected by exact name, passed; the example's clippy with `-D warnings` passed. Changes after those runs were rustfmt only.
- The real-host Node integration passed 2/2.
- The browser's focused JS suite passed 43/43, after a fixed synthetic-fixture bug that caused 10 failures on the first run.
- A localhost Chrome smoke completed the integrated village-and-march loop (final reserve 907, escrow 0) and a Reset (`ready`, bell 6, reserve 600).

See the protocol document's status for details and limits. The exact example tests cover: the full flow with and without Train; Harvest/Farm/Train interleaved through every phase on one holding (Farm queued at bell 6 and completed by a Harvest at bell 21; reserves changed before the survivors' Return); handler refusals (Insufficient, Bucket) with nothing committed; the per-instant budget keeping Depart playable; duplicate and stale economy commands never replaying; oversized responses rolling back; reset after economy and march; the judge refusing foreign writes, escrow/transit/trailer writes, lamport moves, forged stages and tampered receipts; the honest horizon in `get`; pending-departure troop projection; invalid phase/syntax/stale revision; insufficient payer; settlement commitment mismatch; a mid-phase refusal after Seed/Gather writes; account alias mismatch; unknown signer; scope cleanup. They run individually using `--exact --test-threads=1`, not unrelated key-bearing suites.

v1 observed fixed scenario (Train once while departed, no other economy): 300000 initial milli-troops, one engagement, 297633 arrival survivors; Return credited 297 whole troops; reserve 600 → 610 → 907; escrow 20500 during transit → 0. These are earlier observed results, not hardcoded snapshots, and v2 tests assert relations (credit = reserve before Return + survivors / 1000), not those numbers.

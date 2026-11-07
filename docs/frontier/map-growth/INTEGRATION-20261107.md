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

## Wide outpost ticket through the deployed lottery (2026-11-07, third slice, unvalidated)

`WIDE-LAND-WRITER.md` §−1: WideClaimSite now **files** a wide outpost ticket under the deployed FileOutpost checks (a world/coordinate-bound record holding the wide Holding's rent, the Citizen's deployed ticket fields marked so every deployed ticket path refuses, the province's cohort, the anchor's settler cost); the new WideSettleTicket runs the deployed SettleTicket lottery over it (the beacon seed of the bell and the province's region, fresh / displace / taken / expired, a provisional wide holding from the record's rent, the record back to its funder); WideFinalize applies the deployed finality condition; WideClose returns a ticket record to its funder or closes a wide holding at season end; WideResidentAct runs the player instructions for an NFT resident's Citizen under the deployed holder-generation check. Feature-gated guards make the deployed SettleTicket, CloseCitizen and DeclareSiege refuse the marker explicitly. WideDepart stays refused. Not compiled or run by its author.

Escrow retention correction (same day, after native validation of the first draft: ABI 90/90, wide+NFT host 13/13, default 6/6, library clippy): the first draft's immediate refund of the record at every ticket end was rejected as economically different from the deployed escrow. The record now follows the deployed FileOutpost / SettleTicket / CloseCitizen escrow rules exactly (`WIDE-LAND-WRITER.md` §−1, the correction note): a `Settled` status and an `ESCROW` field, the retained rent reused by the next filing under the deployed top-up and funder rule, one rent consumed by a win, nothing refunded while the Season runs, the record closed at season end before or after CloseCitizen in CloseCitizen's shape: the escrow to the funder, the record's rent and remainder to an immutable rent payer kept distinct from the funder (a second review caught that a single mutable funder would have handed a creator's record rent to a later topper-up). The record codec is `PSFXWTK2` / 192 bytes; the never-committed `PSFXWTK1` / 160 bytes is refused. Not compiled or run by its author; the native worker re-runs §−1.6.

## Wide march: mapped, identity decided, Depart corrected, not connected (2026-11-07, fourth slice, unvalidated)

`WIDE-LAND-WRITER.md` §−2 maps every legacy march stage (Muster, Depart, SettleDeparture, Reveal, Gather, Resolve/SkipQuiet, SettleTransit, the return) against the `u64` host id and `i32` coordinate inputs each one keys the host by, and decides the wide identity (`world_index::march`): the full 56-byte host reference as identity, a top-bit roster alias for lookup only that no legacy reader parses and no kernel formula takes, domain-separated wide formulas for the arrival quota key, the tie-break and the clash seed, and a with-seed transit record address. The identity version is defined but no wide holding carries it. WideDepart now has the deployed Depart's shape (standing province distinct from the issuing holding's province), refuses a deployed Province in the standing position as the legacy/wide boundary before any debit, and refuses every wide host at the identity gate. **No wide host moves**: no transit record, escrow, reveal, combat, settle or return exists for the wide world, and the note lists each as blocked. Not compiled or run by its author.

## Wide one-bell resolve model (2026-11-07, on `ad53c8b8`, unvalidated)

`WIDE-LAND-WRITER.md` §−2.4c: after the review ruled out reusing the deployed SkipQuiet for wide provinces (its camp check reads the zero prefix pair, its donor tiebreak compares `u64` ids, no recurring wide camp spawn existed), this step adds the pure bell model a wide Resolve must run: `rules::wide_daily_camp` (the deployed daily check over the canonical coordinate), `keep::advance_with` (the contest generic over the donor's identity; `advance` is the unchanged `u64` form) and `world_index::resolve` (build / resolve / apply / step / settle / finish over a wide province paired with its roster side table under `WideCombatant`, every bell a real resolve, forts/caravans/conquest records refused). Fixed-byte tests include a keep taken by the lowest full identity rather than the first entry. **No handler calls it**: no wide Muster, no debit, no on-chain change; the remaining handler set and the exhausted provisional tag band are listed there. Not compiled or run by its author.

## Wide opening under an explicit configuration (2026-11-07, second slice, unvalidated)

`WIDE-LAND-WRITER.md` §0: a host-only Season whose authority has written the write-once experimental rules configuration (new tag 0xDB, `world_index::rules`) can **open a whole wide province** through WideOpenProvince from the wedge fund, with the wide terrain kernel, the deployed keep tile, mirror, bells and fund bookkeeping, and candidate (not approved) keep-holder, Free City, camp and region rules. Without the configuration the opening refuses as before. WideClaimSite runs the deployed FileOutpost prerequisites read-only and still refuses (the ticket, draw, escrow and finality lifecycle is not ported); WideDepart runs the deployed Depart checks and still refuses at the host-identity gate. Not compiled or run by its author.

### Wide one-bell model native follow-up

The new wide byte model was independently reviewed and corrected before acceptance. ABI 128, generic keep 2, clash 21, existing wide+NFT dispatcher 14 and default dispatcher 6 passed. Two mutation checks establish the pending-settle/snapshot order and keep-only epoch regressions detect their bugs. See WIDE-LAND-WRITER.md sixth-slice validation for exact boundaries. This does not connect new Muster/Resolve/Return instructions or enable asset debit; it is not completed wide gameplay.

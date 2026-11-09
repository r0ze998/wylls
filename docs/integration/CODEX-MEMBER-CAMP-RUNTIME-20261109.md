# Member wire, real camp settlement and original map integration

## Completed source paths

Resolved original-to-wide member settlement now consumes an isolated 301-byte proposal: `[0xDC, 0xFF, 1, 13]`, transit slot, existing commitment and opaque existing seal. Exact 14/15 account roles derive the only supported base split, 8/9; no caller supplies an outcome, retained proof or authorization. The private runtime route repeats the existing anchor, seal and history proof in the same call before settlement. The fclient builder derives public structural addresses, retains explicit historical/payee claims and unions legal alias privileges without creating an executable transaction. The normal WideCommand, v2 and ResidentAct parsers still refuse the new proposal.

Camp settlement is a separate private v2 contract with one additional distinct writable original Citizen. It requires the actual lowest camp_mask winner with Fate(Stays), authenticates the immutable original Citizen and its canonical stored tag/address/Season, and checked-adds the established camp::loot() Works. Existing payment, closure and account staging are reused. The new receipt has explicit byte6=2 and separate operation/context/input/output domains. The original v1 decoder refuses it; CampRecord validates its paired chains and exact Works-only effect. Existing v1 account contracts, receipt bytes and all immutable BTRC/BRES fixtures remain unchanged.

The original game canvas now accepts adjacent tile taps and Enter into the existing original-host boundary composer. It renders a distinct dashed route and next-step tiles across ring128, using exact world/tile identities and bounded relative projection. Source identity stays pinned; stale gestures, duplicate taps, old picker/march actions and automatic camera interruptions are guarded. This is integrated into the original app, not a separate demonstration page. Geometry is explicitly unverified for terrain, costs, timing and admission. No Seal/Send action is enabled.

## Verified execution

The five contiguous native lifecycle functions passed. The new fifth variant creates a minimum-strength camp in the initial destination Province before departure. Thereafter every world transition comes from actual handlers: original departure and combat, boundary proof/Gather, real wide Resolve, then v2 camp settlement. Resolve itself produces camp_mask1 and removes the camp. The test verifies exact original Works credit, v2 pair and prior chains, v1 refusal and replay inertness. It does not insert a resolved camp outcome after departure.

The other four continuous variants retain stays, retreat/home-return, free-city capture and resident reserve return. They now consume actual encoded member settlement bytes; original-resident return already consumes its 60-byte draft. Immutable trace and role snapshots pass byte-for-byte.

Additional selected native tests passed:

- Two existing member/runtime-support functions, including real14/15-role settlement, PREV_HOME, diversion, shared payees, retained-slot closure and refusal paths, now through encoded member wire.
- Four camp-v2 functions: exact receipt/Works delta, current wallet and captured original NFT Citizen, identity/account/overflow refusals, actual native writer closure and chain updates, and replay/overflow inertness checked after successful official writeback. Those focused camp fixtures start from synthetic resolved state; the fifth continuous function above independently exercises actual Resolve.

The member ABI codec passed2 tests and fclient draft passed5. Original-canvas integration passed16 new tests plus15 existing composer regressions with both no-key preloads. Total49 selected tests passed, with zero failures/ignored tests in the selected runs, not a whole-repository pass. Native compile retained three old dead-code warnings plus two now-unused old typed test-adapter warnings.

All native execution used cached Rust1.95, explicit aarch64-apple-darwin, offline locked dependencies, two jobs, CARGO_INCREMENTAL=0, and three exact serial test filters. No broad crypto suite ran. Tests use only the unchanged authorized public proof fixtures; no new keys, signing or production confidentiality are claimed.

## Remaining limits

Public gates and generic parser admission remain closed. Camp-v2 is a separate private handler reached by a narrowly gated native test adapter, not a new publicly dispatched wire. The scoped Rust expedition typed reader, index, keeper observer and herald serializer, plus the browser expedition-history reader, now explicitly understand camp-v2; generic and legacy readers still reject it. See `CODEX-CAMP-V2-READBACK-20261109.md` for separate readback evidence. Existing durably blocked indexes still require an explicit rebuild; no blocker is cleared automatically. Camp Citizen/payee aliases remain intentionally unsupported. Bad seals/nonmembers still refuse pending a separate authenticated reward/forfeit/roster receipt contract. Reverse sealed movement, public activation and deployable Solana-target integration remain incomplete.

No live browser/server/RPC, actual signed transaction, sealing, deployment or CI was part of the reported49 tests. Browser/visual verification is a separate follow-up and is not claimed here. No dependency, lock, workflow, key policy or review-metadata change is included.

The later original-page browser follow-up is recorded in [CODEX-ORIGINAL-BOUNDARY-BROWSER-20261109.md](CODEX-ORIGINAL-BOUNDARY-BROWSER-20261109.md). It verifies geometry editing against a synthetic boundary observation, not live departure or public gameplay.

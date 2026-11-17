# Local economy / keeper integration

Parents: keeper `bf8bd8a6bef5ff7fff3a6146b2adfab776f97945` and economy `8c36b961eaa91c2e54be508bf9e9fe887d5fb4f9`. Common ancestor: `37d07ad0`. Normal merge was conflict-free. No production source needed manual resolution. The economy ancestry includes the local wide action/village UI work; this merge is not published.

CC was requested but returned usage-credit exhaustion before doing work. Native review and tests completed instead; no subscription, credit or model setting was changed.

## Independent static review

Economy kinds 15/16 remain holding-keyed, never create a host/transit or automatic duty, and coexist with existing settle modules. Economy writes preserve escrow, pool, open-transit counters and full identity; Train checked-adds reserves. The return planner reads current snapshots. Solana compile-time refusal, feature-off refusal, UI execution refusal and keeper send gates remain intact.

## Tests on this merged source tree

224 selected tests passed:

- Economy ABI integration: 8.
- Economy real host dispatcher: 12; detached S1 comparison: 27.
- Exact native return dispatcher regressions: 7 (Retreated, direct/routed rounding boundaries, unresolved/resolved home=destination, unranked and bounced final-set returns).
- Keeper: 135 previously audited tests plus 3 economy observer tests.
- Findex: 4 economy and 12 typed-index tests.
- Verify: 10 economy pure judgement and 6 recorded fixture/tamper tests.

Commands used locked/offline Rust 1.89 for root and 1.95 for node, incremental disabled, shared targets checked idle first. `WYLLS_WIDE_ECONOMY_FIXTURES_DIR` was unset; no fixtures were regenerated. No full workspace or unrestricted library suite ran. No keypair generation/derivation, signing, real chain transaction, deployment or CI. Public PDA/with_seed calculation and published signature verification were used by audited host tests. Snapshot RPC tests used loopback HTTP only. Economy non-native-crypto builds showed the nine documented unused-code warnings. This merge did not repeat clippy or UI/browser tests.

## Remaining limitations

These are suites coexisting on one tree, not yet a single scenario that performs economy while a transit is active and then returns it. Add that interleaving regression next, including current reserve, escrow/pool/counters, chain sequence and refusal atomicity. Existing economy preservation tests include stale free-transit payload; they must not be presented as active-transit coverage.

Host departures and other fixture boundaries remain as documented by each suite. In particular dispatcher and planner share settlement expectations, not identical full Reveal worlds. Unknown histories and unresolved-generation payment destinations remain conservative refusals. No full-game playability, signature authentication or live-chain correctness is established.

Earlier component documents describe their own branch snapshots (including statements that return/economy were not merged); this integration note supersedes those statements only for this local merge. No push, main update, fee or payment policy change occurred.

## Follow-up: Train interleaved with an active transit

Added `map_growth_runtime_tests::wide_land::wide_economy::wide_economy_train_during_transit_preserves_escrow_and_returns_into_changed_reserve`. It passed individually and in the 13-test economy runtime module after formatting. This is a new test on top of the 224-test merge result, not a rerun of all 224.

The same holding retains an active settled transit carrying 401,000 milli troops. Real Train adds 10 reserve troops; real routed return then adds 200 whole survivors to that updated reserve. Exact balances and lamport conservation, escrow/pool/open-transit counters, host sequence and identity are asserted. The combined Economy/TransitSettled/Return trace is retained and every affected prev-head is independently advanced with the ABI, then checked against stored final heads.

Wrong-actor Train, unaffordable Train and repeated settlement call direct dispatch, with all involved account bytes, owners, balances and full log contents unchanged. These refusal assertions do not rely on harness rollback. Successful settlement uses the existing helper (which can roll back failures but succeeded here).

An independent static review found no blocker or auth/bucket/finality bypass. Fixtures remain explicit: staged departures, stock and a saturated home roster force the reserve fallback. This establishes Train interleaving, not Harvest/Build interleaving or actual Depart-to-return/live-chain play. No production code, policy, send gate, signing, deployment or publication changed.

## Follow-up: real Depart before Train

Added exact native test `map_growth_runtime_tests::wide_land::wide_land_native_real_depart_train_resolve_and_return_share_one_holding`. It shares a runner with the preserved `wide_land_native_departs_posts_the_beacon_and_settles_for_real` baseline. Both passed, followed by all 13 economy runtime tests on the final source. These 15 runs are the validation for this follow-up; other earlier suites were not rerun.

The variant creates the departure through real WideDepart effects (cfg(test) plus native-crypto-tests only), then executes Train while both home transits are Departed and before origin Resolve. It continues through origin Resolve/SettleDeparture, public-vector PostAnchor/Reveal/PostSeed/Gather/Resolve, SettleTransit, Dissolve/Resolve and Return. The training +10 remains present before the +300 return. All PSW1 collector drains from the first real departure are retained; the holding, home and destination chains are recomputed from their pre-departure heads. Unauthorized and unaffordable Train use direct dispatch with no writes. Return replay checks every supplied account and full logs plus the helper's pre-rollback no-write flag.

Independent static review found no blocker. There is no newly staged departure, escrow or arrival beacon in this variant. Initial reserve, stock, Season configuration, non-arrival beacons and host account/syscall fixtures remain explicit. The two participating hosts are allies: Resolve's combat processing runs, but hostile combat remains unverified. This is not a chain-authenticated transaction or a public playable build. Production gate, ABI and economic policy are unchanged. No keypair generation, secret derivation, signing, real transaction, deployment or push.

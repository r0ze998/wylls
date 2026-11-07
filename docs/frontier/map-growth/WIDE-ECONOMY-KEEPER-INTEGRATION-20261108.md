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

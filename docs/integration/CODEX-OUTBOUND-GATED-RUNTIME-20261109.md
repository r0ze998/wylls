# Original outbound runtime routing behind the closed gate

## What changed

The four existing outbound commands now share one private routing function in `proc/wide.rs`: ExpeditionDepart, ExpeditionSettleOrigin, ExpeditionReveal and ExpeditionGather. Each routes to its existing authenticated handler. Reveal and Gather were previously unconditional dispatch refusals; they now sit behind the same unchanged `EXPEDITION_ENABLED = false` gate as Depart and SettleOrigin.

There is no runtime flag, instruction override, new activation feature or authorization/verdict argument. The private function has one production caller, after the constant gate. The Gather forwarding function exposes only the existing producer to its parent module. No account table, ABI bytes, economic rule, proof rule, allocator, receipt codec or producer body changes.

## Actual unsigned runtime evidence

The four existing contiguous native lifecycle tests now supply the exact encoded outbound command bytes to the official Solana ABIv1 serializer and decode those bytes into the same shared private router. They no longer invoke the four outbound handlers directly with separately constructed arguments.

Before each accepted outbound stage, a disposable copy calls the actual top-level program dispatcher and must return NotImplemented. The closure then returns success solely to force official writeback, so any account mutation would be observable. All accounts must match, with no logs or CPIs. Separate successful-writeback probes reject truncated bytes, appended bytes and a valid wrong-family Return command. These probes never become gameplay trace entries.

The successful native path retains existing literal initial world state and thereafter uses only real handler outputs. The four continuations cover:

- Departure, original combat/settlement, public-proof Reveal, Gather, wide combat and stays settlement.
- The same outward path followed by retreat and original-home return.
- The outward path followed by an actual free-city conquest capture.
- Capture followed by voluntary resident Dissolve, actual Resolve and original reserve return.

The original immutable BTRC receipt trace and BRES role/account snapshots still match exactly. Official native System Transfer and AllocateWithSeed execution remains bounded by the existing audited adapter. This is not SBF, bank processing, signed transactions, live RPC, or proof of historical reachability of the synthetic initial economy.

## Exact checks

The final selected checks passed:

- Four native lifecycle functions under `proc::wide::expedition_gather::exec::lifecycle_tests::`.
- Six Rust `original_expedition_depart_draft` integration tests.
- Nineteen browser plaintext/geometry codec tests and ten public role tests.
- Eighty focused original-game composer, inspection, hand, conquest-hand and wide-holding UI tests, including fifteen composer tests.

Total: 119 selected passing tests, not a whole-repository pass. The runtime compile retained three pre-existing dead-code warnings. The UI task separately found two whole-language-suite failures already present in the baseline; see its composer report.

Native execution used the existing isolated runtime manifest, installed Rust 1.95, an explicit aarch64-apple-darwin target, offline locked dependencies, two jobs and CARGO_INCREMENTAL=0. Only the four-function lifecycle filter ran, serially. No broad crypto or test-beacon suite ran. Public synthetic Rust plaintext/role/wire vectors are exact cross-language codec evidence, not independent native account authorization or successful seal binding.

## Remaining release boundaries

Public dispatch remains closed and original-resident Dissolve/Return remains a private candidate. Reverse sealed wide-to-original movement is not added. The game UI prepares geometry, plaintext and public role proposals only; it does not certify terrain, cost, timing, account readiness or ciphertext binding, and has no Seal/Send action. No sealing, new keys, signatures, transaction submission, activation, deployment, live browser QA or CI was performed.

Existing public proof-fixture recovery remains test-only, deterministic and unsuitable for production confidentiality. No lock, workflow, key policy, review metadata or activation constant changes are part of this checkpoint.

# The local test candidate lane (conquest lane + NFT residents) as an opt-in: version read, launcher, keeper, runner

Branch `claude/nft-candidate-lane-r21-20261114` on canonical `20adb087` (round 21). It is the same work as `claude/nft-candidate-lane-20261114` (left as it was, on `84ec838c`), rebased and published under a new name so that branch's history is never rewritten. Agreed with the territory lane's owner: this branch only, opt-in, the 0x4804 path unchanged, round-only patch for review, nothing written to canonical.

The candidate: feature `localnet-conquest-nft-sbf`, program id [0x4C; 32] (`68qTstPmwfaDbt1a9hnq7XeyZ4zJBqBKU1esRtQXnKWj`), version 0xC804 = 51204. LOCAL TEST ONLY, NOT an allocation, never deployable; the production program and version are undecided.

- Patch: `CLAUDE-NFT-CANDIDATE-LANE-VERSION-READ-20261114.patch` (sha256 `b01536dc147e23ae55192b51d850f36582b61bfc412fc45f0436da080e870d06`): `git diff 20adb087 <head>` of the code on this branch, excluding this note and the patch itself.

## Status (one table; the sections below give the details)

| Part | State |
|---|---|
| Version read from the deployment (gateway, page) | **implemented, tested**: 304/304 of the affected local-play / preparation set on `20adb087` |
| Launcher `--lane-candidate` (runner contract, NFT setup once, mint page child, cleanup) | **implemented, tested with stand-ins** (part of the 304) |
| Keeper preparation (`local_lane.rs`, the three `experimental_*_prepare.rs`) | **implemented, compiled, tested** (2026-11-15 host slot): `cargo test -p keeper` with and without `conquest-dispatch-experimental`; `local_lane` test passes. The first compile found `local_lane` ungated (fixed in `85018666`). One test fails in both runs, `tests/play.rs::claim_after_late_reveal` ("no claim"). **Open, cause not yet known.** With features off this branch's keeper code is not compiled, which suggests the failure is not from this branch, but that is NOT proof: the single test has not yet been run on unchanged `20adb087` with the same toolchain and flags. Source diagnosis, hypotheses and the measurement plan: `CLAUDE-KEEPER-CLAIM-AFTER-LATE-REVEAL-20261115.md` (leading lead: the W-version cap of `0147a885`). The baseline/bisect runs are pending; until then the keeper row is not complete |
| Runner (itest), step 1: `Lane`, candidate options, Season version, base/home/fixture, candidate deploy, seed file, first-line keys | **implemented, compiled, tested** (2026-11-15): `cargo test -p itest --features localnet-conquest-play --lib --bins`, 142 passed / 20 ignored, the four `lane_tests` pass on the first compile |
| Runner (itest), step 2: the runtime modules read the process's world lane | **implemented, compiled** (same run); not run in a world yet |
| Candidate feature and the old combinations (NFT branch) | **checked** (2026-11-15): `cargo check -p permutation-frontier --features localnet-conquest-nft-sbf` passes (warnings only); five old combinations each stop at their `compile_error!` (expedition-sbf+nft, conquest-sbf+nft, candidate+localnet-nft-sbf, candidate+rights, candidate+trace) |
| The candidate `.so` (SBF build with the candidate feature) | not done: needs an agreed SBF slot (`scripts/build-frontier-localnet-conquest-nft-sbf.sh` is on the NFT branch) |
| A candidate world | not done: needs the two items above |
| The candidate on the natural preset | not supported (conquest preset only, by design) |

## Version read (gateway and page)

One definition of the served local-play versions (`permutation-gateway/src/frontier/local-lane-versions.mjs` = page `flocallanes.mjs`): 0x4804 (default, exactly as before) and 0xC804. The gateway's expedition / conquest / depart preparation, the page's expedition and depart preparation, local play's Season check and the hand's preparation section read the version through it; a prepared proposal must echo the deployment's own version. A Season version is checked as a number, a deployment version as a decimal string (as the old literals were). Test: `test/frontier-local-lane-versions.test.mjs` (2). Two import pins name the new module.

## Launcher

`--lane-candidate localnet-conquest-nft-sbf --resident-so --core-so --nft-setup --mint --mint-port`: all or none, conquest preset only, one world.
- The runner gets `--lane-candidate --resident-so --core-so --authority-seed-dir <world dir>`.
- Its first line must state the candidate id, `"program_version": "0xc804"`, the feature, the resident program, Core, and an authority seed file inside that world's directory.
- The NFT setup then runs once (exit 0, bounded), and the mint page runs as a world child: it must answer, it stops with the world, and its port is recorded.
- A plain start takes the runner's own `"0x4804"` line as ever and refuses any other candidate key. (An earlier version refused every real plain world because the real runners print that line; fixed, and the stand-in prints it the same way.)
- Tests: stand-ins, no chain (3 cases in `test/frontier-local-play-launcher.test.mjs`).

## Keeper

`keeper/src/local_lane.rs`: served(program, version), 0x4804 as before, 0xC804 only under [0x4C; 32]. The three `experimental_*_prepare.rs` check through it and echo the deployment's served version; two now-unused imports removed. Verified: `cargo test -p keeper` (the package is `keeper`, in the `frontier-node` workspace; `frontier-keeper` is its binary). The module is gated on `expedition-dispatch-experimental`, like its users.

## Runner, itest

The runner's program id was the constant `expedition_play::PROGRAM` ([0x45; 32]), about 90 uses in 15 modules, most of them inside test modules. A runner process runs exactly one world, so the threading is in two steps:
- **Step 1, `expedition_play.rs`.** `Lane { program, version }` with `Lane::CONQUEST` (the old constants) and `Lane::CANDIDATE`. The candidate options are parsed all-or-none: exact word, absolute paths.
  - Season bytes carry the lane's version. `Base::new_for`, `open_home_for` and the fixture use the lane's program, while `Base::new`, `open_home` and `Fixture::new` stay the conquest lane, so every existing caller is unchanged.
  - `launch_lane` (`launch_full` = `launch_lane(None)`), in candidate mode: deploys the artefact under [0x4C; 32] with one throwaway upgrade authority, plus Core and the resident program (same authority); writes that key's seed as hex, 0600, create-new, only to `<authority-seed-dir>/candidate-authority.seed` (never printed); adds the candidate keys to the first line.
  - The binary requires the conquest preset, and the artefact must carry `PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD` exactly once.
- **Step 2, the runtime modules.** One process-wide world lane is set only by `launch_lane` for a candidate. Unset, as in every plain start and every test, it is the conquest lane.
  - Read through `world_lane()` / `world_program()` by: the keeper loop, destination driver, origin driver, resident bells, legacy march, wide destination (ctx, the instruction's program id, owner check) and conquest world (owner check).
  - `check_wallet` refuses both lanes' program and Season.
  - Test modules, and the test-only `conquest_real` / `destination_real`, keep `PROGRAM`.
- Compiled and tested on 2026-11-15 (`--lib --bins`, no world started): 142 passed, 20 ignored. No runtime `PROGRAM` use is left in those modules.

## Order once slots are agreed

1. frontier-abi golden test (NFT branch). **Done 2026-11-15, 8/8.**
2. Host checks (**done 2026-11-15**, results in the table): `cargo test -p keeper`, `cargo test -p itest --features localnet-conquest-play`, `cargo check -p permutation-frontier --features localnet-conquest-nft-sbf`, and the old combinations that must still fail to compile.
3. The candidate `.so` (SBF).
4. One candidate world.

Each step is agreed with the territory owner first, under the unchanged guard.

# Local play reads its program version from the deployment; the local test candidate 0xC804 as an opt-in

Branch `claude/nft-candidate-lane-20261114`, based on canonical `84ec838c` (rebased from `e3611382`; includes round 19). Agreed with the territory lane's owner: this branch only, opt-in, the 0x4804 path unchanged, round-only patch for review, nothing written to canonical.

- Patch: `CLAUDE-NFT-CANDIDATE-LANE-VERSION-READ-20261114.patch` (sha256 `3cb2dc7a558b8e3b7ba2c0b64069c849d29fd0474458079114312e13c929c8a7`), `git diff 84ec838c <commit>`.
- What it does: one definition of the served local-play versions (`permutation-gateway/src/frontier/local-lane-versions.mjs` = page `flocallanes.mjs`): 0x4804 (the conquest lane, default, served exactly as before) and 0xC804 = 51204, the LOCAL TEST CANDIDATE `localnet-conquest-nft-sbf` (program [0x4C; 32]; not an allocation, never deployable). The gateway's expedition / conquest / depart preparation, the page's expedition and depart preparation, local play's Season check and the hand's preparation section read the version through it; a prepared proposal must echo the deployment's own version. A Season version is checked as a number, a deployment version as a decimal string (as the old literals were).
- Tests: `test/frontier-local-lane-versions.test.mjs` (2); the 32 affected local-play / preparation test files: 298/301 at this commit. The 3 failures (`frontier-local-play-natural.test.mjs`, natural-world runner) fail identically on `84ec838c` without this change. Two import pins name the new module.
- Not done (next steps, not yet implemented): the launcher option that selects the candidate and records 0xC804 and [0x4C; 32] in the deployment, adding the resident program, Core, policy and mint page to the start-up; the keeper's Rust preparation (`experimental_*_prepare.rs`, 0x4804 fixed: it would refuse 0xC804; changing it needs a host build to verify); a candidate world (needs the candidate .so built: SBF build slot to be agreed).

## Added later on 2026-11-14 (22:30–23:00): the launcher opt-in, the keeper's preparation, and the runner's real obstacle

- **Launcher** (`cb11791a`, fixed in `a8432b63`): `--lane-candidate localnet-conquest-nft-sbf` with `--resident-so --core-so --nft-setup --mint --mint-port`. All or none, conquest preset only, one world.
  - The runner is given `--lane-candidate --resident-so --core-so --authority-seed-dir <world dir>`.
  - Its first line must state the candidate id `68qTst…` ([0x4C;32]) and `"program_version": "0xc804"`, plus the feature, the resident program, Core, and an authority seed file inside that world's directory.
  - The NFT setup then runs once (exit 0, bounded), and the mint page runs as a world child: it must answer, it stops with the world, and its port is recorded.
  - A plain start takes the runner's own `"0x4804"` line as ever and refuses any other candidate key.
  - Tests use stand-ins and no chain: the local-play set gives 301/304 (the 3 failures are the same natural-world tests that fail on `84ec838c`).
  - The `a8432b63` fix: the real runners already print `"program_version": "0x4804"`, and the first version would have refused every real plain world. The stand-in now prints it the same way.
- **Keeper** (`60347065`, NOT COMPILED): `keeper/src/local_lane.rs` (served(program, version): 0x4804 as before, 0xC804 only under [0x4C;32]); the three `experimental_*_prepare.rs` check through it and echo the deployment's served version. Verify: `cargo test -p frontier-keeper` in an agreed build slot.
- **Runner (itest), not implemented — the real obstacle:**
  - The runner's program id is the constant `expedition_play::PROGRAM` ([0x45;32]), used about 90 times in 15 itest modules: `expedition_play`, `natural_play`, `keeper_loop`, `local_keeper`, `destination_*`, `origin_driver`, `conquest_*`, `resident_bells`, `wide_destination`, `world` and more. PDAs are derived from that constant throughout.
  - A candidate deployment under [0x4C;32] therefore needs that program id threaded through all of them. A blind edit across 15 modules could not be checked without a compiler, so it is not done.
  - Plan (agreed with the territory owner as files I may edit; byte-identical without the flag):
    1. A `Lane { program: [u8;32], version: u16 }` value with `Lane::CONQUEST` (= today's constants).
    2. Each module takes `&Lane` instead of the constant (mechanical; the conquest path passes `Lane::CONQUEST`).
    3. `--lane-candidate` builds `Lane { program: [0x4C;32], version: 0xC804 }`.
    4. Deploy Core and the resident program with a fresh throwaway authority, write its seed only into `--authority-seed-dir` (0600), and never print it.
    5. Season bytes at 0xC804.
    6. State the candidate keys on the first line.
    7. Verify with `cargo test -p itest --features localnet-conquest-play` in an agreed host-build slot, then one candidate world, with the candidate .so built in an agreed SBF slot.

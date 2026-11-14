# Candidate world, run 1 (2026-11-15): the runner deployed the candidate; the herald stopped the world

LOCAL TEST CANDIDATE only: conquest lane + NFT residents, program [0x4C; 32], version 0xC804. Not an allocation, never deployable.
- Loopback only; test keys only.
- No real wallet, no public chain, no real funds.
- The slot was agreed with the territory owner (main CC) and ⑰. Nothing ran at the same time.

## Inputs (world branch `claude/nft-candidate-world-r21-20261115` @ `578389cd`)

| What | Where it came from | sha256 (first 16) |
|---|---|---|
| Candidate frontier `.so` (3,613,280 B) | `scripts/build-frontier-localnet-conquest-nft-sbf.sh`, from `644f11b4` | `404633c823e8eb46` |
| Runner `localnet-expedition-play` | staged host build, `itest --features localnet-conquest-play` | `dc11d62c49b8589b` |
| Keeper tools (depart-prepare, expedition-preview, expedition-prepare, conquest-prepare) | staged host build, `keeper --features conquest-dispatch-experimental` | `5428ec25…`, `e9a1c320…`, `33695292…`, `23c90254…` |
| Resident program `.so` | NFT branch `program/BUILD-RECORD.json` | `947da0b94d0b51ca` |
| Metaplex Core `.so` (mainnet ELF, untrimmed) | `.local/programs/mpl_core.record.json` | `515541c84caa71a2` |
| Herald | reused read-only: `wylls-claude2-map-20261110/frontier-node/target/debug/frontier-herald` | `569ecc8706cecf96` |

- The host build ran one package at a time under the unchanged guard. Each target was deleted after its binaries were copied out.
  - Runner: peak 2.6 GB, 64 s.
  - Keeper tools: peak 1.2 GB, 40 s.
- Launcher options:
  - `--world-preset local-conquest-test-v1 --prepare-scale 20 --economy page-signed-v1 --world-ttl-minutes 45`;
  - `--lane-candidate localnet-conquest-nft-sbf --resident-so --core-so --nft-setup --mint --mint-port 41996`;
  - ports: page 41920, world 41980–41984.
- Disk watchdog stops the world at 20.85 GiB free.

## What happened

1. The page's own local-play gate (English, `?localPlay=1&launcher=1`) made its memory-only wallet. That address was shown on the gate, and the gate screenshot was saved.
2. **The runner deployed the candidate and created the world.** Its first line (public facts only):
   - program `68qTstPmwfaDbt1a9hnq7XeyZ4zJBqBKU1esRtQXnKWj` ([0x4C; 32]);
   - `program_version` `0xc804`;
   - lane `localnet-conquest-nft-sbf`;
   - resident program `68TBCtDEfvunEQYEb4cZSBnkPWnu2h6XuvSTmLctZyv5`;
   - Core `CoREENxT…`;
   - artefact sha256 `404633c8…`;
   - "real SBF artifact in the in-process LiteSVM chain";
   - Season `EsSJ4noi…`.
   This is the first live evidence of the runner's candidate lane threading (Lane, deploy under [0x4C], the Season version).
3. **The herald exited**, with `metadata: not the dedicated local-play program, or not --program`. The launcher recorded `stopped.json` `{"reason": "herald-exited"}`. The screen check was stopped, and the launcher was stopped and verified down: no listener on 41900–41999, 23.07 GiB free.

## Cause

- The herald's local-play bootstrap (feature `local-play-bootstrap`, `herald/src/local_play.rs`) exists only as **uncommitted** changes in another session's tree (`wylls-claude2-map-20261110`, branch `claude2/original-map-scaling-20261110`). It is in no branch, including canonical.
- It pins the program as `e.program.to_bytes() != PROGRAM`, i.e. [0x45] only. So no herald on hand can serve a candidate world.
- The fix is a candidate-only **exact pair** in that bootstrap: [0x4C] only with Season version 0xC804, and [0x45] exactly as before. Its owner, or an agreed committed copy, decides how. Asked of the main CC; not done.

## Status of the goal stages

| Stage | State |
|---|---|
| Candidate artefact deployed by the runner, version 0xC804 | **proven in a world** (run 1) |
| NFT setup, mint page, mint → transfer A→B → JoinResident | **not reached** (blocked by the herald) |
| Build / Train / Muster as the NFT (0xE2 through the world relay) | mock and real-controller tests only; not in a world |
| March / territory (0xDD) | **not connected** (only DeclareSiege's inner can be a 0xDD player command) |
| Pass sold away after play: old owner refused / new owner acts | relay mock tests only; the page has no candidate transfer action yet |

The evidence stays local (screenshots, logs and the world's data directory, which holds its throwaway authority seed): it is never committed or published.

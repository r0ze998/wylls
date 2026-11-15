# Land preview → canonical: integration note (Claude, 2026-11-16)

No secrets in this file. Nothing here is NFT, transfer, session guard, prize, real funds or public issuance.

## What to take
- Branch `claude/continuous-territory-integ-20261115`, range `68e8548d..7a514f20` (68e8548d = canonical round 49 handover,
  already merged into this branch). 31 files, +3059 / −11. As one patch: `git diff 68e8548d 7a514f20`
  (sha256 prefix 332b7fe88f8f9b33).
- All of it is opt-in: the cargo feature `land-preview` (rules, abi, program, herald), `localnet-land-play` /
  `localnet-land-sbf` (itest, sbf script), and the launcher's `--world-option land-preview-v1`. A default build, a
  natural world, vectors, hashes and budgets are unchanged. Tags 0xCD/0xCE are PROVISIONAL (the integrator allocates).
- Real-chain evidence: land5 (TEST-ONLY ×10, 2026-11-16, see CLAUDE-CONTINUOUS-TERRITORY-R1-20261115.md): enemy took 4
  tiles, 3 open tiles added, the map and panel showed the change; cleanup 01:41:58.

## Against canonical HEAD bcc63a24 (the migration WIP on 68e8548d — unverified, not treated as checked)
- Files both touched: `frontier-node/crates/herald/Cargo.toml`, `frontier-node/crates/herald/src/fold.rs`.
  Blob ids — Cargo.toml: base 8fdfccba, this branch 3ebed94a, bcc63a24 72f7d618; fold.rs: this branch 3966ccd8,
  bcc63a24 8cdf5cf7.
- `git merge-tree HEAD bcc63a24`: fold.rs merges by itself; Cargo.toml conflicts only because both add one feature line
  after `local-play-bootstrap = []` (`land-preview` here, `expedition-records-experimental` there). Resolution: keep both.
- Gateway suite (checkpoint §5 command) on a scratch export of the trial merge (tree 2f5c43fc, with the fix below):
  2100 tests, 2095 pass, 4 fail, 1 skipped. The 4 are the checkpoint's known ones: boundary control and the NFT home
  record (restricted, not touched), web-lang completeness (b)/(c) (owner's call). No new failure from the combination.

## Round on this branch: 7a514f20
- The only failure new against 68e8548d was proto-hand's word test: `frontier/land.mjs` says 領土 (the land preview's
  reader of the program's own land record). It joins the test's list of files where the chain's record decides land.
  After (full suite, run alone): 1868 tests, 1864 pass, 3 fail — NFT home record and web-lang (b)/(c), all known.
  The boundary-control failure appears only with bcc63a24's files.
- base 68e8548d showed 3 extra natural-world failures in the first run: EADDRINUSE 41982, because I ran base and HEAD
  suites at the same time. Alone, `frontier-local-play-natural.test.mjs` passes 11/11 on both. Not a base failure.

## Not done / not run here
- No Rust was built or tested in this round (no target in this worktree; the build guard is unchanged). The Rust in
  the range is the one land5 ran on.
- No world was started. Still open: fray to its end, retaking land, a natural-speed world.
- Canonical was not written. The canonical owner applies this (one integrator), after the WIP bcc63a24 is checked.

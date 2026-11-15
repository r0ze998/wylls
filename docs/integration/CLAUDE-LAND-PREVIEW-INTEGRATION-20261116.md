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

## Ordinary-play-only regression (2026-11-16)
- Subset of the checkpoint §5 suite, files whose topic is restricted dropped by name (`nft|resident|prize|session|wallet|
  viewer-own-citizen|ws07|outbound-arrival-pick|boundary`); restricted tests are neither fixed nor retried. Base and HEAD
  run one after the other (no shared port).
- HEAD 46ccf5ac's tree (182 files): 1729 tests, 1726 pass, 2 fail, 1 skipped. Base 68e8548d (180 files): 1716 / 1713 / 2.
  The 2 on both are web-lang completeness (b)/(c); their reported items are the same on base and HEAD (only paths and
  test numbers differ), none from a land file. No ordinary-play regression from the land preview.

## Left for a safe canonical integration (in order)
1. The canonical owner checks the migration WIP bcc63a24 (79 files) on its own first; this branch is not a check of it.
2. Before writing herald/Cargo.toml and herald/src/fold.rs in canonical: paths + blob ids above to the other owner, wait
   for OK (shared files, one integrator).
3. Apply `68e8548d..46ccf5ac` (or the patch) on the checked canonical head; Cargo.toml: keep both feature lines.
4. Rerun on the result: the ordinary-play subset above, and the full §5 suite (expect only the known failures).
5. Rust, not run in this round: `cargo test` with `land-preview` (rules `land.rs`, herald `land_capture.rs`) and a
   default build without it — only within conquest-guard.sh (unchanged) and the free-space floor.
6. Allocate the land tags (0xCD/0xCE are provisional) before anything leaves local development.
7. Then the open play items, each a new TEST-ONLY world reported before it starts: fray to its end, retaking land,
   a natural-speed world.

## Not done / not run here
- No Rust was built or tested in this round (no target in this worktree; the build guard is unchanged). The Rust in
  the range is the one land5 ran on.
- No world was started. Still open: fray to its end, retaking land, a natural-speed world.
- Canonical was not written. The canonical owner applies this (one integrator), after the WIP bcc63a24 is checked.

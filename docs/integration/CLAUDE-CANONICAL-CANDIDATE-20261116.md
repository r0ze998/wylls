# Canonical integration candidate (Claude, 2026-11-16)

No secrets. Nothing here is NFT transfer verification or an equivalent procedure, session guard, prize, real funds or
public issuance. **No real world or launcher was run for anything in this candidate** (the launcher start was refused
by the permission check on 2026-11-16 and was not retried or worked around).

## What it is
- Branch `claude/canonical-candidate-20261116` (isolated worktree), cut from canonical
  `codex/wide-conquest-lifecycle-20261109` @ **bcc63a24**, with the integration branch
  `claude/continuous-territory-integ-20261115` merged in (525990f4 → merge e74a0d92; c46b6768 → merge 800f5d98).
- **bcc63a24 is the 2026-11-15 migration WIP snapshot (79 files), NOT verified.** This candidate does not verify it;
  it only shows that the integration work merges onto it and that the ordinary-play tests pass on the result.
- Canonical itself was only read: HEAD bcc63a24 (= remote), 3 untracked entries of other lanes
  (`docs/integration/CLAUDE-CONQUEST-V2-CLI-PREPARED-EVIDENCE-20261112.json`,
  `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/c-before-files.tar`,
  `permutation-gateway/screens/node_modules`). Its tree, index and branch were not changed; nothing force-pushed.

## Paths both sides changed since round 49 (68e8548d)
| path | integration | WIP bcc63a24 | result | decision |
|---|---|---|---|---|
| `frontier-node/crates/herald/Cargo.toml` | feature `land-preview` | feature `expedition-records-experimental` | conflict (same place) | keep both lines (done) |
| `frontier-node/crates/herald/src/fold.rs` | land capture + envelope `land` (cfg land-preview) | expedition-record hunks | auto-merged, no shared line | adopt both; **Rust not compiled here** |
No other path is shared (integration 60+ files, WIP 79).

## WIP files worth a decision (not changed by this candidate)
- `permutation-server/web/lang/en-frontier-play.mjs.orig` (1569 lines): a backup copy, not loaded by any page.
  Recommend not adopting it into canonical; left in place here (no deletion in this candidate).
- `permutation-server/web/frontier/seal-worker.mjs`, `frontier-node/crates/findex/*`, `herald/tests/expedition_records.rs`,
  `scripts/build-frontier-localnet-expedition-sbf.sh`, `permutation-frontier/src/proc/*.rs.txt`: the Codex expedition
  lane's WIP — unverified; kept as is.

## Restricted boundary in the candidate
Carried in from the WIP, never run or edited here: `test/frontier-local-play-resident.test.mjs`,
`test/web-frontier-ephemeral-wallet.test.mjs`, `test/web-frontier-outbound-arrival-pick.test.mjs` (boundary control),
`screens/codex-route-preview.screen.mjs` (boundary editor + prize stub). From earlier work: every test file whose name
matches `nft|resident|prize|session|wallet|viewer-own-citizen|ws07|outbound-arrival-pick|boundary`. All NOT verified.
One WIP test kept in the ordinary run after reading it: `web-frontier-local-play-act.test.mjs` mentions `FS.prize` only
to assert local play refuses while a prize is set (a source-text check).

## Tests on the candidate (scratch exports by SHA; no Rust build; no world)
- 800f5d98: ordinary-only subset (206 files, restricted names excluded) — 1967 tests, 1966 pass, **0 fail**, 1 skipped,
  0 todo; `web-lang-play-glossary` 16/16; screens (keyless fixture or blank page) first-session 2, local-march-maptap 5,
  conquest-press 10, march-block-reasons 16, return-card 2; `scripts/play2-land-ops/tests` 17/17 (dummy processes).
- e74a0d92 (before the far-land chip): the same — 1966 tests, 1965 pass, 0 fail.

## Rust on the candidate (2026-11-16 08:50–09:00 JST, 6a7284a5) — guarded, land-only, all pass
Preconditions measured: free 22.87 GiB; no cargo/rustc/build-sbf, launcher, world or ffmpeg; 0 listeners on
40000–41999. Target: a NEW folder `wylls-canonical-candidate-20261116-target`, an APFS copy-on-write clone of the land
target (free unchanged by the clone; the original and its pinned play2 binaries untouched — herald cd5a9281…, natural
runner f00415a2… re-checked after). Each command under conquest-guard.sh (unchanged, 94baeb7d: 4 GiB target, 20 GiB
free, 30 min) inside an outer floor (floor21.sh 99dbed44: free < 21 GiB or deadline 10:30 JST → TERM the guard's
own cargo group, checked by ppid/pgid/command). Serial; no workspace-wide build, no full suite; nothing fired.
| package (workspace) | command | result |
|---|---|---|
| herald (frontier-node) | `check --features land-preview,expedition-records-experimental` (the merged fold.rs) | ok |
| herald | `check` (default) | ok |
| herald | `test --features land-preview --test land_capture` | 2/2 |
| herald | `test --features expedition-records-experimental --test expedition_records` (WIP side of the merge) | 1/1 |
| herald | `test --lib` (default) | 65/65 |
| permutation-rules (root) | `test --features land-preview --lib land` / `test --lib` | 19/19 / 175/175 |
| frontier-abi | `test --features land-preview --lib land` / `test --lib` | 9/9 / 115/115 |
| permutation-frontier (host) | `check --features land-preview` / `check` | ok / ok |
| permutation-frontier | `test --features land-preview --lib map_growth` | 10/10 |
| itest (frontier-node) | `test --features localnet-land-play --lib land_lane` | 3/3 |
Peak target 2.7 GiB apparent (clone included), free ≥ 22.18 GiB throughout; no process left; nothing deleted (the clone
target stays). Not run: the program's default lib tests (they reach NFT-resident paths), any SBF build, herald
`real_chain`, any world. No change to the candidate was needed.

## Land SBF on the candidate (2026-11-16 09:00 JST) — byte-identical to the pinned land4 program
`cargo build-sbf … --features localnet-land-sbf --offline --skip-tools-install -- --locked` (solana-cargo-build-sbf
3.1.9, platform-tools v1.52), guarded as above, in the clone target; permutation-rules, frontier-abi and
permutation-frontier recompiled from this tree. Output (git-ignored, separate from the pinned file):
`permutation-frontier/target/deploy-localnet-land-sbf/permutation_frontier.so` sha256
f2e644420dd8dca4a9c985b995ea599040e09b0e69bc561f3069e625e96a5987 (3,648,952 B) = the land4/play2 pin; the script's checks
pass (SBPF v2, overflow checks, localnet markers, no test marker). Not deployed, no world.

## Tag audit (2026-11-16)
`frontier-abi` `the_land_tags_collide_with_no_routed_band`: 0xCD/0xCE outside the v2 table, rights 0xD0–0xD5, capacity
0xF0–0xFD and the wide drafts 0xD6–0xDF + 0xEE — 13/13 with all those features, here (99666882) and on the integration
branch; workstream 20's 0xE0–0xE7 by the existing assertion. No other first-byte use found statically. Still provisional.

## WIP inventory and ABI rev 7 (2026-11-16, 375478e4)
- Per-file inventory of bcc63a24's 79 files: docs/integration/CLAUDE-WIP-BCC63A24-INVENTORY-20261116.md — 46 adopt
  (per-file evidence), 22 records, 6 hold, 1 not adopted (`.orig`), 4 restricted (not run/changed). Two WIP tests failed at
  bcc63a24 itself and are fixed here (cfffc589). Not a whole-WIP pass.
- ABI-ALLOCATION rev 7 (provisional): 0xCD FoldLand, 0xCE ClaimLandYield, 0xCF reserved; seed `ld` / PSFLAND1; version bit
  0x0400 reserved, not applied. Test `frontier-abi-land-allocation.test.mjs` 3/3. Land SBF still f2e64442… after.
- Ordinary-only subset on 375478e4: 1967 tests, 1966 pass, 0 fail, 1 skipped.

## Held WIP items verified (2026-11-16 10:00, after the approved scratch cleanup; free 23.5–24 GiB)
- runtime-contract-tests (own workspace, Rust 1.95, offline, --locked), in an APFS clone of that workspace's existing
  target (original untouched), guarded (conquest-guard 94baeb7d + floor21, deadline 11:30): depart_message 5/5 (the keeper's
  real unsigned Depart message through the actual handler; no key/signature/transaction/SBF VM), runtime-contract-support
  unsigned_message 4/4; README's narrow-filter rule kept (no library suite, no native-crypto/test-beacon/oracle).
- Expedition SBF: build-frontier.sh's lane arguments, guarded, separate out dir
  (`permutation-frontier/target/deploy-localnet-expedition-sbf/`, git-ignored): its own checks pass (SBPF v2, overflow
  checks, expedition marker only, 0 data relocations); sha256 f2f033281f695e2f8b2fbae88f4e24f9706566aff27a5c014a780f3a8c9ce6f3,
  program_hash 2752619fdd7fb4dc…, 3,377,056 B. Not deployed; no world.
- Inventory now: 50 adopt, 22 records, 1 hold (`.rs.txt`), 1 record-only hold (`long-run.json`), 1 not adopted, 4 restricted.

## Left before canonical takes it
1. The canonical owner checks bcc63a24 on its own (it is unverified).
2. Rust: DONE for the land scope above, including the land SBF build (byte-identical to the pin) and the tag audit.
3. `.orig`: not needed (inventory). Land tags: rev 7 proposal written; the integrator confirms it (and decides on the 0x0400 bit).
4. A real TEST-ONLY world with the owner's go (ops: `scripts/play2-land-ops/`, fail-closed; never run for real yet):
   none of the fixes since land5 (block reasons, S1 ore, English, return card, far-land chip) has been seen in a world.
5. Natural-speed world; phone width (PC first, owner).

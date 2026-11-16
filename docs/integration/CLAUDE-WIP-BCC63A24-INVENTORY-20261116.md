# The migration WIP bcc63a24: per-file inventory on the canonical candidate (Claude, 2026-11-16)

No secrets. **This does not make bcc63a24 "verified" as a whole.** Each row says what was checked for that file, on the
candidate `claude/canonical-candidate-20261116` (WIP + integration), and what was not. Restricted areas (NFT transfer
verification or equivalents, session guard, prize, real funds, public issuance) were neither changed nor run.
**No real world or launcher was run.**

How the evidence was taken (2026-11-16):
- Gateway tests: each ordinary WIP test file run ALONE on an export of e62d0ae6 (`node --test <file>`); the two that failed
  were run alone on an unchanged export of bcc63a24 with the same command and failed there too (WIP-own failures), then
  fixed on the candidate in cfffc589. A wider all-ordinary gateway run was refused by the tool's permission check and was
  not retried; the per-file runs below are the evidence.
- Rust: guarded (conquest-guard.sh 94baeb7d + an outer 21 GiB floor, deadline 10:30 JST) in an APFS-clone target, one
  package/feature/test at a time; no workspace-wide build.

| file | A/M | area | decision | evidence |
|---|---|---|---|---|
| `CLAUDE2-OVERVIEW-LOADING-20261110.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-20261112.json` | A | evidence (generated) | adopt as record | read by frontier-conquest-real-evidence* tests (pass) |
| `docs/integration/CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-CAPTURE-STAGES-20261112.json` | A | evidence (generated) | adopt as record | read by frontier-conquest-real-evidence* tests (pass) |
| `docs/integration/CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-NOTAPPLIED-STAGES-20261112.json` | A | evidence (generated) | adopt as record | read by frontier-conquest-real-evidence* tests (pass) |
| `docs/integration/CLAUDE-EXPEDITION-CONNECTION-20261111.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113.patch` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/c-after.sha256` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/c-before.sha256` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/git-diff-before-round-files.patch` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/git-status-before.txt` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/tests-after-summary.txt` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/tests-before-summary.txt` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-KEEP-HIT-INDEX-20261110.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-LEGACY-MARCH-REAL-TEST-PLAN-20261113.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-LOCAL-MARCH-OPEN-CONTRACT-20261113.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CLAUDE-PAGE-MARCH-TRIAL-RESULT-20261113.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CODEX-REVERSE-CAPTURE-20261110.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CODEX-REVERSE-PRODUCER-20261110.md` | M | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/CODEX-REVERSE-TERMINAL-RUNTIME-20261110.md` | A | record (doc / patch / summary) | adopt as record | not executed |
| `docs/integration/evidence-fable-conquest-v2/res-real-evidence-v2codec-e6bfe8c2-capture.json` | A | evidence (generated) | adopt as record | read by frontier-conquest-real-evidence* tests (pass) |
| `docs/integration/evidence-fable-conquest-v2/res-real-evidence-v2codec-e6bfe8c2-notapplied.json` | A | evidence (generated) | adopt as record | read by frontier-conquest-real-evidence* tests (pass) |
| `frontier-node/crates/fclient/tests/experimental_expedition_message.rs` | M | expedition (Rust, experimental features, off by default) | adopt | `test -p fclient --features expedition-dispatch-experimental --test experimental_expedition_message` 5/5 |
| `frontier-node/crates/fclient/tests/wide_seal_js_cross.rs` | A | expedition (Rust, experimental features, off by default) | adopt | `--features wide-records-experimental --test wide_seal_js_cross` 1/1 (+1 ignored: the vector generator, by design) |
| `frontier-node/crates/findex/Cargo.toml` | M | expedition (Rust, experimental features, off by default) | adopt | `test -p findex --features expedition-records-experimental --lib` 18/18 |
| `frontier-node/crates/findex/src/expedition_records.rs` | A | expedition (Rust, experimental features, off by default) | adopt | same, 18/18; herald `expedition_records` 1/1 |
| `frontier-node/crates/findex/src/index.rs` | M | expedition (Rust, experimental features, off by default) | adopt | findex lib 18/18 |
| `frontier-node/crates/findex/src/lib.rs` | M | expedition (Rust, experimental features, off by default) | adopt | findex lib 18/18 |
| `frontier-node/crates/findex/tests/fixtures/browser_depart_v1.json` | A | expedition (Rust, experimental features, off by default) | adopt | read by findex/herald expedition tests (pass) |
| `frontier-node/crates/herald/Cargo.toml` | M | expedition (Rust, experimental features, off by default) | adopt | merged with land-preview (both lines); `check -p herald --features land-preview,expedition-records-experimental` ok |
| `frontier-node/crates/herald/src/fold.rs` | M | expedition (Rust, experimental features, off by default) | adopt | auto-merged; same check ok; herald lib 65/65; land_capture 2/2 |
| `frontier-node/crates/herald/tests/expedition_records.rs` | A | expedition (Rust, experimental features, off by default) | adopt | 1/1 |
| `frontier-node/crates/keeper/tests/experimental_expedition_depart_prepare.rs` | A | expedition (Rust, experimental features, off by default) | adopt | `test -p keeper --features expedition-dispatch-experimental --test experimental_expedition_depart_prepare` 10/10 |
| `frontier-node/crates/keeper/tests/support/wide_reverse_expedition.rs` | A | expedition (Rust, experimental features, off by default) | adopt | support of wide_expedition (pass) |
| `frontier-node/crates/keeper/tests/wide_expedition.rs` | M | expedition (Rust, experimental features, off by default) | adopt | `--features wide-world-experimental --test wide_expedition` 20/20 |
| `permutation-frontier/runtime-contract-tests/fixtures/expedition-depart-prepared-report-heap256k.json` | A | expedition (Rust, own workspace) | adopt (2026-11-16 10:00) | read by keeper `experimental_expedition_depart_prepare` (10/10), which fails when this fixture is stale |
| `permutation-frontier/runtime-contract-tests/support/src/lib.rs` | M | expedition (Rust, own workspace) | adopt (2026-11-16 10:00) | `cargo +1.95.0 test --offline --locked -p permutation-frontier-runtime-contract-tests --lib --features expedition-dispatch-experimental,system-cpi-tests --target aarch64-apple-darwin proc::wide::expedition_dispatch_tests::depart_message::` 5/5 (listed first: exactly 5), guarded |
| `permutation-frontier/runtime-contract-tests/support/src/unsigned_message.rs` | A | expedition (Rust, own workspace) | adopt (2026-11-16 10:00) | the depart_message tests above 5/5 (no key, signature, transaction, bank or SBF VM) and `-p runtime-contract-support --lib unsigned_message` 4/4 |
| `permutation-frontier/src/proc/wide_expedition_close_positive_unexecuted.rs.txt` | A | unexecuted code text | hold | not compiled; the expedition lane decides |
| `permutation-gateway/screens/codex-route-preview.screen.mjs` | M | restricted | boundary: not run, not changed | NFT-resident / wallet / boundary control / prize stub |
| `permutation-gateway/test/fixtures/frontier-expedition-depart-prepare-heap256k-rust.json` | A | test fixture | adopt | read by the passing expedition / seal tests |
| `permutation-gateway/test/fixtures/frontier-expedition-depart-prepare-rust.json` | A | test fixture | adopt | read by the passing expedition / seal tests |
| `permutation-gateway/test/fixtures/frontier-expedition-depart-prepare-wallet-payer-rust.json` | A | test fixture | adopt | read by the passing expedition / seal tests (web-frontier-expedition-depart-prepare 16/16) |
| `permutation-gateway/test/fixtures/wide-seal-cross-v1.json` | A | test fixture | adopt | read by the passing expedition / seal tests |
| `permutation-gateway/test/frontier-conquest-real-evidence-states.test.mjs` | A | gateway test (ordinary) | adopt | pass=5 fail=0 (after cfffc589: stale English updated; failed at bcc63a24 too) |
| `permutation-gateway/test/frontier-conquest-real-evidence.test.mjs` | A | gateway test (ordinary) | adopt | pass=6 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/frontier-conquest-v2-cli-report.test.mjs` | A | gateway test (ordinary) | adopt | pass=5 fail=0 (after cfffc589: redacted evidence copy added; failed at bcc63a24 too, file untracked) |
| `permutation-gateway/test/frontier-conquest-v2-evidence.test.mjs` | A | gateway test (ordinary) | adopt | pass=6 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/frontier-expedition-depart-prepare.test.mjs` | A | gateway test (ordinary) | adopt | pass=19 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/frontier-expedition-prepare.test.mjs` | A | gateway test (ordinary) | adopt | pass=8 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/frontier-local-play-act.test.mjs` | A | gateway test (ordinary) | adopt | pass=11 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/frontier-local-play-preview.test.mjs` | A | gateway test (ordinary) | adopt | pass=6 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/frontier-local-play-relay.test.mjs` | A | gateway test (ordinary) | adopt | pass=17 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/frontier-local-play-resident.test.mjs` | A | restricted | boundary: not run, not changed | NFT-resident / wallet / boundary control / prize stub |
| `permutation-gateway/test/frontier-local-play-reveal.test.mjs` | A | gateway test (ordinary) | adopt | pass=10 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-design-pass.test.mjs` | A | gateway test (ordinary) | adopt | pass=31 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-ephemeral-wallet.test.mjs` | A | restricted | boundary: not run, not changed | NFT-resident / wallet / boundary control / prize stub |
| `permutation-gateway/test/web-frontier-expedition-depart-prepare.test.mjs` | A | gateway test (ordinary) | adopt | pass=16 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-expedition-prepare.test.mjs` | A | gateway test (ordinary) | adopt | pass=7 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-expedition-reveal.test.mjs` | A | gateway test (ordinary) | adopt | pass=6 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-keep-at-index.test.mjs` | A | gateway test (ordinary) | adopt | pass=6 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-keep-hit-index.test.mjs` | A | gateway test (ordinary) | adopt | pass=8 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-local-fixture-citizen.test.mjs` | A | gateway test (ordinary) | adopt | pass=3 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-local-play-act.test.mjs` | A | gateway test (ordinary) | adopt | pass=17 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-nation-confirm-layout.test.mjs` | A | gateway test (ordinary) | adopt | pass=4 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-outbound-arrival-pick.test.mjs` | A | restricted | boundary: not run, not changed | NFT-resident / wallet / boundary control / prize stub |
| `permutation-gateway/test/web-frontier-outbound-clock.test.mjs` | A | gateway test (ordinary) | adopt | pass=7 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-overview-reentry.test.mjs` | A | gateway test (ordinary) | adopt | pass=8 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-render-loop.test.mjs` | A | gateway test (ordinary) | adopt | pass=3 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-seal-wide.test.mjs` | A | gateway test (ordinary) | adopt | pass=8 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-terrain-frame.test.mjs` | A | gateway test (ordinary) | adopt | pass=7 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-trace.test.mjs` | A | gateway test (ordinary) | adopt | pass=6 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-wedge.test.mjs` | A | gateway test (ordinary) | adopt | pass=6 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-wide-work.test.mjs` | A | gateway test (ordinary) | adopt | pass=9 fail=0 skipped=0 todo=0 |
| `permutation-gateway/test/web-frontier-world-sparse.test.mjs` | A | gateway test (ordinary) | adopt | pass=9 fail=0 skipped=0 todo=0 |
| `permutation-server/web/frontier/seal-worker.mjs` | M | page (sealed march worker) | adopt | web-frontier-seal-wide 8/8 and fclient wide_seal_js_cross 1/1 (JS ↔ Rust seal vector) |
| `permutation-server/web/lang/en-frontier-play.mjs.orig` | A | backup | not adopted (left in place, not deleted) | older copy of en-frontier-play.mjs (differs from round 49 at line 161 on); no code loads it; only docs mention it |
| `scripts/build-frontier-localnet-expedition-sbf.sh` | A | build script | adopt (2026-11-16 10:00) | its build (build-frontier.sh lane: `cargo-build-sbf --tools-version v1.52 --arch v2 --features localnet-expedition-sbf --offline --skip-tools-install -- --locked`) run guarded with a separate out dir; build-frontier.sh's own `check` (lines 92–140, verbatim) passes: SBPF v2, overflow checks, expedition marker only, 0 data relocations; .so sha256 f2f033281f695e2f…, 3,377,056 B. The script itself was not run as is (it pins a new in-tree target) |
| `workstreams/15-coop-outcomes/results/long-run.json` | M | generated timings | hold (record only) | only totalMs/perWindowMs changed; output of workstreams/15 test/long-run.mjs |

Totals: adopt: 46 + 4 adopted on 2026-11-16 10:00 (runtime-contract-tests 3, expedition SBF script 1) = 50, adopt as record: 22, boundary: not run, not changed: 4, hold: 1, hold (record only): 1, not adopted (left in place, not deleted): 1 (of 79)

## Notes on the holds and the one not adopted
- `en-frontier-play.mjs.orig`: not needed by the candidate — no import, no script or test loads it; it is an older copy of
  the play dictionary (it differs from round 49's file from line 161 on). Left in place; nothing deleted, in canonical or here.
- runtime-contract-tests (3 files) and `build-frontier-localnet-expedition-sbf.sh`: verified 2026-11-16 10:00 after the
  approved scratch cleanup (free 23.5–24 GiB), in APFS-clone targets under the guard and the 21 GiB floor — adopted (rows above).
- `wide_expedition_close_positive_unexecuted.rs.txt`: code kept as text by the expedition lane; not compiled anywhere.
- `long-run.json`: machine timings of a coop evaluator run; no test asserts them.

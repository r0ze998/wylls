# CQ1-D formats-docs: notes

Unit CQ1-D of wave 1 of the conquest milestone MC (`CONQUEST-CONTRACT.md` v1.1 §11). Branch `frontier/cq-1d-docs`, worktree `.claude/worktrees/cq-1d-docs`, cut from `frontier/cq-integ` at `CQ0` = **`39ff369`** (used wherever the contract writes `CQ0` or `d11d058`). Local commits only; nothing pushed; no server started, no port bound outside `127.0.0.1:0` test sockets, no chain transaction, no download or install, no paid API.

## 1. What landed

| Deliverable (§11 CQ1-D) | Where | State |
|---|---|---|
| Herald format codecs `PSFCT1`, `PSFOV2`, `PSFSD1` and the JSON schemas of §8.4, encoder and decoder | `frontier-node/crates/herald/src/cqfmt.rs` (+ one `pub mod cqfmt;` in `herald/src/lib.rs` inside a `// MC hook` block) | done; `cq_*` unit tests (9) |
| Shared vectors | `frontier-node/fixtures/cq/formats/` (50 files: 11 valid, 38 invalid, and `vectors.json`) | done; one producer (`cqfmt::vectors::files`), one freshness test (`cq_formats_vectors_fresh`) |
| JS decoders in `herald.mjs` (additive) | `permutation-server/web/frontier/herald.mjs` | done; nothing above the new section changed except one `import` line from `fgeo.mjs` |
| `web-frontier-cq-formats.test.mjs` | `permutation-gateway/test/web-frontier-cq-formats.test.mjs` | done; 10 tests |
| `scripts/cq-ownership-check.sh` | `scripts/cq-ownership-check.sh` | done; `--self-test` 14 cases |
| The contract committed as `docs/frontier/conquest/CONQUEST-CONTRACT.md` | already at `CQ0` | checked byte-identical to the planning copy in the session scratch (`cmp`), not rewritten; likewise `SUMMARY.ja.md` and the five area designs |
| `DECISIONS.md` part CQ (K-01…K-27, OD-1…OD-16, R-01…R-26) | `docs/frontier/DECISIONS.md` part CQ (CQ-A records, CQ-B working defaults, CQ-C conflicts, CQ-D review, CQ-E this unit's records) + change-log row + intro sentence | done. **OD-1…OD-16 are recorded as working defaults the owner may revise, not as owner approvals** (1–12 yes, 13–15 no, 16 stop and ask) |
| DESIGN rev 3.2 section "Conquest milestone" | `docs/frontier/DESIGN.md` §24 (the keep, the control layer, the holding contest, the defaults and timers, season end, ABI and cost, criterion 10, what is out) + status bullet; title now "revision 3.2" | done; plan numbers, tagged; CQ4-E replaces them with measured ones |
| — | `docs/frontier/README.md`: the conquest documents linked | done |

Commits: `17aad4e` (codecs, vectors, JS decoders, JS test), `172bca5` (ownership check), `d10e373` (JS refusals through `check()`), and the docs commit that carries these notes. The message of `17aad4e` says "12 valid"; the true count is **11 valid, 38 invalid** (commits are local; not rewritten).

## 2. The formats

| Format | Rust (`herald_fold::cqfmt`) | JS (`herald.mjs`) |
|---|---|---|
| `PSFCT1` `/h/control/{bell}.bin` | `ControlFile::{encode, decode}`, `ControlProvince`, `ControlMarch`, `march_order`, `rings_of`, `pflag`, `mflag` | `decodeControl(bytes, {seasonId, bell})`, `marchOrder(rings)`, `ringsOf`, `PROVINCE_FLAGS`, `MARCH_FLAGS` |
| WS `control` delta | `encode_control_delta`, `decode_control_delta`, `control_delta(prev, cur)` (None = resync hint) | `decodeControlDelta`, `applyControlDelta` |
| `PSFOV2` `/h/overview2/{ring}/{bell}.bin` | `Overview2File`, `Overview2Record::{from_v1, encode, decode}` (bytes 0–23 = `overview::record`) | `decodeOverviewV2(bytes, {seasonId, ring})` (v1 fields as `decodeOverview`, plus `occupiers`, `siegeStates`, `siteKinds`, `keepTile`, `keepTroops`, `immune`) |
| `PSFSD1` `/h/standings/series.bin` | `StandingsSeries`, `FactionHour` | `decodeStandings(bytes, {seasonId})`, `STANDINGS_FIELDS` |
| `/h/sieges/{latest,bell}.json` | `SiegesFile::{to_json, parse}`, `SiegeEntry`, `KeepContest` | `parseSieges(text \| bytes \| object)` |
| `/h/conquest/{day}.json` | `ConquestDay::{to_json, parse}`, `ConquestEvent`, `EventKind::{ALL, shape}` | `parseConquestDay(…)`, `CONQUEST_EVENT_SHAPE` |

- **Validating decoders, same codes in both languages:** `BadMagic`, `BadLength`, `BadReserved`, `BadShape`, `BadValue`, `BadOrder`, `NotCumulative`, `TooMany`, `BadJson`, `BadSchema` (plus the JS-only pins `WrongSeason` / `WrongKey`). Both check in the same order, so a file with one defect gets the same code from either side; the 38 invalid vectors (one defect each) prove it. The Rust encoders refuse anything the decoders would refuse, so the herald (CQ2-E) cannot write a file its readers reject.
- **Writers are canonical:** the JSON writers emit §8.4's fields in §8.4's order, compactly, without depending on `serde_json`'s map-ordering feature (the bytes are the same under `-p herald` and `--workspace` feature unification); the binary writers zero every reserved byte.
- **Cross-checks the vectors give:** the JS decoders reproduce Rust's canonical decoded form of every valid file (including the March coordinates, so `fgeo.mjs` and `geometry::march_of` / `march_members` agree on the March order); the test-side JS encoder writes Rust's bytes back exactly; both refuse each invalid file with the same code.
- **The two JSON files only.** §8.4 pins the shapes of `sieges/*.json` and `conquest/{day}.json`; it does not pin `standings/latest.json`, `standings/players.json`, `call/{day}.json`, `season/final.json`, `siege/…json` or `keep/…json`. Those are CQ2-E's to define; see request D-5.

## 3. Format clarifications CF-1…CF-8 (for the integrator: amend §8.4, or overrule before CQ2-E starts)

Each is pinned by the vectors and stated in `cqfmt.rs`'s module doc.

| # | Where §8.4 left a choice | Pinned |
|---|---|---|
| CF-1 | `PSFCT1` "dense province order over rings 0..open" | `n_prov = provinces_within(R)` for whole rings 0..=R, R ≤ 127; an unopened province inside them has control 7; readers derive R |
| CF-2 | `PSFCT1` marches "sorted by the March's centre province index" (the 4-B record has no id) | the set is **every March with ≥ 1 member in rings 0..=R**; `n_march` must equal its size; order by the centre's dense index (the centre may lie in ring R + 1, hence R ≤ 127); readers attach (m, n) by position (`march_order` / `marchOrder`) |
| CF-3 | reserved bytes and value ranges | header reserved = 0; province flags bit 128 = 0; March flags bits 32–128 = 0; control 0–7 with 6 only at the Concord; the seat flag exactly on rings 0–1; heartland only from ring 2; contender 0–5 or 7; `progress ≤ required`; a contender ⇔ progress ≥ 1 and ≠ control; `points_lead` 0–7; banner 0–5 or 7; keeps ≤ 7. M3's truce and hostility bits are not refused |
| CF-4 | `PSFOV2` header and bit fields | `PSFOV1`'s header layout with magic `PSFOV2\0\0`; per-site fields little-endian, site i at bits 3i (occupier) or 2i (siege, kind) of their run, as `PSFOV1`; occupier 6 refused; keep tile 0–60 or 0xFF (none, rings 0–1) and 0 troops without a keep; byte 39's high nibble 0 |
| **CF-5** | **`PSFSD1`'s record is "6 factions × 32 B" but its fields sum to 30 B** | the record stays 32 B; offsets `provinces 0, banners 2, keeps_taken 4, keeps_lost 6, dominion_bells 8 (u32), captures 12, occupations_active 14, sieges_won 16, sieges_lost 18, liberations 20, holdings 22, members_active 24`, **reserved 26..32 (6 B, not the "u32" §8.4 writes)**; factions in order 0–5; header reserved 0; the seven cumulative fields never decrease hour to hour (`NotCumulative`) |
| CF-6 | the WS `control` delta | `n × 10 B` = `index u16 LE · record 8 B`, 1 ≤ n ≤ 64, strictly increasing index; more than 64 changed provinces, or a different province or March count, is a resync hint (`control_delta` returns `None`) |
| CF-7 | JSON details | a citizen tag is 16 lowercase hex characters of the tag's 8 bytes (the first 8 bytes of the Citizen address, the roster file's u64 LE); a Free City's `owner` is `null` with `ownerFaction` 6; `pauseReason` is `null` exactly while `status` is `progressing`; `key` = `sg:P,Q,site,declared`; sieges sorted by (p, q, site), keeps by (p, q), events by `seq` (stable); a March is `{"m":…,"n":…}`; `seq` is a decimal u64 string; `sig` base58; unknown fields ignored by readers. Semantic checks: `required` 1–60, `progress < required`, `declared ≤ bell < …`, `etaBell > declared`; keeps `1 ≤ progress < required`, `since ≤ bell`, `etaBell ≥ since` |
| CF-8 | which conquest events carry `p`, `q`, `site`, `march` | `site` events (siege_*, occupied, liberated, occupation_expired, capture_due, captured, free_city, outpost): p, q, site; `province` events (keep_*, province_control): p, q; `march` events (march_banner, march_points_lead): march only; `retired`: p, q, site optional; `from` / `to` 0–7 or null; `bell` inside the file's day (144 bells a day); `detail` an object |

A known, harmless divergence: JSON cannot tell `3` from `3.0` in JS, so `parseSieges` accepts `3.0` where Rust refuses it (`BadSchema`); no writer emits it.

## 4. The ownership check (`scripts/cq-ownership-check.sh`)

- **Protected:** §4.5's list exactly, **plus the design chat's footprint**: every path a commit on `frontier/ui-shell` touched since `CQ0` (`git log CQ0..frontier/ui-shell`), except the three shared herald files. Today that adds `permutation-server/web/frontier/intro/title.mjs` (the two `ui-shell` commits after `246b1fd`, `6a3d17c` and `86497ab`, which the contract's list predates). `--no-footprint` checks the written list only.
- **Shared herald files** (`herald/src/{lib,fold,server}.rs`): every added line (new numbering) and every removed line (old numbering) must lie inside a block that starts at a line containing `// MC hook` and ends at the next line containing `// MC hook end`. **The end marker is this script's pin** (§4.5 names only "a `// MC hook` block"); an unclosed block covers only its opening line. CQ2-E must write its hooks this way (request D-4).
- **Which commits:** `git rev-list --first-parent FORK..BRANCH`. A merge commit counts only for its own lines (a combined diff: lines added against every parent), so a merge of `codex/frontier` carrying the design chat's or `roster.rs`'s lines is never counted, while an "evil merge" that edits a shared file outside a hook is.
- **Deviation from §4.5's wording on the fork point:** `git merge-base --fork-point` alone answers the branch's own tip once the integrator has merged it into `frontier/cq-integ` (its reflog then contains the merge), which would make every merged branch pass vacuously in the Gate CQ1 run that happens after the merges. The script therefore takes **the branch's creation entry in its reflog first** ("branch: Created from …"), then `merge-base --fork-point` unless it equals the tip, then `merge-base`; `--fork REF` overrides; the method is printed. The self-test shows a merged bad branch still fails.
- **Self-test** (`scripts/cq-ownership-check.sh --self-test`, a scratch repository under `$TMPDIR`, removed afterwards): clean hooks pass; a design-chat file, a herald line outside a hook, a removal outside a hook, an unclosed hook, a footprint path, an evil merge, a merged bad branch, and one bad branch among good ones fail; a merged `codex/frontier` and a merged clean branch pass; an unknown branch or no branch exit 2. Bash 3.2-compatible (macOS).

## 5. Tests and gate lines run

All on this branch, `CARGO_BUILD_JOBS=6`.

| Command | Result |
|---|---|
| `(cd frontier-node && cargo test --locked -p herald --lib cq_)` | 9 passed (`cq_formats_vectors_fresh`, `cq_formats_vectors_decode_and_refuse`, `cq_control_layout_offsets`, `cq_march_order_matches_geometry`, `cq_control_round_trip_many`, `cq_control_encoder_refuses_what_the_decoder_refuses`, `cq_overview2_round_trip_and_v1_prefix`, `cq_standings_offsets`, `cq_json_round_trip`) |
| Gate CQ1: `(cd frontier-node && cargo fmt --all -- --check)` | exit 0 |
| Gate CQ1: `(cd frontier-node && cargo clippy --locked --workspace --all-targets -- -D warnings)` | exit 0 |
| Gate CQ1: `(cd frontier-node && cargo test --locked --workspace)` | **exit 101, not green.** The first run stopped at the one failure below; a re-run with `--no-fail-fast` gave **432 passed, 1 failed, 11 ignored**. The failure is `herald` `tests/fold.rs::checkpoints_save_in_the_background` (asserts 24 ingest steps finish in < 1.4 s wall clock; measured 1.42–2.15 s). It is **pre-existing and depends on machine load, not this unit**: the load average was 28–106 (the parallel CQ1 units' builds and the local model spike). Back to back in the same minutes, the `fold` binary at **base `39ff369`** (a temporary detached worktree, since removed) **failed 7 of 7** runs, and this branch failed 7 of 7 too, at the same timings (1.51–2.15 s). The test passes alone (3 / 3) and with `--test-threads=1` (2 / 2). `tests/fold.rs` does not use `cqfmt` |
| Gate CQ1: `cargo fmt --all -- --check` (root) | exit 0 (no root-workspace file changed) |
| Gate CQ1: `(cd permutation-gateway && npm test)` | **546 / 546 pass**, exit 0 (includes `web-frontier-cq-formats` 10/10, `web-frontier-herald`, `web-frontier-errors`) |
| Gate CQ1 / preamble: `scripts/cq-ownership-check.sh $(git for-each-ref --format='%(refname:short)' 'refs/heads/frontier/cq-1*')` | PASS (cq-1a, cq-1b, cq-1c: 0 own commits at the time of the run; cq-1d: OK) |
| `scripts/cq-ownership-check.sh --self-test` | PASS (14 / 14) |
| Preamble: `git diff --quiet 39ff369 -- permutation-server/web/session.mjs permutation-chain/src` | exit 0 |

**Not run, and why:**

- `npm ci --ignore-scripts`: it reinstalls `node_modules`, and installs are not approved. As in the M1 close (U4), `permutation-gateway/node_modules` is an APFS clone (`cp -cR`) of `m1-integ`'s copy, whose `package-lock.json` is byte-identical to this branch's; it is git-ignored and not committed.
- `scripts/cq-regen.sh --check`: the integrator's script, not on this branch. This unit changes no generated output (`abi.mjs`, the SDK, vectors under `frontier-abi/`, the WASM are untouched).
- Gate CQ1's rules, ABI, simulator, doctrine, criterion and `mapmove` lines: other units' files (CQ1-A, CQ1-B, CQ1-C). Nothing here changes `permutation-rules`, `frontier-abi` or `frontier-sim`.

**For the integrator:** run the workspace line on a quiet machine, or with `-- --test-threads=1` for `herald --test fold`. The 1.4-s wall-clock bound in `checkpoints_save_in_the_background` (M1 integ-W6t) does not hold at a load average above about 20; the test belongs to the M1 herald, so this unit leaves it unchanged (request D-6).

## 6. Deviations

1. **`frontier-node/crates/herald/src/lib.rs` changed** (not in CQ1-D's list): three lines, `// MC hook: …` / `pub mod cqfmt;` / `// MC hook end`, without which `cqfmt.rs` does not compile. §4.5 allows MC `mod` lines in `lib.rs` inside an MC hook block, and the ownership check passes it. Listed as request D-1.
2. **The test-side JS encoders live in `web-frontier-cq-formats.test.mjs`**, not in `permutation-gateway/test/fixtures/frontier/cq/formats/` (owned by this unit): `web-frontier-herald.test.mjs` asserts the exact entry list of `test/fixtures/frontier/` (everything except `make-fixtures.mjs` and `recorded`), so any `cq/` directory there fails it. Request D-2.
3. **Refusals in the new `herald.mjs` section go through `check(false, code, …)`**, like the v1 decoders, not `throw new HeraldError('Code', …)`: `web-frontier-errors.test.mjs` scans the latter form for page codes and wants JA/EN texts in `fi18n.mjs`, which is CQ3-D's file. No page module calls the new decoders yet, so no new code can reach a player in wave 1. Request D-3.
4. **The ownership check's fork point** comes from the branch's reflog first (§4 above) and the **footprint** extends §4.5's list; both are stricter than the written rule, never looser.
5. **`DESIGN.md`'s title now says revision 3.2**, with a status bullet pointing to §24; no other section of DESIGN was edited.

## 7. Dependency and integration requests

| # | Request | To |
|---|---|---|
| D-1 | Accept the `lib.rs` MC hook (`pub mod cqfmt;`) as part of this unit's merge | integrator |
| D-2 | Before CQ3-D creates `permutation-gateway/test/fixtures/frontier/cq/`, let `web-frontier-herald.test.mjs`'s fixture-set check skip `cq` (one filter term), or assign that edit to CQ3-D; CQ3-D may then move the encoders out of the test file | integrator / CQ3-D |
| D-3 | CQ3-D: JA/EN texts in `fi18n.mjs` / `en-frontier.mjs` for `BadMagic`, `BadLength`, `BadReserved`, `BadShape`, `BadValue`, `BadOrder`, `NotCumulative`, `TooMany`, `BadJson`, `BadSchema` before any page module calls the MC decoders; consider extending the page-code scan to `check(…, 'Code'` | CQ3-D |
| D-4 | Amend §4.5 to name the block end marker `// MC hook end` (the script's pin) so CQ2-E writes its `fold.rs` and `server.rs` hooks that way | integrator (contract amendment) |
| D-5 | Amend §8.4 with CF-1…CF-8 (CF-5 fixes an arithmetic slip); decide who extends `cqfmt.rs` in Wave 2 for the JSON files §8.4 does not pin (`standings/latest.json`, `players.json`, `call/{day}.json`, `final.json`, `siege/…`, `keep/…`): CQ2-E "uses" `cqfmt.rs` but does not own it | integrator (contract amendment) |
| D-6 | `herald/tests/fold.rs::checkpoints_save_in_the_background` fails under load at `39ff369` too (§5): run Gate CQ1's frontier-node line on a quiet machine, or relax its wall-clock bound in an integration-window commit (the test is no unit's in wave 1) | integrator |
| — | No manifest, lockfile, `package.json`, toolchain or `.gitignore` change is needed | — |

## 8. Links

- Contract: `docs/frontier/conquest/CONQUEST-CONTRACT.md` (§4.5, §8.4, §11 CQ1-D, §12 Gate CQ1)
- Code: `frontier-node/crates/herald/src/cqfmt.rs`, `permutation-server/web/frontier/herald.mjs` (section "MC formats"), `scripts/cq-ownership-check.sh`
- Vectors: `frontier-node/fixtures/cq/formats/vectors.json`
- Tests: `permutation-gateway/test/web-frontier-cq-formats.test.mjs`; `cargo test -p herald --lib cq_`
- Docs: `docs/frontier/DECISIONS.md` part CQ, `docs/frontier/DESIGN.md` §24, `docs/frontier/README.md`

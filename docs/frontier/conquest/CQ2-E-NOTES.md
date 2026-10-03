# CQ2-E herald-cq: notes

Unit CQ2-E of Wave 2 of the conquest milestone MC (`CONQUEST-CONTRACT.md` v1.3 §11 Wave 2, §8.4, §6, §12 Gate CQ2). Branch `frontier/cq-2e-herald`, worktree `.claude/worktrees/cq-2e-herald`, cut from `frontier/cq-integ` at **`3751173`** (the Wave-2 base, Gate CQ1 green). CQ0 = `39ff369`. Local commits only; nothing pushed; no chain transaction; no download or install; no paid API. The one service started was `frontier-herald --fixture conquest` on `127.0.0.1:41420` for about a minute (inside 41400–41599), stopped afterwards; every test binds `127.0.0.1:0`.

OD-1…OD-16 are working defaults the owner may revise (1–12 yes, 13–15 no, 16 stop and ask), as recorded in DECISIONS part CQ; nothing here changes or depends on a different reading of them.

## 1. What landed

| Brief item (§11 CQ2-E) | Where | State |
|---|---|---|
| Fold of kinds 80–89 | `herald/src/conquest.rs` (`on_record`), from one `// MC hook` in `fold.rs`'s record loop | done: v2 decoder, `/h/events` numbering, WS `event`, sieges, keeps, folds, tallies, the day's events, alerts |
| Per-province conquest state with `conquest_model`; per-bell siege and keep progress; the CONQUEST records digest checked (`conquest_mismatch`) | `conquest.rs` (`after_records`) | done: a single-bell resolve uses the post-state; a SkipQuiet run is **replayed bell by bell** with `report_quiet → settle_bell → step → finish_bell`; each logged CONQUEST record's digest and keep fields are compared with the herald's bytes of that bell; a bell that had to log CONQUEST and did not is `conquest_missing`; a replay whose end differs from the post-state's conquest block is `conquest_mismatch` |
| Completeness rule (M1's overview rule over every opened province) | `conquest.rs` (`complete`) | done: bell b's `PSFCT1`, `/h/sieges/{b}.json`, the WS `control` and `siege` deltas once every opened province resolved or skipped through b |
| Files and routes of §8.4 | `conquest.rs`, `control.rs`, `standings.rs`, `cqroutes.rs` (mounted by one `server.rs` hook) | done: `/h/control/{bell,latest}.bin`, `/h/overview2/{ring}/{bell,latest}.bin`, `/h/sieges/{bell,latest}.json`, `/h/siege/{P},{Q},{site}/{declared}.json`, `/h/keep/{P},{Q}.json`, `/h/conquest/{day}.json`, `/h/standings/{series.bin,latest.json,players.json}`, `/h/call/{day}.json`, `/h/season/final.json`, plus `/h/status/conquest` (alarms); `/h/me` adds `alerts[]`, `sieges[]` and `player` (the caller's `players.json` row, §8.4's "caller's row via `/h/me`"; MC seasons only) |
| WS additions | `ws.rs` | done: `{op:"sub", control, sieges, standings}`; messages `control` (CF-6 delta or empty = resync hint naming the file), `siege` (JSON delta), `standings` (`latest.json`), `alert` (wallet scope). An M1 client's ack is byte-identical |
| Standings, Call, final.json | `standings.rs`, `conquest.rs` | done (§3 below for the rules the contract leaves open) |
| `--fixture conquest` (synthetic now) | `cqfixture.rs`, `main.rs` | done: `frontier-herald --fixture conquest --data DIR [--listen 127.0.0.1:41900]` folds and serves a synthetic `MC_TEST` mini-season |
| v1/v2 dispatch | throughout | done: an M1 season never turns the conquest fold on (no v2 record, no v2 Province, `program_version` 1); M1 outputs proven byte-identical (§4) |
| Determinism and completeness tests (`cq_*`) | `herald/tests/cq_fold.rs`, `herald/tests/cq_server.rs`, unit tests | done (§4) |
| A-4: the JSON shapes §8.4 does not pin, additions to `cqfmt.rs` with vectors | `cqfmt.rs` (appended section "CQ2-E additions"; the pinned part is byte-for-byte unchanged, `git diff` is additions only), vectors `herald/vectors/cq-json/` | done: `StandingsLatest`, `PlayersFile`, `CallFile`, `FinalFile`, `SiegeHistory`, `KeepHistory`, `SiegeDelta`; 7 valid and 14 invalid vectors, `cq_json_vectors_fresh` (one producer, one freshness test, every invalid file refused with its code) |

Also in owned paths, needed by the above:

- `checkpoint.rs`, `runner.rs`: the conquest state is checkpointed as an optional section (`"PSFHCQ1\0"` · len · JSON) before the hash; an M1 checkpoint has no section, so its bytes are unchanged (`round_trips_and_refuses_damage` extended).
- `clash.rs`: a Province v2's clash report is recomputed with `frontier_abi::clash_model::build_v2` (keep and Free City garrisons), so an MC CLASH report is not a false `MISMATCH`.
- `records.rs`: `/h/events` decodes MC records.
- `findex/src/index.rs`: records are decoded with `frontier_abi::v2::log` (M1 kinds read exactly as before), so `/h/events` numbers an MC season's records as the fold does (asserted in `cq_fold_restarts_from_checkpoints`).

## 2. Shared files: the hooks

`fold.rs`, `lib.rs` and `server.rs` change only inside `// MC hook` … `// MC hook end` blocks (markers alone on their lines). `scripts/cq-ownership-check.sh frontier/cq-2e-herald`: **PASS** (one report-only footprint warning: `views.rs` is a path `ui-shell` touched since `39ff369`; those `ui-shell` changes are already in the base, `git diff 3751173 frontier/ui-shell -- …/views.rs` is empty, and this unit's change is one appended block at the end of `me_json`).

| File | Hook blocks |
|---|---|
| `lib.rs` | the existing CQ1-D block gains `conquest`, `control`, `cqfixture`, `cqroutes`, `standings` |
| `server.rs` | one: `.merge(crate::cqroutes::mount())` |
| `fold.rs` | five: the `cq` field, its initialiser, the record dispatch (`on_record`), the per-bell views (`after_records`, before the per-bell closing) and the completeness hook (`complete`) — deviation D-1 |

## 3. Rules this unit had to pin (for the integrator: amend §8.4 or overrule)

Each is stated in the module docs (`conquest.rs`, `control.rs`, `standings.rs`, `cqfmt.rs`'s CQ2-E section).

| # | Where §8.4 / §3.10 left a choice | Pinned |
|---|---|---|
| CF-9 | Herald's Call's "day seed" (undefined; `control::herald_call` takes one) | `sha256("PSF-HERALD-CALL-DAY" ‖ Season.genesis_seed ‖ day u32 LE)` (`cqfmt::call_day_seed`). The Call of day d is computed over the control map of bell `144·d` (`/h/call/{d}.json` names the bell) with `recently_lost` = factions whose banner a March showed within the last 288 bells and does not show now |
| CF-10 | `PSFCT1` details the format leaves to the writer | `points_lead` = the side with the unique largest control weight at the bell (`conquest_model::control_weights`), 7 on a tie or no weight; `points_share` = its weight × 255 / total. `CONSOLIDATING` while `b + 1 < consolidated_until_bell`. `HEARTLAND` = the keep's `heartland_safe`. `CHANGED` = control differs from the previous bell's file. March `points_lead` = the controller of the March's last MARCH_FOLD folded so far; `DOMINION_CHANGED` on the first file after a fold changed it; `CALL_TARGET` = a Call March of the bell's day |
| CF-11 | `/h/sieges` `status` / `pauseReason` / `etaBell` | paused when the progress did not move since the previous bell (after the declaring bell): `vigil` when `bell_start(b)` is inside the snapshotted vigil, else `defender`; `etaBell = max(declared + 1, siege::earliest_completion_bell(required − progress, vigil, b + 1, genesis))`; a keep contest's `etaBell = b + required − progress`, `since = contest_from_bell` |
| CF-12 | when a day file is complete | `/h/conquest/{d}.json` is written (immutable) once the control is complete through `144(d+1) − 1 + 36` (36 bells of grace for MARCH_FOLD lag, R-23), or at the season's end; until then it is served live (`max-age=5`). A record for an already-written day rewrites it and counts `lateEvents` (0 in every test) |
| CF-13 | derived events | `province_control`: a control change between two factions, named by that province-bell's CONQUEST record (`seq`, `sig`); `march_banner`: any banner code change, named by a member's CONQUEST record of the bell (else its last CONQUEST/KEEP record); `march_points_lead`: a MARCH_FOLD whose controller differs from the March's previous one (the record's header bell gives the day) |
| CF-14 | standings rows (`PSFSD1`) | hour h's map figures come from the control file of `min(6h + 5, end_bell − 1)`; the row is written when every March with an opened member (`first ≤ 6h`) has a MARCH_FOLD for h, or 72 control bells later, or at the season's end. Cumulative fields count events of bells ≤ that bell and folds of hours ≤ h known then (never below the previous row). Definitions: `sieges_won` = completed (occupied or capture due) as the attacker; `sieges_lost` = completed against the faction's holding; `liberations` = LIBERATED events on the faction's holdings; `captures` = credited CAPTURE_DUE; `members_active` = Σ JoinShard `final_holdings`, as of the transaction that completes the row |
| CF-15 | `latest.json` | `dominion = dominion_bells + dominion_per_capture × captures`; `index` = `per_capita_ratio(dominion, members_active, Σ, Σ)` clamped to [0.5, 2] × `herding(members, Σ members)` (`index::IndexParams::REV2`, γ = 0.6), × 10⁶; `official: false` |
| CF-16 | players (R-10) | keeps taken = the citizens with a non-civilian host of the taking faction on the keep tile after the taking bell, plus the donor; **keep-bells** = bells a citizen's host of the counting contender stood on the keep tile (§3.2's "a keep its faction held while a contender counted" cannot happen with a defender present, so this reads "held" as holding the hex); sieges won and captures = the declarer's; liberations = the owner faction's hosts on the hex at a LIBERATED with Respite. Titles in `final.json`: Breaker of Keeps (most keeps taken), Warden of the Marches (most keep-bells) |
| CF-17 | `final.json` | written once EndSeason has landed (Season status Ended or Closed), the control is complete through `end_bell − 1` and every standings hour is written; `movement` = §13.4's figures over the control files (10a by day; 10b; 10c over P; 10d with the denominator "Marches that ever showed a faction banner"; 10e′ over P′ from `max(open, 287)`, 10e over P₂; 10f; 10g; 10h from the events; 10i = captures of an order-1 target). Ratios are counts plus basis points (no floats). CQ3-B's decider gates; this file reports |
| CF-18 | siege and keep histories | `/h/siege/…json` is served live from the fold until the season ends, then written immutable (the records that follow a siege — SIEGE_SETTLED, CAPTURE_SETTLED, liberation — can land long after its end); a siege still active at the end is `lapsed`. `/h/keep/{P},{Q}.json` is rewritten on change (`max-age=5`); a contest running at the end is `stopped` |
| CF-19 | WS | `control`: key `/h/control/{b}.bin`, bytes the CF-6 delta (none when only flags of the March section changed; empty bytes = resync hint); `siege`: `cqfmt::SiegeDelta` JSON (`upsert`, `remove`, `keeps`, `keepsRemove`); `standings`: `latest.json`'s bytes; `alert`: `{v, kind: horn \| keep_contest \| occupied \| captured \| liberated, bell, p, q, site, faction, seq, sig}` to the owner's wallet (the last 32 kept for `/h/me`) |

## 4. Tests and gate lines run

All on this branch with `CARGO_BUILD_JOBS=6`, `--offline --locked`.

| Command | Result |
|---|---|
| `(cd frontier-node && cargo test --locked -p herald --lib cq_)` | 17 passed: the 10 `cqfmt::tests::cq_*` already on the base (unchanged, incl. `cq_formats_vectors_fresh`: CQ1-D's vectors byte-identical) and this unit's 7 (`cq_json_round_trips`, `cq_players_ranked_cut_at_100`, `cq_siege_delta`, `cq_json_vectors_fresh`, `cq_points_lead_is_a_unique_maximum`, `cq_unopened_records_pass_the_format_checks`, `cq_empty_state_round_trips`) |
| `cargo test --locked -p herald --test cq_fold` | 8 passed: `cq_fold_writes_every_file_and_event` (a control and sieges file for each of the 288 bells; every `PSFOV1` has its `PSFOV2` with the v1 record as prefix; both day files and Calls; the event kinds siege_declared, siege_failed, occupied, liberated, capture_due, captured, keep_contest, keep_broken, keep_taken, province_control, march_banner, march_points_lead, free_city, outpost, retired; contests, taken/broken flags, a banner change and a vigil pause in the files; 48 standings rows; `final.json`; a credited capture and an uncredited recapture; zero alarms, zero immutable rewrites), `cq_fold_is_deterministic`, `cq_fold_restarts_from_checkpoints` (batches through findex, a checkpoint at ⅓, a crash at ⅔: byte-identical tree; `/h/events` numbering = the fold's), `cq_tampered_conquest_digest_raises_the_alarm`, `cq_tampered_keep_fields_raise_the_alarm`, `cq_skip_replay_checks_the_post_state`, `cq_m1_season_is_untouched`, `cq_me_alerts` |
| `cargo test --locked -p herald --test cq_server` | 1 passed: `cq_routes_and_ws_messages` (every new path with its cache header and security headers, decoded with `cqfmt`; `/h/me` alerts; `/h/events` decodes CONQUEST, SIEGE_DECLARED, MARCH_FOLD, CAPTURE_SETTLED, KEEP, NEUTRAL; a WS socket subscribed to control, sieges, standings and its wallet receives control deltas, siege deltas, standings and alerts with no sequence gap and nothing else) |
| `cargo test --locked -p herald` (whole crate, M1 tests included) | all green: lib 31, cq_fold 8, cq_server 1, fold 11, server 5, real_chain 1, viewers 3, load 1 (+ ignored as before) |
| `cargo test --locked -p findex` | 12 passed |
| `cargo clippy --locked -p herald -p findex --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all -- --check` (frontier-node) | exit 0 |
| **M1 byte-identity** (scratch test, not committed: the M1 fixture `mini_season(24)` folded by `3751173` and by this branch) | identical: 424 files (sha256 of the tree `60620951…fd9d`), 1,050 WS diffs (`12af7363…c7f9`), the checkpoint bytes (`5ad84e14…e073`), `/h/me` (`0cd4d4e5…2481`) |
| `scripts/cq-ownership-check.sh frontier/cq-2e-herald` | PASS (1 report-only footprint warning, §2) |
| `frontier-herald --fixture conquest --data … --listen 127.0.0.1:41420` | served; `/h/status/conquest` all alarms 0, `controlNext` 288, `final` true; stopped |

Gate CQ2 lines for this unit's files — see §6 for the full-workspace runs and their results.

**Measurements (the synthetic fixture, 7 Provinces × 288 bells):** 443 transactions with 669 PS2 records; `cq_fold_writes_every_file_and_event` (one pass plus every check) runs in ≈ 1.8 s in a debug build; the output is 288 control files of 572 B (rings 0..=4), 864 `PSFOV2` beside 864 `PSFOV1`, 288 sieges files, 2 day files, 2 Calls, 48 standings rows, 4 siege and 7 keep histories, `final.json`; the herald checkpoint at the season's end is 109,341 B with the conquest section. Not a stack measurement: the exit-scale herald load (criterion 6 with the `control` subscription) is CQ3/CQ4's.

## 5. Deviations

1. **D-1 Five hook blocks in `fold.rs`**, where §4.5 names "one `conquest::on_record(…)` dispatch and one completeness hook": the conquest state needs a field and its initialiser, and the per-bell views need the `before` bytes and the `resolved` list, which exist only inside `apply` before the closing loop consumes them. Every line is inside a marked block; the ownership check passes.
2. **D-2 `frontier-abi` read directly.** The herald reads Province v2, Season v2, MarchState and the v2 log through `frontier_abi::v2` and `conquest_model` (no offset of its own), not through `fclient`'s v2 decoders, which are CQ2-D's concurrent work. When they land, the herald can switch without a format change.
3. **D-3 "Replays … over the clash it already recomputes."** For a ResolveFromInputs (one bell) the post-state is exact and is used as is; only SkipQuiet runs are replayed (with the quiet model, which the program's skip uses). The conquest fold does not re-run the kernel clash. A resolve's siege series flags `holds` / `defender` are read with `report_quiet` over the post-state (the hex's survivors), a display approximation; in a replay they are the bell's report.
4. **D-4 Vectors of the A-4 shapes live in `frontier-node/crates/herald/vectors/cq-json/`**, not `fixtures/cq/formats/` (frozen in Wave 2, and its JS test enumerates the formats it knows). JS decoders for these shapes are CQ3-D's.
5. **D-5 The fixture is synthetic** (§8.4 says "a synthetic fixture now; the recorded one from CQ3-E"): the conquest step and folds are the shared models, but DeclareSiege, SettleSiege, SettleCapture, the outpost's SettleTicket, arrivals and departures are scripted byte edits with their records; no CLASH, seed or anchor records; entity chains are advanced only for the Province (and MarchState). Its `capture_credit_min_bells` is 144 (MC_TEST has 36) so an uncredited recapture can happen inside a two-day season.
6. **D-6 `views.rs`** (CQ2-E's path, in the design chat's report-only footprint): one appended block; no conflict with `ui-shell` today (§2).
7. **D-7 `/h/status/conquest`** carries the conquest alarms; `/h/status` (in `server.rs`, outside a hook) is unchanged.

## 6. Full-workspace gate lines

| Gate line | Command run (exactly) | Result |
|---|---|---|
| Gate CQ2: frontier-node `cq_` | `(cd frontier-node && cargo test --locked --offline --release --workspace -- cq_)` | **exit 0**: herald lib 17, `cq_fold` 8, `cq_server` 1; `frontier-agents` `profile_equality` 8 (the base's); every other binary 0 matched |
| Gate CQ1 (carried into CQ2): frontier-node | `(cd frontier-node && cargo fmt --all -- --check && cargo clippy --locked --offline --workspace --all-targets -- -D warnings && cargo test --locked --offline --workspace --no-fail-fast)` | **exit 0**: fmt clean, clippy clean, **459 passed, 0 failed, 11 ignored** across 54 test binaries (the M1 herald tests included; `checkpoints_save_in_the_background` passed in this run) |
| preamble: ownership | `scripts/cq-ownership-check.sh frontier/cq-2e-herald` | PASS (1 report-only footprint warning, §2) |
| preamble: MC never touches `session.mjs` / `permutation-chain/src` | `git diff --quiet "$(git merge-base HEAD codex/frontier)" -- permutation-server/web/session.mjs permutation-chain/src` | exit 0 |
| preamble: generated outputs | `scripts/cq-regen.sh --v1-unchanged "$(git merge-base HEAD codex/frontier)"` | lists only the v1 WASM artefact and its `.sha256` (the base's A-13 exception); this unit changes none of `frontier-abi`, `permutation-rules`, `permutation-server`, `permutation-gateway`, `frontier-wasm` or `scripts` (`git diff --stat 3751173 -- …` empty). `scripts/cq-regen.sh --check` was **not run** (node, the WASM build and the SDK sync are the integrator's; no source of theirs changed here) |

**Not run, and why:** Gate CQ2's program lines (`permutation-frontier` clippy and tests, `build-frontier.sh --twice`, the svm-tests `g01_cq_…p_cq_` rows, `PSF_TRACE=1`) and Gate CQ1's `permutation-rules`, `frontier-abi`, `permutation-chain`, `frontier-sim` and `npm` lines: none concerns a file of this unit (they are CQ2-A/B/C's and the base's; this branch does not change them). The herald's tests over the **program's** output (a recorded mini-season, `inproc_cq_day`, G14-CQ) are Gate CQ3's (CQ3-E).

## 7. Dependency and integration requests

| # | Request | To |
|---|---|---|
| — | No manifest, lockfile, `package.json`, toolchain or `.gitignore` change (the herald already depends on `frontier-abi` and `permutation-rules`) | — |
| R-1 | Amend §8.4 with CF-9…CF-19 (or overrule before CQ3-A codes V21 against them) | integrator |
| R-2 | CQ2-C/CQ2-B: the herald assumes SIEGE_DECLARED's `owner_tag` is the target Holding's owner tag (0 for a Free City), MARCH_FOLD's header bell is the bell of the fold transaction, and SkipQuiet logs one CONQUEST per skipped bell whose step `emits()`, in bell order, in the skip's transaction | CQ2-B, CQ2-C |
| R-3 | CQ3-D: JS decoders for the A-4 shapes (`cqfmt` CQ2-E section, vectors in `herald/vectors/cq-json/`) and the WS `siege` / `standings` / `alert` bodies | CQ3-D |
| R-4 | CQ3-A (V21): recompute `sieges/{bell}.json` (CF-11), `call/{day}.json` (CF-9), `PSFSD1` and `players.json` (CF-14, CF-16) by the rules above | CQ3-A |
| R-5 | CQ3-E: the recorded `MC_TEST` mini-season replaces `cqfixture::mini_season` behind `--fixture conquest` (the herald side is ready: `cq_fold`'s assertions are the checklist) | CQ3-E |
| R-6 | CQ2-D: once `fclient` reads v2, the herald may move its reads there (D-2) | CQ2-D (later) |
| R-7 | Add `cq_json_vectors_fresh` (`FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_json_vectors_fresh`) to `scripts/cq-regen.sh` beside step 4 (`scripts/` is not this unit's) | integrator |

## 8. Links

- Code: `frontier-node/crates/herald/src/{conquest,control,standings,cqroutes,cqfixture}.rs`; the CQ2-E section of `cqfmt.rs`; hooks in `fold.rs`, `lib.rs`, `server.rs`; `ws.rs`, `views.rs`, `checkpoint.rs`, `runner.rs`, `clash.rs`, `records.rs`, `main.rs`; `frontier-node/crates/findex/src/index.rs`
- Tests: `frontier-node/crates/herald/tests/{cq_fold,cq_server}.rs`; vectors `frontier-node/crates/herald/vectors/cq-json/`
- Contract: `docs/frontier/conquest/CONQUEST-CONTRACT.md` §4.5, §6, §8.4, §11 (CQ2-E), §12 (Gate CQ2), §18 A-3/A-4

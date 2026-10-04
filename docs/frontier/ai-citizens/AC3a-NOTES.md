# AC3a notes: brain core (Rust)

Unit AC3a of wave A, AI-CITIZENS-CONTRACT v1.2 (`73408a5`). Branch `frontier/ai-ac3a`, local commits only. Everything below was run on the local test chain fixtures and recorded files; no stack, no llama-server, no Gemma, no devnet or mainnet, no paid API was used. Nothing here says the model "wants" or "intends" anything: the brain offers code-made candidates and executes what a validated answer chose.

## 1. What was built

| Path | What |
|---|---|
| `frontier-node/crates/bots/src/ai/mod.rs` | hook state (`AiHook`, `BotAi`, `DayState`, `Timeline`), `install`, `mark_bots`, `setup` and `AiOpts` for `main.rs`, `write_stats`, and the **AC3b seams** `follow_offer`, `follow_intents`, `follow_wake`, `follow_next_wake` (all no-ops here) |
| `.../ai/brain.rs` | candidate generator (§4.3: autopilot, hold, camp march, open-field-stack march, build, walls, train, muster, explore), situation (§4.2), the **autopilot filter** and the **quota floor** (§3.6, §3.4), **V6** (`replan`, §4.5), the day caps V3(a)-(d), the step (§3.1), `obs_digest`, the marchbook, the late rule |
| `.../ai/mindport.rs` | wire types of `/v1/decide` and `/v1/outcome`, tokio `TcpStream` HTTP client with `Authorization` and a per-call timeout (no new crate; chunked bodies handled; loopback only) |
| `.../ai/standing.rs` | standing orders (`reserved`, `declined_calls`, `caps`), expiry, the follow filter |
| `.../ai/ready.rs` | private copy of `ready_host` and `can_depart` (+ `departable_from`, `why_not`) |
| `.../ai/meview.rs` | own hosts, transits and seals from `/h/me`; `opened_of` (null until the arrival bell has ended **and** the destination is public) |
| `.../ai/aislots.rs` | `ai-slots.json` parser, the AI roster (AI = `Skilled`, seat = `Idle`), `--export-seat-key` writer (0600, refused under `pub`/`state`) |
| `.../ai/raid.rs`, `.../ai/recall.rs` | **empty `offer` stubs** (they return nothing). `brain.rs` calls them so it compiles; **AC3b replaces both files** |
| `.../bots/src/{bot,fleet,main,lib}.rs` | the four hook files, `// AI hook` blocks only, **pure additions** (110 added lines in all, largest block 20 lines): `Shared.ai` and `Shared.outcome_sink`, the sink call in `Shared::record`, `Bot.ai` and two accessors (`ai_quota_left`, `ai_spent_reset`), the step hook after `policy::decide`, eager cadence for AI bots (2 lines), the follow-wake seam calls (2 lines), the flags `--brain --brain-token-file --ai-slots --follow-council --export-seat-key`, `ai::setup`, `ai::mark_bots`, `ai::write_stats`, `pub mod ai;`, one small parse test |
| `frontier-node/crates/bots/Cargo.toml` (+ one `Cargo.lock` line) | `sha2.workspace = true` inside an `# AI hook` block (see section 6) |
| `frontier-node/crates/bots/tests/ai_*.rs` | 11 files, section 3 |
| `permutation-gateway/test/fixtures/ai-decide-v1.json` | **the golden wire fixture** (§4.1), committed first (commit `55644a9`); producer `bots/tests/ai_wire.rs` |
| `permutation-gateway/test/fixtures/ai-brain-real/` | files recorded from a real (paused) herald, section 4 |

## 2. Wire facts AC1a must know (pinned by the fixture)

The contract's examples are illustrative where they differ; the fixture wins for Node.

- **u64 ids are decimal strings**: `host_id` everywhere (a real host id is `(province_index << 44) | …`, above 2^53; the herald serves them as strings). The contract example shows `1234`.
- `ai.tag` = the Citizen's `citizen_tag` as 16 lowercase hex digits of the **u64** (`format!("{:016x}")`, the web's `tagKey`), not the byte string of the address.
- Candidate `kind` is the table entry verbatim: `autopilot`, `hold`, `march`, `recall:<handle>`, `build:<item>`, `walls`, `train:<unit>`, `muster:<unit>`, `explore:<handle>`. March candidates carry `facts.target_kind` (`camp`, `field`; AC3b adds `raid`, `call`) and `facts.target = {p,q,tile}`. `flags` is always an object (`{council:true}` or `{}`); `troops` only on marches. Item names are resource names (`build:food`, `build:wood`, `build:stone`, `build:ore`, `build:gold`, `build:science`) because the kernel names no buildings; units are lowercase kernel names (`spearman`).
- **Troops on the wire are whole troops.** The chain stores `Entry.troops`, a site mirror's `garrison` and `Transit.dep_mass` as milli-troops (the recorded herald serves a 100-troop host as `100000`); a Holding's `reserve` and a camp's `troops` are whole. The brain divides the milli quantities by 1000. `home_troops` = combat hosts at home + combat reserve + garrison.
- `situation.secs_left` = game seconds to the season end; `home.shield_until_bell` is 0 once the shield is over; `home.tier` is a name (`hamlet`…); `quota.bucket_left` = `bucket_milli/1000` as last settled; `my_clashes` is **always `[]`** (the files `observe` reads carry no loss figures; the mind adds clash facts from its feed). Hosts list the own armies in view **and in transit** (a transit host has only its origin and `arrive_bell`).
- The autopilot candidate's facts show `quota_left` and `economy_held_by_quota` (the floor, §3.4).
- `scale` is an integer when whole, else 3 decimals; `deadline_unix_ms` = now + (the bell's end − `margin`) with `margin = max(3 s real, 60 game-s ÷ scale)`.
- `obs_digest` = sha256 of the sorted `"<path> <sha256>\n"` lines of the files **the brain itself read** for this decision: `/h/me/<wallet>` and every `/h/province/<p>,<q>/latest` of the observation (`Bot::observe` keeps no per-bot raw bytes and the herald is shared, so files are re-read). A file that changed between the two reads digests differently from what `observe` saw.
- The answer schema is as §8.1; the brain also reads `caps` and `standing`. The outcome body carries the step's duties and chosen actions (`intent`, `sig`, `status`, `code`) and `own_marches`.
- Golden fixture keys: `request`, `answer`, `answer_autopilot`, `outcome`, `outcome_answer`, `candidate_samples_ac3b` (hand-written candidates in the §4.3 shape for the kinds AC3b adds: a flagged Strike-Order march, a recall, a raid). The request is what the real brain posts when it steps the agents fixture wallet; `deadline_unix_ms` is pinned and the relay signature is a fixed string.

## 3. What was run, with real results

Environment: `CARGO_TARGET_DIR=…/scratchpad/frontier/ai-build/target-ac3a`, `nice -n 5`, `-j 6`, toolchain 1.95.0. Mac load (`uptime`) at the runs: 2.1 to 4.2 (load averages 1 min), shared with the paused m1-exit stack.

| Command | Result |
|---|---|
| `AI_WRITE_VECTORS=1 cargo test -p bots --locked --test ai_wire` then without the flag | ok, fixture written, then fresh |
| `cargo test -p bots --locked` (final run, section 3.1) | all pass |
| `cargo test -p bots -p agents --locked` | all pass |
| `cargo test -p stack --locked` | 70 passed |
| `cargo test -p itest --locked -- --skip inproc_day --skip g14` | pass (inproc_smoke 1, native_rerun 5, relay_standin 1, lib 6); **`inproc_day` and `g14` were skipped, not run** (known open on `30ba411`, DECISIONS U3) |
| `cargo test -p stack -p itest --no-run --locked` | builds |
| `cargo fmt -p bots` then `cargo fmt -p bots -- --check` | clean (rustfmt works here; the unit text said it might not) |
| `cargo clippy -p bots --locked -- -D warnings` and `cargo clippy -p bots --tests --locked -- -D warnings` | clean (clippy works here) |
| `git diff 73408a5 -U0 -- bot.rs fleet.rs main.rs lib.rs` | additions only, every block inside `// AI hook` … `// AI hook end` markers, largest block 20 lines |

Not run: `inproc_day`, `g14`, the JS suites (`npm test`, `node --test test/citizens-*.test.mjs`: no shared JS path was touched, only the new fixtures under `permutation-gateway/test/fixtures/ai-*` were added, and no `citizens-*` test exists on this branch).

### 3.1 The tests of this unit (all in `frontier-node/crates/bots/tests/`)

- `ai_wire.rs` (1): the golden fixture is fresh.
- `ai_brain.rs` (20): candidates are deterministic, ordered and capped at 12; march facts and fixed reward text; day caps remove the march and `hold` says so; V3(a)-(d) exact; ids map to the intents they name; V6 drops (caps of the answer, one action per host, host gone, camp gone in the fresh files, queue slots and stores counted across one decision); a model answer is re-observed, sent, booked and reported; hold reserves; **a same-bell nudge repeat sends from the cached answer (no second mind call)**; five fallbacks (mind down, deadline, no time left, malformed answer, wrong token) run the filtered autopilot; `v6_all_refused` runs A'; **no hook means identical intents** (the rule path, with and without the hook installed); **the seat never calls the mind**; the quota floor (autopilot economy held at 16, model builds allowed down to the reserve 6, model Depart allowed); Harvest held at the floor; the eager 90-150 s cadence through `Fleet::step_due`; restart rebuilds the marchbook; the step-0 (d) timeline.
- `ai_brain_stale.rs` (3): a mind that answers 40 game-s late means two observations (counted by `/h/me` reads) and the plan is checked against the **second** observation (camp removed in it: dropped); an autopilot answer older than 30 game-s is re-observed, exactly 30 is not; a decision that lands after the bell is never executed.
- `ai_brain_tk1.rs` (1): **T-K1**, 1,000 requests plus their outcomes (the test asserts more than 1 MB scanned) for the secret keys (wallet, session, direct; hex, base64, base58, raw), the seed as little-endian bytes and every seal salt, plaintext and seal of the marchbook: none found; no request key named seed, salt, secret, private, journal, plain or seal; in-flight own marches are listed with `opened: null` and no destination. Limit: the fixture seed is 7, too short to search as a decimal. Runs in about 6 s (debug build, Mac load average about 2.1 to 2.6).
- `ai_brain_real.rs` (2): the brain on real recorded herald files (section 4).
- `ai_brain_step0.rs` (3): step 0 (a) and (e).
- `ai_meview.rs` (4): hosts and seals from a recorded real `/h/me`; transit rows from the shape of the herald's source (synthetic, labelled); `opened` rules; `opened` stays null through the arrival bell.
- `ai_ready_matches_policy.rs` (3): every host `decide` departs (5 archetypes x 160 bells) is ready by the copy; mutated stamina, pending order, ready bell, from bell and state are never departed; the 74-stamina boundary.
- `ai_slots_disjoint.rs` (5): wallets and sessions of slot indices >= 1000 never meet the script bots for the five stack configurations of §8.4 (the tomls are AC5's and are not in this branch: the contract values were used and the test reads them when they exist); strict slots parsing; the roster; the seat key file; CLI option checks (the mind's port must lie in 41901-41999).
- `ai_autopilot_no_voluntary_march.rs` (4): the kept and dropped lists cover every `Intent::name()` once; the filter drops every Depart `decide` makes (the rule policy departed in at least 20 of 160 decisions: the test bites); over 100 bells the rule bot departs at least 10 times while the AI brain (no mind, and a mind answering `autopilot`) sends **no** Depart; the Strike-Order follow filter (reserved host, declined period, expiry).
- `ai_common.rs`: helpers, no tests of its own.
- `main.rs` (`tests::ai_flags_parse`) and the unit tests inside `ai/*.rs` (url checks, chunked parsing, standing orders).

## 4. Real herald files

`permutation-gateway/test/fixtures/ai-brain-real/` holds the files `Bot::observe` reads for bots seed 1, wallets 153 and 202, **recorded from the paused m1-exit herald by read-only GET requests** (`127.0.0.1:41040`; the herald was not touched), read at game time = bell 997. It is a **final-state** herald (the season had ended), so it checks parsing, units and the candidate shape on real bytes, not a timeline. Facts it showed: host troops are milli-troops (100000 = 100 troops); camps have 100 to 400 whole troops; wallet 153's two hosts have stamina 58, below the Depart cost 74 (so "resting"); wallet 202 has one ready host of 200 and a scout.

## 5. Step 0 results

| Item | Result |
|---|---|
| (a) march onto the own holding tile | **Accepted: `recall` stays in the design.** `ai_brain_step0.rs`: for an own host standing in a neighbouring province, `plan_march` to the own holding tile gives a plan (12 hexes, 1,920 s, arrival bell 45 on the agents fixture), `shield_refuses` is false, the plaintext validates and the kernel's `travel::path_cost` and `check_arrival_bell` price it. The program's Reveal (`permutation-frontier/src/proc/reveal.rs`, "6. path": the `dest_site` block at line 860) only refuses another nation's shielded holding site; an own site is not `other`. A host standing on the holding tile has no path to it (start = goal, `walk` at line 479 needs a step), so a recall exists only for an arrived host away from home. Not run on a live chain. |
| (b) kept and dropped list | Pinned in `brain.rs` and tested. **Kept (duties, sent at once):** join, file_ticket, reveal, settle_transit, settle_explore, settle_own_ticket, nudge, harvest. **Kept (economy, held at quota <= 16):** build, train, muster, explore. **Dropped:** depart, redepart, prefund, hold, spam. The Strike-Order follow (AC3b) is the only Depart an autopilot sends. |
| (c) census on the smoke | **Not run** (needs a live stack and AC5's `census.mjs`). Command for the slice gate: `permutation-gateway/citizens/bin/ai-citizens-run.sh --stack permutation-gateway/citizens/stack/ai-smoke.toml --citizens-config permutation-gateway/citizens/config/smoke.json`; the run script starts the census from the first bell at which an AI has a final village (§9.5), output `AI_DIR/census/<bell>.json`. |
| (d) bells from the first final village to the first and second ready host | **Not run** (needs the smoke). The brain now **records it**: `ai-brain.json` beside the bots `--report` file holds `timeline[<index>] = {first_final_bell, first_ready_bell, second_ready_bell, first_model_march_bell}`. After the smoke: `jq .timeline <report dir>/ai-brain.json`; the answer is `first_ready_bell - first_final_bell` and `second_ready_bell - first_final_bell`. The AI fleet command (the run script builds it): `frontier-bots --herald http://127.0.0.1:41940 --relay http://127.0.0.1:41933 --rpc http://127.0.0.1:41910 --seed 41 --first-index 1000 --bots 7 --ai-slots $AI_DIR/ai-slots.json --brain http://127.0.0.1:41980 --brain-token-file $AI_DIR/state/mind.token --export-seat-key $AI_DIR/keys/seat.txt --journal <dir> --report <dir>/report.json --scale 10 --game-hours <8..16> --control 127.0.0.1:41971`. |
| (e) host-size distribution | **Derived from the policy constants and measured on fixtures and recorded files; not measured on a smoke.** Skilled: `want_hosts = 1 + floor(2q) = 2` (so at most 2 combat hosts), train `k = 1 + floor(4q) = 4` hundreds, muster takes the whole reserve in hundreds. Agents fixture world (reserve 300), 120 bells: muster sizes {300: 120}, train sizes {400: 120}. Recorded real files: wallet 153 two hosts of 100, reserve 200 (home 400, none ready); wallet 202 one host of 200 ready and a scout (home 200). **Real final-state population (read-only GET of the paused m1-exit herald, 169 provinces, 696 combat roster hosts of the script-bot population, not the AI autopilot):** min 13.6, p10 200, p25 200, median 300, p75 300, p90 400, max 1,774.6; buckets: <=100: 18, <=200: 178, <=300: 334, <=400: 133, <=600: 17, <=1000: 10, above: 6. |

**Consequence of V3(a) worth knowing (computed by `caps_violation` in the step-0 test):** `home_troops` includes the marching host itself, and the program starts a garrison at 0 (`citizen.rs`: "its garrison starts at 0"). Hosts 400+400 (home 800): either may march; 400+100 (home 500): only the 100 host may; a single host of 300 or 400 with no reserve: **no march is possible**. A march needs 5/3 of the host's size at home, which the second host or the reserve provides (reserve counts, even before it is mustered). With H0 < 200 only (a) and (d) apply (no day cap, no floor). The recorded real hosts (100 to 200 troops) are all small. Expect Y to depend on the autopilot building its second host.

Stamina (recorded, §0.5): a Depart costs 74 of 120; the recorded wallet 153's two hosts show stamina 58 at bell 997 (their seal records are at bell 990).

## 6. Dependency requests (for the integrator)

1. `frontier-node/crates/bots/Cargo.toml`: added inside an `# AI hook` / `# AI hook end` block: `sha2.workspace = true` (§11.2). `sha2 = "=0.10.9"` is already a workspace dependency.
2. `frontier-node/Cargo.lock`: the `bots` package entry gains one line, `"sha2 0.10.9"` (`cargo --locked` fails otherwise). It was produced by an offline `cargo build` (no download) and is committed on this branch; replace it if the integrator regenerates the lock.

No other manifest or lock change, no new crate.

## 7. Deviations from the contract (each also in the final report)

1. **u64 ids as decimal strings** on the wire (section 2).
2. **Economy candidates are not capped at 4.** The table says "next <= 4" for two builds, walls, train, muster and explore (six slots). A hard cap of 4 never offered muster or explore while two builds, walls and a train were affordable, which is the usual state, and muster is how an AI gets a second host. The bound is the global 12 with the pinned order kept.
3. **Harvest is held at the quota floor too.** §3.4 names Build, Train, Muster and Explore; Harvest is a duty sent at once, but the rule policy rolls it at 20 % each bell (about 29 a day against a relay quota of 40) and would drain the quota before a model choice. Model-chosen actions and every Depart are not held (builds keep the reserve of 6, as for every bot).
4. **The policy's nudges do not re-run the step.** The rule policy's own nudges (for a Muster or Depart it gated) are still sent with the duties, but `bot.nudged` is reset unless the brain's own gate nudged a chosen action: otherwise the discarded rule Departs would trigger fleet retries (up to 3 per bell) for nothing. The brain's own gated action re-runs the step and is sent from the cached answer.
5. **V6 also checks that the target is still there** (the camp is live, the open-field stack still stands on its tile) and counts queue slots and stores across the chosen actions of one decision; the contract's V6 list does not name these.
6. **Late is enforced in the brain too** (a decision that lands after the bell's end is never executed; the filtered autopilot runs). §3.5 says it; the contract does not say where.
7. **`my_clashes: []`, `obs_digest` over re-read files, `secs_left`, `bucket_left`** as in section 2.
8. **Seat = `Arch::Idle`** (joins, files its ticket, then never plays; the operator's script or the presenter acts with the exported key). The `--export-seat-key` file format is not pinned by the contract: `{index, wallet, wallet_keypair_b58, session, session_keypair_b58}`, mode 0600.
9. **Quota floor "cadence" in `fleet.rs`**: nothing was needed (AI bots step every bell regardless of quota); the follow wake is only a seam (`follow_wake`, `follow_next_wake`, no-ops), because the Call window is AC3b's state.
10. **`--follow-council` is accepted and inert** until AC3b.
11. **`ai-brain.json`** (counters and the step-0 (d) timeline) is a new output written beside the bots report, only when AI slots are configured; without the AI flags the binary's behaviour and outputs are unchanged.
12. **Hook edits**: the contract allows the four hook files; the `main.rs` parse test sits inside an `// AI hook` block.
13. **Test-only**: the agents fixture world writes whole troops where the chain stores milli-troops; `ai_common.rs` scales them on read so the brain sees what it sees on a real herald (the golden fixture's numbers are unchanged by the scaling).

## 8. Handoffs and open points

- **AC3b** replaces `raid.rs` and `recall.rs` (`pub fn offer(&Inputs) -> Vec<Offer>`), supplies `follow_offer`, `follow_intents`, `follow_wake`, `follow_next_wake` (the bodies in `ai/mod.rs`; replace them, do not add a second call site), and may need `replan` to handle `timing: "call"` (`extra = S - earliest - 1`; `replan` plans with `extra = 0` today) and `MarchKind::{Raid, Call, Recall}` (`replan` only plans the path for those; the "target still there" check covers camp and field). `Offer`, `Inputs`, `Action::March { kind }`, `MarchKind` and `BookMarch { via }` are public for that. `standing::filter_follow` is ready.
- **AC1a**: build against the fixture; the mind owns `done`/idempotency per `(index, bell)` too (the brain also reuses its cached answer for the same bell and never calls twice). Ids `c1..cN` are positional; `Offer::identity()` is the stable identity inside the brain.
- **AC5 / run script**: flags in section 5 (d); the mind port must lie in 41901-41999 (the brain refuses others); `--ai-slots` seed must equal `--seed`.
- **Integrator**: the `Cargo.lock` line (section 6); `MC-FILES` refresh before the hooks merge (§0.2); `ai-hook-check.sh` is AC5's.
- **Not verified**: anything that needs a live stack or Gemma: the census, step 0 (c) and (d), the real latency of a decision (the brain's own cost is small: 1,000 steps take about 6 s in a debug build on fixtures), the behaviour of `Fleet::run` under the game clock (the cadence was tested through `step_due` on a fixed clock), and the real relay's quota. The golden fixture is produced from the agents' fixture world, not from a live run.

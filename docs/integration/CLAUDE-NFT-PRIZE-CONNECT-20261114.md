# ⑰ NFT prize connection — integration candidate (2026-11-14)

**Status: candidate only. Not merged into any mainline branch. Not deployable.**
No real funds, no public mint, no real wallet, no chain, no validator, no
world, no SBF/Cargo build was used. Nothing here decides an economic rule.

| item | value |
|---|---|
| branch | `claude/nft-prize-connect-20261114` |
| worktree | `/Users/r0ze/Projects/wylls-nft-prize-connect-20261114` |
| base (current baseline at investigation) | `0ebfe040` (`claude/nft-pass-mint-20261114`; that branch has since moved to `6c9dbc72`, not included) |
| source candidate (read-only) | `/Users/r0ze/Projects/wylls-cc-nft-prize-20261107` @ `3090242` (base `6984acfa`, an ancestor of `0ebfe040`) |
| round patch | `CLAUDE-NFT-PRIZE-CONNECT-20261114.patch` (this round's own commit only, on top of the 3 carried commits) |

## 1. What was done

1. The three commits of the 2026-11-07 candidate (`f9dc2ad`, `1934bd0`,
   `3090242`) were replayed onto `0ebfe040` with their authorship kept
   (`8b5d3427`, `65ddf305`, `ec226d1b`). Neither source checkout was edited;
   the original's objects were read with `git fetch` from its path.
2. Conflicts resolved by keeping both sides:
   - `permutation-prize/src/lib.rs`: the current `CeilingPastTally = 0x111`
     (⑧, map growth) **and** the pass band `0x113–0x11A` (+ `0x11B`). The
     candidate had left 0x111 free for exactly this proposal, so the numbers
     do not collide. Comments and the band unit test now say 0x111 is
     CeilingPastTally and assert it.
   - `permutation-server/web/frontier/controller.mjs`:
     - `resetViewer` keeps the current rule (prize view cleared only on a
       wallet change, the wide inventory cleared via `fwide.clearWide`) and
       adds the candidate's pass rule: the pending pass claim is dropped and
       a new **pass epoch** starts on **every** viewer change (wallet switch,
       NFT login, logout, switching between the wallet's Citizen and a
       pass), so an in-flight claim of A never revives after A → B → A.
     - `nft-login`: the candidate's wallet-and-epoch check (`same()`) runs
       first, then the current `adoptResident(...)` (which goes through
       `resetViewer`).
     - `nft-logout` uses the current `adoptResident(null)`; both the current
       `nft-reload` and the candidate's `prize-claim-pass` actions are kept.
     - `act`'s send keeps the current local-play/wide-refusal path and adds
       the candidate's `via: v.via` (x402 route for a pass that already
       paid) to `tx.submit`.
   - `permutation-server/web/frontier/fplay.mjs`: union of imports
     (`wideResidentActIx` from current, `JOIN_RESIDENT_TAG` and `x402Network`
     from the candidate).
3. New limited contract test
   `permutation-gateway/test/web-frontier-prize-pass-connect.test.mjs`
   (8 tests): current owner's unclaimed right; former owner refused (page
   and relay); A → B → A generations and stale operations; double claim
   refused; DTO through the real decoder/mapper/JSON; English screen (no
   Japanese, no banned word, every pass refusal has words); what stays
   refused (new NFT deposits, continuous-world pools, feature off by
   default, registry agreement); the controller merge.

## 2. Consistency with the current API / ABI / holder generation

| check | result |
|---|---|
| `frontier_abi::resident_auth::authorize` signature (Binding, Policy incl. `guard_authority`, Account, actor, signed, generation, now, session_allowed) | unchanged since `6984acfa`; the prize's call compiles against the same signature (source read, not built) |
| holder generation rule | current `resident_auth::Holder` doc names the prize as a reader of "who holds the pass now"; every holder change bumps the generation and clears the session — the prize's A → B → A rule rests on exactly this |
| `resident_policy` (`PSFNP002`), `resident_citizen::{resident_tag15, resident_asset}`, `resident_binding` | unchanged since `6984acfa` |
| JS `joinResidentIx` / `JOIN_RESIDENT_TAG = 0xe1` | unchanged; current additions (CreateResidentPolicy, 0xDD WideResidentAct on the local candidate lane only) are additive and not touched |
| relay `routes/prize.mjs` at base → current | unchanged before the candidate; candidate's changes apply cleanly |
| prize program tags 8/9/10 | free in `[prize_program_ix]`; still provisional |
| prize errors | 0x113–0x11B registered; **0x111 CeilingPastTally is in the program at `0ebfe040` but absent from `registry.txt` and `registry.rs`** — a pre-existing gap of ⑧'s, left to its owner; the new test pins it as the only difference |

## 3. Kept refusals (unchanged, re-asserted)

- **New NFT deposits refused at every layer**: tag 8 PayResident →
  `ResidentDepositsDisabled` at dispatch; relay refuses the
  `[prefix, PayResident, JoinResident]` shape; SDK and page refuse
  (`PASS_DEPOSITS_ENABLED = false`, `passJoinPlan` → `depositDisabled`).
- **Continuous-world pools refused**: `ContinuousSeason` (0x112) in
  InitPool's season check.
- `nft-experimental` is not a default feature; `scripts/build-prize.sh`
  refuses it (bash -n only).
- **Not decided here** (left exactly as the candidate left them): whom a
  pass refund follows (pass claim in refund mode → `ResidentRefundUndecided`),
  prize period / continuous-world economics, wallet ↔ NFT migration,
  cross-world carry-over.

## 4. Results actually run (2026-11-14, Node v20.19.4, no-keys guard)

| run | result |
|---|---|
| 3 carried pure files (`web-frontier-prize-pass`, `web-frontier-prize-dto`, `frontier-prize-claim-outcome`) on the merged tree | **16/16 pass**, 0 skipped (same 16 as the candidate's own record) |
| + new `web-frontier-prize-pass-connect` | **24/24 pass**, 0 skipped |
| related pure suite (`web-lang`, `web-frontier-words`, `web-frontier-nft-viewer-switch`, `web-frontier-ws07-nft`, `web-frontier-nft-mint-link`, `web-frontier-controller`, `web-frontier-prize`) on baseline `0ebfe040` vs candidate | **56/64 both**; the same 8 fail on the untouched baseline (lang/bell-word checks, and the key-using `web-frontier-prize` refused by the guard). Detailed output diff: only line-number shifts in controller.mjs, no new violation |
| `scan-node-key-tests.mjs --check` | exit 5 on baseline and candidate alike: the same 10 stale reviews (pre-existing); no new file flagged |
| `sync-web-sdk.mjs --check` | up to date |
| `node --check` on every changed `.mjs` | pass |
| `bash -n scripts/build-prize.sh`, `git diff --check` | pass |

## 5. Not verified (and why)

- **No Rust was compiled or run** (disk 22 GiB free; heavy Cargo/SBF
  forbidden this round). `permutation-prize` lib tests, clippy, and the 9
  host scenarios of `e2e-native/tests/nft_pass_prize.rs` are unexecuted; the
  `lib.rs` merge and the 0x111 assertion are source-reviewed only.
- Address-deriving JS (`frontier-prize-resident.test.mjs`) and key-using
  relay tests (`frontier-prize.test.mjs`) were not run (policy).
- No signed transaction, browser flow, relay route, CPI/CU or chain run.
- The controller merge is verified by static reads and existing pure tests,
  not by the page running.

## 6. Next work (for the owner / integrator)

1. When disk allows: `(cd permutation-prize && cargo test --lib && cargo test --lib --features nft-experimental)` and
   `cargo check --locked --tests` in `e2e-native`; then an approved run of
   `nft_pass_prize`, `registry`, `error_codes`.
2. ⑧'s owner: register `0x111 CeilingPastTally` in `registry.txt` /
   `registry.rs` (then update test 7's expected list to `[]`).
3. Owner decisions before any deposit can be enabled: pass refund owner,
   prize period for continuous worlds.
4. Review and merge this branch into the NFT pass line by the one
   integrator only; it is not auto-merged.

## 7. Round 2 (2026-11-14)

### 7.1 Remote check (read-only)

`git ls-remote origin refs/heads/claude/nft-prize-connect-20261114` →
`3823fe199de4c6b804e86773c5cef23b6805dd91`, equal to local `HEAD` at the
start of the round. Working tree clean.

### 7.2 Reports and the 0x111 ownership question

Sent to ⑳ 「Wylls NFT参加パス発行実装」 and the main 「Opus｜KEEP選択の高速化」:
candidate SHA `3823fe19`, 24/24 pure, Rust/SBF not run, remaining items, and
the 0x111 gap. 0x111 came from the map-growth port `7df3187a` (⑧); the
registry files are ws04's and sit on ⑳'s baseline branch. Asked which of
(a) ⑳'s line, (b) this candidate branch, (c) another owner adds the two
one-line entries. **Both messages were queued (the sessions were busy); no
answer yet, so `registry.txt` / `registry.rs` were not touched.**

### 7.3 Contract gap found and fixed (prize lane files only)

With new pass deposits refused at every layer, the screen still invited
one: a pass with no Entry read "The entry fee is paid when the NFT joins
this season", and the join terms could offer the x402 fee sentence and the
faucet to a pass. Fixed without deciding any rule:

- `fprize.passClaimModel` now carries `depositsOpen` (= `PASS_DEPOSITS_ENABLED`, false).
- `screens/prize.mjs`: the `unpaid` state says deposits are not taken until
  the refund right is decided, that this NFT cannot pay one and has no
  prize right (`data-pass-deposit="refused"`, nothing to press); the old
  sentence is kept only for `depositsOpen`. `renderJoinTerms` for a pass
  without an Entry shows the existing refusal sentence instead of the
  price, the x402 sentence and the faucet.
- `lang/en-frontier-play.mjs`: one new English entry in the prize block.
- Pure coverage added to test 7 of `web-frontier-prize-pass-connect`.

**Not changed (another owner's file):** `screens/join.mjs`'s NFT list
still enables "Join with this NFT" in a pool season; the click is refused
(`ResidentDepositsDisabled`) by the controller, so nothing is sent. Whether
to disable or annotate that button belongs to ⑳.

### 7.4 English prize screen in a real browser (fixture)

`permutation-gateway/screens/prize-pass.screen.mjs`: the page's real
modules (`screens/prize.mjs`, `fprize.mjs`, `lang.mjs`, `base.css`,
`frontier.css`) in headless Chromium, English, over literal fixtures; the
test's own GET-only static server on 127.0.0.1:0; every non-GET or
off-origin request is aborted and fails the test. No wallet, signature,
relay, chain or validator. playwright-core is imported read-only from an
existing install (`PLAYWRIGHT_CORE`), Chromium from the local cache;
nothing downloaded; skipped with the reason when unavailable.

Cases and what was checked on screen: current owner (claim button visible,
enabled, on top at its centre), current owner busy (disabled; a forced
press sends no request), former owner (not in this wallet, no button),
earlier generation (claimed by a previous owner, generation shown, no
button), own claim (claimed, no second claim, no button), refund
(undecided, no button), refused deposit on the panel and in the join terms
(refusal visible, nothing to press, no x402/faucet). Every case: English
only, no banned word, no page error.

Result: **1/1 pass** (`node --import ./codex/no-key-node.mjs --test prize-pass.screen.mjs`).
Per-case images were looked at (scratchpad `shots/`, not committed).
Fixture-shell fixes made on the way (not product changes): the real
`.panel` is `position: fixed`, so the cases are shown with the drawer's
surface but static placement.

**Look issue seen, not fixed (shared `frontier.css`):** in prize callouts
the bold line runs into the explanation ("25 test USDCClaimed by
wallet…", also "…this count.Tally and Finalize…"): no `.callout strong`
rule exists. Pre-existing; for the stylesheet owner.

### 7.5 Re-runs after the round's changes

| run | result |
|---|---|
| 4 pure prize files | 24/24 pass |
| browser fixture | 1/1 pass |
| related pure suite vs baseline | 56/64 both, same 8 pre-existing failures, no new violation |
| key-test scan | same 10 pre-existing stale reviews |
| `sync-web-sdk --check`, `node --check`, `git diff --check` | pass |

## 8. Remaining work, by what it waits for

**仕様判断 (owner decisions; nothing decided here)**
- Whom a pass refund follows (payer or current owner); until then deposits stay refused.
- Prize period / settlement for continuous worlds (pools stay refused there).
- Wallet ↔ NFT entry migration; cross-world carry-over.
- Who registers 0x111 CeilingPastTally (asked ⑳ and main; awaiting answer).
- Whether ⑳'s NFT list disables or annotates "Join with this NFT" in a pool season.
- The callout bold-line spacing in `frontier.css` (stylesheet owner).

**重build待ち (disk 22 GiB; heavy Rust/SBF forbidden)**
- `permutation-prize`: `cargo test --lib` with and without `nft-experimental`; clippy.
- `e2e-native`: `cargo check --locked --tests`; then approved runs of `nft_pass_prize` (9 host scenarios), `registry`, `error_codes`.
- Address-deriving JS (`frontier-prize-resident.test.mjs`) and key-using relay tests (`frontier-prize.test.mjs`) under an approved run.

**実world待ち (none of this is claimed done)**
- A pass claim signed by a real test wallet through the relay on a local chain; ResidentStaleGeneration after a real TransferResident; A → B → A on chain.
- RecordResidentNation after CloseCitizen on a real world; CU/CPI limits.
- The page's claim flow end to end in the running app (controller merge verified only statically and by pure tests).

### 7.6 0x111 registered (after ⑳'s answer)

⑳ answered (b): add it on this candidate branch as its own commit, labelled
as a pre-existing registry gap; registry.txt is a shared ws04 contract file,
so the canonical integrator decides whether it lands. Done in
`9e98b8fc` (registry.txt + registry.rs, one line each, in
number order; test 7 now expects no unregistered prize error). The main
session had not answered by then. registry.rs was not compiled or run.
⑳ also confirmed it has no planned changes to resetViewer / nft-login /
nft-logout / adoptResident, and its commits after 0ebfe040 do not touch
controller.mjs or fplay.mjs.

The 仕様判断 item "who registers 0x111" is settled for this candidate; landing
it is the integrator's call. Re-runs: 24/24 pure, git diff --check pass.

### 7.7 Join screen NFT card (after ⑳'s handover of that case)

⑳ handed over `screens/join.mjs`'s NFT card on this candidate branch,
scoped to prize-pool seasons, keeping the English default and the
`?lang=` mint link as they are. Done in `271ade92`:

- prize-pool season (`FS.prize` present, the same test the controller uses
  for the refused path): an NFT that has not joined gets a disabled "Join
  with this NFT" and a note in the prize screen's wording
  (`data-pass-deposit="refused"`); a joined NFT's "Play this NFT" stays
  enabled; a pass whose earlier entry the relay reported (`FS.prize.pass`
  with an entry) may still join; with only joined NFTs no note is shown;
- no pool: unchanged (enabled once a nation is picked, no note);
- one English entry added in the prize block.

Tests: new `test/web-frontier-nft-join-pool.test.mjs` (3, including
"enabled outside prize-pool seasons"); existing `web-frontier-nft-mint-link`
and `web-frontier-ws07-nft` still pass. The browser fixture renders the
card with and without a pool and checks each button's enabled/disabled
state and the note in real Chromium (1/1 pass, images looked at).
Fixture-shell fixes on the way: the static server now reads before
answering (a missing file no longer crashes it; missing files fail the
test), and the page is served from `/frontier/` because the icon sprite
path is relative.

Re-runs: pure prize + card 27/27; related suite 56/64 with the same 8
failures as baseline `0ebfe040`; key scan unchanged; `git diff --check` pass.

The 仕様判断 item "⑳'s join button in a pool season" is done for this
candidate (still not merged; the integrator decides).

### 7.8 0x111: main's answer and the hash notice

The main session (「Opus｜KEEP選択の高速化」, canonical `b2802d8b`, which
does not touch prize, contracts or e2e-native) answered after `9e98b8fc` was
already committed. It does not object to any of (a)/(b)/(c). It asked for
two things: (1) the paths and base→new hashes before the write, sent to it
and to the map-side owner 「Fable 5.2 マップ読み込み堅牢化」; (2) to keep
this marked not done until registry.rs runs.

(1) was sent to both **after** the commit, saying so, and offering to drop
the independent commit if either objects:

| file | 0x111 commit 8d246b6c → 9e98b8fc (blob) | base 0ebfe040 → head a72ec026 (sha256, incl. the carried NFT rows) |
|---|---|---|
| `workstreams/04-execution/contracts/registry.txt` | `b9ead95f` → `c2903361` | `9ee4487c16aa3d06…` → `d16bbd7ff5d3ad73…` |
| `workstreams/04-execution/e2e-native/tests/registry.rs` | `9777ae50` → `7f09bce8` | `35188014e9c793dc…` → `054f91c8d2898ec4…` |

(2) **Status of the 0x111 registration: NOT DONE (candidate).**
registry.rs has not been compiled or run; this stays the wording until
`cargo test --locked --test registry` in e2e-native actually runs (重build待ち).

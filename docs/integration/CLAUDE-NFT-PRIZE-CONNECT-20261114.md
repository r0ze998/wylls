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

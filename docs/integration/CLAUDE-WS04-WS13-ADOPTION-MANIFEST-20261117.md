# ④/⑬ adoption manifest: two fixed tips for Lane D's shared intake (2026-11-17)

**What this is:** the exact units to hand to Lane D, which manages the common independent intake branch.
- **Not done:** nothing was integrated or cherry-picked, and no shared, canonical or `main` ref was moved.
- **Read with:** `git log`, `git diff --raw`, `git diff --check`, `git ls-remote` and `git merge-base` only.
- **Not done either:** no test, import, syntax check, guard, runner, network, signing or world.

## Fixed tips (remote equal at the time of writing)

| Unit | Branch | Fixed tip | Base |
|---|---|---|---|
| **U13**: ⑬ SendFailed same key, and reports | `claude/ws13-sendfailed-same-key-20261117` | `b88794bb3a2ae5237bbee4b22c58a52a0b8f2c93` | `d16048aa76399124affebeb38f7fc4f447857d00` |
| **U04**: ④ receipt `code`, ⑬ Duplicate reading, and reports | `claude/ws04-acts-receipt-code-20261117` | `10a4c1cb915db9d951b72dfe4be8da98d222114f` | `d16048aa76399124affebeb38f7fc4f447857d00` |

**The shared candidate** `claude/canonical-candidate-20261116` is at `d16048aa` (remote equal), so both units are direct descendants of it. `main` is `92142932` and is not touched.

## Commits

**U13** (oldest first; only the first changes code):
1. `1f814ec739acb4897834d4bcd5280f32f9143593` — fix: `#run` may-have-left keeps its key; regression written
2. `b18a0f1045d9ff9108af7ab8451498801af9ca6b` — docs: static counter-check
3. `b48b4cc9f7713e28d3cd1d9baeb1c3a7c5ffa62b` — docs and test: the out-of-contract Transport correction; two written-only cases
4. `5d02c791e09de8acfc82f48022bba50de7bcf017` — docs: journal restart boundaries
5. `b88794bb3a2ae5237bbee4b22c58a52a0b8f2c93` — docs: the Duplicate restart producer gap

**U04** (oldest first):
1. `6d8ae8db583498a856e21d39af6b9c8a37a76738` — fix: ④ receipt `code`; ⑬ `fateOfReceipt` Duplicate; two regressions written
2. `1bebe9717615ec18e76b393318397cd713eacf47` — docs: counter-review and real-connection gaps
3. `10a4c1cb915db9d951b72dfe4be8da98d222114f` — docs: remaining item 5 (④ `cancel`)

## Files (10 in total; no path in both units)

| Unit | Status | Mode | Blob (12) | Path |
|---|---|---|---|---|
| U13 | A | 100644 | `4bb09536eeb3` | `docs/integration/CLAUDE-WS13-DUPLICATE-RESTART-PRODUCER-GAP-20261117.md` |
| U13 | A | 100644 | `ada976328095` | `docs/integration/CLAUDE-WS13-JOURNAL-RESTART-BOUNDARY-20261117.md` |
| U13 | A | 100644 | `4a3257d374dd` | `docs/integration/CLAUDE-WS13-SENDFAILED-SAME-KEY-20261117.md` |
| U13 | M | 100644 → 100644 | `8b23f0619b1e` | `workstreams/13-citizens/resident/resident.mjs` |
| U13 | A | 100644 | `f03204cbfe93` | `workstreams/13-citizens/test/sendfailed-may-have-left.test.mjs` |
| U04 | A | 100644 | `820193a3e9d7` | `docs/integration/CLAUDE-WS04-ACTS-RECEIPT-CODE-DUPLICATE-20261117.md` |
| U04 | M | 100644 → 100644 | `dcc8e1d6f16d` | `workstreams/04-execution/src/acts.rs` |
| U04 | A | 100644 | `0710d820a65d` | `workstreams/04-execution/tests/acts_code.rs` |
| U04 | M | 100644 → 100644 | `6fc3e2a30c95` | `workstreams/13-citizens/resident/ports/ws04-acts.mjs` |
| U04 | A | 100644 | `132775034206` | `workstreams/13-citizens/test/ws04-acts-duplicate.test.mjs` |

**Checks** (each tip against `d16048aa`):
- `git diff --check` is clean;
- there are no deletions, renames or mode changes;
- the overlap of the two path sets is 0.

**Not included** (each checked):
- `17f4cca4` is not an ancestor of either tip.
- No path matches `land`, `en-frontier`, `walls`, `muster`, `runner`, `world`, `guard`, or a media extension (`.png`, `.jpg`, `.webm`). That excludes the refused earlier C (G1-generations land) and D (english-r3 en-frontier) sets, and the 13 media deletions in this worktree.
- **No commit from another lane is included:** all eight commits are this lane's, on branches made from `d16048aa`.
- **No ③ or `receipt-port`, Lane C ① or Lane D ③ file** is touched.

## Dependencies and order

**Each unit stands alone:**
- U13 changes `resident.mjs` `#run` only.
- U04 changes ④ `acts.rs` (an added receipt field) and ⑬ `ws04-acts.mjs` `fateOfReceipt`.
- U04's Duplicate answer (`status: 'failed'`, `fate: 'failed'`, code `Duplicate`, no signature) ends the line `failed` through `#retryOrFail('Duplicate')`, both with the base `resident.mjs` and with U13's. U13's new branch needs `fromSubmit` and excludes Duplicate, so it does not apply to a status reading.
- U04's ⑬ change reads `code`, which only U04's ④ change provides. **Within U04 the two parts belong together.** Without the ④ part, `code` is absent and ⑬ behaves as at the base.

**Suggested order:** U13, then U04. Either order gives the same tree, since the path sets are disjoint and both are fast-forwards of `d16048aa`. U04's reports refer to U13's reports by name, so U13 first keeps the references resolvable at each step.

**Intake** is Lane D's: the shared intake branch. This lane moves no ref.

## Regressions written and not run

| File | Unit | Imports and runs with | Status |
|---|---|---|---|
| `workstreams/13-citizens/test/sendfailed-may-have-left.test.mjs` | U13 | ⑬ `test/helpers.mjs` and the world harness (the same family as ⑬'s other tests) | **NOT run** (the ⑬ guard and its family are held) |
| `workstreams/04-execution/tests/acts_code.rs` | U04 | `runexec` (`acts`, `store`), `tests/common` | **NOT run** (`cargo` not run, not compiled) |
| `workstreams/13-citizens/test/ws04-acts-duplicate.test.mjs` | U04 | `resident/ports/ws04-acts.mjs` only (imports nothing), plain objects | **NOT run** |

No existing test was run for either unit, and no combined run was made.

## What a real connection still lacks

1. **⑬'s production `send` and assembly:** only the test stack's `send` exists. Not decided: how a real caller turns the wallet's HTTP 409/503 into a result.
2. **⑬'s acts client must read through the wallet gateway.** With store-only reads, a send lost before the wallet stays `registered`/`pending` indefinitely and is never resubmitted (`CLAUDE-WS13-JOURNAL-RESTART-BOUNDARY-20261117.md` §4-1).
3. **④ owner acceptance** of the added receipt field `code` (Rust, under `p04-acts/0.1`, following the precedent of `next` and `newAttemptAllowed`), and one wording line for `cancel` on a Duplicate (proposal only).
4. **The wallet's fate answer for a Duplicate entry** says `sent: true` without `duplicateOf` (proposal for its owner). ④'s receipt after a dropped wallet entry keeps the earlier signature beside `unqueryable` (proposal for ④'s owner). ⑬ is not affected by either.
5. **Whether an earlier send's effect may count for a line** (the same open question as Lane D's for ③).
6. **⑤'s handling of a Duplicate** (`fc43eb72` line, if it keeps S as its own signature). That is Lane D's area; ⑤ can tell by ④'s new `code`.
7. **Every run** (the three regressions above, ⑬'s guard tests and family, ④'s `cargo` tests) needs its own approval.

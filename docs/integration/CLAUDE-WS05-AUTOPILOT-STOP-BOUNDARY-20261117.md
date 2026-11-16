# ⑤ Autopilot stop (owner-approved A): no new decision acted on, nothing sent or re-sent; sent acts followed read only (2026-11-17)

Branch `claude/ws05-autopilot-stop-boundary-20261117`, from candidate `claude/canonical-candidate-20261116` at
`d16048aa`. Independent of every other branch (`6cd7a788`, `fada02f9`, `eaf2b97d`, `fc43eb72`, Lane D), none merged or
cherry-picked.

**Static implementation, NOT run, NOT integrated. The stop guarantee is NOT demonstrated** — it rests on reading the code.
Nothing was executed (no test old or new, node syntax check, import, scanner, fixture, relay, world or runner); the two
guard-refused frontier tests were not run in any form. Commands: source/history reads, file edits (Python exact-string
replacement scripts), `git diff --check`, git save/push.

Owner decision (relayed): "AI停止時、新しい操作を止め、送信済み結果だけ確認し続けるA" — approved. Contract:
`model-api/HANDOFF-4.ja.md` §5, "⑤の停止（`Autopilot.stop`）: その時から、新しい判断も `agent_act` もしない".

## Files

- Edited: `workstreams/05-ai-participation/model-api/src/autopilot.mjs`, `workstreams/05-ai-participation/src/participate.mjs`.
- New: `workstreams/05-ai-participation/model-api/test/stop-boundary.test.mjs` (unrun).
- Read only: `model-api/src/{process-lease,citizen-boundary,api-decider}.mjs`, `src/adapters.mjs` (journal), ⑤ docs
  `HANDOFF-4`, `FATE-ACTS-5`, `GUARANTEES`; tests `autopilot`, `citizen`, `continuing`, `same-citizen-contention`,
  `ws03-same-citizen`, `multiprocess*`.

## What the code did before (d16048aa)

| Point | Lease | No lease |
|---|---|---|
| re-ask of unfinished acts at tick start (`participate.mjs:189-190`, may send once) | no check | no check |
| model plan → fresh `agent_view` → `beforeAct` (`:282-293`) | `lease.check()` (fails after `stop()` releases) | citizen boundary only: **no state check** |
| `registerAct` (await) → `act-begin` → `agent_act` (`:315-325`) | no check after the await | no check |
| `act()` retries on `RelayUnreachable` (`:135-143`) | no check between retries | no check |
| stop → resume during a tick | the new lease passes `check()` | state is `running` again |
| end of tick `stopped-by-budget` / `stopped-capability` | could overwrite a resumed run's state | same |

`Autopilot.stop` only changed state, lease and events; `#actFence` returned the citizen boundary when there was no lease.

## The change

**autopilot.mjs**
- `generation`: advanced by every `start` (so by every `resume`). A tick captures it when it begins.
- `#actFence(gen)` (with or without a lease) gives participate two checks:
  `beforeAct` (after the fresh view) and `beforeSend` (after the act's last await; before every re-ask; between
  `agent_act` retries). Each refuses `AutopilotStopped` unless `state === 'running'` and the generation is the tick's,
  then `LeaseLost` if the lease is no longer this process's, then (beforeAct) the same Citizen's boundary as before.
- A tick from an earlier generation does not change the current state at its end (no budget/capability stop applied to
  the resumed run). Its read-only bookkeeping (registry status reads, receipt close, record) still finishes.
- `checkSent()` (new, read only): only when not running and no tick is in flight; `verifyPending` over the journal with
  at most `FOLLOW_UP_READS = 8` chain reads per call (FATE-ACTS-5 §3: unsettled acts read again up to 8 a time; relay 20
  burst, 2/s). No timer: the caller asks again. Returns `verified`, `open` (unknown / landed-without-effect / not read
  this call), `unfinished` (begun without an answer: held as unknown, not re-sent), `settled` only when nothing is open
  and nothing unfinished, and `sends: 0`. Never decides, never calls the model, never sends.

**participate.mjs**
- Before each re-ask of an unfinished act: `boundary.beforeSend()`; refused → reported `unknown`, not re-sent.
- New act: `beforeSend()` after the registration and **before** `act-begin`, so a stopped act leaves no unfinished entry a
  restart would re-ask; the executor's game reservation is released, the item is `skipped` with the code, and `stale`
  stops the rest of the run (the existing rule).
- `act()` takes the fence: a retry after the stop is not made; the answer stays unknown (the existing unreachable path).
- `verifyPending({maxReads})`: optional bound (default unbounded: ticks unchanged); unread acts are returned `notRead`.

Not changed: receipts (no cancel, no Completed — the in-flight tick still closes its receipt with what happened), the
relay's mode (`manual` stays the owner's signed command), sessions, other senders, authorization, scopes, budget and
cost classes (a model call in flight is still billed when it answers; nothing is released or refunded), retry/hold
rules for the relay, the ABI.

## Paper refutation review

- Existing tests that stop then resume (`continuing.test.mjs:162`, `ws03-same-citizen.test.mjs:126`, contention C3/C4)
  tick **after** `start`, so their generation is current: they still send.
- `citizen.test.mjs:302-316` stops after the tick and reads receipts: unchanged.
- Without a lease and without a citizen, `beforeAct` now returns `{ok: true}` where `boundary` was null: same outcome.
- The staking path (`src/staking/session.mjs`) passes no boundary: every new check answers ok, unchanged.

## Residual windows (stated, not closed)

- Between `beforeSend` and `agent_act` there is a synchronous journal write and `await crash('act-begin')` (a no-op hook:
  one microtask). A `stop()` called from a microtask scheduled exactly there would not be seen; a stop from another
  event (an HTTP handler, a timer) cannot run in that gap.
- Once `agent_act` is in flight it is not recalled (HANDOFF-4 §5: sent and signed game acts cannot be undone).
- An act registered in ④'s registry and then refused by `beforeSend` stays `registered` (never sent); later reads show
  it not sent.

## Decision points (not invented)

1. After the owner's resume, the next tick re-asks an act begun without an answer before the stop (existing crash
   recovery: same requestId, replayed if sent, sent once if not). Whether ⑤'s stop should forbid that re-ask after a
   resume is a contract choice.
2. Who calls `checkSent` and how often (an owner view, a CLI): no caller exists; no timer was added.
3. Whether ⑤'s stop should also ask the relay to go `manual` (today the owner's signed command only).

## Regression source (written, NOT run)

`model-api/test/stop-boundary.test.mjs`: S1/S3 stop during the model's answer, without and with a lease → nothing sent,
`AutopilotStopped`, no act-begin; S2 stop + resume during the wait → the old tick sends nothing and leaves the state
alone, the next tick sends; S4 `checkSent` read only, an unsettled send open, never settled; S5 refused while running or
with a tick in flight; S6 an unfinished act reported, not re-sent. It uses `autopilot.test.mjs`'s harness (the local
world, whose relay makes an in-memory test agent key, and the model HTTP fixture on 127.0.0.1): run only through the
repository's key-free guard.

## Working-tree note

Twenty tracked binary files (images and videos under `docs/img`, `permutation-server/web/frontier/art`,
`permutation-state-prototype`, `workstreams/07-player-experience/shots`) were found deleted in this worktree before this
round, not by this session. They were neither restored nor committed.

## Checks NOT run (all open)

The new test, `autopilot.test.mjs`, `citizen.test.mjs`, `continuing.test.mjs`, `multiprocess*.test.mjs`,
`integration/*.test.mjs`, ⑤ `test/*.test.mjs`; no syntax check, import or guard scan.

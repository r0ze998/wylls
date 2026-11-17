# ⑬ operator resident: a respond proposal enacted with the observation it was made from (2026-11-17)

**Branch:** `claude/ws13-enact-step-20261117`, one commit **on `f60dca78`** (the enact-respond unit's final tip, unchanged).

**Static change, NOT run:**
- no test, syntax check, import, call, observation, signature, POST, send, charge, key or runner;
- **nothing was enacted.**

## The gap

- `liveStep` (and `factory.mjs` `step()`) made a proposal from one observation, but returned only part of it: the world and the bell, not the Season, the clock or the requests.
- `enactRespond` needs that observation as its own `observed` argument.
- So a caller had to **observe again**, and the snapshot it passed might not be the one the proposal was made from (another Season, other requests, another clock).
- The board the requests came from was not recorded at all.

## What is connected

### 1. The step keeps its observation (`step.mjs`)

- **A proposal's result now also carries `context`:**
  - kind `ws13-live-step-context/1`;
  - the wallet the step observed for;
  - `requestsFrom` (the board the requests were read from);
  - the world, the Season and the Season-bell clock;
  - the requests;
  - `forProposal` (the candidate id, kind, request and offer it belongs to).
- **It is a deep frozen copy** of plain data, so a later change to the observation or to the proposal object does not change it. Anything that is not plain data gives `{unavailable: why}`, which is held.
- **The step itself still enacts nothing:** every proposal is `enacted: false`.
- **The one-step entry (`once.mjs`) is unchanged.** Its summary does not include the context, and it does not import any enacting module.

### 2. Which board (`observe.mjs`, `factory.mjs`)

- `getReader` now exposes its normalised `base`.
- `observeLive` records `requestsFrom` when the board's view was read: `null` when not read, or when the reader does not say.
- Nothing else changes in what is read or how.

### 3. The explicit entry: `resident/live/enact-step.mjs` (new), `enactStepRespond({step, dir, signer, nation, boardUrl, fetchImpl, nowSecs})`

- **No observation:** it reads, fetches and times nothing itself. It passes the step's `context` **as it is** to `enactRespond` as `observed`, with the context's wallet and board.
- **`held`, with nothing signed, posted or written** (`stepRespondProblem`), when:
  - the step was stopped;
  - there is no unenacted proposal, or it is held;
  - it is not a respond (a send stays `enactSend`: unsupported);
  - there is no context, the context is not frozen, it is unavailable, or it was made for another proposal (candidate, kind, request, offer);
  - the context has no wallet, world, Season or clock (nothing is filled in);
  - it does not say which board its requests came from;
  - the board given is not that board (a trailing slash is the same board);
  - there is no signer for the context's wallet. **The signer is the authority:** it is supplied by the owner, and no key is read or made here.
- **Then `enactRespond` runs unchanged:**
  - the stop is read before any new operation and again after the signature (stop-A: only earlier results are read back);
  - the board's world is checked before the one POST;
  - a failed save is `durable: false, saved: 'unknown'` and is never posted again;
  - the journal line is bound to the context's board, world and clock;
  - one call per journal in a process.

## Still not connected (said as it is)

1. **Across processes nothing is excluded:** `live-enact.json` and `state.json` have no lock between processes. Use one process per resident directory. **Not guaranteed, and not ready for unattended use.**
2. **A send** stays unsupported (`enactSend`): it is localnet-pinned, has no idempotency key, and its `sending` record is a browser-hook contract.
3. **Re-posting an unknown respond** that is not on the board is not done. This is an open decision.
4. **The signer, the agent-wallet policy, funding and join** are not supplied. Nothing calls this entry: there is no runner, no CLI and no loop.
5. **The step's `missingAuthority`** is still what the step was given (`once` gives none). The entry's own authority check is the explicit signer; no new rule is added.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-enact-step.test.mjs` (new)

Fake readers and decoders (as `live-resident.test.mjs`), a temporary resident directory, a fake signer (fixed bytes, no key), a fake board.
- **The context:** deep frozen, a copy (not the observation's own objects), with the wallet, board, Season, clock, the requests and the proposal it belongs to. A later change to the observation does not reach it.
- **Enacted with it:**
  - the herald is not read again, and the step observed once;
  - posted once, to the board the requests came from;
  - the record's request, offer, Season and signer are the context's;
  - the journal line is bound to the context's board and clock.
- **Held, nothing signed, posted or written:**
  - no step;
  - a stopped step;
  - no context, an unfrozen one, or an unavailable one;
  - another proposal;
  - an enacted proposal;
  - a send;
  - a board reader that does not say its base;
  - another board;
  - no signer, or one for another wallet.
- **Stopped (manual):** held, nothing signed or posted.
- **As text:**
  - `step.mjs`, `once.mjs` and `factory.mjs` do not enact;
  - the entry observes, fetches, times and signs nothing itself, and passes the context as it is;
  - the step returns the context;
  - the reader says its base.

## Hand-over (Lane D)

**Unit:** `claude/ws13-enact-step-20261117`, one commit on `f60dca78`. Take its own diff `f60dca78..<tip>`, all `100644`:
- `workstreams/13-citizens/resident/live/step.mjs` (M)
- `workstreams/13-citizens/resident/live/observe.mjs` (M)
- `workstreams/13-citizens/resident/live/factory.mjs` (M: one line in `getReader`; the aggregate does not have `d00f13b4`'s resident view, and this hunk does not touch it)
- `workstreams/13-citizens/resident/live/enact-step.mjs` (A)
- `workstreams/13-citizens/test/live-enact-step.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-ENACT-STEP-20261117.md` (A)

**Not run:** anything. Nothing was observed, signed, posted or sent.

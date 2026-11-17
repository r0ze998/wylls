# ⑬ operator resident: a keyless command that reads saved respond results once (2026-11-17)

**Branch:** `claude/ws13-enact-read-once-20261117`, one commit **on `ccabada3`** (the enact-read unit's final tip, unchanged).

**Static change, NOT run:**
- no test, syntax check, import, command, API call, read, HTTP, RPC, signature, POST, send, charge, key or runner;
- **nothing was read or enacted.**

## What is connected

### `resident/live/read-once.mjs` (new)

- **`readOnceConfig(input)`:** exactly four settings, all required, nothing filled in:
  - `residentDir` (absolute);
  - `wallet` (base58);
  - `heraldUrl` and `boardUrl` (http(s), no credentials, query or fragment).

  Anything else (`signer`, `proposal`, `fetchImpl`, `worldFromSeason`, …) is refused. The result is a frozen copy.
- **`runReadOnce(input, {fetchImpl, read})`:** checks the settings **itself, whoever calls**. Bad settings return `config-missing` **before anything is read or fetched**. Good ones call `enact-read.mjs` `readRespondResults` **once**, with:
  - exactly those settings;
  - **workstream 12's own `worldFromSeason`** (`12-memory/adapters/canonical.mjs`, imported explicitly, as `factory.mjs` does).

  `read` and `fetchImpl` are stand-ins only for a test.
- **The result:**
  - `{kind: 'ws13-enact-read-once/1', outcome, effects, summary, result}`;
  - `outcome`: `result` (the read answered), `not-read` (the directory or journal not readable), `config-missing` or `error`;
  - `summary.counts` keeps **the journal's word** (`fromJournal`: posted, refused, intent, signedNotPosted) apart from **the board's view now** (`fromBoardNow`: confirmed), with `unknown` and `held` separate;
  - the reader's own `result` (each line's `journal`, `board`, `result`) is included as it is.

### `bin/live-enact-read.mjs` (new)

```
node workstreams/13-citizens/bin/live-enact-read.mjs --resident-dir /abs/… --wallet <base58> --herald http://… --board http://…
```

- Strict arguments; the same settings check.
- **Exit codes:**
  - `0`: a result, whatever the lines say;
  - `1`: not read, or an error;
  - `64`: usage or a missing setting (nothing run).

## What it reads and does (as `enact-read.mjs` does, unchanged)

- **Local:** the journal (one read) and its lock file (`lstat` only).
- **Outside:** only when a `sending` line needs the board's answer, GET of herald `/h/season`, board `/coop/config`, board `/coop/view`. A journal with no such line reads nothing outside.
- **Never:**
  - writes (journal, lock, `state.json`);
  - makes or removes a lock;
  - observes for candidates, proposes, signs, posts or re-sends;
  - chooses a wallet, URL, key or identity.
- **No journal now:** a result (exit `0`) that says only that, with **no claim about the past.**
- **`unknown`** is never "not sent". **`confirmed`** is the board's view now, not a chain fact.

## Unchanged

- **`once.mjs`** and `bin/live-once.mjs`: the one-step entry stays non-enacting and does not read results.
- The state writers, the single-writer limits, the enact rules, stop-A and the unknown-is-never-re-posted rule.

## Not verified (said as it is)

- **The import chain:** `read-once.mjs` loads `12-memory/adapters/canonical.mjs`, which itself imports `node:sqlite`, `ws08-world.mjs`, `ws04-receipts.mjs`, `../src/view.mjs` and `../src/records.mjs` at load.
  - What loading them does (an experimental-module warning, any work at load) was **not checked**: nothing was imported or run.
  - `factory.mjs` already imports the same module.
- **Nothing calls the command on a schedule:** no runner, timer or loop. It is a command a person runs.

## Still not connected

1. **Locking `state.json` across its writers** (`Resident`, owner mode, the initial writer): no adopted contract.
2. **The resident's caravan send:** unsupported (localnet pin, no idempotency key, a browser-hook `sending` record).
3. **Re-posting an unknown respond** not on the board: an open decision.
4. **The signer, the agent-wallet policy, funding and join:** not supplied.
5. **Updating a confirmed line in the journal** happens only in `enactRespond`'s next call, under its lock. This command does not write it.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-enact-read-once.test.mjs` (new)

- **Settings:** all four required; a relative directory, a bad wallet, ftp, credentials, a query or a fragment each named; extra keys refused; frozen.
- **A direct call with bad settings:** no read, no fetch.
- **Good settings:**
  - one read with exactly the settings and workstream 12's own `worldFromSeason`;
  - the counts kept apart;
  - `not-read` and `error` give exit `1`.
- **No journal (a real temporary resident, no fetch allowed):** `result`, `journal: 'not there now'`, the no-evidence wording, `state.json` unchanged, no journal or lock made.
- **The command:**
  - an unknown flag, a missing board or a positional: `64`, nothing run;
  - good arguments: one run with exactly them, exit `0`;
  - `inputOf` fills nothing in.
- **As text:**
  - neither file enacts, signs, posts, writes, locks, steps, observes, times or loops;
  - the explicit workstream 12 import;
  - checked before reading;
  - `once.mjs` does not read or enact results.

## Hand-over (Lane D)

**Unit:** `claude/ws13-enact-read-once-20261117`, one commit on `ccabada3`. Take its own diff `ccabada3..<tip>`, all `100644`, all new:
- `workstreams/13-citizens/resident/live/read-once.mjs` (A)
- `workstreams/13-citizens/bin/live-enact-read.mjs` (A)
- `workstreams/13-citizens/test/live-enact-read-once.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-ENACT-READ-ONCE-20261117.md` (A)

**Not run:** anything.

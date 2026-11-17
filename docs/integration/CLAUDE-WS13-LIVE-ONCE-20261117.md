# ⑬ operator resident: a one-step, no-charge, non-enacting entry with a readable result (2026-11-17)

**Branch:** `claude/ws13-live-once-20261117`, one commit **on `d00f13b4`** (the resident-view unit, unchanged).

**Adoption:** take this unit's own diff `d00f13b4..<this tip>`, after `8b8e14c6..d00f13b4`. They are separate units.

**Static change, NOT run:**
- no test, syntax check, import, factory or entry call, HTTP, RPC, runexec, signature, submission, charge or key;
- **not a running resident, and never run against a real world.**

## The gap

The live path (`factory.mjs` `createLiveResident(...).step()`) was reachable only from tests. There was no product entry that takes explicit settings, runs **one** step and gives the operator a result they can read.

**Not the same as `bin/observe-canonical.mjs`:** that command prints workstream 12's canonical evidence about counterparties. This one runs the resident's own live step.

## The fix

| File | What it is |
|---|---|
| `resident/live/once.mjs` (new) | The API. Imports only `factory.mjs`; nothing runs at import. |
| `bin/live-once.mjs` (new) | The command. It does something only when run as `node workstreams/13-citizens/bin/live-once.mjs …` (the same main guard as `observe-canonical.mjs`), once, and ends. |

### `once.mjs`

- **`onceConfig(input)` checks the settings; nothing is completed with a default.**
  - **Required:**
    - `heraldUrl` (http(s), no credentials);
    - `wallet` (base58: the resident's own, given by its owner);
    - `residentDir` (absolute: the resident's stop and submitted keys are read from it).
  - **Optional, each whole or absent:**
    - `boardUrl`;
    - `rpc {url, cluster, source}`;
    - `actsStatus {bin, db, registry, agentId, gatewayPort?, bridge?}`.
  - **Anything else is refused:** `provider`, `allow`, `authority`, `execution`, …. A charging model cannot be given through this entry.
- **`runOnce(config)`:** makes the live resident with **the no-charge rule fixed** (`provider: null`, `allow: {}`, `authority: {}`), calls **one** `step()`, and returns `summarizeStep(…)`.
  - **On an error:** only a code and a short message. Long tokens are masked, and no setting values or internal error text are passed on.
- **`summarizeStep(result, config)`:** the result as an operator reads it, always `enacted: false`.
  - **`outcome`:** `stopped`, `wait`, `proposal` or `error`.
  - **When not stopped:**
    - the observed `world`, `bell` and `bellBasis` (informational);
    - the `decision` (choice, by, why);
    - the **proposal**: kind, request, source, offer, `needs` and `missingAuthority`; for a send, its plan (steps, caravan number, fee as a string, the stock estimate, or the plan's code and why); for a respond, the record and the fields only the signer adds; `held`; and a notice: **"a proposal only: nothing was signed, posted or sent, and nothing has landed"**;
    - each candidate with its `held` reasons;
    - `unsupported`, `unknown` and `held` kept apart.
  - **When stopped:**
    - **no observation, candidates or proposal**;
    - `stop` (why, and each source);
    - **`stopA`:**
      - `worldRead` (none, or the one `/h/season` read made to match keys);
      - `confirmed` (each matched key's answer: landed, failed, expired, not-sent, unknown, pending; *"not registered (workstream 4 NoRecord)"* for null; duplicate and commitment kept);
      - `couldNotRead` (the registry could not answer);
      - `notMatched` (keys held, with why);
    - `unsentIntents`.
  - **`effects`, said as they are:**
    - **reads:** the herald, the board and the chain when not stopped; the resident's files; workstream 4's run store only when stopped;
    - **writes:** with `actsStatus.gatewayPort`, **each status read records the wallet's answer in workstream 4's run store (workstream 4's behaviour)**; otherwise none by this step;
    - **sent:** nothing.

### `bin/live-once.mjs`

- **Settings from flags only**: `--herald`, `--wallet`, `--resident-dir`, `--board`, `--rpc-url/-cluster/-source` and `--acts-bin/-db/-registry/-agent/-gateway-port/-bridge`. A malformed port is passed on as invalid, so it is refused, not dropped.
- **Exit codes:**
  - 64 for usage or missing settings, printed, **without running**;
  - 0 for a result;
  - 1 for an error.
- **Nothing ongoing:** no daemon, timer or loop.

**Unchanged:**
- the factory (stop first, the resident's files, provenance matching, the status-only port);
- the no-charge rule;
- `enacted: false`;
- workstream 4's client, the board page and the game.

## Not connected yet: what a real run still needs (facts, not decisions taken here)

1. **A running world for the resident:** a herald (and a board, if requests are wanted) of a continuous ws08 world, and an RPC declared for its network. None is named here.
2. **The resident's own directory with its charter and state**, made by its owner. Making one requires constructing a `Resident`, which may make a key. This entry only reads one.
3. **For stop-A against a real registry:** the resident's execution port wired with `ws04ActsPort(…, {registry})`, so new lines record an origin, and the same `registry` and `agentId` given here. There is no production wiring of the resident's port yet.
4. **Enacting** (signing a board record, signing and submitting a caravan), **join**, a **running resident**, a **persistent key and identity**, and **funding**: not connected.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-once.test.mjs` (new)

- **Settings:**
  - the three required ones;
  - foreign settings refused (provider, allow, authority, execution);
  - partial groups and malformed values refused;
  - nothing defaulted.
- **`runOnce`:** the fixed no-charge rule; one step; a short error (long tokens masked).
- **The result:**
  - a proposal is never said as sent;
  - the plan and fee are readable (no bigint left);
  - held, unknown and unsupported are apart;
  - a failed plan is held.
- **stop-A in the result:**
  - confirmed answers (landed with commitment, NoRecord, a Duplicate), could-not-read and not-matched told apart;
  - the run-store write is said;
  - no proposal when stopped.
- **The command:** usage and missing settings exit 64 without running; a result 0; nothing defaulted from flags; a malformed port is refused.
- **As text:** no timer, loop, signing, posting, submitting, registering, cancelling or joining; the fixed no-charge rule; the main guard, with one `await main(`.

## Hand-over (Lane D)

**Unit:** `claude/ws13-live-once-20261117`, one commit on `d00f13b4`, all `100644`:
- `workstreams/13-citizens/resident/live/once.mjs` (A)
- `workstreams/13-citizens/bin/live-once.mjs` (A)
- `workstreams/13-citizens/test/live-once.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-LIVE-ONCE-20261117.md` (A)

**Not run:** anything.

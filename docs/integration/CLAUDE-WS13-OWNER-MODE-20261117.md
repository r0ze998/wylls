# ⑬ operator resident: the owner's signed mode command, applied without constructing a Resident (2026-11-17)

**Branch:** `claude/ws13-owner-mode-20261117` **on `089a8463`** (the initial-resident unit's final tip, unchanged).
- `edb6cc80` is the first tip.
- A wording correction (the second tip) is on top of it.
- **Adopt the final tip only.**

**Adoption and closure:**
- take this unit's own diff `089a8463..<this tip>`, after the initial-resident unit `cd2f6683..089a8463`, because its regression uses `writeInitialResident`;
- **the product file needs only** `resident-state.mjs` and `factory.mjs` `existsForHalt` (in the aggregate) and workstream 0's gateway modules (`owner-auth.mjs`, `ledger.mjs`, `config.mjs`), all unchanged.

**Static change, NOT run:**
- no test, syntax check, import, call, signature made, mode changed, file written, HTTP, RPC, key, submission, charge or runner;
- **not a running resident.**

## The gap

A new resident starts stopped (`mode: 'manual'`). The only way to let it run is the owner's signed mode command, and the only code that applied one was `Resident.command`. That requires constructing a `Resident`, whose constructor may make a key, switches a new record to `auto` and saves.

## The contract it follows (checked, unchanged)

- **`Resident.command` for `op: 'mode'`:**
  1. `verifyCommand({command, signature}, {op, nonces: ledger.db.ownerNonces, now})`;
  2. the command's owner must be the charter's owner and its agentId the charter's id (`NotOwner`);
  3. `ledger.setMode(id, …)`;
  4. save. It saves even when the mode did not change, so the nonce is kept.
- **`verifyCommand` (`owner-auth.mjs`):**
  - the owner's wallet signature over the canonical command (`OWNER_PREFIX` + canonical JSON);
  - `expiresAt` within `MAX_COMMAND_MS` of its clock;
  - an 8..64-character nonce, consumed in `ownerNonces` (a replay is `OwnerCommandReplayed`).
- **`AgentLedger.setMode`:** increments `modeEpoch`, releases held holds on `manual`, and saves only on a change.

## The fix: `resident/live/owner-mode.mjs` (new), `applyOwnerModeCommand({dir, wallet, signed})`

**The steps, in order. Every step before `save` writes nothing:**
1. **Only `op: 'mode'`** with params **exactly** `{mode: 'auto'|'manual'}`. This is narrower than `Resident.command`, which turns any other value into `auto`. `withdraw` (which changes the journal) and `op: 'policy'` (which changes the charter) stay with the resident and are refused.
2. **`readResidentState`:** `state-unknown` is refused. That covers another wallet, another owner, a malformed policy and the versions.
3. **The charter is read**, and the state is loaded through **the existing `createStateStore`**. The record's agent key and owner are checked again, because the state may have changed since step 2.
4. **`new AgentLedger({store})`.** Its own integrity checks apply.
5. **`verifyCommand`** with **owner-auth's own clock** (no time is taken from the caller) and the ledger's nonces. A bad signature, an expired command or a replay is refused, and **nothing is saved**, so the nonce is not consumed on disk.
6. **Owner and agent** must match the charter (`NotOwner`).
7. **`ledger.setMode`, then `ledger.save()`** (a temporary file, then a rename). The nonce is kept even when the mode does not change.

**The result:** `{ok: true, mode, modeEpoch}` or `{ok: false, step, why}`.
- A failure at `save` **before the rename** leaves the file as it was.
- A failure **after** it (syncing the directory) is still reported as a failure, with `readAgain: true`. It is **never reported as applied**.

**What it never does:**
- read or make a key: verifying reads only the owner's public address;
- sign, send, fund or authorize.

**(Second tip, correction) What `auto` allows depends on the reader:**
- **The live, non-enacting path** (`step.mjs`, `once.mjs`): it only proposes.
- **A `Resident`:** the mode is the agent ledger's own record, **shared with the resident**. A `Resident` process stepping this directory acts under `auto` as it always does (`resident.mjs` `step`).
- **So `auto` is not "proposals only" in general.** The first tip's sentence was too broad.

## Limits (stated, not solved)

- **No lock:** the state file has no lock in the existing contract. A resident process, or another writer, on the same directory at the same time could overwrite the change, or be overwritten by it (the last writer wins). **Apply it only while nothing else writes the directory.** This is not enforced or detected here.
- **Not done here:** no mode was changed and no command was signed. The flow is code only.
- **Not carried here:** `withdraw` and `policy` (goal, `extendTurns`) remain the resident's own commands.

## The way through (not run)

1. `writeInitialResident({...})` → stopped (`manual`).
2. **The owner signs** `{op: 'mode', owner, agentId: id, nonce, expiresAt, params: {mode: 'auto'}}` with their wallet (`owner-auth.mjs` `signCommand`, or the browser does the same). **Nothing here signs.**
3. `applyOwnerModeCommand({dir, wallet, signed})` → `{ok: true, mode: 'auto', modeEpoch: 1}`.
4. `runOnce({heraldUrl, wallet, residentDir: dir, …})` → `wait` or `proposal`, always `enacted: false`.

## Next concrete gap

**Enacting a proposal** is not connected yet. It needs:
- **a board record:** signed with the resident's identity (a key the owner supplies), posted to workstream 1's board;
- **a caravan:** signed and submitted through the agent wallet's `send`, with workstream 1's `sending` record first and `ws04ActsPort(…, {registry})` so the line records an origin;
- **authority and funding:** the agent wallet's policy must allow the action (`policy.allowed` is empty for a new resident; changing it is the owner's `policy` command in the agent wallet, not ⑬'s), and the record must be funded.

None of these is supplied, and join is not connected.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-owner-mode.test.mjs` (new)

- **No key needed:**
  - another op, `withdraw`, an unknown mode or parameter, and no command: refused at `command`, with nothing written;
  - a bad signature: refused at `verify`, with nothing written and the nonce not consumed;
  - another wallet, or a missing directory: refused at `state`;
  - still `stopped-by-owner`.
- **Signed** (skipped in the keyless default, as `continuity.test.mjs`):
  - `auto` applied with `modeEpoch: 1`, and the live reader then sees no stop;
  - a replay refused, with the nonce on disk;
  - another agent refused at `owner`;
  - an expired command refused;
  - back to `manual` (`modeEpoch: 2`);
  - the same mode again: unchanged, with the nonce still kept.
- **As text:**
  - `verifyCommand` with the ledger's nonces and no caller time;
  - the `NotOwner` rule;
  - verify, then apply, then save;
  - no Resident, key, signing, clock, withdraw, post, submit, write or removal;
  - the resident's own rule it mirrors.

## Hand-over (Lane D)

**Unit:** `claude/ws13-owner-mode-20261117`, two commits on `089a8463` (`edb6cc80`, then the wording correction). Take the final tip's diff from `089a8463`, all `100644`:
- `workstreams/13-citizens/resident/live/owner-mode.mjs` (A)
- `workstreams/13-citizens/test/live-owner-mode.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-OWNER-MODE-20261117.md` (A)

**Not run:** anything. No mode was changed and nothing was signed.

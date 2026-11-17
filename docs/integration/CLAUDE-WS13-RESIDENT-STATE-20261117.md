# ⑬ operator resident: its own stop and submitted keys, read only, in the live factory (2026-11-17)

**Branch:** `claude/ws13-resident-state-20261117` **on `ebda31cc`** (the live-resident unit's final tip, unchanged).
- `5ab89984` is the first tip.
- The correction (the second tip) is on top of it.
- **Adopt the final tip only:** the diff `ebda31cc..<final>`, 4 paths.

**Adoption:** take this unit's own diff `ebda31cc..<this tip>`, after `fdc9fd0d..ebda31cc`. The two are separate units.

**Static change, NOT run:**
- no test, syntax check, import, factory call, file read, HTTP, RPC, start, signature, submission or charge;
- **not a running resident.**

## The gap

The live step (`resident/live/step.mjs`) took `stop` and `submittedKeys` from whoever called it. Nothing connected them to the resident's own stop or to the keys its journal had already submitted.

## The producer contract (`resident/resident.mjs`, unchanged)

- **`charter.json`** (`createCharter`): `{v: 1, id, owner, limits.maxTurns, haltFile, …}`.
- **`state.json`** (`createStateStore`; one file for the resident and the agent ledger): `{v: STATE_VERSION (2), turn, journal, …, agentWallet: {agents: {[id]: {mode, policy, agentKey, owner, …}}}}`.
- **The stop** (`#stopReason`), in order:
  1. `policy.revoked` → `authority-revoked`;
  2. the halt file exists → `halted-by-operator`;
  3. `mode !== 'auto'` → `stopped-by-owner`;
  4. `turn >= maxTurns` → `max-turns` (it keeps promises).
- **Journal lines:**
  - `#run` sets `sendKey` (`key`, or `key#aN` for attempt N) with or after the submit. A board line is posted, not sent.
  - `#reconcile` reads `sent`/`unresolved` lines.
  - `#applyRevocation` treats `intended` with `lastError: 'Transport'` and a `sendKey` as sent (a lost reply).

## The fix

| File | Change |
|---|---|
| `resident/live/resident-state.mjs` (new) | **`readResidentState({dir, wallet, fs})`**, through an injected reader (`readText`, `exists`). <ul><li>Reads `charter.json`, `state.json` and the halt file's existence. **Never constructs a Resident** (its constructor may make a key, create the ledger record, set the mode and save). **Never opens the key file and writes nothing.**</li><li>**The stop:** `#stopReason`'s order and meaning. Anything unknown is **`state-unknown`, a stop, never "auto"**: an absent or unparsable file, another state version (an older one is migrated only by the resident), no ledger record, an agent key that is not the live wallet, owners that differ between charter and ledger, a relative halt path (its meaning depends on the working directory), or a halt file that cannot be checked.</li><li>**Submitted keys:** `action` lines with a `sendKey` in `sent`/`unresolved`, and `intended` + `Transport` + `sendKey`. Board lines and `intended` lines without a `sendKey` are **not** sends (the latter are listed as `unsent`). Final lines are not read.</li><li>**Every submitted key is held:** the resident's files record **no world, clock or execution port** for its keys, and the test harness's `MOCK_WORLD` keys look the same. So none is read against the live execution port, and the reason is given.</li></ul> |
| `resident/live/factory.mjs` | **New option `residentDir`.** At each `step()` call (not at creation), it reads the resident's state with node's `readFileSync`/`existsSync` over `charter.json`, `state.json` and the halt file. <ul><li>**Stop:** the resident's stop is used, and a caller's `stop` may add one but never clear it.</li><li>**Keys:** only the resident's are used (today: none, all held).</li><li>**Output:** the step's result carries `resident: {stop, facts, submittedHeld, submittedWhy, unsent}`.</li><li>**Without `residentDir`:** the earlier API is unchanged.</li></ul> |

**stop-A is unchanged:**
- under any stop, no observation, decision or plan;
- only `execution.status` of the keys given, which today is none because they are held;
- never `submit`, `cancel` or a re-send.

## Second tip: the parent's review of `5ab89984`

**Do not adopt `5ab89984` alone.**

1. **The halt check.**
   - **Before:** the factory used node's `existsSync`, which answers `false` on a permission error or a bad path component as well as on absence. The reader took any non-`true` answer as "not halted".
   - **Now:** the factory's `existsForHalt` uses `lstatSync`:
     - present (a link counts, even a dangling one) → `true`;
     - **only ENOENT** → `false`;
     - any other error throws.
   - **The reader accepts only `true` or `false`.** Anything else, or a throw, is `state-unknown` (a stop).
2. **Owner and policy.**
   - **Before:** a charter without an owner address skipped the owner comparison, and a missing policy read as "not revoked", so such a state could run as `auto`.
   - **Now:**
     - **Owner:** the charter must name `owner.address`, and the ledger's `owner` must equal it. `Resident` creates the ledger record with `owner: charter.owner.address`, so a normal state passes.
     - **Policy:** it must be the ledger's own shape, an object with `version ≥ 1` (`ledger.mjs` `create` saves `{...policy, version: 1}`; `setPolicy` increments it).
     - **`revoked`:** absent means not revoked (the normal saved policy, kept backward compatible); a boolean is taken as given; any other value is unknown.
     - **Anything else is `state-unknown`.**
3. **Unchanged:**
   - the stop order;
   - the submitted keys held (no recorded world or port);
   - stop-A: results read only, no new operation, no re-send;
   - `Resident`, the agent ledger and every producer.

## Not connected (concrete)

1. **Reading the held keys against the live execution port.**
   - **What's missing:** the resident must record which world (workstream 12's `{cluster, world_id}`) and execution port its keys were submitted to. That is a change to `resident/resident.mjs`, which this unit does not make.
   - **Where it would go:** a `world` field set at join in `state`, and checked in `#run` before `submit`.
2. **`max-turns`:** the resident keeps promises by code. The live path cannot, because enacting is not connected.
3. **Still not connected from the earlier unit:** enacting (signing, posting, submitting), join, a running resident, and the persistent key and identity.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-resident-state.test.mjs` (new)

- **Running state:** submitted keys found and held with the reason; unsent intents and board records not sends; final lines skipped.
- **The stop order:** revoked > halted > manual > max-turns (with `keepPromises`); no mode is not auto.
- **Every unknown case** → `state-unknown`, and no keys.
- **Pinned to `resident.mjs`:** `STATE_VERSION`, and the `#stopReason` order.
- **The reader** reads no key, writes nothing, and constructs no Resident.
- **The factory (as text):** reads at `step()` only; the caller can add a stop but not clear one; only the resident's keys are used; nothing is read before `step()`.
- **(second tip) The halt check:** only `true` or `false` is accepted; `undefined`, `null`, numbers, strings, an object or a throw are unknown. The factory's `existsForHalt` treats only ENOENT as absent, and `existsSync` is not used.
- **(second tip) Owner and policy:** a normal versioned policy without `revoked` runs. These are unknown: no charter owner, an owner without an address, no ledger owner, no policy, no version, version 0, and a non-boolean `revoked`. `revoked: true` stops (`authority-revoked`), and `revoked: false` runs.

## Hand-over (Lane D)

**Unit:** `claude/ws13-resident-state-20261117`, two commits on `ebda31cc` (`5ab89984`, then the correction). Take the final tip's diff from `ebda31cc`, all `100644`:
- `workstreams/13-citizens/resident/live/resident-state.mjs` (A)
- `workstreams/13-citizens/resident/live/factory.mjs` (M)
- `workstreams/13-citizens/test/live-resident-state.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-RESIDENT-STATE-20261117.md` (A)

**Not run:** anything.

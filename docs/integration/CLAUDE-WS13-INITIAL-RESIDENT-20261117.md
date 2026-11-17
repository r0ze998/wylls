# ⑬ operator resident: a new resident directory, stopped from the start, from public values only (2026-11-17)

**Branch:** `claude/ws13-initial-resident-20261117`, one commit **on `cd2f6683`** (the one-step entry's final tip, unchanged).

**Adoption and closure:**
- take this unit's own diff `cd2f6683..<this tip>`, **after the one-step entry** `d00f13b4..cd2f6683`, because its regression uses `runOnce`;
- **product code dependencies:** `resident-state.mjs` (in the aggregate) and the pieces named below.

**Static change, NOT run:**
- no test, syntax check, import, call of these functions, Resident constructed, HTTP, RPC, runexec, key, signature, submission, charge or runner;
- **no directory or file was made.**

## The gap

The one-step entry needs a resident directory (`charter.json`, `state.json`). Until now one could be made only by constructing a `Resident`. Its constructor:
- may make and save a key (`resident.key`);
- creates the agent ledger's record;
- **switches it to `auto`**;
- saves.

## The producer formats (checked)

| File | Format |
|---|---|
| `charter.json` | `resident.mjs` `createCharter`: `{v: 1, id, name, goal (GOALS), pos, owner, funder (the owner when absent), stoppedBy, siblings, limits (DEFAULT_LIMITS + given), budget (DEFAULT_BUDGET + given), haltFile (dir/HALT), undecided, lifetime}` |
| `state.json` | the constructor's initial state (`v: 2`, `turn: 0`, empty journal, …) and the agent ledger in the same file (`agentWallet`), made by `AgentLedger.create(...)`: `mode: 'manual'`, `policy: {allowed: [], budget, version: 1}`, zero balances, a `created` history line. The constructor then calls `setMode('auto')`. |

## The fix

| File | Change |
|---|---|
| `resident/resident.mjs` (minimal hunks, behaviour unchanged) | **`charterOf(dir, c)`:** the object `createCharter` builds, now built without writing. `createCharter` = `charterOf` + `mkdir` + write, in the same order (the goal is still checked before `mkdir`). **`initialStateOf(charter)`:** the constructor's initial state; the constructor now calls it. One source each, so the new entry cannot drift from the resident's own formats. |
| `resident/live/initial.mjs` (new) | <ul><li>**`initialResident(input)`, pure:**<ul><li>**Explicit values only:** `dir` (absolute, normalized, not the root); `id` (1..64, no spaces; also the agent id); `name`; `goal` (one of `GOALS`); `owner.address` (the operator's public address); `funder` (optional, as the charter: the owner when absent); `wallet` (the resident's own public address); `createdAtMs` (given; **the clock is not read**); optional `limits`, `budget` and `siblings` as `createCharter` takes them. The test world's `pos` is `null` (not used by the live path).</li><li>**Charter:** from `charterOf`.</li><li>**State:** from `initialStateOf` plus **`AgentLedger.create` on an in-memory store** (its own record format), never `setMode('auto')`. The result is checked to be `manual` with nothing allowed.</li><li>**On a bad input:** `{ok: false, missing}`, with nothing invented.</li></ul></li><li>**`writeInitialResident({dir, charter, state})`, the explicit save:**<ul><li>the input must be `initialResident`'s result for this `dir`;</li><li>the parent must be a real directory (no link);</li><li>`dir` is made **non-recursively**, so an existing directory or link is refused, never reused or overwritten;</li><li>`dir` is checked to be a real directory owned by this process's user;</li><li>`charter.json`, then `state.json`, are created **exclusively** (`wx`, 0600), written whole (a short write fails) and synced, then the directory is synced.</li></ul>On any failure it stops and says where (`step`, `why`, what was written). **Nothing is removed or cleaned up**: an incomplete directory reads as `state-unknown`, which is a stop. **No halt file** is made: the stop is the `manual` mode.</li></ul>Nothing runs at import. |

**What it never does:**
- read or make a private key;
- choose a wallet, owner or funder;
- fund, authorize, switch to `auto`, join, connect to a world, sign or send.

## The way through (not run)

1. **Build:** `initialResident({dir, id, name, goal, owner: {address}, wallet, createdAtMs})` → `{ok, charter, state}`.
2. **Save:** `writeInitialResident({dir, charter, state})` → `{ok: true, wrote: ['charter.json', 'state.json']}`.
3. **Read back:** `readResidentState(dir, wallet)` → `stop: stopped-by-owner`, with no submitted key.
4. **One step:** `runOnce({heraldUrl, wallet, residentDir: dir})` (or `bin/live-once.mjs`) → `outcome: 'stopped'`. With no execution port, no key is read and no network is used.

**Leaving the stop** is the owner's signed mode command (the agent wallet's owner commands). It is **not offered here**.

## Next concrete connection (not made)

- **Leaving the stop:**
  - the owner's signed `mode` command for this record (`owner-auth.mjs`, the agent wallet's owner routes);
  - then a live step proposes, still `enacted: false`.
- **Enacting** needs the resident's signing authority and the agent wallet's `send`, with `ws04ActsPort(…, {registry})`, so its lines record an origin.
- **Not supplied:** the operator wallet, the funding and the authority.
- **Also not connected:** join, a running resident, and a persistent key and identity.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-initial.test.mjs` (new)

- **The pure assembly:**
  - the charter equals `charterOf`, with `HALT` and the funder defaulting to the owner;
  - the state equals `initialStateOf` plus the ledger record: `manual`, `policy {allowed: [], budget, version: 1}`, `agentKey`, `owner`, `createdAt`, zero balances;
  - the same input gives the same content (no clock, no random id).
- **Missing or malformed values** are named: the seven required ones; a relative, root or non-normalized dir; an id with spaces or too long; an unknown goal; an owner without an address; a bad funder; an empty wallet; a bad time.
- **Read back:** `stopped-by-owner` with no keys; another wallet gives `state-unknown`.
- **The save** (in a `mkdtemp` folder the test removes):
  - written once, with mode 0600;
  - no `HALT` and no key file;
  - a second save refused at `mkdir`, with nothing overwritten;
  - a link refused, with the link and its target untouched;
  - no parent refused; another directory's input refused before anything is made;
  - then **`runOnce` says `stopped`**, with fetch never called.
- **As text:**
  - no `setMode`, key function, `new Resident`, `createCharter(` call, clock, random id, removal, recursive `mkdir` or `writeFileSync`;
  - a non-recursive `mkdir` and exclusive files;
  - `createCharter` and the constructor use the two builders;
  - the constructor still switches a new resident to `auto`, which is why it is not used here.

## Hand-over (Lane D)

**Unit:** `claude/ws13-initial-resident-20261117`, one commit on `cd2f6683`, all `100644`:
- `workstreams/13-citizens/resident/resident.mjs` (M)
- `workstreams/13-citizens/resident/live/initial.mjs` (A)
- `workstreams/13-citizens/test/live-initial.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-INITIAL-RESIDENT-20261117.md` (A)

**Not run:** anything. No resident directory was made.

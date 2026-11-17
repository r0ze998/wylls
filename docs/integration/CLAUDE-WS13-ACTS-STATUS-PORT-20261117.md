# ⑬ operator resident: a status-only result port over workstream 4's registry, assembled in the live factory (2026-11-17)

**Branch:** `claude/ws13-acts-status-port-20261117`, one commit **on `a2c5cb52`** (the key-provenance unit's final tip, unchanged).

**Adoption:** take this unit's own diff `a2c5cb52..<this tip>`, after `1c3f96a5..a2c5cb52`. They are separate units.

**Static change, NOT run:**
- no runexec, test, syntax check, import, factory call, HTTP, RPC, start, key, signature, submission or charge;
- **not a running resident.**

## The gap

- **No result port for stop-A:** the live factory's stop-A needs an execution port with `status()` and a declared origin `{registry, agentId}`. None existed.
- **The full port doesn't fit:** ⑬'s `ports/ws04-acts.mjs` `ws04ActsPort` needs `send`, registers before sending, and declares no origin. That is too much for a result reader, and not enough to be matched.

## What workstream 4's client does (`workstreams/04-execution/clients/acts.mjs`, unchanged)

- **Construction:** `createActsClient({bin, db, gatewayPort?, bridge?})` keeps its arguments and runs nothing.
- **`status({agentId, key})`:** runs `runexec act status --agent … --key … --db …` (no shell).
  - **With a `gatewayPort`:** runexec also reads the agent wallet's `GET /f/agent/fate` on 127.0.0.1 once and **records that answer in the run store** `db`.
  - **Without one:** it answers from the store only.
- **NoRecord:** runexec's own NoRecord (exit 3) is `NoRecord`; any other "NoRecord" is `Spawn` (D's `1fd0e274`, in the aggregate).

## The fix

| File | Change |
|---|---|
| `resident/ports/ws04-acts-status.mjs` (new) | **`ws04ActsStatusPort(acts, {agentId, registry})`** → a frozen `{kind, access: 'status-only', origin, status(key)}`. **No submit, register, cancel or send.** <ul><li>**`status`:** `null` **only** for workstream 4's NoRecord. Otherwise it reuses ⑬'s `fateOfReceipt`: unknown stays unknown, `registered` is pending, expired and not-sent are kept as given, a Duplicate with a signature is a Duplicate failure (never this key's success), and commitment, final and conflict are kept. Any failure, and an unqueryable or unknown state, throws `Unqueryable`.</li><li>**`origin`:** `{kind: 'workstream 4 act registry', registry, agentId}`. `registry` is the **caller's explicit, non-secret name** for the registry this client is connected to, and `agentId` the agent's. It is required (a missing or malformed one is refused), fixed at creation, and **never inferred** from a kind label or the db file's name. It grants nothing; it is only matched.</li><li>**`kind`:** the registry's kind, the same the resident's port declares; status-only is `access`.</li></ul> |
| `resident/live/factory.mjs` | **New option `actsStatus: {bin, db, gatewayPort?, bridge?, registry, agentId}`.** It builds `ws04ActsStatusPort(createActsClient({bin, db, gatewayPort, bridge}), {agentId, registry})` at creation, **with no IO**. <ul><li>`bin` and `db` must be absolute.</li><li>`gatewayPort` must be a port number or null.</li><li>Giving both `execution` and `actsStatus` is refused.</li></ul>The port is what stop-A reads with: `execution.origin` takes part in matching, and `execution.status` is called for the matched keys. |

**Unchanged:**
- workstream 4's client and runner;
- the resident's full execution port;
- stop-A (matched keys' status only; no new operation, re-send or cancel);
- older lines, which stay held (no provenance).

## The side effect, stated

Each stop-A status read runs runexec once. **With `gatewayPort` it also reads the wallet once and writes the answer into workstream 4's run store.** That is workstream 4's own behaviour, not added here. Without `gatewayPort`, it is a store read only.

## Not connected yet

1. **The resident's own port declares no origin yet.** For a line's provenance to record `execution: {registry, agentId, kind}`, whoever wires the resident's execution port (`ws04ActsPort` through the harness's `wire`, or the operator's own assembly) must attach the same `origin` the status port states. **Next concrete candidate:** an `origin` option on `ws04ActsPort` (⑬'s own file), set from the same explicit `{registry, agentId}`. That is a one-line addition to its returned object plus the regression. It is not made here.
2. **The earlier units' gaps remain:** enacting, join, a running resident, persistent key and identity, and max-turns' promise-keeping on the live path.

## Regression (written, NOT run): `workstreams/13-citizens/test/ws04-acts-status.test.mjs` (new)

- **The surface:**
  - only `kind`, `access`, `origin` and `status`, frozen;
  - the origin as stated;
  - each malformed setting refused.
- **Answers:**
  - landed with commitment kept;
  - unknown, registered → pending, expired, not-sent;
  - Duplicate → failed with no signature;
  - NoRecord → null;
  - Spawn, StoreError, unqueryable and an unknown state → `Unqueryable`;
  - bad keys refused;
  - never `register`; always its own agent id.
- **Matching:**
  - the same stated registry and agent match (`provenanceMismatch`, `bindingMismatchOf`);
  - another registry, or a kind label alone, does not.
- **As text:**
  - the side effect is stated;
  - nothing but status;
  - the factory builds the port from explicit settings, refuses both options together, and reads or runs nothing at creation.

## Hand-over (Lane D)

**Unit:** `claude/ws13-acts-status-port-20261117`, one commit on `a2c5cb52`, all `100644`:
- `workstreams/13-citizens/resident/ports/ws04-acts-status.mjs` (A)
- `workstreams/13-citizens/resident/live/factory.mjs` (M)
- `workstreams/13-citizens/test/ws04-acts-status.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-ACTS-STATUS-PORT-20261117.md` (A)

**Not run:** anything.

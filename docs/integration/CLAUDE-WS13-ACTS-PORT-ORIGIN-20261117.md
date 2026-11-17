# ⑬ resident's execution port: an explicit registry origin, the same contract as the status-only port (2026-11-17)

**Branch:** `claude/ws13-acts-port-origin-20261117`, one commit **on `2908b7bb`** (the status-port unit, unchanged).

**Adoption:** take this unit's own diff `2908b7bb..<this tip>`, after `a2c5cb52..2908b7bb`. They are separate units.

**Static change, NOT run:**
- no test, syntax check, import, factory call, runexec, HTTP, RPC, signature, submission, charge, key or runner;
- **not a running resident.**

## The gap

- **The resident's full execution port** (`resident/ports/ws04-acts.mjs` `ws04ActsPort`) stated no origin, only a `kind` label.
- **The effect:** the resident's new journal lines recorded `execution: null` (`resident.mjs` `#provenance`), and the live reader held them. They could never match the status-only port's origin `{registry, agentId}`.

## The fix

| File | Change |
|---|---|
| `resident/ports/ws04-acts.mjs` | <ul><li>**`REGISTRY_KIND`** and **`registryOrigin(agentId, registry)`** (new, exported): the one origin contract. `registry` must be the caller's explicit, non-secret name (no spaces, 1..256 characters); it is never inferred and grants nothing. The result is a frozen `{kind, registry, agentId}`.</li><li>**`ws04ActsPort(acts, {agentId, send, runId, registry})`:** a new **optional** `registry`. When given, the port states `origin`, made by `registryOrigin` with the port's own `agentId`. It is **fixed at creation**: enumerable (a caller's `{...port}` keeps it), not writable and not configurable. **Omitted or null** (every earlier caller): **no `origin`, as before**, and nothing is inferred.</li><li>**Unchanged:** `kind` (the same string, now the constant); `submit` (BadKey check, register first, then the caller's `send`); `status` (null only for workstream 4's NoRecord, else `fateOfReceipt`); `cancel` (NotSupported); retention.</li></ul> |
| `resident/ports/ws04-acts-status.mjs` | Uses `registryOrigin` and `REGISTRY_KIND` from `ws04-acts.mjs`, which it already imported from. There is **no import cycle**: the full port imports nothing from the status port. Its surface and answers are unchanged, and it still exports `REGISTRY_KIND`. |

**How it connects:**
- A resident wired with `ws04ActsPort(…, {registry})` records `execution: {registry, agentId, kind}` on each **new** line.
- A live factory given `actsStatus: {…, registry, agentId}` with the same values matches those lines (`bindingMismatchOf`, `provenanceMismatch`), and stop-A reads their status.
- **Older lines** (no provenance, or `execution: null`) stay held. Nothing is upgraded.

## Existing callers (checked)

- **`ws04ActsPort` callers:** only tests (`test/stack.test.mjs`, `test/ws04-acts.test.mjs`, `test/ws05-cost.test.mjs`). **None has an adopted registry setting**, so none is given one here. They stay undeclared, as before, and their behaviour is unchanged.
- **No production assembly** of the resident's execution port exists in the tree: no call outside tests.

## Next concrete gaps for the real world

1. **No production wiring of the resident.**
   - **The only constructor of a `Resident`** is `world/harness.mjs` `openResident`: the test world, with `wire(resident)` as the hook to set a workstream 4 port.
   - **What a real operator assembly needs:**
     - a real observe port declaring a real world and clock (the live `observe.mjs` is a separate path, not the resident's `ports.observe` shape);
     - `ws04ActsPort` with `registry` over `createActsClient({bin, db, gatewayPort})`;
     - the agent wallet's `send`;
     - a board port;
     - a memory port;
     - a provider that does not charge;
     - and the identity.
   - **Not built:** the operator identity, wallet, funding and stop ownership must be supplied, and they are not.
2. **Enacting from the live path** (signing, posting, submitting), **join**, a **running resident**, **persistent key and identity**, and **max-turns' promise-keeping** remain unconnected.

## Regression (written, NOT run): `workstreams/13-citizens/test/ws04-acts-status.test.mjs` (extended)

- **No registry:**
  - no `origin`, and the same `kind`;
  - `null` is treated as omitted.
- **With a registry:**
  - the frozen origin, equal to the status port's;
  - not writable and not deletable;
  - kept by a spread;
  - each malformed name refused.
- **`submit`, `status` and `cancel`:** the same calls and answers with and without a registry, including a refused over-long key.
- **Matching:** a line recorded from the full port's origin matches the status port's origin.
- **Contract and wiring:** `registryOrigin` is the one contract; the full port does not import the status port; the resident records `ports.execution.origin`.

## Hand-over (Lane D)

**Unit:** `claude/ws13-acts-port-origin-20261117`, one commit on `2908b7bb`, all `100644`:
- `workstreams/13-citizens/resident/ports/ws04-acts.mjs` (M)
- `workstreams/13-citizens/resident/ports/ws04-acts-status.mjs` (M)
- `workstreams/13-citizens/test/ws04-acts-status.test.mjs` (M)
- `docs/integration/CLAUDE-WS13-ACTS-PORT-ORIGIN-20261117.md` (A)

**Not run:** anything.

# ③ MCP: a settle record with an outcome the ABI does not define is held, not completed (Lane C, 2026-11-17)

**Branch:** `claude/lane-c-ws03-settle-outcome-unknown-20261117`, from the shared aggregate at `f705221623239270ccc9bf4fc797d53e3f4c6d3f` (fixed base). The aggregate and every other branch are unchanged.

**Written, not run:** no test, syntax check, import, server, world or send.

## The path (source at `f7052216`)

| Step | Source | What it does |
|---|---|---|
| ABI | `frontier-abi/src/v2/log.rs:192-195` `caravan_outcome` | `DELIVERED = 0`, `LOST = 1`, and nothing else |
| Program | `permutation-frontier/src/proc/caravan.rs:1039-1041` | Emits only those two |
| Decoder | `mcp/src/events.mjs` `decodeCaravanRecord` / `caravanEvent` | Passes the payload byte through. `SETTLE_OUTCOME = {0: 'delivered', 1: 'lost'}` |
| Evidence (before) | `mcp/src/server.mjs`, the evidence loop, `CARAVAN_SETTLED` | `SETTLE_OUTCOME[x.payload.outcome] ?? 'settled'`. Any other value, or none, became `op.outcome = 'settled'` and **`step(op, STATES.COMPLETED, …)`**, a terminal state |
| ④ view | `mcp/src/receipt-port.mjs` `ws04View` | `completed` with an outcome other than `delivered` becomes ④ **`Failed`** (`failReason['settled'] ?? 'Failed'`), with outcome `Unverifiable` |

**The defect:** a record the server cannot read ended the operation for good and was reported to ④ as `Failed`.

## The fix (`mcp/src/server.mjs`, the evidence loop's `CARAVAN_SETTLED` branch only; sha256 `10367c9a…9b10ea24`)

- **The guard.** When `!Object.hasOwn(SETTLE_OUTCOME, String(x.payload.outcome))`, the code calls `hold(op, 'Inconsistent', "the settle record's outcome … is not one the ABI defines (0 delivered, 1 lost): nothing is decided", { evidence: ref })` and `continue`.
  - This is the existing hold, the same one a mismatched `CARAVAN_SENT` gets.
  - A hold is not a state: nothing is decided and nothing is released.
  - The existing guard (`op.hold?.code === 'Inconsistent'` → `continue`) then keeps later settle and raid records from deciding the operation.
- **`0` and `1`** take exactly the old path: `op.outcome` from `SETTLE_OUTCOME`, the burned-raid rule, then `step(… COMPLETED …)`.
- **Stored operations** that are already `completed` are not reread or migrated: the loop stops at a terminal state (`if (TERMINAL.includes(op.state)) break;`).

**Not changed:**
- `events.mjs`, the ABI and the program;
- `receipt-port.mjs`: an `Inconsistent` hold maps to no ④ `held_reason`, as before for that hold;
- sending, auth, permissions;
- main's `initialize` and HTTP, and D's aggregate.

**Left as is (observation):** an unknown **raid** choice becomes `'raided'` (`RAID_CHOICE[…] ?? 'raided'`). That is not terminal: only `taken` completes. A later settle with `delivered` then completes as `delivered`. This was not in scope.

## Regression (`mcp/test/settle-outcome-unknown.test.mjs`, sha256 `c99b4ebd…779c8ece`, written, not run)

**Key-free by the existing convention:** it imports only `node:test`, `node:assert/strict` and `node:fs`, and reads `server.mjs`, `events.mjs` and `log.rs` as **text**. Exercising the evidence loop would need the MCP server and `test/fixture.mjs`, which generates keys.

- **O1:** the ABI defines exactly DELIVERED 0 and LOST 1, and `events.mjs` maps exactly those.
- **O2:** the guard, the `Inconsistent` hold and `continue` come before `op.outcome` is set and before the step to `COMPLETED`; the `?? 'settled'` fallback is gone.
- **O3:** the 0/1 path, the burned-raid rule, the terminal stop and the `Inconsistent` guard are unchanged.
- **Limit:** a source-text check. It does not run the loop.
- Candidate command (for the coordinator; not run): `node --test workstreams/03-composability/mcp/test/settle-outcome-unknown.test.mjs`.

## Hand-over

- **Base:** `f705221623239270ccc9bf4fc797d53e3f4c6d3f`.
- **Branch:** `claude/lane-c-ws03-settle-outcome-unknown-20261117` (the tip is given in the session report).
- **Three paths:**
  - `workstreams/03-composability/mcp/src/server.mjs` (M);
  - `workstreams/03-composability/mcp/test/settle-outcome-unknown.test.mjs` (A);
  - `docs/integration/CLAUDE-LANE-C-WS03-SETTLE-OUTCOME-UNKNOWN-20261117.md` (A).

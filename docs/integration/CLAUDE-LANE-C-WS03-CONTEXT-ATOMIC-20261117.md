# ③ MCP `Game.context()`: a new context is published only after it has been built (Lane C, 2026-11-17)

**Branch:** `claude/lane-c-ws03-context-atomic-20261117`, from the fixed base `29ce49c24ad642f5d7f35080c655d612a933ea68`. The aggregate, ⑫'s `f4a60d3e` branch (kept apart, not aggregated) and every other branch are unchanged.

**Written, not run:** no test, syntax check, import, server or world.

## The defect (source at `29ce49c2`, `mcp/src/game.mjs` `context()`)

On a new key, the code ran in this order:
1. push the old context to `contextChanges`;
2. **set `this.pinned` to the new key**;
3. `this.addresses = this.addressesFor(…)`;
4. `this.herald.pin(…)`;
5. finally `this.pinnedAt = t`.

`addressesFor` (default `faddr.seasonAddresses`) throws on a malformed program id (`pubkeyString`, `seasonPda`). When it threw:

- **On the first read:**
  - `pinned` already named the new key, `addresses` was `undefined` and the herald was unpinned.
  - The next call re-read the relay (`t - undefined` is `NaN`). The key equalled `pinned.key`, so it **skipped the assembly**, set `pinnedAt`, and returned a context with no addresses. `view` then failed on `this.addresses.of`.
- **On a switch:**
  - `pinned` named the new world while `addresses` and the herald pin were still the old world's, and `contextChanges` already recorded a switch that had not happened.
  - Within the TTL of the previous `pinnedAt`, that mismatched context was returned. After the TTL, the same key skipped the assembly for good.

`herald.pin` (`permutation-server/web/frontier/herald.mjs:452`) only assigns two variables and does not throw.

## The fix (`mcp/src/game.mjs`, `context()` only; sha256 `4931a9a0…a3b1e1ff`)

The next context and its addresses are built into locals first. Only after `addressesFor` succeeds does the code, in order:
1. pin the herald;
2. record the old context in `contextChanges`;
3. publish `pinned` and `addresses`.

`pinnedAt` is updated only on success, as before.

**On failure, nothing changes:**
- the old `pinned`, `addresses`, herald pin, `contextChanges` and `pinnedAt` stay;
- the error propagates as before;
- the next call re-reads the relay and retries: after a failed first read, `pinned` is `null`; after a failed switch, once the TTL ends, the relay's key differs from the old one.

**Not changed:**
- how identifiers are accepted (`key`, `programId`, `seasonId` as before);
- the meaning of the TTL;
- the herald client, auth, sending and permissions;
- `server.mjs` (main's `initialize`), and D's aggregate.

## Real consumers (read, not run)

- `game.mjs` `season()` → `context()`, and `view()`, which uses `this.addresses.of('Citizen', …)` and the pinned herald.
- `server.mjs:92-96` `connection`: `context()` (`null` on error) and `contextChanges`.
- `server.mjs:328` and `:678`: `context().key` (`null` on error).

All of them already handle a thrown `context()`. After the fix they never see a published context without its addresses.

## Regression (`mcp/test/context-atomic.test.mjs`, sha256 `9861960d…63baea0a`, written, not run)

It constructs `Game` with the constructor's own seams: a fake `fetch` for the relay, a `now` variable and an injected `addressesFor`. It replaces `herald.pin` with a recorder. No network is reached and no address is derived inside the test.

- **A1:** a failed first build pins nothing; the next read builds again and pins.
- **A2:** a failed switch keeps the old context object, addresses, pin and an empty history. After the TTL, the retry switches and records the old context once, with `until` equal to the new `since`.
- **A3:** unchanged behaviour. Within the TTL the relay is not read, and the same key after the TTL is not built again.

**Not independent, not key-free:** it imports `game.mjs`, whose static closure reaches `fland.mjs` and `lang.mjs` (the subjects of refused tests) and files that name key APIs. Whether it may run, and then only through the repository's key-free guard, is the coordinator's decision. The key lists are not changed.

## Not verified

No run of anything. The real relay and herald were not observed.

## Hand-over

- **Base:** `29ce49c24ad642f5d7f35080c655d612a933ea68`.
- **Branch:** `claude/lane-c-ws03-context-atomic-20261117` (the tip is given in the session report).
- **Three paths:**
  - `workstreams/03-composability/mcp/src/game.mjs` (M);
  - `workstreams/03-composability/mcp/test/context-atomic.test.mjs` (A);
  - `docs/integration/CLAUDE-LANE-C-WS03-CONTEXT-ATOMIC-20261117.md` (A).

# ③ MCP `get_village_status`: an unread storehouse's `cap` is `null`, not 0 (Lane C, 2026-11-17)

**Branch:** `claude/lane-c-ws03-vault-cap-unknown-20261117`, from `claude/lane-c-ws03-status-unknown-20261117` at `5d60fff3002bf4c268fa3d14f6e409d4758cfb3a`. That branch is itself one commit on the shared aggregate `8a1d799f3c0f886b4406ae4a99bb631740ab53da`, which was the aggregate's origin tip when read.

**Why that base:** it carries the description sentence this change has to stay consistent with. The aggregate, `5d60fff3`'s branch and canonical are not changed.

**Written, not run:** no test, syntax check, import, server or world.

## The facts (source)

- **Upstream contract:** `permutation-server/web/frontier/herald.mjs:1004-1013` `vaultOf` adds `stores` and `cap` **together**, and only once the herald has read the vault's bytes: `...(stores ? { stores, cap: … ?? 0 } : {})`. When the bytes were not read, both are absent.
- **The path:** `game.view` reads the feed through `createHerald` → `caravans()` → `parseCaravans` (`herald.mjs:356-358`, `:1022`), so its vaults follow that contract.
- **Before** (`mcp/src/game.mjs` `view`): `known: Array.isArray(v.stores)` and `stores: … : null`, but `cap: Number(v.cap ?? 0)`. So an unread storehouse came out as `known: false, stores: null, cap: 0`, and `server.mjs` `status` returned it as `storehouses[].cap: 0`: a known capacity of 0.
- **Who reads a place's `cap`:** only `server.mjs:108` `status`, which passes it through. `Game.plan`, `Game.shortfall` (whose storehouse sources take only `known` places), `send` and the confirm text do not read it, so sending, judgement and permissions cannot depend on it. No test or e2e reads a storehouse `cap`.

## The change

| File | Change |
|---|---|
| `mcp/src/game.mjs` (sha256 `d26e1ea7…f0cb2451`) | `cap: Array.isArray(v.stores) ? Number(v.cap ?? 0) : null`, with a comment citing `vaultOf`. With `stores` read, the expression is byte-for-byte the old one. Nothing else in `view` changed |
| `mcp/src/tools.mjs` (sha256 `7783a145…28c22107`) | The `get_village_status` sentence from `5d60fff3` now reads "A storehouse with known: false has stores: null and cap: null: its stores and capacity are not known, not 0." |
| `mcp/test/status-unknown-description.test.mjs` (sha256 `0d4ca74a…eac991d4`) | U2 updated to that sentence, with the reason in a comment. The test has not been run, before or after |
| `mcp/test/vault-cap-unknown.test.mjs` (new, sha256 `1fd29001…e9537273`) | See below |

**Not changed:**
- `herald.mjs` (the upstream contract);
- `server.mjs` (`status`, `handle`, HTTP);
- the schema, permissions, sending and judgement;
- main's store, D's `http.listen`, and the aggregate.

## One-time falsification (by reading; nothing run)

| Case | Before | After | Holds? |
|---|---|---|---|
| Bytes not read (`stores` and `cap` absent) | `known: false, stores: null, cap: 0` | `known: false, stores: null, cap: null` | Yes: unknown stays unknown |
| Bytes read, `cap` given | `Number(v.cap)` | The same expression | Yes |
| Bytes read, `cap` absent (`vaultOf` gives 0) | 0 | 0 | Yes |
| `plan` with an unknown source | `Unknown` ("the storehouse's stores are not known yet"), `cap` never read | The same | Yes |
| `shortfall` storehouse sources | Only `pl.known` places, `cap` never read | The same | Yes |

## Regression (`mcp/test/vault-cap-unknown.test.mjs`, written, not run)

- **Key-free by the existing convention:** it imports only `node:test`, `node:assert/strict` and `node:fs`. It reads `game.mjs` and `herald.mjs` as **text**, without importing them. Exercising `game.view` would need `test/fixture.mjs`, which generates keys (`generateKeyPairSync`), and importing `game.mjs` loads `permutation-server/web/frontier` modules next to the refused tests' subjects.
- **K1:** the new expression.
- **K2:** the old unconditional `cap: Number(v.cap ?? 0),` is gone, and `stores` is unchanged.
- **K3:** the upstream `vaultOf` line it relies on.
- **Limit:** a text check. It does not run `game.view`.
- It needs no key-list entry; the lists are unchanged.
- Candidate commands (for the coordinator; not run):
  - `node --test workstreams/03-composability/mcp/test/vault-cap-unknown.test.mjs`;
  - `node --test workstreams/03-composability/mcp/test/status-unknown-description.test.mjs`.

## Hand-over to D

- **Base:** `5d60fff3002bf4c268fa3d14f6e409d4758cfb3a`, on top of the aggregate `8a1d799f`.
- **Branch:** `claude/lane-c-ws03-vault-cap-unknown-20261117`, one commit.
- **Five paths against `5d60fff3`:**
  - `workstreams/03-composability/mcp/src/game.mjs` (M);
  - `workstreams/03-composability/mcp/src/tools.mjs` (M);
  - `workstreams/03-composability/mcp/test/status-unknown-description.test.mjs` (M);
  - `workstreams/03-composability/mcp/test/vault-cap-unknown.test.mjs` (A);
  - this report (A).
- Against the aggregate `8a1d799f`, it carries `5d60fff3`'s three paths as well.

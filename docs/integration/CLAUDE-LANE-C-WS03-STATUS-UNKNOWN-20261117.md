# ③ MCP `get_village_status`: the description says how to read what was not read (Lane C, 2026-11-17)

Branch `claude/lane-c-ws03-status-unknown-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `8a1d799f3c0f886b4406ae4a99bb631740ab53da` (the same on origin when read). Neither the aggregate nor `5411b878` is changed.

Written, not run: no test, syntax check, import, server or world.

## The existing behaviour (source at `8a1d799f`; not changed)

- **`mcp/src/game.mjs` `view`:**
  - when the caravan feed is not `ok`, `vaults` and `moving` are `[]`, so no storehouse places and no caravans;
  - a vault whose `stores` is not an array gets `known: false, stores: null`;
  - `feedOk: feed.ok` is returned.
- **`mcp/src/server.mjs` `status`:**
  - `storehouses` (with `known`) and `caravansOnTheRoad` come from that view;
  - `caravanFeed: v.feedOk ? 'ok' : 'unavailable'`.
- **The gap:** the tool description did not say how to read these. An empty list could be taken as "none", and `stores: null` as nothing held.

## The change (`mcp/src/tools.mjs`, the `get_village_status` description only; sha256 `1df2a831…d85c9e33`)

Two sentences were added after the budget clause:

> caravanFeed says whether the caravan feed was read: when it is "unavailable", storehouses and caravansOnTheRoad are empty because they were not read, not because there are none. A storehouse with known: false has stores: null: its stores are not known, not 0.

**Not changed:**
- the data, the result's meaning and the schema;
- `server.mjs` and `game.mjs`;
- the other tools;
- permissions;
- main's store, and D's dispatcher, status and list areas.

**Who reads it:** only `server.mjs` `tools/list` serves this `TOOLS`. No test pins this description (searched: no `description` length or text check for `get_village_status`). `instructions-flow.test.mjs` checks `SERVER_INSTRUCTIONS` and other descriptions, which are unchanged.

## One-time falsification (by reading the code; nothing run)

| Claim | Code | Holds? |
|---|---|---|
| `"unavailable"` → both lists empty because not read | `caravanFeed` is `'unavailable'` exactly when `feed.ok` is false, and then `vaults` and `moving` are always `[]` | Yes |
| Does not claim anything when the feed **was** read | When `ok`, an empty list is the feed's answer; the description says nothing about that case | Yes (no over-claim) |
| `known: false` ↔ `stores: null`, not 0 | `known: Array.isArray(v.stores)`; `stores: … : null` | Yes |
| The village's own stores are unaffected | They come from the owner's record (`storesAt(h, …)`), not the feed | Yes (not mentioned) |
| Not claimed | An unknown vault's `cap` is `Number(v.cap ?? 0)` and may read 0. The description does not mention it | Left as is |

## Regression (`mcp/test/status-unknown-description.test.mjs`, sha256 `5dcfc96d…97ea5cee`, written, not run)

- **Key-free by the existing convention:** it imports only `node:test`, `node:assert/strict` and `node:fs`, and reads `tools.mjs` as text without importing it (like `instructions-flow.test.mjs`). It reaches no `game.mjs` and no `permutation-server/web/frontier` file. It needs no key-list entry; the lists are unchanged.
- **U1:** the "unavailable" sentence. **U2:** the `known: false` sentence. **U3:** the earlier sentences are unchanged.
- **Limit:** a text check of the description only.
- Candidate command (for the coordinator; not run): `node --test workstreams/03-composability/mcp/test/status-unknown-description.test.mjs`.

## Hand-over to D

- **Base:** `8a1d799f3c0f886b4406ae4a99bb631740ab53da`.
- **Branch:** `claude/lane-c-ws03-status-unknown-20261117`, one commit.
- **Three paths:**
  - `workstreams/03-composability/mcp/src/tools.mjs` (M);
  - `workstreams/03-composability/mcp/test/status-unknown-description.test.mjs` (A);
  - `docs/integration/CLAUDE-LANE-C-WS03-STATUS-UNKNOWN-20261117.md` (A).

# ⑬ operator resident: the resident's observation shape from the live read, and a declared, fail-closed observe port (2026-11-17)

**Branch:** `claude/ws13-resident-view-20261117`, one commit **on `8b8e14c6`** (the port-origin unit, unchanged).

**Adoption:** take this unit's own diff `8b8e14c6..<this tip>`, after `2908b7bb..8b8e14c6`. They are separate units.

**Static change, NOT run:**
- no test, syntax check, import, factory call, Resident constructed or stepped, HTTP, RPC, runexec, world, runner, key, signature, submission or charge;
- **not a running resident.**

## What the resident consumes, and what the live read grounds

The resident's consumers are `resident.mjs` (`step`, `#learn`, `#duties`, `#settleReturns`, `#noteDebts`, `#wakes`, `#decide`), `candidates.mjs` `buildCandidates` and `safety.mjs`. `RESIDENT_NEEDS` lists each field they read, the consumers that read it, and what the live read gives:

| Field | Live |
|---|---|
| `world.bell` | herald `/h/season` `latestUnix` through the Season clock (**informational, not finality**) |
| `world.villages[].{citizen, owner}` | **own Citizen only** (`/h/me`); no world-wide list |
| `world.villages[].stores` | not mapped (a Citizen has several S1 villages; the test world has one per citizen) |
| `world.villages[].{buildings, building, tier, cap, pos}` | not mapped (the test world's 1-D position and items) |
| `world.caravans` | not read |
| `world.events` | not mapped from the herald's program records |
| `world.me.quota.*` | not mapped (`/h/me` has a quota of another shape) |
| `world.me.pending` | not read |
| `board.requests[]` | not mapped: workstream 1's requests (need, destination village, `expiresAt`, goal, responses) are another schema, with no payment offer, open-to or return |
| `board.replies[]` | not mapped: workstream 1's responses are another schema |

## The fix (`resident/live/resident-view.mjs`, new; `factory.mjs`)

- **`residentObservationOf(liveObs, {wallet})`:** `{complete: false, view, missing}`.
  - **`view`:** only the grounded part. `world.bell` comes only with a herald time; `world.villages` is **only its own** `{citizen, owner, places}`; `board: null`.
  - **Missing fields are listed, with the consumer and why.** They are **never filled with an empty list or a guess**. Caravans, events and `me` are absent, not empty, and **workstream 1's requests are not turned into the test world's board.**
- **`observeDeclaration({herald, worldFromSeason, seasonClock})`:** one `/h/season` read → `{world, clock}`, real only (a continuous ws08 world and a valid Season clock), else `{world: null, why}`.
- **`residentObservePort({observe, wallet, declaration})`:** an async function in the resident's port form, with the declared `world` and `clock` attached (as `world/harness.mjs` `portsFor` attaches the mock ones).
  - **Creation:** refused without a real declaration (the mock world is not one).
  - **Each call:** reads the live observation and **throws `ResidentObservationIncomplete`**, carrying the grounded view and the missing fields. It also throws for another address, or when the observed world is not the declared one.
  - **Why throwing is the safe form:** the resident's `step` observes **first**, before `join` and before `#stopReason`. A resident given this port stops at its first line and never joins, decides or sends on a partial world.
  - **Provenance:** a line made under it would record a **real** binding, which matches only a complete one (`bindingMismatchOf`). An action line still needs a declared execution origin.
- **The factory** adds two calls, each a read when called and nothing at creation:
  - `residentView()`: one live observation, projected;
  - `residentObservePort()`: one `/h/season` read for the declaration.

  Neither decides or enacts. The existing `step()` (stop first, `enacted: false`) is unchanged.

**What this does not do:**
- it **never constructs a Resident**: its constructor may make a key, create the ledger record and save;
- it never calls a resident's `step`, joins, signs, posts, submits, registers or cancels;
- it picks no wallet, funding or authority;
- no charging provider, and no `Date.now`.

## Still missing (each needs a mapping or a reader that does not exist)

1. **The world beyond the resident's own villages:** a world-wide citizen and village list, with stock. The herald has no such endpoint; it would mean reading every province.
2. **Events in the resident's vocabulary:** a mapping from the herald's program records (`CARAVAN_SETTLED`, `CARAVAN_RAIDED`, …) to the resident's kinds, which is not defined.
3. **The board:** a request with a payment offer, open-to and return is not workstream 1's request. Either the resident's board rules change to workstream 1's (a design decision), or a board of that kind is adopted.
4. **The quota:** a mapping from `/h/me` `quota` to the resident's `bucket`, `relayLeft` and `lamportsLeft`.
5. **Positions and items:** the test world's 1-D `pos`, tier and buildings vs S1 places and S1 build items.
6. **Rules:** `candidates.mjs` uses the test world's rules (`world/rules.mjs`). The live path uses workstream 1's `planSend` instead (live candidates).
7. **The rest:** enacting, join, a running resident, persistent key and identity, and max-turns' promise-keeping.

Until 1 to 6 exist, a Resident cannot be given a real world. The live path (observe → candidates → decide → proposal, stop first, `enacted: false`) is the product path.

## Regression (written, NOT run): `workstreams/13-citizens/test/resident-view.test.mjs` (new)

- **The projection:**
  - grounded fields only;
  - every other need listed;
  - no board, caravans, events or `me` given as known;
  - no time → no bell, with why;
  - own villages unread → none, with why;
  - not a live observation → no view.
- **The declaration:** real only; http 404, unreachable, not continuous and a malformed clock each say why.
- **The port:**
  - refused without a real declaration, or with the mock world;
  - declares world and clock;
  - every call throws with the view and the missing fields;
  - another address, or a moved world, throws;
  - a line under it would record a real binding; board matches, action needs an origin.
- **As text:**
  - the resident observes before join and before its stop (why the port throws);
  - `resident-view.mjs` imports nothing, and constructs, joins, signs, sends and returns a partial view nowhere;
  - the factory's two calls.

## Hand-over (Lane D)

**Unit:** `claude/ws13-resident-view-20261117`, one commit on `8b8e14c6`, all `100644`:
- `workstreams/13-citizens/resident/live/resident-view.mjs` (A)
- `workstreams/13-citizens/resident/live/factory.mjs` (M)
- `workstreams/13-citizens/test/resident-view.test.mjs` (A)
- `docs/integration/CLAUDE-WS13-RESIDENT-VIEW-20261117.md` (A)

**Not run:** anything.

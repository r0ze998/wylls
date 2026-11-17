# ⑬ resident: where each new journal line belongs, recorded at creation, matched before any read (2026-11-17)

**Branch:** `claude/ws13-key-provenance-20261117`, one commit **on `1c3f96a5`** (the resident-state unit's final tip, unchanged).

**Adoption:** take this unit's own diff `1c3f96a5..<this tip>`, after `ebda31cc..1c3f96a5`. They are separate units.

**Static change, NOT run:**
- no test, syntax check, import, factory call, HTTP, RPC, start, key, signature, submission or charge;
- **not a running resident.**

## The gap

The resident's files recorded no world, clock, execution port or identity for a key. Every submitted key was therefore held, and stop-A could read none.

## The record (`resident/resident.mjs`, the minimum hunk)

**`#intent`, only when the key is new:**
- `provenance: this.#provenance()` is added after the spec, so a spec cannot replace it.
- It is **never** added to or rewritten on an existing line or a reused key.
- **The write-ahead order is unchanged and already covers it:** `#enact` calls `save()` after its intents and before `#run`; `#duties` calls `save()` after its intent and before `#run`. The record is saved before any send.

**`#provenance()`** returns `{v: 1, world, clock, execution, identity}`, **from the declared ports only**:

| Field | Source |
|---|---|
| `world` | the observe port's `{cluster, world_id}` (the test harness declares `MOCK_WORLD`, whose `world_id` is null) |
| `clock` | `frame.mjs` `clockId` of the observe port's clock |
| `execution` | the execution port's **explicit `origin`** `{registry, agentId, kind?}`, else `null`. The ports declare only a `kind` label ("workstream 4 act registry", "test-world (mock)"), which names no registry, so a label alone is never taken as one. The origin is attached by whoever wires the port, as the harness attaches world and clock to observe. It is a declaration, not an authority. |
| `identity` | the resident's address |

**Unchanged:**
- the state version (an added optional field; older readers ignore it);
- every send, retry, reconcile and stop rule;
- signing, authority and cost.

**Restart equivalence:** the values are deterministic for the same ports, so the restart and boundary transcripts stay equal.

## The match (`resident/live/resident-state.mjs`, `factory.mjs`)

- **`provenanceMismatch(provenance, live, wallet)`** returns null only when **every** point matches the live frame:
  - a ws08 world (`world_id` not null), with the same `cluster` and `world_id`;
  - the same clock id;
  - the same declared `registry` and `agentId` (and the same `kind` when both name one);
  - the live wallet.

  Otherwise it says why.
- **What is held:**
  - **a line made before this record:** no provenance;
  - a malformed record;
  - a `MOCK_WORLD` line;
  - another world, clock, registry, agent, kind or identity;
  - a missing live world, clock or origin.

  **Nothing is inferred or upgraded after the fact.**
- **`readResidentState({…, live})`** returns only the matching keys in `submitted.keys`, and every other one in `held` with why.
- **The factory**, at `step()`:
  - reads `/h/season` once (workstream 12's `worldFromSeason`, then `seasonClock`, then `clockId`) and takes the execution port's `origin`;
  - passes them as `live`. A failure leaves them unknown, and every key is held.
- **stop-A:**
  - only `execution.status` of the matching keys;
  - never `submit`, `cancel` or a re-send;
  - no observation, decision or plan.

  The `/h/season` read is a read, made also under a stop, as the resident itself observes under a stop.

## Limits (not connected)

1. **The origin must be declared:** nothing attaches `execution.origin` today. The operator wiring must attach the same declared `{registry, agentId}` to the resident's execution port and to the live factory's. Until then, new lines record `execution: null` and stay held.
2. **A port changed after a line was created:** a later retry of that line under a changed port is not detected here; the record is the line's creation. The reader only reads keys whose creation record matches.
3. **The earlier units' gaps remain:** enacting (signing, posting, submitting), join, a running resident, persistent key and identity, and max-turns' promise-keeping on the live path.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-resident-state.test.mjs` (extended)

- **`provenanceMismatch`:** the full match; a kind recorded on one side only; and every hold case:
  - none; an unknown version;
  - no live world, clock or origin;
  - a mock world, another cluster or world, another clock or none;
  - no recorded registry; another registry or agent; another kind; another identity.
- **`readResidentState` with a live frame:** the matching key is read; an older line and a mock line are held; under a stop the stop stands and only the matching key is offered.
- **`resident.mjs` (as text):**
  - the record only on a new key and after the spec;
  - never assigned elsewhere;
  - from the declared ports, with a kind label not taken as a registry;
  - saved before `#run` in `#enact` and `#duties`.
- **The factory (as text):** the live frame is read at `step()`; a failure is unknown.
- **The first tip's pins:** updated to the new `why` and to the `live` argument.

## Hand-over (Lane D)

**Unit:** `claude/ws13-key-provenance-20261117`, one commit on `1c3f96a5`, all `100644`:
- `workstreams/13-citizens/resident/resident.mjs` (M)
- `workstreams/13-citizens/resident/live/resident-state.mjs` (M)
- `workstreams/13-citizens/resident/live/factory.mjs` (M)
- `workstreams/13-citizens/test/live-resident-state.test.mjs` (M)
- `docs/integration/CLAUDE-WS13-KEY-PROVENANCE-20261117.md` (A)

**Not run:** anything.

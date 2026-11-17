# ⑬ resident: where each new journal line belongs, recorded at creation, matched before any read (2026-11-17)

**Branch:** `claude/ws13-key-provenance-20261117` **on `1c3f96a5`** (the resident-state unit's final tip, unchanged).
- `15e387f6` is the first tip.
- `c082f988` is the correction.
- The commit after it updates this report only.
- **Adopt the final tip only:** the diff `1c3f96a5..<final>`, 5 paths.

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

## Second tip: the parent's review of `15e387f6`

**Do not adopt `15e387f6` alone.**

### 1. A line used through other ports (`resident.mjs`)

- **The gap:** the record was only written. A line retried, reconciled or cancelled after its ports changed could be sent to another registry under its old record, and the other registry's result read as its own.
- **The fix:** `#bindingMismatch(it)` compares the line's provenance with what the ports declare **now**: world, clock, identity and, for an action line, registry + agent (a kind label alone never decides).
- **Where it's checked:** right before **every** use of the line's key:
  - `#run`, before the board post or the status read, and **again after the status `await`, before the submit**;
  - `#reconcile`, before the status read (its re-submit goes through `#run`);
  - `cancelAction`, before anything changes when the execution port would be asked.
- **On a mismatch:** the line is held. Its state is unchanged (**never failed or not-sent**), `bindingHeld` says why, and nothing is posted, read, sent, re-sent or cancelled through the other ports.
- **Never:** the provenance is never rewritten to fit.
- **A line without provenance** (older) keeps the old behaviour. A matching line goes on as before.

### 2. The factory read too early (`factory.mjs`, `resident-state.mjs`)

- **Before:** `/h/season` was read at every `step()`, before the stop was known, so "no new observation under a stop" was not accurate.
- **Now, in order:**
  1. The resident's files are read first, with no network.
  2. **The world is read only when** the resident is stopped, an execution origin is declared, **and** some key is complete enough that only the live frame could decide it (`needsLive`: a full recorded provenance under this wallet, `provenanceComplete`).
  3. **Then one GET of `/h/season`, for world and clock only.** The result says so (`live.read`).
  4. **Otherwise nothing is read.**
- **Never under a stop:** the board, a plan or a provider.
- **When not stopped:** the step goes on as before, and its keys are not used (only stop-A reads results).

## Limits (not connected)

1. **The origin must be declared:** nothing attaches `execution.origin` today. The operator wiring must attach the same declared `{registry, agentId}` to the resident's execution port and to the live factory's. Until then, new lines record `execution: null` and stay held.
2. **A port changed after a line was created:** (second tip) now detected before every use of the key, and the line is held. The reader still only reads keys whose creation record matches.
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
- **(second tip)** `needsLive` and `provenanceComplete`.
- **(second tip) `resident.mjs` (as text):** the binding check before the post, before the status read, again before the submit (after the read), in `#reconcile` before the status read, and in `cancelAction` before anything changes; an older line keeps the old behaviour; a mismatch changes neither state nor record; a kind label alone never matches.
- **(second tip) The factory (as text):** the files first; one world read, only inside the stop + origin + `needsLive` gate; and it is said.

## Hand-over (Lane D)

**Unit:** `claude/ws13-key-provenance-20261117` on `1c3f96a5` (`15e387f6`, `c082f988`, then this report). Take the final tip's diff from `1c3f96a5`, all `100644`:
- `workstreams/13-citizens/resident/resident.mjs` (M)
- `workstreams/13-citizens/resident/live/resident-state.mjs` (M)
- `workstreams/13-citizens/resident/live/factory.mjs` (M)
- `workstreams/13-citizens/test/live-resident-state.test.mjs` (M)
- `docs/integration/CLAUDE-WS13-KEY-PROVENANCE-20261117.md` (A)

**Not run:** anything.

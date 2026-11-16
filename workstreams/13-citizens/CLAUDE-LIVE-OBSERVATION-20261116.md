# Live observation: from workstream 4 to 12 to 13, read only (2026-11-16)

**Branch:** `claude/ws12-13-live-observation-20261116`, cut from candidate d16048aa.

**Nothing was run:**
- not the new tests;
- no `node --check`, import or scanner;
- no HTTP or RPC request;
- no store opened;
- no browser, server, world or resident started.

Everything below comes from reading the source.

## What existed (reused, not changed)

| Piece | Where | Role |
|---|---|---|
| `worldFromSeason`, `clockFromHeraldEvents`, `identityFromHeraldMe`, `resolverFromIdentity`, `finalizedSlotFrom`, `storeWorldMismatch`, `provenanceOf`, `connectCanonical`, `ws12EvidencePort` | `12-memory/adapters/canonical.mjs` | the pure connection from the herald, a finality attestation and 4's store into a memory, and the read port for 13 |
| `readWs04Store` | same | 4's SQLite store, read-only, in one snapshot (`BEGIN`…`COMMIT`) |
| `ws12CanonicalEvidence`, `basisCheck` | `13-citizens/resident/ports/ws12-canonical.mjs` | 13's evidence port over 12's; the basis is `chain` only when every part is chain |
| `Resident#publicEvidence` | `13-citizens/resident/resident.mjs` | reads `ports.evidence`; reads nothing on another clock or world; acts only on a `chain` basis |

**The gap:** nothing read the live sources and handed them to these functions. Every existing caller of `connectCanonical` is a test with fixture inputs. `04-execution/tools/chain-flow/stages-cde.mjs` calls `ingestReceipts` directly, with a stand-in clock (bell = slot) and stand-in finality.

**Assembly:** no production assembly of a resident exists. The only place that constructs `Resident` is `world/harness.mjs` `openResident`. That is a test world, and its observe port is on `MOCK_WORLD` / `MOCK_CLOCK`. The gateway's operator agent runner is a different program and is not a resident.

## What was added

**1. `12-memory/adapters/live-observation.mjs`** (new). Its I/O is handed in, so the module itself makes no request.
- `readHerald`:
  - GET `/h/season`;
  - GET `/h/events?after=…`, paged by `next` / `full` as `herald/src/server.rs` serves them;
  - GET `/h/me/{wallet}`, only for a well-formed base58 wallet.
  - A failed or malformed answer leaves that input absent, with its reason (`season_http_503`, `events_malformed`, `events_page_limit`, `events_next_did_not_advance`, `me_malformed`, …).
- `readFinalizedSlot`:
  - one `getSlot` at commitment `finalized` (`RPC_METHODS = ['getSlot']`);
  - it is tied to the herald's world only by an explicit `rpcBinding {rpcUrl, cluster, source}` whose cluster equals `/h/season.cluster`;
  - without that binding, no request is made and there is no finality: `rpc_cluster_undeclared`, `…another_cluster`, `…another_endpoint`, `rpc_slot_malformed`.
- `observeLive`:
  - herald → world and clock;
  - RPC → attestation;
  - `readWs04Store` once;
  - `connectCanonical` into `createMemory` with no path (in-process only, nothing written).
  - It returns:
    - the status and reasons;
    - every held receipt with its reason;
    - the world, clock, `observedBell` and identity resolver;
    - the provenance;
    - the inputs (event pages, whether the clock is complete, refused `/h/me` answers, finality).

**2. `13-citizens/resident/ports/live-canonical.mjs`** (new; imports nothing from 12).
- `liveCanonicalEvidence({ws12EvidencePort, observation, residentClock})` returns `ws12CanonicalEvidence` over the observation, carrying the observation summary (status, reasons, held count, held reasons, inputs).
- An observation with no memory or clock, or with status `world_unverified` / `missing`, gives a port that answers `observation_<status>` with no lines.

**3. `wireLiveEvidence(port)`** (in the same file) is the `wire(r)` hook `harness.mjs openResident` already takes. It sets only `ports.evidence` and never `evidenceUse`. `harness.mjs` itself is not changed.

**4. `13-citizens/bin/observe-canonical.mjs`** (new): the composition root as a command.
- It runs one observation and prints JSON: world, clock, provenance, basis, `basisWhy`, inputs, every held receipt, and what the port answers about each `--about` wallet at the current world bell.
- Requests: GET to the herald, and one POST to the RPC (`getSlot` only; any other method throws before a request).
- It starts no resident, world or server.
- Exit codes: 0 connected, 2 held / no world, 64 usage (including an unreadable declaration file).

## Provenance rules kept

| Part | Kind | Rule |
|---|---|---|
| world, clock, identity | the herald's | the caller states it (`--herald-kind`), **capped at `integration-output`** (see the review below). A Season the herald marks `sample` is a fixture. An unknown or missing kind is no statement (`null`, so basis `unstated`). |
| records (4's store) | **at most `integration-output`** | `capKind(kinds.store, 'integration-output')`. 4's executor is a simulation, so a statement of `chain` is lowered, never kept. |
| finality | the caller's (`--rpc-kind`), **capped at `integration-output`** | it exists only with the RPC binding; its `world_id` is the Season's world. |

- Kinds are only ever lowered (`capKind`); nothing in this slice raises a kind.
- **Consequence:** with today's sources the basis is never `chain`, so the resident would show lines but act on none.
- **WS19:** no attestation carries `complete` or `cross_checked`. `coverageFromHistory` is not called, so no absence ("not sent") is concluded. 13's `basisCheck` still refuses `complete: false/null`, `cross_checked` and coverage (regression added).
- **Held, with the reason** (from `connectCanonical` / `ingestReceipts`, not re-decided here):
  - store / world: `ws04_store_world_unbound`, `world_binding_undeclared`, `ws04_store_bound_to_another_world`;
  - slot → bell: `clock_unmapped`;
  - finality: `not_finalized`, `no_finality_attestation`;
  - an unreadable store: `ws04_store_unreadable:…`.
- **Cargo:** arrived cargo stays as 12's facts record it. Nothing here makes a credited amount.

## Tests (source only, not run)

**`12-memory/test/live-observation.test.mjs`** (9 cases, stub I/O, no file and no network):
- connected;
- kinds capped;
- the RPC pairing: 4 refusals with no request, plus 5 malformed slots;
- store / world held;
- `clock_unmapped` / `not_finalized`;
- herald failures and page limits;
- `/h/me` refusals;
- URL rules;
- the source pinned: one RPC method, no write, no `coverageFromHistory(`, no credit, a memory without a path, the store cap.

It is **not** added to `tools/keyfree-tests.txt` (12 runs only listed files).

**`13-citizens/test/live-canonical.test.mjs`** (6 cases, a stub 12 port, no 12 import):
- not connected → nothing;
- connected → basis `integration-output`, with the held receipts carried;
- another clock → `clock_unverified`;
- WS19 words keep the basis off `chain`;
- `wireLiveEvidence` sets only `evidence`, and the harness's test world is on `MOCK_CLOCK`;
- the command and port pinned as text.

13's `run.sh` globs `test/*.test.mjs`, so this file would run there.

## How far the connection actually reaches

- **Reached (in source):** live herald + RPC + 4 store → 12 memory → 13 evidence port → `ports.evidence` through the existing `wire` hook, plus a command that prints the result.
- **Not reached:**
  - **No resident reads it live.** The only resident assembly is the test world, on `MOCK_CLOCK`. A live port there gives `clock_mismatch`, by design; nothing converts one clock into the other. A resident that reads it needs an observe port on the Season clock and world, and no such assembly exists.
  - **No `chain` basis**, because 4's receipts are a simulation's output.
  - **Commitments:** utterances (requests, accepts) are not read from any live source here, so the memory holds only caravan facts. A breach can't be decided from this slice.

## Unverified, and what is needed

**Never run:**
- the tests;
- an actual herald or RPC;
- whether `/h/events` paging over a long season stays within `maxEventPages` (default 64 pages × 500).

**Declarations someone has to make:**
- the store↔world binding (`binding.json`) and the RPC↔cluster binding (`rpc-binding.json`): who runs both declares them. The format of 4's world string is not pinned (canonical.mjs header).

**Known limit:** `provenance.clock` is the weaker of the season and events statements. When both have the same kind, its source is the season's, so an incomplete event read is visible in `inputs.eventsComplete` and `reasons`, not in `provenance.clock.source`. Slots after the cut are unmapped, and so are held.

## Reverse review (2026-11-17): the data path, source by source

| Step | Source | Wired? | Started? |
|---|---|---|---|
| CLI args → observation | `bin/observe-canonical.mjs` `main` → `observeLive` | yes | **never run** |
| herald GETs | `getJson` (GET only, `redirect: 'error'`) → `readHerald` | yes | never run |
| RPC finalized slot | `rpc` (`getSlot` only; any other method throws before `fetch`) → `readFinalizedSlot` | yes; asked only with a declared RPC↔cluster binding | never run |
| 4's store | `readWs04Store` (one read transaction, `readOnly: true`), called once | yes | never run |
| into 12 | `connectCanonical` → `ingestReceipts` into `createMemory` with no path | yes | never run |
| 12 → 13 port | `liveCanonicalEvidence` → `ws12CanonicalEvidence` → `ws12EvidencePort` | yes | never run |
| port → resident | `wireLiveEvidence(port)` = `wire(r)` in `world/harness.mjs openResident` | **available only**: no caller passes it | not started |
| resident reads it | `Resident#publicEvidence` → `ports.evidence.read` | it would read through the same field, but the only constructor is the **test harness** (`openResident`, on `MOCK_WORLD` / `MOCK_CLOCK`), so the answer would be `clock_mismatch` | **no production entry exists** |

The factory and the CLI are not a finished resident. A real resident entry, with an observe port on the Season clock and world, does not exist in this tree.

**Fixed (evidence: this slice's own source):**
1. **The herald's and the RPC's kinds came from the caller's label alone** (`capKind(kinds.herald)` / `capKind(kinds.rpc)`). `--herald-kind chain` made world, clock, identity and finality `chain` with nothing checking that the host serves the chain's accounts or that cluster. They are now capped at `LABEL_CAP = 'integration-output'`, and each lowering is listed in `inputs.lowered`.
   - A `sample` Season is a fixture.
   - The store stays at most `integration-output`.
   - Corroboration that could earn `chain` (for example, comparing the herald's Season bytes with the account read over the declared RPC) is **not designed here** and needs a decision.
2. **Pagination checks.** A failed page, the page limit, a stalled `next`, or a row number that repeats, goes back or skips now holds **every** receipt (`herald_events_incomplete`), with no ingest and no provenance. Before, the slots of the pages read so far were still placed in bells. `next` must also be the page's last row number.
   - This relies on the herald numbering events 1, 2, 3, …: findex `event(ev INTEGER PRIMARY KEY)`, served in `ev` order.

**Checked, no change needed:**
- **No `not_sent` from a short window:** `coverageFromHistory` is never called, and absence is never concluded.
- **One snapshot:** `readWs04Store` is called once (`BEGIN`…`COMMIT`, read-only).
- **Finality stays with its cluster:** the attestation is built only when `rpcBinding.cluster === /h/season.cluster` and the endpoint is the declared one, with the Season's `world_id`.
- **Credited cargo:** 12's `ws04-receipts.mjs` records it only when the body carries an array, and `null` gives no fact. This slice adds no quantity.
- **No signing, auth, AI or trading path:** the import closure was scanned (12 `src/*`, `adapters/{canonical,ws04-receipts,ws08-world,live-observation}`, 13 `frame`, `ws12-canonical`, `live-canonical`, gateway `memory/config` and `mind/sanitize`). It has no `fetch` except the CLI's two, and no key creation, signing, transaction sending or model call. `records.mjs` only *verifies* someone else's signature. `createMemory` is given no keys.

**Not verified:**
- **Renumbered events:** a findex rollback (`DELETE FROM event WHERE seq > c`) can renumber events between two page reads, and the contiguity check can't see that. `/h/season.headSeq` was not compared.
- **No run:** the tests were updated as source only (pagination: 7 cases plus a midway failure; label caps) and never run.

## Open dependency: workstream 4's arrival time is a slot; the chain's is a timestamp (2026-11-17)

**The mismatch** (read in source; not resolved here):

| Where | Field | Type and meaning |
|---|---|---|
| 4 `src/ports.rs:44`, `src/sim.rs:63` | `CaravanView.arrive_slot` | u64, compared with the slot: `executor.rs:1437–1451`, the settle wait and `settle_grace` |
| frontier-abi v2 `layout/s1.rs:150` | caravan `ARRIVE_TS @ 180` | i64 unix timestamp |
| the herald and `CqEvent` | `arrive_ts` / `arriveTs` | a timestamp |

So 4's executor is consistent only with its own simulation. Against the real v2 caravan, a timestamp would be compared as a slot. Whether 4's port should read `ARRIVE_TS` and wait on time is **4's decision; not decided here**.

**What this slice does with it: nothing.**
- A receipt's bell comes only from its own record slot: 4 writes `slot: st.slot` / `r.slot` / `u.slot`, the observed record's slot, not `arrive_slot` (`executor.rs:1013`, `1487`, `1676`). That slot is placed through the herald's `/h/events` rows (`clockFromHeraldEvents`) and is otherwise held.
- No arrival field is read in `live-observation.mjs`, `canonical.mjs` or `ws04-receipts.mjs` (pinned as text in the 12 test).
- No slot is turned into a time or a time into a slot.
- Nothing about arrival fills in a clock, a credited amount or a settlement.

**Not verified:** whether a real-chain run of 4's executor records `caravan_settled` at the right slot while its arrival wait is misread as a slot. That needs 4's port fixed and a run; neither is done.

## Receiving workstream 4's read observation: held, not ingested (2026-11-17, no code change)

**Source:** workstream 4's settled contract as relayed by the owner. Its branch `codex/ws04-read-observation-20261116`, from d16048aa, was **not on the remote** when this was written; its code was not read.

**What 4 gives:**
- decoded `CARAVAN_SETTLED` / `CARAVAN_RAIDED` records;
- the tx slot and signature;
- a PS2 ordinal;
- a body hash;
- `basis: 'unproven'`;
- `held: [world_binding_unproven, finality_unproven, transaction_record_identity_unproven, committed_frame_unproven]` (the fourth added by 4 on 2026-11-17);
- `credited: None`, always.
- **The PS2 ordinal is not a global ordinal.** It numbers the program-attributed PS2 bodies (after the PS2 filter of the typed list in the experimental build), not the instruction or log position.
- **findex's DB meta holds integers only:** no program or season binding and no commitment. The DB alone proves no stable cross-source identifier, no world and no finality.
- 4 writes no runexec receipt and nothing to its DB.

**How 12 receives it, by its existing rules:**

| 4's output | 12's existing receiving side | Rule |
|---|---|---|
| `basis: 'unproven'` | `provenanceOf` / `stated()` take only `chain` / `integration-output` / `fixture`; 13's `basisCheck` takes `unproven` as no statement | **unstated, never chain**. Not raised to `integration-output` either |
| `held: [world_binding_unproven, …, committed_frame_unproven]` | `storeWorldMismatch` needs a 4 store `meta('world')` plus a declaration | **the whole observation is held with all four of 4's reasons kept as they are**. It is not passed to `connectCanonical` or `ingestReceipts`, and the reasons are not replaced by 12's own (`ws04_store_world_unbound`) |
| finality unproven | facts need `slot ≤` an attested finalized slot | held. The live observation's RPC finalized slot is **not lent** to 4's records: it says nothing about which program's bodies findex indexed |
| tx signature + PS2 ordinal + body hash | 12's fact id is `kind\|subject` in the partition (dedupes the feed's `event:` and the history's `history:`) | **not turned into a `kind\|subject` id**. The PS2 ordinal is not a global position, so it can't be a cross-source identifier, and these records are not deduped against, or collided with, the simulated store's receipts |
| decoded SETTLED / RAIDED | `receiptToFacts` would make `caravan_settled` / `caravan_raided` facts | **not converted into the Receipt shape, and no fact is made**. In particular not through `ingestReceipts` directly, which skips the world and world-binding checks the way `stages-cde.mjs` does |
| `credited: None` | `caravan_credited` only when the body carries an array | no credited fact, then or later. The cargo as recorded is not turned into a credited amount |
| no `caravan_sent` (`arrive_ts` is a timestamp) | `fold.mjs` 394–406: without a sent fact, a promise stays `unverified` | no fulfilment, no breach, and no "not sent" (there is still no coverage) |

**Already safe in the current code:**
- If someone handed 4's observation to `observeLive` as the store, `connectCanonical` would find no `meta('world')` and hold everything as `ws04_store_world_unbound`. Nothing would be ingested, but 4's reasons would be lost.
- The only path that would make facts is calling `ingestReceipts` directly with a caller's finalized slot. Nothing in this slice does that.

**Receiving-side change for later** (only after 4 shares the code and the owner says go): an input such as `observeLive({ws04Observation})`.
- For `basis !== chain`, or any `held`, it returns `status: 'held'` with every one of 4's reasons verbatim (none dropped, none merged), its records as `held` entries keyed by `sig|ordinal|bodyHash`, no ingest and no provenance.
- It is not written now.

**What a later provider must add before any of it is a fact:**
1. a world binding for the index (which program and season address its bodies belong to, with a source);
2. finality for those records (a commitment the index records, or a check per signature);
3. a stable cross-source record identity (the signature plus the record's position in that transaction, as a provider defines it);
4. evidence that each record's own frame committed.

**Committed frames (4, 2026-11-17):**
- Legacy findex has no rollback of a failed CPI subtree; the typed log does.
- A strict marker alone is not evidence that a record's frame committed. So a successful transaction does **not** make each of its events committed: an event inside an inner call that failed and was rolled back can still be listed.
- 12 already takes no transaction status as record evidence (`receiptToFacts` reads no `err` or success field). The receiving side must not start: `committed_frame_unproven` stays a held reason until a provider proves the frame, per record, not per transaction.

Until all three exist, the receiving side holds it.

## A production resident entry: what it needs, and the held WS4 report (2026-11-17, source only)

### What Resident needs, from its source

`resident.mjs`, as `resident/assembly.mjs` `REQUIREMENTS` lists it (pinned as text in `test/assembly.test.mjs`):

| Port | Where it is used | What using it does | Is a live, read-only one available? |
|---|---|---|---|
| `dir` | the constructor reads `charter.json`; `createStateStore(state.json)`; the agent ledger over it | writes the resident's own files | no: constructing writes |
| `identity` | `identity ?? keyIdentity(loadOrCreateKey(resident.key))` | without one, **makes and saves a key**; `keylessIdentity` is a test identity (`ws13-test:`) | no |
| `execution` | `assertPort` (submit / status / cancel, `retentionBells`); `#enact`, `#reconcile` | sends to the world | no (4's agent wallet signs and sends) |
| `observe` | `ports.observe(address, {events, boardBell})` → `{world: {bell, villages, …}, board}` | reads | **none exists live.** The only implementation is the test world's (`harness.mjs portsFor`), and no contract maps the herald onto this shape |
| `join` | `ports.join({body, sig: identity.sign(JOIN_DOMAIN, body)})` when no village is found | signs and joins | no |
| `memory` | `all` / `append` / `recall` | writes its episodes | no |
| `board` | `#enact`: `board.post` | posts publicly | no (no live board exists) |
| `provider` | `#decide`: `decideWithin(provider, req)` after `ledger.hold(inference)` | calls a model and spends budget | no |
| `cost` | `#decide`: `(cost ?? flatCost)`, quote / reserve / settle | spends | no |
| `fallback` | `#decide`: `fallback(candidates)` | reads | (code) |
| `evidence` | `#publicEvidence`: `evidence.read(…)` after the clock and world checks | reads | **yes:** `liveCanonicalEvidence` |

**The real consumer is `#publicEvidence`.** It is reached only inside `#decide` from `step()`, and `step()` first does all of these:
1. `assertPort(execution)`;
2. `observe`;
3. `join` if no village is found;
4. `#reconcile` (execution status and cancel).

After the evidence read, it goes on to:
- a budget hold;
- `provider`;
- `#enact` (submit and post).

`step()` has no read-only mode. **So no read-only production resident can be assembled under today's contracts.**

**What was added:** `readOnlyResidentPreflight({dir, identity, ports})` (`resident/assembly.mjs`).
- It never constructs a Resident, writes nothing, makes no key and calls no port.
- It refuses every port that is required and not supplied, and every port whose use signs, sends, joins, spends, posts, calls a model or writes, even when one is supplied. A refusing stub is refused by the same rule, so `assembled` is always false.
- It refuses the test harness's observe port as not live.
- It reports the evidence port (world, clock, basis, the observation's held count, the WS4 report) with `reachesResident: false`.
- The command prints it under `resident`.

### WS4's read observation, as a held report

- **`12-memory/adapters/ws04-observation.mjs` `heldFromWs04Observation(page)`.** It reads 4's `ws04-observation/0` page (4 @ 7baa4d93: `observation.rs`, `READ-OBSERVATION-20261116.md`):
  - **4's reasons, copied verbatim:** the page's three held reasons, and each observation's four.
  - **This module's own findings, kept apart:** a page that claims a world, a finality, completeness or a basis other than `unproven`, a missing reason, a non-null `credited`, an event slot that is not the transaction's, or malformed fields. Each one is one more reason, never fewer.
  - **Nothing admitted:** `admitted: 0`; no fact, receipt, id, coverage or attestation; no import at all.
- **`observeLive({…, ws04Observation})`:** returns it as `ws04` beside the connection, never as its input (pinned: the `connectCanonical(` call has no `ws04`).
- **`liveCanonicalEvidence`:** carries the summary (`observation.ws04`: format, status, admitted, count, page reasons, observation reasons).
- **`observe-canonical --ws04-observation page.json`:** reads the page with `parseJsonU64` (u64 owner and raider tags stay exact) and prints the report.
- **Nothing produces that file:** 4's reader is not on the runexec command line (4's doc: "no runtime consumer yet").

### Where the consumer is actually reached (source)

| Path | How far it reaches |
|---|---|
| live herald + RPC + 4 store → 12 memory → 13 port | wired; never run |
| 4 page → 12 held report → 13 port summary → command output | wired; never run; no producer of the page |
| port → `Resident#publicEvidence` | **not reached**: no production resident; the harness (test world, `MOCK_CLOCK`) would answer `clock_mismatch` |
| WS4 held reasons → a resident's decision | not reached. `#publicEvidence` records `status`, `basis` and `basisWhy` per counterparty, not `observation.ws04` |

### Dependencies, not created here

1. **A live observe port:** a contract for which herald answers become `world.bell`, `villages[{citizen, owner}]`, events and the board. **Undefined.**
2. **A read-only mode of `Resident#step`**, or a separate read-only consumer of `ports.evidence`. It does not exist; adding one is a change to 13's resident design and needs the owner's decision.
3. **An identity for a production resident** without making a key here. Key custody is undecided.
4. **Execution, join, board, provider and cost** for a resident that acts: signing, sending, model calls and budget all stay out of scope.
5. **4's reader on a command line**, and the admission evidence 4 lists: raw transaction and frame proof, world and source binding, finalized context, identity and replay.

**New tests (source only, never run):**
- 12 `test/ws04-observation.test.mjs`: 5 cases. Not added to `keyfree-tests.txt`.
- 13 `test/assembly.test.mjs`: 4 cases.

## The decision core split out, and a preview with no effect (2026-11-17, source only)

**What was moved.** These moved from `resident.mjs` into `resident/decide-core.mjs`, unchanged in meaning, and `Resident` now calls them:

| Was | Now | Its inputs |
|---|---|---|
| `#who` | `whoOf({addr, aliases})` | the view's citizen→owner map, the alias table |
| `#trustIndex` | `trustIndexOf(episodes, aliases)` | `memory.all()` |
| `#publicEvidence` | `publicEvidenceOf({port, observe, evidenceUse, cands, bell, who})` | `evidence.read` (the same chain-only rule; the fixture test switch as before) |
| `#decide`'s hold rule | `heldOf({evidence, inFlight, failures, bell, who})`, `inFlightOf(journal)` | state |
| `#request` | `requestOf({charter, id, citizen, obs, bell, turn, cands, wakes, evidence, mem})` | `mem` = `memory.recall(…)` (still called by the resident) |
| `OPEN_STATES`, `actionSig`, `candidateAction` | moved | `resident.mjs` re-exports `OPEN_STATES` and `actionSig` as before |

**The one difference is an error case:** with no `state.aliases`, `#who` threw before; it now reads an empty alias table. Every saved state has `aliases`.

**`previewDecision({charter, state, address, obs, memory, evidence, observe, evidenceUse})`.** It is the decision up to the point where a provider would be asked:
- candidates and exclusions, including a WS12 breach under the same rule;
- the evidence summary;
- the request text the provider would get. It is not sent. With a single candidate, `byCode: 'wait'` and no request, as `#decide` does.

It uses copies of `charter` and `state` (`structuredClone`), and the day counters are reset on a copy (`todayOf`). It reads only `memory.all` / `recall` and `evidence.read`.

It never reaches:
- the constructor (no key, no ledger, no file);
- `join`;
- the budget hold or the cost port;
- the provider;
- the fallback;
- `execution` or `board`.

**What the preview does not cover.** These are steps `step()` takes before or after deciding, each with effects or with state it changes:
- reconcile;
- learn and duties;
- `#settleReturns` and `#noteDebts`;
- the cursor;
- the wake gate;
- the stop reasons;
- the provider's answer and the fallback;
- the send.

So the preview is **not** the decision a step would make. It is the candidate set and the request at the current state, before those steps.

**How far it reaches:**
- **Normal mode:** the same functions. Equivalence is pinned as text, not by a run.
- **Preview:** inputs exist only in the **test world** (`helpers.mjs small/run` over `world/harness.mjs`). A production preview needs:
  - a live observe port: none exists, and no contract maps the herald to `{world: {bell, villages, me: {quota}}, board}`;
  - a resident's charter and state, from its own files.

  So no production preview exists.
- **Nothing in this slice calls `previewDecision`:** no CLI, no harness.

**Tests (source only, not run):** 13 `test/decide-core.test.mjs`, 4 cases.
- On the test world, the preview reaches no acting port: execution, board, provider, cost, join, fallback and `memory.append` are traps that throw.
- It changes no state or charter, and no file in the resident's directory (size and modification time).
- The hold rules: chain acts; `integration-output` is shown but not acted on; the fixture test switch still works; a clock mismatch is caught.
- The helpers.
- The text pins: the resident calls the same functions, and the core's imports are only frame, sanitize, rules, candidates, goals and the provider schema.

**Kept as before:** WS4's four held reasons; the cap that never raises the simulated store to `chain`; and `assembly.mjs` still reports `assembled: false`. The preview is not a resident.

## Reverse review of the split (2026-11-17, source only)

**Normal mode, before and after** (`git diff 3c5f22d2^ 3c5f22d2 -- resident.mjs`, read line by line):

| Point | Before | After | Same? |
|---|---|---|---|
| `this` reads | `this.addr`, `this.state.aliases`, `this.ports.{memory,observe,evidence,evidenceUse}` read in the method | the same values, read in the same method and passed in | yes |
| exception order | `#request`: `memory.recall` was the first call that could throw | `recall` is called first, then `requestOf` | yes |
| call counts | `memory.all` once per trust index; `memory.recall` once per request; `evidence.read` once per counterparty (at most 3) | the same | yes |
| day counters | `#today` resets `state.counters` in place; `buildCandidates` only reads `today` (no assignment in `candidates.mjs`) | `#today` unchanged | yes |
| aliases | `this.state.aliases[c]`: throws if `aliases` is missing | `whoOf`: an empty table if missing | error case only (every saved state has `aliases: {}`) |
| clock / world / basis gating | `#publicEvidence` body | `publicEvidenceOf`, the same body (`this.ports.observe` → `observe`) | yes |
| hold rule | `held` closure over `st.failures` | `heldOf({failures: st.failures})` | yes |

**Fixed in the preview** (evidence: 3c5f22d2's own source):
1. **It called the ports it was handed.** `previewDecision` called `memory.all` / `recall` and `evidence.read` on objects the caller supplied, so a "read" port that signs, spends or sends would have run inside it.
   - It now takes a **snapshot of plain data** `{charter, state, address, obs, episodes, frame, evidence: {…, answers}}`.
   - The snapshot is `structuredClone`d first: a function anywhere in it fails the copy, and the preview is refused (`snapshot_not_plain_data`). So no port of any name, no callback, signer, budget, provider or sender can be called.
   - Memory and evidence are rebuilt from the data. A counterparty with no answer in the snapshot is `not_in_snapshot`.
2. **A missing observe frame skipped the clock and world check.** Evidence without `frame.clock` and `frame.world` is now refused, not read.
   - Normal mode keeps its behaviour unchanged: it skips the check when its port declares none.
3. **Missing inputs are refused by name and never filled in:** charter, state (incl. `journal` / `counters` / `cooldown` / `accepted` / `aliases`), address, obs (incl. `world.me` and this resident's village), episodes, and the shape of each evidence answer.

**Added:**
- `fallback`: what the **default** code fallback (`safeFallback`, now in `decide-core.mjs` and re-exported by `resident.mjs` as the same function) would pick. A resident's own `ports.fallback` may differ, and its provider would be asked first; neither happened.
- `modelAsked: false`.
- `recall.mjs` `recallFrom`: the local memory adapter's rule. `localMemory.recall` now calls it, so the preview recalls the same way. A resident on another memory port (12's mirror) may recall differently.

**Still true:**
- The preview is not a step's decision and not a model's decision.
- WS4's unproven data is never evidence: its basis is not `chain`, so the resident's rule shows it and does not act on it, and the preview offers no test switch.
- A preview's snapshot exists only in the test world today.

**Tests (source only, not run):** 13 `test/decide-core.test.mjs`, 6 cases.
- a snapshot preview leaves the resident, the snapshot and the files unchanged;
- a port or callback anywhere in the snapshot is refused, and nothing is called;
- missing inputs are refused by name;
- the evidence rule (chain acts; `unproven`, `integration-output` and `unstated` do not);
- the shared rules (recall, counters, aliases, trust, fallback);
- the text pins.

## The preview takes one JSON string; reverse review of types and odd shapes (2026-11-17, source only)

**The defect** (found by the owner's review of 67d136a3): `structuredClone(snapshot)` reads every own property, so a getter (and a Proxy's traps) **runs** during the copy. "No callback handed in is ever called" did not hold.

**The fix:** `previewDecision(snapshotJson)` takes **one primitive JSON string** and nothing else.
- **Anything else is refused by `typeof` before it is touched** (`snapshot_not_a_json_string`): an object, a `String` object, a Proxy, an object with getters, `toJSON` or `valueOf`, a function, a symbol, a Buffer, null. There is no `String()`, no `JSON.stringify` and no `structuredClone` (pinned as text).
- **Size and syntax:** over 8 MiB → `snapshot_too_large`; text `JSON.parse` rejects → `snapshot_not_json`; a non-object result → `snapshot`.
- **Parsing:** `JSON.parse` with no reviver. What it gives is data. A `"toJSON"`, `"toString"` or `"__proto__"` key in the text is only data: never called, and no prototype is changed (`__proto__` becomes an own key).
- **Lookups by a key that comes from the data are own-key lookups:**
  - the goal: `Object.hasOwn(GOALS, goal)`, so `"constructor"` or `"toString"` is refused;
  - evidence answers: `Object.hasOwn(answers, counterparty)`;
  - the state's `aliases`, `cooldown`, `accepted`, `failures`, `journal` and `counters` are copied onto null prototypes.
- **Mis-shaped fields are refused by name:**
  - a village without `citizen`, `owner`, `stores`, `buildings` or `building`;
  - a request without an `id`;
  - `world.me.quota` missing;
  - an episode without `kind`, `bell`, string `entities` or `text.en`;
  - two episodes with one id;
  - evidence `basis` / `basisWhy` / `clock` / `world` of another type;
  - an evidence line without `epistemic`.
- **Anything else that throws** while computing is a refusal (`snapshot_shape_unexpected:…`), never an exception out of the preview.
- The evidence `kind` is shown only if it is a string. Nothing from the data is turned into a string by conversion.

**Normal mode is unchanged** (`resident.mjs` not touched in this fix). `previewDecision` has no consumer outside its tests: there is no other caller in the tree.

**Reverse review: types, inherited properties, odd shapes.**

| Where | What could go wrong | Result |
|---|---|---|
| preview input | getter / Proxy / `toJSON` / implicit conversion runs caller code | **fixed:** a primitive string only, checked by `typeof` first |
| preview goal / answers / aliases | an inherited key (`"constructor"`) found on `Object.prototype` | **fixed:** own keys only |
| preview cooldown / failures keys | `` `${owner}\|${res}` `` / `Name:{…}` | they contain `\|` or `:`, so they are never an inherited name; copied onto a null prototype anyway |
| preview deep nesting | `JSON.parse` throws on extreme depth | inside its `try`: `snapshot_not_json`. Validation does not recurse |
| `requestOf` over a board note that is not a string | the sanitizer may throw | caught: `snapshot_shape_unexpected` |
| **normal mode:** `#who` / `trustIndexOf` over `state.aliases` loaded from `state.json` | a citizen id such as `"constructor"` would find `Object.prototype.constructor` | **not changed:** normal mode is kept as it is, as instructed. A finding for the owner: making `aliases` own-key in normal mode would be a behaviour change of `resident.mjs` |

**Tests (source only, not run):** `test/decide-core.test.mjs` is updated.
- 14 non-string inputs are refused with no getter, trap, `toJSON`, `valueOf` or `toString` called.
- Malformed JSON, non-objects and oversize text are refused.
- `__proto__` / `toJSON` / `toString` in the text are only data.
- 10 more shape and inherited-key refusals.
- The JSON boundary is pinned as text.

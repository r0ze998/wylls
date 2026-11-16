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

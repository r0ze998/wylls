# ⑬ operator resident: the live path up to a proposal (2026-11-17)

**Approval:** the owner approved an **operator-side independent resident** that reads the same world as people and chooses requests and transport itself. It is separate from connecting a player's own AI over MCP (③).

**Branch:** `claude/ws13-live-resident-20261117`, on the aggregate `fdc9fd0d` (the aggregate when it was saved).

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, RPC, signature, submission, join, model call or charge;
- **not a running resident, and nothing on a real chain.**

## What this adds

New files only. **`resident.mjs`, the test world and every existing port are unchanged**, so the test-world path, its tests, `run.sh` and the demo keep their behaviour.

| File | What it does |
|---|---|
| `resident/live/observe.mjs` | **One partial observation of the real world.** <ul><li>**World and clock** from herald `/h/season`, through workstream 12's `worldFromSeason` (injected) and this tree's `frame.mjs` `seasonClock`.</li><li>**Bell** from `/h/season` `latestUnix`, through 12's `currentBellFromSeason` (injected). It is labelled informational, not finality; no slot or wall time is converted.</li><li>**Own Citizen and villages** from herald `/h/me/{wallet}`, decoded by the game's decoder (injected). A village not owned by this Citizen now is held.</li><li>**Stock estimate** at `latestUnix`, only with the game's `stockAt` (injected); otherwise `null`, "unknown".</li><li>**Requests** from workstream 1's board, only when its `/coop/config` world is the herald's: open, of this world, destination verified. The others are held with why.</li><li>**Places** stay S1 `{p, q, site, gen}`.</li><li>**Not read:** other villages, events and positions; each is listed in `unknown`.</li></ul> |
| `resident/live/candidates.mjs` | **Only existing meanings:** `respond` (workstream 1's accept, offer = the need); `send` after acceptance, held unless workstream 1's `pendingSendOf` (injected) allows it and an own village's known stock covers the offer. The plan comes from workstream 1's `planSend` (injected; S1 route and fee, owner, destination and cargo checked on the chain). **`UNSUPPORTED`**, said and never replaced: payment offer, open-if-declined, citizen-addressed request, own new request, join, build and train, gifts and returns, other villages' stock, test-world events. |
| `resident/live/decide.mjs` | **No-charge local rule:** keep an accepted request first, then accept what known stock covers, else wait (unknown stock is never enough). **Provider boundary:** an injected provider must state `charges: false` or be explicitly allowed (`allow.model`), and must choose an offered, unheld candidate; otherwise `wait` with why (fail-closed). |
| `resident/live/step.mjs` | **stop-A:** no observation and no new operation; only `execution.status` of keys already submitted (an Unqueryable stays unqueryable). **Otherwise:** observe → candidates → decide → plan (chain reads only) → a **proposal**. **Enacting is not connected:** every proposal says `enacted: false` and names the authorities it would need and which were not supplied. A respond proposal lists the record fields only the signer can add (`nation`; `v`, `season`, `at`). |

**Injected, never assumed:**
- workstream 12's two functions;
- the game's Holding and Citizen decoders and `stockAt`;
- workstream 1's `pendingSendOf` and `planSend` with a chain reader and the Season;
- the herald and board readers (GET);
- the execution port (workstream 13's existing `ws04-acts` port, status only);
- the wallet;
- a provider.

**No composition root and no runner are added:** a new runner could go around the existing limits.

## Dependency (runtime, not imported here)

- **The execution port's result reading** goes through workstream 4's act client.
- **D's fixed tip** `1fd0e274d202d97691cb22c251586b5dedc7df35` (base `6c19555e`; `workstreams/04-execution/clients/{acts.mjs,runs.mjs,exit3-norecord.test.mjs}`) makes `NoRecord` count only with runexec's own exit 3; anything else is `Spawn`, which becomes this tree's `Unqueryable`.
- **Not in this unit:** that tip is not included here and not in the aggregate. **Adopt it with or before** any use of stop-A's result reading against a real registry.

## Not connected yet (each needs a decision, or a piece not adopted)

1. **Enacting:**
   - signing and posting the board record with the operator identity;
   - signing and submitting the caravan through the agent wallet or the relay, with workstream 1's `sending` record first;
   - the journal and retention of those keys.

   These need the operator identity, wallet and funding to be supplied, and who owns stop to be decided.
2. **Joining:** the operator-invite route conflicts with the design (⑬ README).
3. **The resident's own needs as requests:** no mapping to workstream 1's goals and needs.
4. **Other villages and events:** no world-wide reader; the herald's program records are not mapped.
5. **A charging model:** only with `allow.model`; not used here.
6. **⑮ outcome rules:** not adopted, not used.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-resident.test.mjs` (new)

- **Observe:**
  - world, clock, bell and `latestUnix` basis;
  - own villages, with another owner's held;
  - stock at herald time;
  - requests filtered (expired, unverified, other world held);
  - hex places kept.
- **Unknowns:** no `latestUnix`, no stock reader, not a continuous world, herald down, a board of another world, no Citizen.
- **Candidates:**
  - respond;
  - send only after acceptance;
  - held by an earlier send, by stock, or by the missing pending rule;
  - own requests and own destinations skipped;
  - every unsupported key present.
- **Decide:** promise first; stock-covered accept; unknown stock waits; providers fenced.
- **Step:**
  - stop-A reads only (no observe, Unqueryable kept);
  - the proposal is never enacted, with missing authorities named;
  - the planner is supplied, never assumed.
- **Text pins:** no test-world import, and no sign, post, submit, join, cancel or fetch in the live files.

It makes no key, so it is compatible with `run.sh`'s keyless mode. It was **not run**.

## Hand-over (Lane D)

**Unit:** `claude/ws13-live-resident-20261117`, on `fdc9fd0d`, all `100644`, all new (take the final tip's diff from `fdc9fd0d`):
- `workstreams/13-citizens/resident/live/observe.mjs`
- `workstreams/13-citizens/resident/live/candidates.mjs`
- `workstreams/13-citizens/resident/live/decide.mjs`
- `workstreams/13-citizens/resident/live/step.mjs`
- `workstreams/13-citizens/test/live-resident.test.mjs`
- `docs/integration/CLAUDE-WS13-LIVE-RESIDENT-20261117.md`

**Not run:** anything.

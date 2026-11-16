# ⑬ resident: who really provides each port, and why no production assembly can be written yet (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `9831c91c` (U13 and U04 included). Read with `git show` and `git grep` only.

**Not done:**
- No `Resident` was instantiated; no import, test, syntax check, runner, key, signing, send, RPC, world or model call.
- Not touched: ③ (the user's MCP, separate from ⑬), Lane D, Lane C and the aggregate or canonical refs.

**Verdict:** **no code.**
- ⑬'s world-facing ports (`observe`, `join`, `board`) have **no real provider** anywhere in the tree. ⑬'s own contract says the world and the board are mocks, and that the real-world mapping is an **unimplemented proposal** (`03-contracts.ja.md` §5, l.52-56).
- An "assembly" today could only wire the mock test world, which `world/harness.mjs` `openResident` already does. Anything else would present the mock contract as the real world, or decide owner questions. A factory with no real consumer would be the kind of unused helper the brief rules out.

## The ports the resident uses (`resident/resident.mjs`, call sites)

| Port | Used for | Mock / local provider | Real provider in the tree | What is missing for real use |
|---|---|---|---|---|
| **`observe(me, since)`** (+ `.world`, `.clock`) | every tick: the world view (`me`, villages, events) and the board, both since cursors (`:413`); frame checks (`:835-837`) | `world/harness.mjs` `portsFor`: `TestWorld.view` + `Board.view`, declared `MOCK_WORLD` and `MOCK_CLOCK` | **none.** ⑫'s `adapters/canonical.mjs` reads the herald, but for ⑫'s memory and evidence, not ⑬'s view shape | a mapping from the real world (the herald's views or chain accounts) to ⑬'s `view` (citizens, villages, `me`, events with ⑬'s kinds, a cursor), with ⑬'s world and clock declared. **A design that is not adopted.** |
| **`join({body, sig})`** | first tick: become a citizen (`:424`) | `TestWorld.join` (a signature over `JOIN_DOMAIN`) | **none** | on the real game, joining is an on-chain action of the citizen's own key, and it needs funding. **Owner decisions:** who funds, which key, and whether a resident may join at all. |
| **`board.post(body)`** | requests and replies (`:489`) | `world/board.mjs` (mock rules) via `testWorldBoard` | **none** | the proposal is "a new signed record kind in the citizens' social layer; judged from the herald's caravan records" (`03-contracts` l.56). **Not implemented and not adopted.** |
| **`execution`** (`submit`, `status`, `cancel`, `retentionBells`; `assertPort` at `:409`) | sends and their fates (`:497-501`, `:613`, `:681`) | `testWorldExecution` (mock) | **partly.** `ports/ws04-acts.mjs` (④'s registry: register and status, real `runexec`) and `ports/ws04-run.mjs` (④'s executor runs, `runViewClient`) | **`send(req)`** for `ws04ActsPort`: the wallet's `POST /f/agent/action` under an agent credential. Not decided: the **credential and authorization** (whose capability), the **HTTP 409/503 → `ActionResult` interpretation**, and the acts client's **gateway read mode** (store-only leaves a lost send pending forever: `CLAUDE-WS13-JOURNAL-RESTART-BOUNDARY-20261117.md` §4-1). `ws04ExecutionPort` needs `specOf` (an action → a `RunSpec`) and `requesterOf` (the credential layer), neither of which exists for the resident. |
| **`provider`** | one decision per turn (`:936`, `decideWithin`) | `fixtureProvider` (no network, no key) | `fromChatProvider(chat, {provider, model})` adapts a chat client; ⑤'s providers are the intended source | **model billing:** which provider and account, and who pays. An owner decision. No key in the tree. |
| **`cost`** | reserve and settle per call (`:201`, `:905`) | `flatCost` (default) | `priceBookCost`, `ws05LedgerCost` (⑤'s book and ledger, handed in) | depends on the provider decision; ⑤'s ledger is a mock (`RunCostMock`). |
| **`memory`** | episodes (`:389`, `:425`, `:707`, `:787`) | `localMemory(file)`: **real and local** (one file per resident) | ⑫'s mirror `adapters/ws13-resident.mjs` (wraps it) | none for local use. |
| **`evidence`** (optional) | others' kept or broken promises (`:813-843`) | — | `ws12CanonicalEvidence` over ⑫'s canonical port (handed in); acts only on basis `chain` | ⑫'s port, its herald reads and the world clock must be connected. Without a world bell of the same world, 12 answers `clock_unverified` and nothing is acted on. |
| **`fallback`** | when the provider refuses | `safeFallback` | (local code) | none. |

**The constructor's own side effects** (why nothing here was instantiated): `new Resident` reads `charter.json`, creates or loads `resident.key` (unless a keyless test identity is given), opens `state.json`, creates the agent ledger entry, and saves (`resident.mjs:129-153`). `tick` then calls `observe`, `join` (signing), `board`, `execution`, `provider` and `cost`.

## What can be decided from adopted text, and what cannot

**Can be decided** (and is already in the code):
- the port shapes (`03-contracts.ja.md`, `resident/ports/execution.mjs`);
- retention (08 R1–R5; `ws04-acts` and `ws04-run` declare `Infinity` on ④'s grounds);
- the registry's seven states;
- evidence only on basis `chain`;
- `localMemory`;
- the keyless test identity for tests.

**Cannot be decided here** (the brief: do not decide them):
1. **The real world view for `observe`:** which source (herald, chain), and how it maps to ⑬'s `view`. This is a new mapping, and the adopted text calls it a proposal.
2. **`join`:** whether a resident joins the real game, with which key, funded by whom.
3. **The board:** whether a real board exists (the proposal: a signed social record kind) and where it is served.
4. **`send`:** the agent credential and the owner's authorization for the resident's sends; how a real `send` turns the wallet's 409/503 into results; the acts client's gateway read mode.
5. **The model provider and its billing.**
6. **Funding:** the agent ledger's budget, the wallet and real money.

## The smallest real step, when the owner decides (not done)

This is not a code change today. The order follows what blocks what:
1. Decide (owner) whether ⑬ runs against the real world at all, and under which identity and funding.
2. Adopt a real `observe` mapping (herald → ⑬ `view`) and a board design. Without them, a resident cannot see or negotiate, and the other ports have nothing to act on.
3. Decide `send`'s credential and the 409/503 interpretation. Then `ws04ActsPort(acts, {agentId, send})` with a gateway-reading acts client is the execution port, already written (`ports/ws04-acts.mjs`).
4. Then an assembly takes the handed-in ports exactly as `openResident` does (`world/harness.mjs:46-55`), but without `portsFor`. Its regression (key-free, fixture ports) would come with it.

## Already done on ⑬'s side (for reference)

- **U13 and U04, now in the aggregate:**
  - a may-have-left `SendFailed` keeps its key;
  - ④'s receipt `code`, and the Duplicate reading;
  - their regressions are written, not run.
- **Reports:** the restart boundaries and the Duplicate producer gap (`docs/integration/CLAUDE-WS13-*`).

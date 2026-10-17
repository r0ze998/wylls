# The agent wallet: a test-USDC balance and a delegation for one owner's agent

*Branch `feature/agent-wallet`, 2026-10-17. Local test tokens only; nothing here has value. Off unless the relay runs with `--agent-wallet`.*

## 0. What it is, in one paragraph

A player keeps playing by hand, or hands their village to an agent. To hand it over, the owner deposits test USDC into an operator-held custody account, sets a budget and a list of allowed actions, gives the agent's key the Citizen's session (the existing `SetSession`, signed by the wallet), and switches the agent to **auto**. From then on the agent acts on its own; every model call and every priced game action is held, then settled from that balance, and only what was really used is spent. The owner switches back to **manual** at any time: the agent's new requests are refused at once, nothing already sent is rolled back, and the owner takes the session key back with another `SetSession`. Unused balance is withdrawn to the owner's own wallet at any time; withdrawing everything stops the agent. This is **not** yield: the deposit is a prepaid budget, and existing free or resource-paid actions stay free or resource-paid (`docs/frontier/DESIGN.md`'s rule that no money enters the game is unchanged; the game price table is empty).

## 1. The owner's decisions (2026-10-17) and the defaults taken

| Question | Decision |
|---|---|
| Custody | An operator-held test custody account plus the relay's ledger, local test USDC only. Before any live money, the same interface moves to an on-chain vault (§9). |
| Model calls | One fixed test price per call (default 10,000 base units = 0.01), charged whether the call succeeds or fails. The rule autopilot is free. Token counts are recorded only. |
| Game spending | A `game` category and a price table hook; the table is empty. Existing actions stay free or resource-paid. |
| Withdrawal | `available` at any time; reserved money never. To the owner's wallet only (fixed at creation). A full withdrawal stops the agent. No waiting period. |
| SOL fees (default) | The relay pool pays them as before; the ledger records lamports per action, no USDC conversion (§6.3 has the design for one). |
| Feature flag (default) | `--agent-wallet` off; `--agent-runner` off. |

## 2. Where it sits

```
browser (owner's wallet)  ──owner commands (signed)──┐
operator's runner (model or autopilot) ──{runner}───┤──▶ AgentGateway.submit ──▶ relay sponsor() ──▶ chain
future MCP server ──POST /f/agent/action {capability}┘        │  mode, policy, budget, village, session, build & sign
                                                              ▼
                                                        AgentLedger (agent-wallet.json)   Custody (test USDC)
```

* `permutation-gateway/src/frontier/agent/` — `contract.mjs` (ActionRequest/ActionResult, codes), `policy.mjs`, `ledger.mjs`, `owner-auth.mjs`, `keyring.mjs`, `custody.mjs`, `gateway.mjs` (AgentGateway), `runner.mjs` (autopilot, model decider, scheduler).
* `permutation-gateway/src/frontier/routes/agent.mjs` — the HTTP face (`/f/agent/*`), registered in `app.mjs` (public routes, per-address limits, the funds breaker).
* `permutation-gateway/src/frontier/routes/relay.mjs` — `sponsor()` gained `beforeSend`, `onSent({signature, moved})` and the `AgentKeyDirect` refusal.
* `permutation-gateway/src/frontier/config.mjs`, `server.mjs` — flags, the custody key, the keyring directory, the ledger's own state file, the reconcile timer, the runner.
* Web client: a text for `AgentKeyDirect` (`fi18n.mjs`, `lang/en-frontier.mjs`). No UI yet (§10).

## 3. The interface every entry point shares (`contract.mjs`)

**ActionRequest**

```
{ agentId, source: 'browser'|'ai'|'mcp', idempotencyKey (≤128), policyVersion, modeEpoch?,
  action: { name, holding: [p, q, site], fields: {…JSON: ints as numbers or decimal strings, bytes as arrays or base64} } }
```

`source` is recorded, never trusted for authority. Authority comes from the **credential**: `{owner}` (the route verified the owner's wallet signature), `{capability}` (the agent's token), or `{runner: true}` (the relay's own in-process runner; no HTTP route can set it).

**ActionResult** (returned, and recorded under the idempotency key)

```
{ ok, requestId, agentId, status: 'sent'|'refused'|'failed', signature?, policyVersion, modeEpoch,
  charges: [{category: 'game', amount, state: 'reserved'}], error?: {code, message, …}, balance, replayed? }
```

`sent`: the relay accepted and sent the transaction (its fate is `GET /f/tx/{signature}`). `refused`: nothing was sent, nothing charged — the gateway's own refusal or the relay's (its code is carried, e.g. `Duplicate`, `QuotaExceeded`, a program error name). `failed`: an RPC exception on the way; if the signature was already recorded (`beforeSend` ran) a priced hold stays reserved until `reconcile` reads the chain.

**Codes** (`ERR`): `BadRequest, UnknownAgent, NotOwner, BadOwnerSignature, OwnerCommandExpired, OwnerCommandReplayed, BadCapability, AgentStopped, StalePolicy, StaleMode, ActionNotAllowed, WrongVillage, BudgetExceeded, DailyLimitReached, InsufficientBalance, IdempotencyConflict, SessionNotDelegated, RelayRefused, SendFailed, DepositInvalid, DepositPending, WithdrawFailed, InferenceFailed, AgentKeyDirect, TooManyAgents, AgentWalletDisabled`.

**Actions an owner may allow** (`ACTION_GROUPS`): `economy` = Harvest, Build, Train, Muster, Garrison; `explore` = Explore; `military` = Depart, Dissolve; `vigil` = SetVigil. **Never delegable**, whatever the policy says: Join, SetSession, PlaceHome, FileTicket, FileOutpost, DeclareSiege, RetireHost. Ownership, payout, policy and mode are owner commands, not actions.

**The order of checks in `AgentGateway.submit`** (everything up to the hold is synchronous, so concurrent requests cannot both pass the last unit):
credential → idempotency (same key and request: the recorded result with `replayed: true`; same key, different request: `IdempotencyConflict`; a concurrent repeat shares the in-flight promise) → mode is auto (`AgentStopped`) → `policyVersion` is current (`StalePolicy`) and `modeEpoch`, if given, is current (`StaleMode`) → the action is allowed (`ActionNotAllowed`) → it is on the agent's village (`WrongVillage`) → **hold** the action's game price (`InsufficientBalance` / `BudgetExceeded` / `DailyLimitReached`; the table is empty, so today a zero hold that only records) → on chain, the owner's Citizen names the agent's key as its unexpired session key (`SessionNotDelegated`) → the shape is built here (`accountsFor`, the mirror of the web client's) and signed by the agent's key → the relay's `sponsor()` (shape allowlist, the citizen's quota, co-sign, simulation, drain guard) → `beforeSend`: right before the bytes leave, mode, epoch and policy are checked again synchronously and the hold is marked `sending` with the signature → send.

## 4. The ledger (`ledger.mjs`)

Per agent, base units as decimal strings:

```
deposited = available + reserved + spent.inference + spent.network + spent.game + pendingWithdraw + withdrawn
```

`check()` verifies this and that `reserved` equals the sum of the open holds; the tests assert it after every step. `liabilities()` is what the custody token account must hold at least.

A **hold** is `held` (gives back on expiry, a stop, a refusal or a restart) → `sending` (the transaction's signature and last valid block height are known; only the chain's answer moves it) → **settled** (spent ≤ held, the rest back to available) or **released**. The budget's `total` counts settled plus held over the agent's life; `perDay` counts one UTC day's settled plus held. `spent.network` is always zero (the relay pays SOL; §6.3): the `network` history line carries the lamports.

History (last 500 lines): `created, policy, mode, capability, deposit, spend{category, key, model?, tokens?}, release{reason}, network{lamports}, action{name, key, source, status, signature?, code?}, withdraw, withdraw-failed`. Inference, network and game are told apart by `category`.

Requests (last 2,000): idempotency key → `{hash, result}`. Owner nonces: used once, kept until they expire.

Policy: `{allowed: [action names, sorted], budget: {total, perDay}, version}`; each owner `policy` command bumps `version`, each `mode` command bumps `modeEpoch`, and `manual` releases every `held` hold.

## 5. Who may do what

| | Owner's wallet signature | Capability token | In-process runner | MCP / any caller without a credential |
|---|---|---|---|---|
| create, policy, mode, withdraw, rotate-capability | yes | **no** | **no** | no |
| action (inside the policy) | yes (source `browser`) | yes (`ai` / `mcp`) | yes (`ai`) | no |
| deposit (credit a confirmed owner-signed transfer) | anyone may ask; only the owner's own transfer credits | | | |
| read the view / terms | anyone with the agent id | | | |

**Owner commands** (`owner-auth.mjs`): `{op, owner, agentId?, nonce (8–64), expiresAt (≤ 10 min ahead), params}` signed ed25519 over `'Wylls agent wallet command v1\n' + canonical JSON`; the nonce is used once. The browser signs with its wallet's `signMessage`; the tests and the E2E with a web3 keypair. The gateway re-checks `owner === agent.owner` on every owner method, so a route bug cannot let one owner move another's agent.

**Capability token** (32 random bytes, base64url): shown once at creation and on `rotate-capability`; the ledger keeps its sha256 only; compared in constant time. It can only ask for actions; it cannot change the payout, the owner, the budget or itself.

**The agent's key** (`keyring.mjs`): made at creation, `dir/<agentId>.key` (hex seed, mode 0600) or memory-only in tests; the secret never leaves the module. The owner gives it the village with `SetSession` (wallet-only on chain, `permutation-frontier/src/proc/citizen.rs`) and takes it back the same way. The relay refuses an agent key that signs a transaction outside the gateway (`AgentKeyDirect`, 403): the key cannot be used to go around the budget even by whoever runs the relay's process by hand.

### 5.1 Who holds which secret, and what each boundary can and cannot enforce

| Secret | Held by | Can do | Cannot do |
|---|---|---|---|
| Owner's wallet key | the player (browser, or a web3 keypair in tests) | everything: create / policy / mode / withdraw / rotate, **SetSession** (the only on-chain revocation), manual play, deposits | — |
| Agent key (seed file, 0600) | the operator's relay process | sign player shapes for the owner's Citizen while it is the session key | SetSession (wallet-only on chain), withdraw, change the policy |
| Custody key (JSON, 0600) | the operator's relay process | move the custody token account's test USDC (withdrawals to the fixed payout) | — (an operator is trusted; §9) |
| Capability token | whoever the owner gives it to (an MCP server, an AI) | ask for actions inside the policy through `POST /f/agent/action` | create, fund, re-scope, stop, drain, rotate; sign anything |
| Operator token | the operator | `POST /f/agent/reconcile` | — |

**Enforced on chain** (whatever the operator does): only the owner's wallet sets or revokes the session key; the session key acts for that Citizen only (its holdings; the program checks the actor); the session expiry. **Enforced by the operator's server only** (trusted; a party holding the agent *seed* could go around them by sending to the RPC directly, paying its own fee): the budget and the daily limit, the allowed-action list, the one-village rule (`WrongVillage`), the stop (`manual`), `modeEpoch` / `policyVersion`, the per-call inference price, `AgentKeyDirect` (which covers relay-sponsored sends, not a direct RPC send). The seed never leaves the relay's key directory, and the relay itself never signs an agent key outside `AgentGateway.submit`; the tests assert both, and `GET /f/agent` reports the chain's delegation (`delegation.delegated`) next to the server's mode so the owner can see that a stop is a server-side stop and that `SetSession` is what revokes on chain (the E2E does both).

**Stops racing with sends** (tests in `agent-wallet-review.test.mjs`): a stop after the send rolls nothing back (the hold waits for the chain, then settles); a stop during a model call leaves the call's hold in place (`running`) so the call is paid for when it returns, and what it decided is refused; a stop and restart while a request is between its hold and its send is refused at `beforeSend` by the epoch, with or without `modeEpoch` in the request. *Found by the review:* before it, a stop released a running call's hold and the call went unpaid; fixed in commit a49d0f57.

**Not exposed**: the capability (hash only), the custody key (a 0600 JSON keypair file; `Custody.toJSON()` is public keys), the agent seeds (0600 files; the keyring's `toJSON` is a count). The runner's prompt is built from the public view (`promptOf`), and the tests assert that no token or key reaches the model body, a view, the state file or the log.

## 6. Money

### 6.1 Deposit

The owner sends test USDC to the custody token account in a transaction the owner signs (the E2E builds `[createAtaIdempotent(custody), TransferChecked(owner's ATA → custody, mint, amount, authority = owner)]` and pays its own fee). Then `POST /f/agent/deposit {agentId, signature}`. The relay reads the transaction from the chain (`getTransaction` at the relay's commitment, `confirmed`; a live cluster would use `finalized`) and credits **only when all of these hold** (`Custody.verifyDeposit`):

1. the node returns the transaction **with its result metadata** and `meta.err` is null (no metadata yet → `DepositPending`, never credited);
2. the owner is one of the transaction's required signers;
3. the custody token account is among the transaction's accounts;
4. the amount is the sum over the **top-level** instructions of the **classic SPL Token program** (`Tokenkeg…`, no fee extensions) with tag 12 `TransferChecked`, mint = the custody mint, destination = the custody account, authority = the owner; it must be positive. A `TransferChecked` that ran in a transaction without error moved exactly its amount: the existence of the instruction is not enough, its transaction's success (1) is what moves the tokens. Inner (CPI) instructions, other programs with the same bytes, another mint, another destination, another authority and a zero amount are refused (tests);
5. when the node reports token balances for the custody account, its gain must equal that sum; with `strictBalances` (set automatically for any cluster but localnet) a node that reports none is refused, so the localnet accommodation cannot weaken a full validator.

One signature is credited once, ever: the ledger keys `deposits` by signature across all agents, in the state file, so a repeat for the same or another agent, and a repeat after a restart, answer `already` (tests). *Why instructions, not balances:* the local `frontier-localnet` reports empty `pre/postTokenBalances` (seen in E2E run 1).

### 6.2 Withdrawal

Owner command `withdraw {amount}` or `{all: true}`. Only `available` can go; a hold in `sending` state stays reserved until the chain answers, then comes back and can be withdrawn next. `all`, or an amount equal to everything available, stops the agent first (mode manual, `held` holds back to available, then taken). The custody key signs a `TransferChecked` to the owner's associated token account (created idempotently), a relay pool key pays the fee; the signature is recorded **before** the bytes are sent, so a timeout leaves a `sending` withdrawal that `reconcile` finishes (landed → `withdrawn`; failed or expired past its last valid block height → back to `available`). A withdrawal that cannot even be built fails at once with the money back (`WithdrawFailed`).

### 6.3 Network fees in SOL

The relay pool pays every fee and escrow of a sponsored shape as before; the agent wallet only records `lamports` (base fee plus what the simulation moved) in a `network` history line. **Design for a USDC settlement, not implemented:** (1) a rate `lamportsPerUsdc` published in `GET /f/agent/terms` with its source and validity; (2) at `beforeSend` a second hold in category `network` of `ceil(allowance × rate)` (the relay already knows the kind's allowance); (3) `onSent({moved})` settles it to `ceil((fee + moved) × rate)`; (4) a per-day cap on network spend in the policy. Until the owner chooses a rate source, anything implicit (a float, a fixed test rate) would be a hidden conversion, so it is left out.

### 6.4 Model calls

`meterInference(agentId, fn, {key, free, model})`: refuses when the agent is stopped; for the autopilot (`free`) only runs; otherwise holds the fixed price (an unpayable call is never made), marks the hold `running` (a stop no longer releases it), runs `fn`, then settles the whole price whether `fn` returned or threw, recording `{model, tokens, ok}`, and reports what was really settled as `charged`. A process crash mid-call leaves a `running` hold that the restart gives back; a call that outlives the hold's own TTL (10 minutes; the model deadline is 30 s) is not charged and is logged.

**What an action costs, with the shipped defaults** (`FRONTIER_DEFAULTS`, not a test override): a model-chosen action = one inference price (10,000 base units = 0.01 test USDC, the owner's decision 2) and nothing else; a rule-autopilot action = 0; the game category = 0 for every delegable action because the price table is empty (`--agent-game-prices-file` is an operator hook; nothing ships in it); the network category = 0 always, the relay pays the SOL fee and a `network` history line records the lamports. So the 0.02 of the E2E is exactly two model calls. **Decided:** the inference price. **Proposals, not decided (left out):** any game price, a SOL→USDC settlement (§6.3).

### 6.5 A model call whose outcome cannot be known (the review of 2026-10-17, second round)

The owner's charge and the operator's cost are kept apart: the ledger bills the owner only for a call whose outcome this process saw; everything else goes to the operator's own record (`operatorCosts` in the state file, `GET /f/agent/unresolved` for the operator), never guessed into the owner's bill.

| Case | What happens | Owner billed? | Operator record |
|---|---|---|---|
| The process restarts while a call runs | the `running` hold becomes **`unresolved`**: the money stays reserved (not available, not withdrawable), nothing is charged | not yet | `unknown-call` (reason `restart`) |
| The call outlives its TTL (10 min; the model deadline is 30 s) | the same: `unresolved`, not refunded | not yet | `unknown-call` (reason `ttl`) |
| A result arrives for an `unresolved` hold (the TTL case) | the outcome is known: charged once (`spend` with `late: true`) | yes | — |
| The operator decides (`POST /f/agent/settle {holdId, outcome: charge or refund, note}`) | `charge` bills the owner (`spend` with `decidedBy: operator`); `refund` returns the money | as decided | `refunded-call` on a refund |
| A result arrives after the operator refunded | the hold is gone: not billed, not billed twice | no | `late-result` |
| A second delivery of the same result | the ledger settles a hold once; the second is a no-op | once | — |
| Repeated restarts | an `unresolved` hold stays as it is; one record, not one per restart | — | once |
| A stop while a call runs | the hold stays `running`; the call is paid for when it returns; what it decided is refused | yes | — |

Tests: `test/agent-wallet-billing.test.mjs`. A full withdrawal with an unresolved call leaves exactly that amount reserved until the operator decides (the page shows it as 運営の確認待ち / "waiting for the operator").

**The recommended rule for the owner's decision (implemented behind `--agent-unresolved-release-ms`, OFF by default, not enabled):** an `unresolved` call is released back to `available` after a deadline; a result after that is never billed (`late-result`, the operator's record); the operator's record keeps the call as `released-call`. Deadline candidates from the measurements (model call ≈ 0.9 s, the call deadline 30 s, the hold TTL 10 min, a relay restart ≈ 1 min): **15 min** (a few times the TTL: every real result is in by then), **1 h** (recommended: covers a restart and a human look at the log, and an owner's money is never locked across a day), **24 h** (an operator's working day). Impact: owners get reserved money back without asking; the operator absorbs the cost of calls it cannot prove, bounded per agent per day by the call caps (§7.1). Abuse: an owner cannot cause an unresolved state (restarts and TTLs are the operator's); an operator who wanted to bill unknown calls would have to decide `charge` by hand with a note, which the settlement record shows (who, when, which call, why, on what evidence). With the rule on, the manual `settle` route stays for calls inside the deadline.

**Verified on localnet, the fourth round (2026-10-17, run agent-e2e-8, season 97, relay started with `FRONTIER_AGENT_UNRESOLVED_RELEASE_MS=3600000`; `scripts/agent-wallet-e2e.mjs` with `AGENT_E2E_SCENARIO=unresolved AGENT_E2E_WAIT_RELEASE_MS=4800000`, transcript `.local/agent-wallet-e2e/run8-unresolved-1h/transcript.json`, 16 checks):** the stand-in model held the first call open; the relay was killed (-9) while the hold was `running`; the stack's supervisor had it back in 2.6 s and `recover()` marked the hold `unresolved` (reason `restart`, `unknown-call` in the operator's record, nothing charged); the owner stopped the agent and withdrew everything: 9,990,000 came back and exactly the 10,000 of the unresolved call stayed reserved; 3,601 s after the kill the reconcile released it (`auto-release`, `released-call` in the operator's record), the money was available again, the day's call count stayed at 1; the owner then set `callsPerDay: 1` and switched to auto: no model call followed (the cap counts the released call), the autopilot's free Harvest landed; the last withdrawal returned the 10,000, `deposited = withdrawn = 10,000,000`, nothing spent. **The owner's decision (fourth round): the one-hour release is tried on localnet first and is not a production billing rule yet.** The settlement record now names the credential, not a label (§5.1: `by: {via: 'operator-token', token: <8-hex fingerprint>, ip}`, the body's `by` kept as `claimedBy`); the relay has one operator token, so this identifies the token and the address, not a person — named operator tokens would be the next step if several people settle.

**Other proposals that change the owner's refund rules (not implemented; the owner decides):**
1. *Auto-refund after N hours* of `unresolved` (the operator absorbs the cost without a decision) — cheaper for owners, costs the operator; today the decision is manual.
2. *A late result after the TTL is not billed* (today it is billed, because the outcome is then known) — simpler to explain to owners, costs the operator.
3. *Bill on dispatch* (charge the moment the request leaves for the model, whatever happens after) — the strictest reading of decision 2, no unresolved state at all; the owner pays for calls the model may never have seen. Not recommended for a restart, which is why it is not the default.
4. *A per-day cap on model calls in the policy* (separate from the USDC budget), after what §12 found.

### 6.6 Concurrency, retries, timeouts

* Checks and holds are synchronous in one process; 20 concurrent priced requests against a balance for 10 send exactly 10 (test). Several processes on one state file are **not** supported (§9).
* A retry with the same `idempotencyKey` returns the recorded result (also for `failed`): no second send. A different request under a used key is refused. A concurrent repeat of an in-flight key gets the same promise.
* A send that throws after the signature was recorded does not refund: `reconcile` (every `--agent-reconcile-ms`, and `POST /f/agent/reconcile` for the operator) asks the chain and settles or releases by `landed / failed / expired`. The same rule for withdrawals.
* A stop or a new policy while a request is between the hold and the send refuses it at `beforeSend`: nothing sent, the quota refunded, the replay key released, the hold back (test).
* Restart: `held` holds are released (`restart`); `sending` ones wait for `reconcile`.

## 7. The runner (`runner.mjs`)

With `--agent-runner`, the relay process ticks every agent in auto mode every `--agent-tick-ms` (default 30 s); an agent whose last tick sent nothing (a "rest", a refusal, an unaffordable call) sits out 1, 2, 4 … up to 16 ticks before it is asked again, and a sent action resets that (§12 says why): the decider picks one action, `meterInference` wraps it, the choice goes through `submit` with source `ai` and the key `<agentId>:<modeEpoch>:<tick>`. The **autopilot** harvests when allowed and is free. The **model decider** (`--agent-llm`, a loopback llama-server as the AI citizens use, `citizens/mind/llm.mjs`) sees the public view and a candidate list (`Harvest, Train, Build, SetVigil`, no marches), must answer in the JSON schema, and a late, invalid or unaffordable answer falls back to the autopilot; the failed call is charged, the fallback is not. The runner never sees a secret and never starts a march.

### 7.1 When the model is asked (the third round, 2026-10-17)

The runner no longer asks the model on a timer. Each tick the `AgentObserver` reads what the owner's browser reads (the herald: `/h/season`, `/h/me/{owner}`, `/h/province/{p},{q}/latest`; public records, nothing private) and reduces it to digests over the fields that mean something happened — the village's Holding (state, tier, stores, production, queue, walls, reserve, transits, explore), the province (hosts present, camp, sites, tickets, survey, relations) and the Citizen (session, holding, tickets, works) — not the counters a quiet turn moves (`RESOLVED_NEXT`, the event sequence; run agent-e2e-5 showed that hashing whole accounts made every turn an "event"). `triggersOf` then names why the agent would be asked: `owner` (policy or mode changed), `event` (a digest changed), `turn` (the bell moved), `result` (the owner acted by hand). **No trigger, no call.** On top:

| Control | Rule | Default (TEST VALUE, proposed, not a production figure) |
|---|---|---|
| Deduplication | a tick coalesces everything that happened since the last call into one decision; the same state again is no trigger | — |
| One at a time | one model call per agent in flight (`inflight`); one scheduler tick at a time | — |
| Minimum gap | no call within `minCallGapMs` of the last, except on an owner change | 60 s (`--agent-min-call-gap-ms`); 30 s in the measured runs |
| Owner gap (fourth round) | an owner change gets through the minimum gap, but a burst of owner commands is one call per `ownerCallGapMs`; the change is never dropped (it stays a trigger for the next tick); the caps are checked before any trigger | 10 s (`--agent-owner-call-gap-ms`) |
| Rest back-off | after a call that sent nothing, turn-only triggers are sat out 1, 2, 4 … 16 turns; an event or an owner change ends it | 16 turns |
| Operator cap | `maxCallsPerDay` per agent in the scheduler | 200 (`--agent-max-calls-per-day`) |
| Owner cap | `policy.budget.callsPerDay` (a count next to the money), enforced in the ledger: the model is not called past it, the autopilot plays free | none unless the owner sets it |

Why these numbers: a turn is 600 s of chain time (60 s of wall time in the 10× test world, 10 min in the real one); the measured Gemma 4 26B call is ≈ 0.9 s (prompt 0.23 s, generation 0.65 s), so a gap of 60 s is "at most one call a turn in the test world" and far above the model's time; 200 a day is above the 144 turns of a day plus some events, so the cap bites only on a runaway. The owner decides the production figures (§13).

Two things the fourth round found and fixed: (1) the scheduler's cap read the agent's stored day, which the ledger rolls only when a hold is made — on a new UTC day the cap would have read yesterday's count and never called again (nothing else rolls the day); `view()` now reports the day as the ledger would roll it (`test/agent-wallet-caps.test.mjs`); (2) the observer read the province's bytes at `province.bytes_b64`, but the herald's `/h/province/{p},{q}/latest` carries them as `bytes` next to `slots` — so in runs 6 and 7 no province change (an arrival, a camp) was ever an event; the observer now reads the real shape (and the old one), and the trigger test's fake herald uses the real shape.

Tests (`test/agent-wallet-triggers.test.mjs`): fifty ticks on an unchanged state make no call; after a rest, turns are sat out 1, 2, 4, 8 while an event and an owner change get through; a flood of 1,000 events over 100 ticks makes at most one call per gap and stops at the operator's cap, the owner's cap refuses the hold before the model is called; one call per agent at a time; an unreadable herald asks nothing; the digests ignore a quiet turn and see an arrival, a promotion, a session change.

### 7.2 What the model is told (the fourth round, 2026-10-17)

Until this round the model saw only the agent's view (balance, policy, recent lines) and the candidate list: it had nothing to decide *with*, which is why it harvested once and rested (§12.1). The observer now also returns `state`, built by `villageState()` from the same decoded public records it digests: tier; stores projected to the chain's clock as the owner's page projects them (whole units; the cap); production and upkeep per hour; the queue (what, seconds left) and the free slots; walls; the reserve by unit; marches out; the garrison (the province's site mirror), the village's own hosts and the other factions' hosts and camp in the province; the vigil; and one derived line, `threat` (`{hostile_troops, troops_at_home, outnumbered}`), present only when something hostile is there. `promptOf` adds, for the allowed actions, what each does (`ACTION_NOTES`) and the catalog (`CATALOG`: the six buildings with their first-copy cost and rate; the six trainable units with the cost per started batch of 100; informational — the program decides). The decider refuses, before anything reaches the chain, a `Train` with `n < 1` and an answer the state's stores cannot pay for (`affordable()`); a refused answer is a failed call (charged, as decided) and the autopilot plays free, and the runner's log now says why. Nothing private reaches the model: no key, no token, no owner address (test). Prompt size grew from ≈ 180 to ≈ 930 prompt tokens per call (`run9`: 985–991), within the pinned server's 16k context; the latency stayed ≈ 1.2–1.9 s per call on the bench.

## 8. What was verified

* `cd permutation-gateway && npm test` — the full suite, including the new `test/agent-wallet-*.test.mjs` (gateway, money, runner, server, ledger). See the completion report for the count.
* `scripts/agent-wallet-e2e.mjs` on a disposable `frontier-stack` world (its header has the commands; runs `agent-e2e-2` (season 92) and, after the review fixes, `agent-e2e-3` (season 93), 2026-10-17: **17 checks passed** each; run 4 also checks the breakdown (two `spend` lines of 10,000, both `inference`; `game` and `network` 0; three `network` lines of 10,000 lamports paid by the relay) and the chain's delegation before and after the owner's SetSession — deposit 10,000,000, two model calls charged 20,000, withdrawn 9,980,000 to the owner's token account): faucet → x402 join → PlaceHome → manual Harvest → create (owner command) → forged and stranger commands refused → owner-signed deposit credited once → `SetSession` to the agent key → auto → an outside caller's Harvest sent and landed, a repeat replayed, a march and another village refused, a bad token refused → the relay's own runner acting twice with a stand-in model server on loopback, charged per call → the agent key on `POST /f/relay` refused → manual: requests refused, the runner silent, the owner's `SetSession` back and a manual Harvest → `withdraw all` landing in the owner's token account, `deposited = spent + withdrawn`. The transcript is written to `.local/agent-wallet-e2e/<run>/transcript.json`.

* **Fourth round (2026-10-17).** `test/agent-wallet-caps.test.mjs` (the two questions, the owner burst, the state and the guards); run `agent-e2e-8` (the deadline rule end to end on localnet with a real kill -9, §6.5); runs of `scripts/agent-decision-bench.mjs` against Gemma (`bench-1` … `bench-4`, §12.2); run `agent-e2e-9` (the real model in the live world with the state, 18 checks, §12.2). `docs/agent-wallet/VERIFY.md` has the commands to repeat each of these without trusting this document.

## 8.1 Where the implementation should land

Measured on 2026-10-17 with `git merge-tree --write-tree --name-only <A> <B>` (a trial three-way merge that touches no worktree; each `CONFLICT` line is one file whose merge needs a hand), `origin/main` = 2321d557 after `git fetch`:

| Trial | Result |
|---|---|
| `origin/main` × `codex/territory-opening` | 189 conflicting files (135 add/add, 53 content, 1 modify/delete); merge-base ad1c919d (2026-10-04); 2,210 files changed on main since, 3,955 on territory, 1,916 on both |
| `feature/agent-wallet` × `codex/territory-opening` | the same 189 files, not one more |
| `origin/main` → `feature/agent-wallet` | a fast-forward: this branch is origin/main + 4 commits, main has nothing this branch lacks |

A cherry-pick of this branch's commits onto `codex/territory-opening` in a disposable worktree stopped at the second commit with content conflicts in `app.mjs`, `routes/relay.mjs` and `server.mjs`, all of the same kind: territory-opening has **no prize pool** (no `routes/prize.mjs`, no `client/src/frontier/prize.mjs`, no `--prize-mint`/`--faucet-key-file`, `sponsor()` not exported and without `extraAllowance`), which main gained in 9ed6fe40. The agent wallet's custody mint *is* the prize pool's test USDC and its E2E joins over x402 and the faucet, so on territory-opening alone it has nothing to hold: the conflicts are semantic, not textual, and were not resolved. **Recommendation: integrate into `main`** (fast-forward; the full suite and the E2E ran on exactly that tree), and bring `codex/territory-opening` to main separately (its 189 conflicts with main exist with or without this branch). Which branch is the trunk is a decision for the owner.

## 8.2 What `codex/territory-opening` has, and what main has (measured 2026-10-17)

Both branches diverged from ad1c919d (2026-10-04). Since then: territory-opening has 499 commits of its own (the UX waves of 10-01 to 10-10: the hand and the board, the first-village flow, the sample world, the AI-citizen runs and their notes); main has 20, almost all in one squash, 9ed6fe40 "Integrate recorded Wylls build and submission docs" (2026-10-12, 2,192 files), followed by the prize pool / x402 / faucet / submission fixes.

What the content says (`git diff --name-only codex/territory-opening origin/main` over code, excluding art, run records and fixtures: 190 files):

| Measure | Result |
|---|---|
| Files where main's copy is newer (last commit date) | 190 of 190; none where territory-opening's is newer |
| Files with **no line that only territory-opening has** (main is a superset) | 79 of 190 |
| Largest territory-only residues (lines) | controller.mjs 65, map/fmap.mjs 58, app.mjs 44, lang/en-frontier-play.mjs 35, en-frontier.mjs 34, citizens/verify-minds.mjs 26, hud/feed.mjs 21 |
| 23 distinctive identifiers of territory-only lines (feed toasts, march book, the away marker, watch painting, survey gain, the conquest screen, bots' v2 dispatch, verify-minds M7…) | every one is present in main's copy, with the same or a higher count |
| Code files that exist only on territory-opening | none; only docs: `docs/frontier/ai-citizens/*-NOTES.md`, the AC/FB/integ run notes and screenshots, `RECORDING-GUIDE.ja.md`, `runtree-r2/` (evidence, not code) |
| What main has that territory-opening lacks | the prize pool and x402 entry (`routes/prize.mjs`, `client/src/frontier/prize.mjs`, `--prize-mint`, the faucet, `sponsor()` exported with `extraAllowance`), `permutation-prize`, 214 web modules/assets added since (keeps, keephand, marcher, fprize, fkeepreach, proto…), the submission docs |

So, by content, main carries territory-opening's features in later form; the residue is older phrasing and structure, not features main lacks. The reviewer's caveat stands: a 65-line residue in `controller.mjs` may still hold a fix that main re-did differently; the seven files above are where a human would look before deleting the branch. The branch's own worktree (`~/.codex/.chatgpt-projects/…/wylls-territory`) holds 143 uncommitted changes (UX design doc, tests) that are not in either branch; they were not touched.

**Integration policy proposed:** take `main` as the trunk; merge `feature/agent-wallet` into it (fast-forward); treat `codex/territory-opening` as a source of a few possible fixes (the seven files) and of the AI-run notes to copy under `docs/frontier/ai-citizens/`, then retire it. The 189-file conflict is the cost of merging territory-opening *into* main wholesale, which brings nothing main does not already have. Nothing was merged or resolved in this round.

## 9. Known limits and unresolved points

* **One relay process per state file.** The ledger's safety is the single-threaded event loop; a second process on the same `agent-wallet.json` would double-spend. A multi-process deployment needs a real database with row locks or the on-chain vault below.
* **The custody is the operator's key.** It is a test setup; the operator could move the tokens. The migration keeps `Custody`'s interface (`verifyDeposit`, `withdraw`, `status`, `balance`) and replaces the implementation with an on-chain vault program: a per-agent escrow PDA the owner funds directly (deposit = the program's instruction, no relay verification needed), withdrawals signed by the owner (not the operator), and the relay's ledger becoming an index of on-chain state plus the off-chain holds. Spending from the vault for model calls would then be a program instruction the relay signs within an on-chain budget, so the operator's charge is auditable.
* **The relay's quota** charges the citizen's bucket for the agent's actions, as for manual play; an agent in auto cannot be rate-limited apart from its owner.
* **The game price table is empty**; a non-zero price would make an action's hold wait for the chain's answer, which the tests cover but no real world uses.
* **The browser page is a first version** (§10): one standalone page, the dev wallet only, tested with a fake DOM against the live stack (`scripts/agent-page-smoke.mjs`), not yet in a real browser session.
* **A full withdrawal while a hold is `sending`** leaves that hold's money to come back later; the owner withdraws it with a second command.
* **The deposit transaction must be built by the client** (the E2E and later the browser); the relay does not build or sponsor it. A sponsored deposit (relay-paid fee, owner-signed, verified byte for byte as the x402 join is) would be the natural next step for the browser.

* **The model's judgement is measured, not solved** (§12.2): with the state and the catalog Gemma 4 26B builds a Food building first whenever it can afford one, reads a threat from the derived line but not from the raw host list alone, and once answered an unaffordable training with a reason admitting it; the guards turn such answers into a free autopilot turn. A herald record a few seconds behind the chain can make an answer that was right on the record be refused on chain (run 9: one `Build` refused `QueueFull`; the model call is charged, the action costs nothing).
* **The settlement's identity is the token, not a person** (§6.5): one operator token per relay. Named tokens, or a per-operator credential, would be needed before several people settle calls.

## 10. The owner's page (`web/frontier/agent.html`, `fagent.mjs`)

A standalone page next to the play page (`/frontier/frontier/agent.html`), under the herald's CSP (no inline script or style), Japanese source with English in `lang/en-frontier-agent.mjs`. It shows, in this order: the connection token (once, at creation or reissue); **the balance apart** — deposited, available now (the only withdrawable part), reserved in flight, waiting for the operator (unresolved calls), withdrawing, withdrawn, and spending by category (decisions, in-game, fees with the note that fees are the operator's SOL); **manual / auto** with the switch count, and the sentence that a stop is server-side and rolls nothing back; **the delegation on chain** with one of four sentences for the four states (auto+delegated, auto+not, manual+still delegated, manual+yours), and the two wallet-signed buttons — hand the key over, take it back — each followed by the chain's confirmation and a re-read; **deposit and withdraw** (the sponsored deposit the wallet signs; withdraw an amount or everything, with the note of what stays reserved and that everything stops the agent); the policy form (groups and the two limits, with the version); the history by category. Every write is one of: an owner command signed with `signMessage`, `SetSession` signed with `signTransaction`, the sponsored deposit signed with `signTransaction`.

Verified: `test/web-frontier-agent.test.mjs` (models, the commands the relay verifies, the deposit the relay accepts, the words in both languages) and `scripts/agent-page-smoke.mjs` against the live stack with the real model (connect → create → deposit 2 → hand over → auto → the agent acted → stop → key back → withdraw everything). Not yet done: a real browser session (the Chrome extension was not connected in this session), a wallet other than the dev wallet, the play page linking to it.

**Verified in a real browser (the fifth round, 2026-10-17):** `scripts/agent-page-browser.mjs` drives Google Chrome 155 (headless, the DevTools protocol over the `ws` package; Playwright is not installed here and no extension is needed) through the page as the herald serves it, CSP on: real clicks, typed values, the page's own modules signing with its dev wallet (the owner's key placed in the browser's localStorage). Runs `.local/agent-wallet-e2e/browser-1`, `browser-2`, `browser-3` (18 steps each, a screenshot and the page's text per step, `report.json`): connect → create → deposit 2 (sponsored) → the policy form (1.5 / 0.6 a day, economy and vigil) → the key handed over (SetSession, wallet-signed, confirmed on chain) → auto → the runner's Harvest on the page → a refused message signature (the mode stays auto) and a refused transaction signature (nothing deposited), both rejected at the Wallet Standard boundary → offline (the command does not go out, the page says so) and back → a reload (connect again finds the agent; the token is not shown again) → a stop while a model call is in flight (the hold stays reserved; the page shows 処理中の予約 0.01) → a withdrawal with that call running (everything else leaves) → the late result charged once → the key taken back (confirmed) → the rest withdrawn, the books balancing. The agent page's console: no error of its own; only `/favicon.ico` 404. (The lobby page at `/frontier/`, loaded once in browser-1 and 2 to set localStorage, logs a CSP violation for the language toggle's inline style — shared `lang.mjs`, unchanged from main, not this page.) **Not verified:** a real wallet extension (Phantom, Backpack …) — its approval window cannot be driven; the dev wallet signs in-page.

## 11. Remaining work for the MCP connection

An MCP server is one more caller of `POST /f/agent/action` (or `AgentGateway.submit` in process). It needs nothing new in the balance or payment path. Still to do:

1. **Tools**: `agent.view(agentId)`, `agent.terms()`, `world.*` reads (the herald's existing JSON), and `agent.act(ActionRequest)` → ActionResult; errors are the `ERR` codes.
2. **Credential**: the MCP server holds the agent's capability token (given by the owner), never the owner's wallet; it cannot create, fund, stop or drain the agent, and must not be presented as authentication or as a payment approval.
3. **Idempotency**: the MCP layer must generate the key and keep it across its own retries.
4. **Rate limits**: `POST /f/agent/action` is 40 burst / 2 per second per address and 30 burst / 1 per second per agent.
5. **The browser**: owner commands signed with the wallet's `signMessage`, the deposit transaction, the `SetSession` hand-over, the view.
6. **Observability**: the ledger's history is the audit trail; an operator route to list agents and the custody's liabilities against its on-chain balance would complete it.

## 12. The real model (Gemma 4 26B A4B, Q4_0, local llama-server), 2026-10-17

Run `agent-e2e-4` (season 94), the relay's runner on `http://127.0.0.1:41901` (the pinned `citizens/llama/start-pinned.sh`: alias `gemma-4-26b-a4b-it`, model `.claude/data/models/gemma-4-26B-A4B-it-Q4_0.gguf`, one slot, context 16384, thinking off), tick 8 s, no paid API, test tokens only. `scripts/agent-wallet-e2e.mjs` with `AGENT_E2E_MODEL=real` (transcript `.local/agent-wallet-e2e/run5-gemma/transcript.json`, kept apart from the stand-in runs 2–4 by its `model.mode`):

| What | Result |
|---|---|
| Checks | 17 of 17 |
| Model calls charged | 3 × 10,000 (the test price), tokens 155/25, 161/57, 169/60 |
| Actions decided by the model | 2 Harvests, both sent and landed, each with the model's own reason recorded (e.g. "harvesting is the most efficient way to increase the village's resource pool within the budget") |
| Fallbacks to the autopilot | 0 |
| Latency (llama-server timings) | prompt ≈ 0.23 s, generation ≈ 0.65 s per call |
| Deposit 10 (9 sponsored + 1 direct) → withdrawn | 9,970,000; `deposited = spent + withdrawn` |

**Finding:** in the page smoke on the same world the agent spent its whole daily limit (0.5 = 50 calls) in about seven minutes: after the first harvests the model answered "rest" at almost every 8-second tick, and a "rest" costs a call like any other. Cost was proportional to time, not to actions. The scheduler now backs off after a tick that sent nothing (§7); the shipped tick is 30 s. Still open for the owner: a per-day cap on model calls in the policy, and an event-driven runner that asks the model only when something changed (the AI citizens' design). The 0.01 per call stays a localnet test price, not a production one.

### 12.1 Before and after the call controls (the third round, 2026-10-17)

Same world shape (conquest, 10×, tick 8 s), same model server, same price. "Before" is the page smoke on run agent-e2e-4 (the timer-driven runner); "after" is run agent-e2e-7 on the field-level observer with a 30 s minimum gap, the E2E's seven-minute window (`AGENT_E2E_WINDOW_MS=420000`, transcript `.local/agent-wallet-e2e/run7-gemma-triggers/transcript.json`). Run agent-e2e-6, between the two, hashed whole accounts and still called once a turn (13 calls in ten minutes): that is why the digests read fields.

| | Before (timer, 8 s) | After (triggers, 8 s tick, 30 s gap) |
|---|---|---|
| Model calls in ≈ 7 minutes (≈ 7 turns) | 50 — the daily limit of 0.5 | 5 (+1 first call before the window) |
| Charged | 0.50 test USDC | 0.05 (0.06 with the first call) |
| Actions sent | 2 Harvests (run 5) | 1 Harvest (the first call), then the model rested |
| "rest" answers charged | ≈ 48 | 5, each on a trigger: 1 event (its own Harvest landing), 4 turns at the back-off's 1, 2, 4, 8 |
| Ticks that asked nothing | — | 47 (no change 21, rest back-off 23, minimum gap 3) |
| Checks | 17 of 17 | 18 of 18 |

A rest still costs a call (the owner's rule stands); what changed is that the same state is never asked twice and a resting agent is asked less and less often until something happens. The price per call stays the localnet test price.

**A limitation of runs 6 and 7, found in the fourth round (§7.1):** the observer of those runs read the province's bytes at a path the herald does not use, so no change in the province (an arrival, a camp) was ever an event in them; their "event" triggers came from the village's own Holding and the Citizen only, and their call counts are a floor for a world where the province moves. The runs since (9 and later) read the province as the herald answers (`test/agent-wallet-regression.test.mjs` pins the shape and the arrival and camp events).

### 12.2 Judgement by situation, and the live world with the state (fourth and fifth rounds, 2026-10-17)

The owner's point after the third round: fewer calls is not "the same result for less" when the agent also did less. Two measurements answer it, each with two scores kept apart — **the model's judgement** (its answer against what a careful player would do, over every situation; an answer the code refused counts as a wrong judgement) and **the code's safety** (how many wrong answers the decider refused before the chain; the autopilot then plays free).

**(a) The bench** (`scripts/agent-decision-bench.mjs`): prepared situations put to the real model through the relay's own decider and prompt, temperature 0, seed 7; nothing on chain. As the prompt grew (fourth round, eight situations, one run each):

| Bench | Prompt | Judgement | Safety | The misses |
|---|---|---|---|---|
| bench-1 | state + catalog | 6 of 8 | — | both "train" situations: built Food with a hostile host and a camp in the province; rested with a host at the gate and a batch affordable |
| bench-2 | + the derived `threat` line, "defence first" | 7 of 8 | — | "a threat but nothing affordable": `Train n=0`, the reason saying it cannot afford a batch |
| bench-3 | + "n ≥ 1" in the Train note; `n < 1` refused | 7 of 8 | 0 refused | the same situation: `Train n=100` on Food 20, the reason again admitting the stores are short |
| bench-4 | + an unaffordable answer refused (`affordable()`) | **7 of 8** (the same wrong answer) | **1 refused** before the chain; the autopilot would play free | the model's judgement did not change; the code stopped the action |

Fifth round (`bench-5-*`, ten situations — the eight plus two for the Food question — **three runs each**, and the same ten with the catalog listed in reverse and with the stores listed in reverse, an order-bias check and not a tuning): every situation answered identically in all three runs and in all three orders (temperature 0 holds); judgement **24 of 30** judged runs (8 of 10 situations), 3 refused by the code (the "threat but unaffordable" situation, each time). The second miss is the Food question below.

**The Food question** (is "a Food building first" reasoning or a bias?): with Food 40 and a shortfall the model builds Food (right); with Food at 1,990 of a 2,000 cap, Wood and Stone plentiful and nothing under way, it still builds Food — "high food stores … building a Food farm is a priority for long-term sustainability" — in all three runs and in both reversed orders. So it is not the catalog's or the stores' order (candidate bias ruled out), and the information is in the prompt (`stores.Food`, `store_cap`): the model does not connect a store at its cap with wasted output. It reads as a prior of the model (food first), not a bias of the observation's order or of the prompt's wording — the system prompt names no resource; the Train note lists Food among the costs, which could prime it (not tested apart). What would make the cap legible to it (a per-store "at cap" or "hours to cap" line) is general information, not a tuning to these situations; it is left for the owner to decide (§13), as is whether a Food-first opening is acceptable in play. The bench's live situation (run 8's village at turn 65, stores ≈ 300 of each): `Build item 0`.

**(b) The live world, same conditions as run 7** (conquest, 10×, tick 8 s, minimum gap 30 s, owner gap 10 s, Gemma on the pinned server, 0.01 per call, the E2E's seven-minute window; a new wallet, home and agent each run on the same kind of world; the relay of run 9 had the state and the catalog but not yet the threat line and the two guards; runs 10a–c had everything):

| Run | Model calls | Charged | Model actions sent | Refused on chain | Refused by the code (autopilot plays) | Rests | Autopilot actions (free) | Ticks that asked nothing |
|---|---|---|---|---|---|---|---|---|
| 7 (no state) | 5 (+1 first) | 0.05 | 0 (1 Harvest at the first call) | 0 | 0 | 5 | 0 | 47 (no change 21, back-off 23, gap 3) |
| 9 (state, catalog) | 11 (+1) | 0.11 | 6: Build ×2, Train ×4 | 1 (Build, `QueueFull`) | 2 (the message was not logged then) | 2 | 2 Harvests | 41 (gap 28, no change 10, back-off 3) |
| 10a (threat line, guards) | 10 (+1) | 0.10 | 4 | 0 | 2 | 4 | 2 Harvests | 42 (gap 22, no change 12, back-off 8) |
| 10b | 8 (+1) | 0.08 | 4 | 0 | 0 | 4 | 0 Harvests | 44 (gap 17, no change 16, back-off 11) |
| 10c | 9 (+1) | 0.09 | 4 | 0 | 0 | 5 | 0 Harvests | 43 (gap 16, no change 12, back-off 15) |

Transcripts: `.local/agent-wallet-e2e/run{7-gemma-triggers,9-gemma-state,10a-gemma-repeat,10b-gemma-repeat,10c-gemma-repeat}/transcript.json` (`window.breakdown`). What these runs show, and no more: in these worlds the calls rose from 5 to 8–11 a window once the model had something to act on; the minimum gap did most of the bounding (16–28 of ≈ 42 skips); 4–6 of the calls became actions the model sent (Build and Train), the rest were rests; the cost of a window was 0.08–0.12 at the test price. Three runs on the same kind of world under the same settings (10a–c) differ by two calls and one rest: the world's own events (a camp, the model's own actions landing) decide the exact count. "Cost followed activity" and "≈ 0.014 per action" (the fourth round's reading of run 9) are observations of those runs, not a rule; another world, model or gap would give other figures. The calls the code refused (two in run 9, two in 10a, none in 10b and 10c) were answers the state could not pay for or empty trainings; each was charged (a call is a call) and the autopilot's free Harvest followed. The "ticks that asked nothing" column counts from each run's own start (its setup minutes before the window included).

## 13. Decisions: taken, and still wanted (fourth and fifth rounds)

**Taken by the owner, 2026-10-17:**
1. **Integration:** `main` is the base; no merge before the real-browser verification (done in the fifth round, §10, the wallet extension excepted); `codex/territory-opening` is not deleted; its art/VFX track is taken in later as its own track (INTEGRATION-REVIEW.md §3). Nothing there was touched in the fifth round either.
2. **Unresolved calls:** the one-hour release is a localnet trial (§6.5), off by default, not a production billing rule. No named operator tokens for now: one token per relay, so a settlement names the token's fingerprint and the caller's address, never a person (§6.5, §9; the token itself is never written — test).
3. **Call controls:** event-driven stays; an owner change is bounded by the owner gap; the caps are checked before any trigger.
4. **Scope:** no new actions for the model (walls, the tier-up) until the current verification is judged; the production prices, caps, gaps and refund rules stay open.

**Proposed settings for the next trial, with the reason (PROPOSED — none is a production figure):**

| Setting | Flag / field | Measured with | Proposed next | Why |
|---|---|---|---|---|
| Model call price | `--agent-inference-price` | 10,000 (0.01) | unchanged, test only | the owner's rule; the production price is open |
| Tick | `--agent-tick-ms` | 8 s (runs), 5 s (page tests) | 30 s (the default) | the observer reads three herald files a tick; 30 s is a twentieth of a turn and well under the gap |
| Minimum gap | `--agent-min-call-gap-ms` | 30 s | 60 s (default) in the 10× world; one turn (600 s) in a real-time world | at 30 s the gap did most of the bounding (22–28 of ≈ 42 skips a window) and ≈ 10 calls a window followed; one call a turn is the natural unit |
| Owner gap | `--agent-owner-call-gap-ms` | 10 s | 10 s (default); 60 s in real time | a burst of owner commands is one call per gap and the change is never lost (test) |
| Operator cap | `--agent-max-calls-per-day` | 200 | 200 (default) | above the 144 turns of a day plus events; bites only on a runaway; the day rolls in the view (test) |
| Owner cap | `policy.budget.callsPerDay` | 1–4 in tests | none unless set; show it on the page | a count next to the money; the autopilot plays free past it |
| Back-off | `BACKOFF_MAX_TICKS` | 16 turns | 16 | a resting agent is asked 1, 2, 4 … 16 turns apart; an event or an owner change ends it |
| Reconcile | `--agent-reconcile-ms` | 5–15 s | 15 s (default) | the chain's answer for sent holds and withdrawals |
| Unresolved release | `--agent-unresolved-release-ms` | 3,600,000 on localnet | off by default; 1 h for localnet trials | verified end to end (§6.5); the production deadline is open (15 min / 1 h / 24 h) |
| What the model is offered | `CANDIDATES` | Harvest, Train, Build, SetVigil | unchanged | walls and the tier-up wait for the owner |

**Still wanted:**
1. The production figures above, once the owner judges the trials enough.
2. The production deadline for unresolved calls, and named operator tokens if several people will settle.
3. The wallet extension: the page's signing with a real wallet (Phantom, Backpack …) is the one part of the page not verified; it needs a person at the wallet's approval window, or a wallet with a test mode that can be driven.
4. The Food question (§12.2): accept a food-first opening, or give the model a per-store "at cap" line (general information, not a tuning), or both.

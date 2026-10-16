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

**Not exposed**: the capability (hash only), the custody key (a 0600 JSON keypair file; `Custody.toJSON()` is public keys), the agent seeds (0600 files; the keyring's `toJSON` is a count). The runner's prompt is built from the public view (`promptOf`), and the tests assert that no token or key reaches the model body, a view, the state file or the log.

## 6. Money

### 6.1 Deposit

The owner sends test USDC to the custody token account in a transaction the owner signs (the E2E builds `[createAtaIdempotent(custody), TransferChecked(owner's ATA → custody, mint, amount, authority = owner)]` and pays its own fee). Then `POST /f/agent/deposit {agentId, signature}`. The relay reads the transaction from the chain and credits once per signature across all agents when: confirmed, no error, the owner among the signers, and the sum of its top-level SPL `TransferChecked` instructions of the custody mint into the custody account with the owner as authority is positive. When the node reports token balances (a full validator), the custody account's gain must equal that sum. *Why instructions, not balances:* the local `frontier-localnet` reports empty `pre/postTokenBalances` (seen in E2E run 1); an instruction that ran in a transaction without error moved its tokens.

### 6.2 Withdrawal

Owner command `withdraw {amount}` or `{all: true}`. Only `available` can go; a hold in `sending` state stays reserved until the chain answers, then comes back and can be withdrawn next. `all`, or an amount equal to everything available, stops the agent first (mode manual, `held` holds back to available, then taken). The custody key signs a `TransferChecked` to the owner's associated token account (created idempotently), a relay pool key pays the fee; the signature is recorded **before** the bytes are sent, so a timeout leaves a `sending` withdrawal that `reconcile` finishes (landed → `withdrawn`; failed or expired past its last valid block height → back to `available`). A withdrawal that cannot even be built fails at once with the money back (`WithdrawFailed`).

### 6.3 Network fees in SOL

The relay pool pays every fee and escrow of a sponsored shape as before; the agent wallet only records `lamports` (base fee plus what the simulation moved) in a `network` history line. **Design for a USDC settlement, not implemented:** (1) a rate `lamportsPerUsdc` published in `GET /f/agent/terms` with its source and validity; (2) at `beforeSend` a second hold in category `network` of `ceil(allowance × rate)` (the relay already knows the kind's allowance); (3) `onSent({moved})` settles it to `ceil((fee + moved) × rate)`; (4) a per-day cap on network spend in the policy. Until the owner chooses a rate source, anything implicit (a float, a fixed test rate) would be a hidden conversion, so it is left out.

### 6.4 Model calls

`meterInference(agentId, fn, {key, free, model})`: refuses when the agent is stopped; for the autopilot (`free`) only runs; otherwise holds the fixed price (an unpayable call is never made), runs `fn`, then settles the whole price whether `fn` returned or threw, recording `{model, tokens, ok}`. A process crash mid-call leaves a `held` hold that the restart gives back (§7).

### 6.5 Concurrency, retries, timeouts

* Checks and holds are synchronous in one process; 20 concurrent priced requests against a balance for 10 send exactly 10 (test). Several processes on one state file are **not** supported (§9).
* A retry with the same `idempotencyKey` returns the recorded result (also for `failed`): no second send. A different request under a used key is refused. A concurrent repeat of an in-flight key gets the same promise.
* A send that throws after the signature was recorded does not refund: `reconcile` (every `--agent-reconcile-ms`, and `POST /f/agent/reconcile` for the operator) asks the chain and settles or releases by `landed / failed / expired`. The same rule for withdrawals.
* A stop or a new policy while a request is between the hold and the send refuses it at `beforeSend`: nothing sent, the quota refunded, the replay key released, the hold back (test).
* Restart: `held` holds are released (`restart`); `sending` ones wait for `reconcile`.

## 7. The runner (`runner.mjs`)

With `--agent-runner`, the relay process ticks every agent in auto mode every `--agent-tick-ms`: the decider picks one action, `meterInference` wraps it, the choice goes through `submit` with source `ai` and the key `<agentId>:<modeEpoch>:<tick>`. The **autopilot** harvests when allowed and is free. The **model decider** (`--agent-llm`, a loopback llama-server as the AI citizens use, `citizens/mind/llm.mjs`) sees the public view and a candidate list (`Harvest, Train, Build, SetVigil`, no marches), must answer in the JSON schema, and a late, invalid or unaffordable answer falls back to the autopilot; the failed call is charged, the fallback is not. The runner never sees a secret and never starts a march.

## 8. What was verified

* `cd permutation-gateway && npm test` — the full suite, including the new `test/agent-wallet-*.test.mjs` (gateway, money, runner, server, ledger). See the completion report for the count.
* `scripts/agent-wallet-e2e.mjs` on a disposable `frontier-stack` world (its header has the commands; run `agent-e2e-2`, season 92, 2026-10-17: **17 checks passed** — deposit 10,000,000, two model calls charged 20,000, withdrawn 9,980,000 to the owner's token account): faucet → x402 join → PlaceHome → manual Harvest → create (owner command) → forged and stranger commands refused → owner-signed deposit credited once → `SetSession` to the agent key → auto → an outside caller's Harvest sent and landed, a repeat replayed, a march and another village refused, a bad token refused → the relay's own runner acting twice with a stand-in model server on loopback, charged per call → the agent key on `POST /f/relay` refused → manual: requests refused, the runner silent, the owner's `SetSession` back and a manual Harvest → `withdraw all` landing in the owner's token account, `deposited = spent + withdrawn`. The transcript is written to `.local/agent-wallet-e2e/<run>/transcript.json`.

## 9. Known limits and unresolved points

* **One relay process per state file.** The ledger's safety is the single-threaded event loop; a second process on the same `agent-wallet.json` would double-spend. A multi-process deployment needs a real database with row locks or the on-chain vault below.
* **The custody is the operator's key.** It is a test setup; the operator could move the tokens. The migration keeps `Custody`'s interface (`verifyDeposit`, `withdraw`, `status`, `balance`) and replaces the implementation with an on-chain vault program: a per-agent escrow PDA the owner funds directly (deposit = the program's instruction, no relay verification needed), withdrawals signed by the owner (not the operator), and the relay's ledger becoming an index of on-chain state plus the off-chain holds. Spending from the vault for model calls would then be a program instruction the relay signs within an on-chain budget, so the operator's charge is auditable.
* **The relay's quota** charges the citizen's bucket for the agent's actions, as for manual play; an agent in auto cannot be rate-limited apart from its owner.
* **The game price table is empty**; a non-zero price would make an action's hold wait for the chain's answer, which the tests cover but no real world uses.
* **No browser UI** for the owner commands yet (§10).
* **A full withdrawal while a hold is `sending`** leaves that hold's money to come back later; the owner withdraws it with a second command.
* **The deposit transaction must be built by the client** (the E2E and later the browser); the relay does not build or sponsor it. A sponsored deposit (relay-paid fee, owner-signed, verified byte for byte as the x402 join is) would be the natural next step for the browser.

## 10. Remaining work for the MCP connection

An MCP server is one more caller of `POST /f/agent/action` (or `AgentGateway.submit` in process). It needs nothing new in the balance or payment path. Still to do:

1. **Tools**: `agent.view(agentId)`, `agent.terms()`, `world.*` reads (the herald's existing JSON), and `agent.act(ActionRequest)` → ActionResult; errors are the `ERR` codes.
2. **Credential**: the MCP server holds the agent's capability token (given by the owner), never the owner's wallet; it cannot create, fund, stop or drain the agent, and must not be presented as authentication or as a payment approval.
3. **Idempotency**: the MCP layer must generate the key and keep it across its own retries.
4. **Rate limits**: `POST /f/agent/action` is 40 burst / 2 per second per address and 30 burst / 1 per second per agent.
5. **The browser**: owner commands signed with the wallet's `signMessage`, the deposit transaction, the `SetSession` hand-over, the view.
6. **Observability**: the ledger's history is the audit trail; an operator route to list agents and the custody's liabilities against its on-chain balance would complete it.

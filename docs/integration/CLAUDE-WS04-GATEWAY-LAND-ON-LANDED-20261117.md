# ④ gateway port: a transaction's effect reaches the simulated world only when it finalized landed (2026-11-17)

**Branch:** `claude/ws04-gateway-land-on-landed-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `51daba36`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged.

**Static change, NOT run:**
- **Not done:** no `cargo`, test, build, node, bridge, HTTP, RPC, bind, key or signing.

**Provenance, not hidden:** everything on this path is **MOCK**.
- **The gateway port** (`src/gateway.rs`) talks to the agent wallet's gateway over loopback: the test bridge `bridge/agent-gateway-bridge.mjs`, or a scripted stub in `tests/gateway_facts.rs`.
- **The chain behind it** is the agent wallet tests' scripted chain.
- **The "canonical" world** is this crate's simulation (`src/sim.rs`).
- **Nothing here is a real chain connection.**

## The defect (traced at `51daba36`)

`GatewayPort` puts a transaction's effect into the simulated world through `land(sig)`:
- it reads the bytes the scripted chain received (`GET /tx?sig=`), decodes the SendCaravan, and
- calls `SimWorld::land_external`, which **executes** the request: the stores are debited and the caravan created.

It was called in two places:
1. **`remember()`:** on **every `sent` answer**, before anything was known about the chain's decision.
2. **`status()`:** for **both** fate `landed` **and** fate `failed`.

**The result:**
- **A send finalized `failed`** (ran with an error, moved nothing): the simulated world still got the full effect, while the run was told `Failed`.
- **A `sent` answer proved `expired`** (never landed): the effect was already applied by `remember()`. The run then made its one new attempt, which landed too, so **the effect existed twice**.
- **A `sent` answer whose result stays `unknown`:** the effect was applied on the strength of the answer alone.

**Why the existing tests missed it:** they avoided these cases by using `FailedSigned` instead of `Sent` for the attempt that does not land (`tests/gateway_facts.rs`: "a failure after signing, so the simulated world has no caravan from the answer itself").

**The guard that held:** `land_external` is idempotent per signature (`sigs`), so the same signature never applied twice. The double effect needed two signatures: the expired one and the new one.

## The change (`src/gateway.rs` only)

- **`remember()`** records the answer and **lands nothing**.
- **`status()`, fate `landed`:** lands the transaction (idempotent), then reads the simulated status as before. A `landed` transaction that cannot be placed is logged and held (`Unavailable`), as before.
- **`status()`, fate `failed`:** **lands nothing**. The run gets `Failed` (the wallet's reason), as before.
- **Unchanged:**
  - `pending`, `unknown`, `unqueryable`, `expired`, `not-sent`, refused and older-gateway answers;
  - `facts()`, `chain_sig()`, `land_from_chain()` (the test oracle), `prepare()` and `send()`;
  - fees (the relay's, never in `ledger.fees`), the attempt keys and the replay rule.

**Timing:** a successful send's caravan now appears in the simulated world on the first status read that says `landed`, not at the `sent` answer. The executor already handles that: `undecided` treats `Landed` without a canonical record yet as "a lagging read: look again soon" (`executor.rs:895-899`). Existing cases whose fate starts `pending` (`sent_and_finalized_is_fulfilled_once`, `unqueryable_is_a_read_failure_not_an_outcome`, `failure_before_sending_is_absent`) go through that path. **Not run.**

## Restart, own signature, Duplicate (part B, traced)

- **Restart:** the port's answers live in memory. After a restart, `result_of` reads the gateway's history and `remember`s it, which **now lands nothing**. Only a `landed` fate lands, once per signature. **No duplicate effect and no re-send:** the same key is the gateway's replay.
- **Own signature:** `status` lands `r.signed()`, the signature in **this key's** answer, and `chain_sig` names the same one. The executor's content check is unchanged.
- **Duplicate** (the wallet's `failed` + `Duplicate` naming the earlier signature S, for a seq action):
  - the fate follows S; if `landed`, S is landed, which is idempotent if the earlier attempt already landed it;
  - by the wallet's own rule, a seq Duplicate is the same bytes, so this is the same transaction's effect, not a second one;
  - **whether the earlier submission counts as this run's own is the open ownership question** (shared with ③ and ⑬), not decided here.
- **The `u64::MAX` deadline** on gateway attempts is unchanged. It is not turned into `null`, which would change ④'s view contract.

## Regression (written, NOT run): three cases added to `tests/gateway_facts.rs`

They reuse that file's stub and scene.

| Case | Script | What is checked |
|---|---|---|
| `sent_then_finalized_failed_applies_no_effect` | `Sent`, fates `pending` then `failed` | not `Fulfilled`; `sig1` never took effect; nothing delivered |
| `sent_then_proved_expired_then_new_attempt_delivers_once` | `Sent`, `Sent`; per transaction `expired`, then `pending, landed` | `Fulfilled`; exactly 2 transactions; `sig1` never took effect; the new signature (read from the latest attempt's facts, since the stub names signatures by POST count) did; **delivered once** |
| `sent_then_unknown_holds_without_effect` | `Sent`, fate `unknown` | held `Indeterminate`; 1 transaction; `sig1` never took effect; nothing delivered |

## Running them: not approved, and what a run would involve

- **Build:** `cargo test --locked --test gateway_facts` in `workstreams/04-execution` (its own workspace, target dir `workstreams/04-execution/target`, `.cargo/config.toml`).
- **Dependencies:**
  - path crates `permutation-rules` and `frontier-abi`;
  - crates.io `rusqlite =0.40.2` (`bundled`: **a C build script** compiling SQLite), `serde`, `serde_json`, `sha2`, `hex`, `solana-address =2.6.1`, `base64`.
  - **A fetch from crates.io unless the registry cache already holds them** (`--offline` would refuse otherwise).
- **I/O while testing:**
  - SQLite files under `CARGO_TARGET_TMPDIR/runexec-tests` (`tests/common/mod.rs` `db_path`);
  - a **loopback `TcpListener` bound on `127.0.0.1:0`** and a thread serving it (`gateway_facts.rs:102-106`).
  - No key, no signing (the stub's signatures are strings), no outside network.
- **Not the refused tests:** no world, runner, walls-items, muster, ⑬ guard, G or H path.
- **Why it is not run here:** it is a `cargo` build (not approved), it binds a socket (not approved), and a crates.io fetch may be needed (not approved). **A run needs its own approval** naming these. It is not started here, and no substitute smoke run is made.

## Static counter-review (once)

- **A `landed` fate after an earlier `failed` one:** that cannot happen. The wallet's final states never change (④'s registry rule; the stub's last answer repeats).
- **`land` fails on `landed`** (bytes not found, or not the agent's village): logged, and `sim.status` is `Pending` (no record), so the arm `_ => Unavailable` holds. Not attributed, as before.
- **Fate `failed` and the simulated status:** with no landing, `sim.status` is `Pending`, so the arm `_ if f.state == "failed"` gives `Failed`. The arm `SigStatus::Failed` is reached only when a `landed` transaction was refused by the simulated world's rules, as before.
- **`facts()`** never landed and still does not.

**Fixed tip:** the commit that adds this report on `claude/ws04-gateway-land-on-landed-20261117`. It changes 3 paths on `51daba36`:
- `workstreams/04-execution/src/gateway.rs`
- `workstreams/04-execution/tests/gateway_facts.rs`
- this report

# ④ reads: which have a real provider, and what blocks each one that does not (2026-11-17)

**Base:** the aggregate `claude/aggregate-approved-20261117` at `d8b65619`. Read with `git show` only.

**Not done:** no code, no `cargo`, test, RPC, world, key or signing.

**Result:** no read of ④'s `Chain` port can be backed by a real provider with **the same meaning** under what is adopted today, so nothing was implemented. Each read is listed below with the one decision it needs.
- ④'s one real read product, the RPC pass reader, was checked: **no defect**.

## What exists

**`ports.rs`:** "Neither ② nor ③ has delivered a contract … These traits are this workstream's *proposal* … implemented here only by the simulated world (`sim`, marked MOCK)."

**The executor reads, through `Chain`:**
- `slot()`: `:294`, `:313`, `:320`
- `events()`: `:385`
- `place()`: `:605`, `:759`, `:1076`
- `facility_use()`: `:975`
- `caravan_seq()`: `:1104`
- `caravan_history()`: `:1171`, `:1519`, `:1533`
- `caravan()`: `:1428`

**Real providers in ④:**
- **`intake_rpc.rs` `RpcPasses`:** the pass of a Citizen over JSON-RPC, used by `runexec run accept`.
- **`gateway.rs` `GatewayPort`:** sends through the gateway, but **reads through the simulated world** (MOCK).

**No real `Chain` read exists.**

## Each `Chain` read against the real chain (`frontier-abi` v2)

| Read | What the chain has | Same meaning? | The decision it needs (not taken here) |
|---|---|---|---|
| `place` for a **vault** | `s1::vault` at `va‖(p, q, tile)` (`v2::addr::vault`): `STATE` (live = 1), `GEN`, `OWNER_TAG`, `STORES [i64; 8]`, `CAP i64`, **`CUSTODY_QUOTA [i64; 8]`** ("`STORES[r] + CUSTODY_QUOTA[r] ≤ CAP`") | **no** | `PlaceView` has `stores` and one `cap`. The room the executor computes (`cap - stores[r]`) would **overstate** a vault holding custody lots, and a vault at `CAP` drops the excess silently. The port needs the quota (or the room per resource) as a field: a change to ④'s proposal, for ②/③. |
| `place` for a **holding** | `player::holding`: `STORES` are **accrual records** (`"rec:Accrual x8"`) | **no** | an amount needs the accrual evaluated at a time, which means a clock rule (bell vs slot). Not decided. |
| `caravan` | `s1::caravan`: arrival is **`ARRIVE_TS` (i64 unix seconds)** | **no** | `CaravanView.arrive_slot` is a slot (sim). Converting ts to slot is **not allowed** (the owner's rule). The port would have to carry the timestamp and compare it with the chain's Clock. |
| `caravan_seq(owner_tag)` | `Citizen.CARAVANS` of the Citizen account, whose address comes from the Citizen's **key**, not its tag | **no** | an address for a tag: the port takes the Citizen's address, or a resolver is adopted. |
| `slot()` | `getSlot` | **only with a commitment** | which commitment the executor's "now" is (validity windows, waits). Not decided. |
| `events`, `caravan_history` | findex index / `runexec observe` pages | **held** | the executor records events and reads them back as evidence (`settle_seen` / `raids_seen`). A findex page is held (world, finality and identity unproven, `ws04-observation/0`), so using it here would promote an observation. Not allowed until those are proven. |
| `facility_use` | **no facility instruction on chain** (`ports.rs`) | **none** | a chain instruction (③). |

**So none was wired.**
- **Not done:** no proposal was turned into a contract, no time was squeezed into a slot, no simulation was labelled chain, and no arrival was taken as credited.
- **The smallest decision, if the owner wants the first real read:** the vault `place`, with the custody quota added to `PlaceView` (for example `room: Res` or `custody: Res`). Everything else that read needs is in `frontier-abi` already: the address, `STATE`, `GEN`, `OWNER_TAG`, `STORES` and `CAP`.

## ④'s real read product: `intake_rpc.rs` `RpcPasses` (checked, no defect)

| Point | What the code does |
|---|---|
| **Accounts and owners** | **The citizen:** must be owned by the game program. **The link and the policy:** PDAs under the program, and owned by it (`check_requester`). **The resident record:** `["resident", asset]` under the **policy's** resident program, and the link must name it and the asset. **The asset and the resident:** go through `holder(...)` (frontier-abi `resident_auth`) with their owners. |
| **One context slot** | the asset, the resident record and the Clock are read in **one** `getMultipleAccounts` at `confirmed`, so the owner, generation, session and time are of one slot (as documented). The earlier two reads are by design not in that slot. |
| **Clock** | `unix_timestamp` at offset 32 of the Clock sysvar (`slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp`) |
| **HTTP** | plain `http://` only; `Connection: close`; chunked bodies decoded (`gateway::dechunk`); a body that is not JSON, an `error`, a missing `result` or the wrong number of accounts is an error, never "no pass" |
| **Absent vs error** | `Ok(None)` only for "no citizen", "no resident asset", "no link in this Season" and "no policy". Every decode failure is an error. |

**Liveness limits, not defects:**
- the connect timeout is the system's;
- the read times out at 10 s;
- the HTTP status is not checked separately, but a non-JSON or result-less answer is an error anyway.

## Hand-over

- **No code unit.** This report is the only file on `claude/ws04-real-read-gaps-20261117` (on `d8b65619`).
- **The fixed findex units are unchanged:** `5de93797` → `b7ec5124` → `2d7b0ce7`.
- **Still held:** `142c1cdb` and `a99b961f`.

# Run a keeper (M1 "First Bell")

A keeper is the program that keeps a Frontier season moving: it posts the drand beacons the rules need, reveals sealed marches after their timelock opens, gathers and resolves clashes, skips quiet bells, settles transits and tickets, archives old anchors and closes what can be closed. **Anyone may run one.** Nothing a keeper does needs a privilege: every keeper write is a permissionless instruction, the first valid write wins, and a second keeper's copy of the same write is refused as `AlreadyDone` (or lands as a no-op). A keeper that reveals a march earns that march's tip; the keeper that resolves a province-bell earns the march fees of its arrivals; every account a keeper creates pays its rent back to the fee payer that paid it when it closes.

This guide describes the keeper built in M1 (`frontier-node/crates/keeper`, binary `frontier-keeper`) as of contract v1.12 (the wave-6 base, v1.9, plus the `w6-s7` triage fixes of unit U2; the triage changes are marked **v1.12**). The design reasons are in `../DESIGN.md` §6.4 and §8.6; the normative rules are the M1 contract §8.2 (duties, bid policy, payers) and §5 (the instructions). Everything below runs on the local stack only: **M1 has no devnet or mainnet keeper**, and §9 lists what is missing for one (the reveal-floor pricing gap listed there before was fixed in integ-W6r, DECISIONS R9: the `w6-s7` keepers showed `pools.reveal.floor` 215,076,060).

---

## 1. What you need

| Item | M1 state |
|---|---|
| `frontier-keeper` | `cd frontier-node && cargo build --locked --release -p keeper` → `frontier-node/target/release/frontier-keeper` (toolchain 1.95.0 from `frontier-node/rust-toolchain.toml`) |
| A chain RPC | `frontier-localnet` (the M1 local chain node; `feed = "localnet"`, the default: the keeper reads the program's transaction feed through `frontier_feed`, a localnet extension), or a public cluster's JSON-RPC over `https://` with `feed = "rpc"` (2026-11-18, devnet-readiness B1/B2: the feed is `findex::RpcPoll`, paced and backed off for public rate limits; see §9) |
| drand | `drand-replay` on loopback (`--test-key` for the test-beacon program build, or `--archive <dir>` for real quicknet rounds with the release build), or live quicknet over `https://` (verified TLS through `fclient::https`, the system `curl`; every round is still checked against the pinned key) |
| A master seed | 32 random bytes; every payer and funder key is derived from it (§4). `frontier-keeper --config keeper.toml --init-seed` writes one (mode 0600) and exits |
| A beneficiary | the address that receives tips, march fees and rewards. To claim defence refunds the keeper also needs the beneficiary's key (`beneficiary_key_file`), because ClaimDefence is signed by the beneficiary. **The beneficiary is also ClaimDefence's fee payer, so it must hold lamports** (M1 exit U4): an unfunded beneficiary's claims are dropped by the chain for want of the fee and expire unlanded. 0.1 SOL covers five claims at the keeper's per-write spend cap (0.02 SOL); a landed claim's refund is paid to the same key. The stack airdrops each beneficiary `pools.beneficiary_lamports` (default 1 SOL) at start |
| Lamports | enough for the funders to keep 150 reveal payers and 32 delay payers at their floors (§4.3): about 1.2 SOL for a local season with the recommended R99, 32–65 SOL at the contract's default R99 of 4,000 |
| Ports | the loopback API on a free port in 41000–41999 that is not reserved (4185, 4190, 4191, 4194, 18899, 17799, 28899, 27799, 26699, 5185, 5191 are never used). The stack's keepers use 41050 (A) and 41051 (B) |

## 2. What a keeper does: roles and duties

`roles` in `keeper.toml` selects duties. The stack runs keeper A with every role (the operator's keeper) and keeper B with the **public profile** `["reveal", "settle-departure", "settle", "claims"]` (the duties that earn tips and fees, and the ones whose liveness matters to players).

"Every role" is the 16 roles of `keeper/src/config.rs` `ROLES`. The playable lane (devnet, `program_version` 0x4804) adds three roles outside that list, `wide-tickets`, `expeditions` and `wide-resolve` (`WIDE_ROLES`, only in a keeper built with `--features playable-lane`), and the `rings` duty's `rim_per_wedge`, `provinces_reach` and `wide_rings` keys; the devnet keeper A's full `keeper.toml` is in [`../devnet/DEVNET-DEPLOY-RUNBOOK.md`](../devnet/DEVNET-DEPLOY-RUNBOOK.md) §8.

| Role | Duty (contract §8.2) | Instructions | Class |
|---|---|---|---|
| `beacon` | genesis seed; one anchor per (bell, region) when round `T(b)` appears (combined posts of ≤ 7 regions **and** per-region fallbacks); seed caches when `S(b, r)` appears (a random unused nonce, switched if not landed in 2 slots); BeaconLogs every bell. **v1.12:** anchors only for bells before `end_bell` (the program refuses later ones); a round drand has not served yet is asked for again within the slot, on the 100-ms idle ticks | ConsumeGenesisSeed, PostAnchorMulti, PostAnchor, PostSeed, PostBeacon | D (PostBeacon N) |
| `reveal` | open every seal of the bell at `T(b)` (Rust tlock), reveal each arrival **in descending departure mass** per (province, bell, faction), targeting the slot index the quota rule computes; retry `SlotMoved` ≤ 4 times; **never after `A + W − 2 slots`**; owner submissions via `POST /v1/reveal`. **v1.12:** never for an arrival bell ≥ `end_bell`; one Reveal per march per slot (its opened seal and the owner's material are deduplicated by `(host, arrive)`) | Reveal | **W** |
| `settle-departure` | once the origin resolved past the departure bell (plus `backup_delay_slots`, v1.12), move the host's post-clash values into the Holding; return settles of dissolved hosts (`transit_slot = 0xFF`, ≤ 3 entries per transaction) | SettleDeparture | D |
| `gather`, `resolve` | after the reveal close, gather every province-bell with arrivals (≤ 10 Holdings per part, ≤ 3 parts), then resolve once a seed cache exists | GatherClash, ResolveFromInputs | D |
| `skip` | advance idle provinces over quiet bells (≤ 24 per transaction); a batch is split only for a nudge, an arrival bell, a departure to settle, or a pending `Spend`/`Leave` (the settles wait on them) — musters, splits, merges and forfeits ride inside the whole 24-bell batch (v1.12) | SkipQuiet | D |
| `settle` | settle every transit after `close + 600` (plus `backup_delay_slots`, v1.12) with the logged commitment and seal (the seal proof runs inside): revealed, quota-refused, unrevealed and bad seals alike | SettleTransit | D |
| `tickets` | settle every ticket of a cohort **in descending score in the first slots after S**, oldest cohort first; expire tickets after 24 bells | SettleTicket | D |
| `explore` | settle explorations once the bell's seed exists | SettleExplore | N |
| `archive` | 48 h after an anchor: ArchiveAnchors (tombstone first, then close), then CloseSeedCache | ArchiveAnchors, CloseSeedCache | D / N |
| `close` | close ClashInputs, ArrivalDays and ArrivalSlots once their conditions hold (slots after the 6-bell claim grace). **v1.12:** accounts read in batches of ≤ 100 with a per-key recheck time, after the tick's critical sends; a close that ended `dead` is not planned again until its account changes | CloseClashInputs, CloseArrivalDay, CloseArrivalSlot | N |
| `fold` | fold occupancy every bell while joins are open (three parts, same bell) | FoldOccupancy | D |
| `rings` | open rings and provinces when the crowding rule holds; with `provinces_reach` (devnet keeper A) also the absent provinces next to settled land, never below a wedge fund's floor. Every fund check uses the **cluster's rent** (the Rent sysvar, re-read every 1,500 slots ≈ 10 min); with no usable rate (never read, or the last good read older than 9,000 slots ≈ 1 h) it opens no crowding ring and no province on demand and raises `rent-unknown` (keeper-rent-floor) | OpenRing, ConsumeRingSeed, OpenProvince | D |
| `dormancy` | release dormant holdings, disband stranded hosts | ReleaseDormant, DisbandStranded | N |
| `claims` | claim defence refunds for its own late Reveals within the claim grace | ClaimDefence | D |
| `sweep` | move `Holding.pool_owed` to the DefencePool | SweepPoolOwed | N |

The keeper keeps the dependency order itself: resolve(origin, departure bell) → SettleDeparture → gather(destination) → resolve(destination) → SettleTransit. `regions = "0-15"` (default: all) limits the beacon and play duties to some regions, for fleets that split the world.

## 3. How it bids

Every rule time comes from the chain's Clock (`GameClock`), never the wall clock. Each write is sent as a series of **versions** — W writes one per slot, D and N writes on the resend cadence below (W6-C) — each a new signature from a **newly drawn random payer** of the right pool:

| Class | Start | Escalation | Cap | Paid from |
|---|---|---|---|---|
| **W** (Reveal) | the tip level `p_tip` (`--peace-start f` starts at `f × p_tip`; off by default) | ×2 per slot | **P_def = 2.0** (`p_def_milli`, ≤ the season's `defence_cap_milli`) | the reveal pool; the part above the tip is refundable by ClaimDefence when the Reveal landed late by on-chain evidence |
| **D** (delay-only writes) | `p_low` (0.1) | ×2 per slot | **P_delay = 0.5** (`p_delay_milli`) | the delay pool, the keeper's own money |
| **N** (non-critical) | `p_low` | none | — | the delay pool |

- **Compute budget on every transaction:** the CU limit and the loaded-data limit `L(kind)` from the budgets table (`frontier-abi/vectors/budgets.json`: e.g. Reveal 26,500 CU and 1,146,880 B). Without `SetLoadedAccountsDataSizeLimit` the runtime would count 64 MiB and a bid's priority would halve; with a smaller limit than `L(kind)` the transaction fails and still pays its fee (SIMD-0186).
- **Priority is in cost units:** `priority = (priority fee + 2,500) / (CU limit + 720·signatures + 300·write locks + 8·⌈L/32 KiB⌉)`; the keeper converts the target priority to a CU price. A Reveal at `tip_min` (14,668 lamports) is 0.433.
- **Resend cadence (W6-C, contract §8.2 A1):** W writes (Reveals) get a new version every slot. A D or N write whose earlier version is still in flight (sent, status unknown, blockhash valid) gets its next version `d_resend_slots` (2) slots after the last while its bid still rises, and every `cap_resend_slots` (16) slots once the bid is at the class cap (P_delay for D, the fixed bid for N: a version at the same bid only buys a fresh payer); a version whose failure is known is followed at once. The cadence counts from the chain slot the version went out at, and the bids still follow the slots since the first version, so a D write reaches P_delay at the same slot as before. A 24-slot hold leaves ≤ 3 losing versions (was 23).
- **Contested detection:** a W or D write not landed within `contested_slots` (2) at a bid ≥ `p_tip` marks its (bell, region) contested: W writes there start at `p_tip`, anchor fallbacks go every slot, and an alert is journalled. It runs every slot whether or not a version went out.
- **Retry ladder (I-50):** `ComputeBudgetExceeded` → resend at 2× the limit, then 1,400,000 CU; a heap fault → resend with a 256-KiB heap frame. Each retry is an alert (`retry-ladder`): a budget miss is a bug to report, not a stuck province. **v1.12:** a `ProgramFailedToComplete` that used the whole CU limit, or whose logs say `exceeded CUs meter`, is treated as a CU miss (2×, then 1,400,000 CU), not a heap fault (the keeper reads the units and logs from the program feed; without play roles it waits 3 slots and falls back to the heap rung); in `w6-s7` the season-end closes were taken for heap faults and re-sent about 270 times each (28,655 failed transactions).
- **Refusal back-off (fix-keeper-backoff, D-dress-8):** a write the program refused waits before its duty may plan it again. Refusals that mean "not yet" or "someone moved first" (`NoAnchor`, `SeedNotReady`, `FoldStale`, `TicketState`, `NotQuiet`, `SlotMoved`, `QuotaRefused`, `TooEarly`, `DepartureUnsettled`, `FoldTooEarly`, `NotGathered`, `InputsOpen`, `NotDue`, `HostInTransit`, `NeedArrivalDay`, `CapturePending`, `StakeUnsettled`, `SiegeBusy`; a payer's `InsufficientFunds…`) keep the old wait: 2, 4, 8 … slots, at most 1,024. Every other refusal (e.g. `BadAccount`, `WindowClosed`, a write that ends `dead` other than at its deadline) is taken as deterministic for that instruction: after its `n`-th refusal in a row with the same code the key waits `2 << (n−1)` slots, at most `refusal_max_slots` (9,000 ≈ 1 h), **and** `2^(n−1)` keeper passes, at most `refusal_max_passes` (64; a pass on the public devnet RPC is tens of slots). A landing ends the hold and the streak; when the duty plans a different instruction for the key (the chain state changed) that one goes out at once, and the streak goes on if it is refused the same way (an archive batch that grows by a bell every bell is sent once per change, not ramped from 2 slots again). Once `refusal_group_min` (4) distinct keys of one duty kind were refused with one code and nothing of that kind landed since, the kind sends one probe at a time at doubling gaps until one lands (verify-pr192: each probe goes to a key that asked last pass, one outside the refused set first, else the one refused longest ago, so a stuck key planned first cannot take every probe and keep the kind closed) (Reveals, the beacon's anchors/seeds/logs and payer care are exempt). `/v1/status` `refusals` shows the held keys (key, kind, code, count, held until slot/pass, suppressed plans), the open groups and totals; `kinds.<kind>.refused` / `.suppressed` and `/metrics` `frontier_keeper_refused_total`, `frontier_keeper_refusal_suppressed_total`, `frontier_keeper_refusals_held` count them. The holds are in memory: a restart starts them over. RPC errors (429, timeouts) are not refusals and keep their own retry. Before: the 1,024-slot cap applied to every refusal (≈ 200 resends a day per key at 1×) and a `dead` write was planned again the next pass.
- **Expiry:** a write whose every version's blockhash expired (151 slots) at its version or spend cap ends with `write-expired` and is re-planned with a fresh escalation, so a long hold only delays.
- **Done codes:** `AlreadyDone`, `NoTicket` (SettleTicket), `TransitState` (settles) and `OutOfOrder` (resolves, skips) end a write as done: another keeper or version got there first.
- **Duplicates:** the versions of one write cost at most `per_write_cap_lamports` (default 0.02 SOL); `daily_budget_sol` caps the day.
- **Backup keepers (v1.12):** a keeper that runs next to another one can wait `backup_delay_slots` slots after a SettleDeparture or SettleTransit first becomes eligible and re-read the transit before sending, so it only acts when the primary did not. In `w6-s7` two keepers settling at once paid 3,220 refused settles (`AlreadyDone`, `TransitState`); the stack now runs keeper B with `backup_delay_slots = 8`. Reveals are never delayed: every keeper reveals at once.

## 4. Payers, funders and the payer band

### 4.1 Derivation

`payer_i = ed25519(sha256("PS-FRONTIER-PAYER-v1" ‖ master_seed ‖ pool_id ‖ le32(i)))` with `pool_id` = `"reveal"` (i < `reveal_pool`, ≥ 150), `"delay"` (i < `delay_pool`, ≥ 32) and `"funder"` (i < `funders`, ≥ 4). The keeper refuses smaller pools unless `dev = true` (tests and local drills only). A payer is drawn **uniformly at random** (OS CSPRNG) among the pool's payers above the floor for every version; there is no round-robin, so an attacker cannot predict which payer a critical write will use.

### 4.2 Why 150

An attacker can hold a *known* account by listing it writable in its own fillers at priority p, for about p × 40M CU per block, and one transaction stream holds up to ~20 (legacy) or ~60 (lookup table) known accounts at that price. With ≥ 150 rotating reveal payers, pricing every payer out costs ≥ ⌈150/60⌉ × 40M > 100M CU per block — a whole block — so keeper reveals are as expensive to exclude as unenumerable writes ([`DESIGN.md`](../DESIGN.md) §6.4, §8.6; measured basis: SP-FEE drill (g)).

### 4.3 The band (I-49)

Each reveal payer fronts, per reveal, the ArrivalSlot rent (1,463,040 lamports), the ArrivalDay rent on a first reveal (1,137,920) and the fee at P_def (54,300: the keeper prices it at the Reveal it requests — the budgets table's 26,500 CU and `L` 1,146,880 B with a first reveal's 3 write locks — integ-W6r); the rent comes back when the slot and the day close. The keeper keeps every reveal payer between a floor and 2 × floor:

`F_r = 3 × ⌈R99 / N⌉ × (rent(slot) + rent(day) + fee(P_def, Reveal))`

(The rents above are at 5,080 lamports/byte. The keeper prices `F_r` at the compile-time 5,080 only until its first read of the cluster's Rent sysvar, then at the cluster's rate, and again whenever the rate changes; keeper-rent-floor. A configured `reveal_floor` is never repriced.)

where R99 is the p99 number of reveals per bell one fleet makes (`r99_reveals`) and N the reveal pool size. **R99 recommendations (W6-E, c4 model v3 final, DESIGN §22.4):**

| Season | R99 to configure | `F_r` (N = 150) | 150 reveal payers hold (floor – ceiling) |
|---|---|---|---|
| Local 7-day season (≤ 1,000 bots) and the private playtest (50–200 people) | **150** (any value ≤ 150 gives the same floor) | ≈ 0.0080 SOL | ≈ 1.2 – 2.4 SOL |
| Up to 50,000 wallets (simulated R99 = 243) | **300** | ≈ 0.016 SOL | ≈ 2.4 – 4.8 SOL |
| Contract default (`fclient::payers::R99_DEFAULT`) | 4,000 | ≈ 0.215 SOL | ≈ 32 – 65 SOL |

The default of 4,000 stays in the code until the owner accepts the recommendation; set `r99_reveals` (or `reveal_floor` in lamports) in `keeper.toml`. Delay payers have a flat floor, `delay_floor` (default 0.5 SOL).

**Effective N** is the number of reveal payers above the floor. Below 150 the keeper alerts and tops the pool up at once from the funders (drawn at random, batched at rest and before any bell marked contested, never inside a critical transaction); **it never stops sending reveals** — stopping would be exactly the exclusion the design guards against. Payer care runs every `care_every_slots` (150 slots, one minute at 400-ms slots) **or** `care_every_game_secs` (300 game seconds), whichever comes first (W6-C: at 100× a slot is 40 game seconds, so the slot cadence alone ran every 10 bells and a pool starved), and 2 slots after a care that planned top-ups while a pool is below its minimum effective N; never while care transfers are still pending. The stack's reports gate effective N ≥ 150 in every bell (E5 criterion 4).

### 4.4 Funding

Fund the **funders**; the keeper funds the payers. `frontier-keeper --config keeper.toml --print-addresses` prints every derived address (payers, funders; offline, it sends nothing), and `frontier-keeper --print-relay-addresses <relay-master.seed>` the relay pool's; they follow the formula in §4.1 (any ed25519 library: the 32-byte `sha256` output is the secret seed) over the master seed file (on a local run the stack writes it to `<run>/keeper-a/keeper.seed` and `<run>/keeper-b/keeper.seed`, and airdrops the funders itself). Fund the **beneficiary** too if the keeper has the `claims` role: the funders never pay for it, and ClaimDefence's fee comes from the beneficiary (§1). Keep the funders' balance above the sum of the ceilings you configure; the `/v1/status` `pools` object shows each pool's lamports and effective N.

## 5. `keeper.toml`

Required: `program`, `season`, `beneficiary`. Everything else has a default. Unknown keys are refused.

```toml
program = "<program id, base58>"
season = 7
beneficiary = "<address that receives tips and fees>"
rpc = ["http://127.0.0.1:41010"]         # frontier-localnet (plain http)
drand = ["http://127.0.0.1:41020"]       # drand-replay (plain http)
roles = ["reveal", "settle-departure", "settle", "claims"]   # the public profile
regions = "0-15"
reveal_pool = 150                        # ≥ 150
delay_pool = 32                          # ≥ 32
funders = 4                              # ≥ 4
r99_reveals = 150                        # W6-E recommendation for M1-size seasons (default 4000)
# reveal_floor = 8000000                 # lamports; overrides the R99 formula
# delay_floor = 500000000
# send_spare_lamports = 0                # a payer signs only at ≥ fee + its rent-exempt minimum + this (lamports); covers the rent of an account the write creates (Q-FKC-1, default 0)
p_def_milli = 2000                       # ≤ 2000 and ≤ the season's defence cap
p_delay_milli = 500
# p_low_milli = 100
# peace_start = 0.5                      # W writes start at 0.5 × p_tip (off by default)
daily_budget_sol = 50
per_write_cap_lamports = 20000000
api = "127.0.0.1:41052"                  # loopback only; a free port in 41000–41999
token_file = "keeper.token"              # bearer token for the API
master_seed_file = "keeper.seed"
journal = "keeper.journal.sqlite"
beneficiary_key_file = "beneficiary.key" # needed for the `claims` role
# race_jitter_slots = 2                  # random 0..n-slot start on play writes when several keepers race
# backup_delay_slots = 0                 # v1.12: settles wait n slots after first eligible, then re-read the transit (a backup keeper: 8)
# contested_slots = 2
# nonce_switch_slots = 2
# fallback_lag_slots = 1                 # peacetime lag of per-region anchor fallbacks
# care_every_slots = 150
# care_every_game_secs = 300             # payer care also every 300 game s, whichever comes first (W6-C)
# d_resend_slots = 2                     # D/N writes: next version 2 slots after the last while the bid rises (W6-C)
# cap_resend_slots = 16                  # ... and every 16 slots once the bid is at the class cap
# refusal_max_slots = 9000               # a deterministically refused write waits 2, 4, … slots, at most this (fix-keeper-backoff)
# refusal_max_passes = 64                # ... and 1, 2, 4, … keeper passes, at most this (0: no pass gate)
# refusal_group_min = 4                  # n keys of one kind refused with one code → one probe at a time (0: off)
# rescan_bells = 288
# land_scan_slots = 8
# stranded_scan_slots = 450
# dev = false                            # allows pools below their minimum (tests only)
```

## 6. Start, stop, restart

```sh
frontier-node/target/release/frontier-keeper --config keeper.toml --init-seed   # once
frontier-node/target/release/frontier-keeper --config keeper.toml               # run; Ctrl-C stops it
```

- **The chain is the state.** The SQLite journal (WAL, `synchronous=FULL` for attempts) records every attempt (signature, kind, object, bell, region, class, payer, bid, CU limit, slots, status), the plaintexts it learned, its feed cursor, claims and payers. On start the keeper takes the journal's file lock (a second process on the same journal refuses), reconciles in-flight attempts with `getSignatureStatuses`, catches up the feed, rebuilds its queues and resumes. `kill -9` at any point is safe: the M1 gates inject about 20 crash points × 3 duty kinds and require identical outcomes with at most one duplicate version per in-flight write.
- **Run it under a supervisor that restarts it** (security audit 2026-11-22, D-security-audit-3). The keeper does not restart itself, and two things end the process: a panic (the tick runs in `main` with no `catch_unwind`; the audit's M-1 was one: an RPC answer with fewer accounts than asked made a duty index past the end; since #164 such an answer is refused, the tick logs it and the next tick retries — other panics remain possible) and a fatal journal error (`tick: … stopping keeper to preserve accepted Reveal material`, exit 1: `main.rs` `fatal_tick_error`). Start-up refusals exit 1 or 2 (a bad `keeper.toml`, a journal locked by another process, no drand URL serving the pinned chain). Restarting is safe at any point (the paragraph above), so use `systemd` `Restart=always` with `RestartSec=5` (or `launchd` `KeepAlive`), keep stderr, and alert on repeated restarts: a keeper that exits at once every time (a fatal journal error, a config error) needs a person, not a loop. While keeper A is down nothing reveals, resolves or opens rings; a season with one keeper stalls until it is back (a reveal window is the season's `reveal_window`, 600–1,800 s: M1-CONTRACT §5.1). [From the code; no supervisor file is in the repository and none has been run.]
- **Several keepers** may run against one season; they race, and the program keeps the result unique. Give each its own master seed, journal and API port; `race_jitter_slots` spreads their play writes.
- **Test key vs real rounds:** with `drand-replay --test-key` the program must be the `test-beacon` build (never deployable); with `--archive` it must be the release build pinned to quicknet's key.

## 7. Watching it

- `GET /v1/status` (bearer token): `duties.rent` (keeper-rent-floor: `lamports_per_byte` as last read from the Rent sysvar, `read_slot`, `usable`, `error`) and `duties.provinces_demand.waiting` (why on-demand opens wait, e.g. `wedge fund 2 at its floor (… lamports at 6960 lamports/byte)` or `rent rate unknown …: not opening provinces`); season status, next bell, anchors and caches known, contested bells, anchor and seed latency p99 in slots, provinces opened, tickets open/settled/expired, per-kind writes/versions/landed/failed/dead/fees/refused/suppressed and latency p50/p99, pending writes, **refusals** (the refusal back-off above: held keys, open groups, totals, parameters), **pools** (n, effective N, floor, lamports; funders' lamports), bid parameters, spend by day, alert count. **v1.12:** it answers within 1 s even while a tick runs: it serves a snapshot the keeper takes at the end of each tick, so a sample can be up to one tick old but is never missing. The per-duty fields are under `duties` (e.g. `duties.anchor_latency_slots_p99`, `duties.seed_latency_slots_p99`, `duties.archived_bells`), the pools under `pools` (e.g. `pools.reveal.floor`, `pools.reveal.effective_n`), per-kind counters under `kinds`. (In `w6-s7`, before the fix, 322 of 1,035 per-bell samples timed out while a slow tick held the keeper.) **v1.13:** `play.nudges_recent` lists the nudges the keeper took over the last 288 bells as `[P, Q, bell]`; each nudge makes the keeper catch that province up at once (one SkipQuiet split), and the stack report uses the list to tell a nudged province-day from an idle one (contract §13.4 criterion 3, A1 as amended).
- `POST /v1/reveal` (the owner's reveal material; the relay's `/f/reveal` forwards to it and passes the answer through unchanged). The keeper checks the material against the chain before queuing it:

  | Answer | When |
  |---|---|
  | `202 {"accepted": true, "track": id}` | queued; the same material again gets the same track |
  | `409 {"code": "CommitMismatch", "detail": …}` | the plaintext, salt and `ct_hash` do not open the transit's seal root |
  | `409 {"code": "TransitState", "detail": …}` | no Holding at that address, or its transit slot is not in state 1–3 |
  | `409 {"error": "Shielded", "code": "Shielded", "detail": …}` (v1.12) | the Reveal would be refused by rule (§5.11 step 6): the host's own holding is still shielded at the start of the arrival bell (and not dormant) and the target is another faction's holding site, or the target is the site of another faction's shielded holding. Nobody can reveal this march; it will settle routed. Tell the player at once |
  | `409 {"error": "ArrivalBell", "code": "ArrivalBell", "detail": …}` (v1.12) | the arrival bell is at or after the season's `end_bell`, whatever the season's status; the program refuses such a Depart from v1.12, so this only meets marches sealed on an older build |
  | `410 {"code": "WindowClosed", "detail": …}` | the reveal window closed, the bell is archived, the latch is closed, or the season takes no reveals |
  | `422 {"code": "BadPlaintext", "detail": …}` | the plaintext is not a valid order for this transit |

- `GET /metrics`: the same as Prometheus text.
- `GET /v1/track/{id}` for a reveal submitted through `POST /v1/reveal`; `POST /v1/nudge {province: [P, Q], bell}` asks the keeper to prioritise a province (the relay forwards players' nudges).
- fix-gw-highs (security audit H-1, H-2): `/v1/reveal` and `/v1/nudge` are reached by anyone through the herald's `/gw` and the relay. The keeper refuses forged reveal material (no live DEPART of its index has its seal root: `503 RevealNotIndexed`), nudges past the current bell + 2 (`422 BellOutOfRange`) and unknown provinces (`404 UnknownProvince`) without any RPC call; the reveal gate's chain reads run on a budget of their own (`api_rpc_gap_ms`, default five `rpc_min_gap_ms`: a fifth of the pacer), so external requests never take more than that share of the RPC budget the duties need. A taken nudge expires after 24 bells; one taken nudge per province per bell, at most 64 provinces without residents newly nudged a bell (a province with residents is never capped, verify-pr166). Material that opens an already acknowledged live DEPART answers that march's track whatever its `holding` / `transit_slot` (one acknowledgement per seal root). Refusals are counted in `/v1/status` `api` and `/metrics` `keeper_api_total{event}`, and logged at most once per 10 s.
- **Alerts** (journalled, counted in the status): `rent-unknown` (keeper-rent-floor: the Rent sysvar could not be read or its last good read is stale; the rings duty stops crowding OpenRings and on-demand opens until a read succeeds; raised once per outage), `rent-rate` (the cluster's rent rate changed; the reveal floor was repriced), `contested` (a region-bell is being held), `write-expired` (a write ran out of versions and was re-planned), `anchor-missing` (a bell was left behind without its anchor), `retry-ladder` (a CU or heap budget was exceeded: report it), `payer-care` (a pool was topped up or could not be), `failed` / `dead` (a write refused for good).
- What the M1 runs look like when healthy (test-key nightly on the merged wave-6 tree, 100 eager bots, one game day at 100×, `m1/runs/integ-w6-nightly-3`): round → anchor p99 2 slots (2.98 from the publication instant), S → first seed cache 2 slots, every reveal inside its window (anchor → last valid reveal 0 slots), S → resolve 4 slots (close → resolve 6), SkipQuiet per idle province-day p50 1 / p99 6 (a churned day is a catch-up: up to 125, reported), 4 `SkipQuiet: OutOfOrder` per run, reveal effective N 150 throughout (at 100× a slot is 40 game seconds) ([`integ-W6-NOTES.md`](integ-W6-NOTES.md) §4–§5; before wave 6: [`W5-B-NOTES.md`](W5-B-NOTES.md) §2). **At 20× over 7 game days** (`w6-s7`, 1,000 bots, real rounds, before the v1.12 fixes) the first half met the targets (p99 2 / 2 / 4 slots for round → anchor, S → first cache, S → resolve) and the second half did not (7 / 6 / 16): the closes duty re-read every open ClashInputs one RPC at a time, a list that grows all season. On a copy of that late state the v1.12 keeper gives 1 / 1 / 2 (`w6-s7` triage `latency.md`; the exit re-run's numbers will replace these). If `duties.anchor_latency_slots_p99` creeps up over a season, look at the tick time first.

## 8. What it costs and what it earns

- **Costs:** priority fees (peacetime writes land in 1–2 slots at the start bid; escalation only under contention), base fees of 5,000 lamports per signature, and the rent float of what it creates (returned at close: anchors after archiving, caches, slots after settlement or the claim grace, ArrivalDays after the day, ClashInputs after the close grace).
- **Earnings:** each Reveal's tip (≥ `tip_min`; the relay's sponsored presets are 14,668 / 22,002 / 29,336 lamports), each resolved province-bell's march fees (10,000 lamports per arrival), and, for a bad seal it settles, the tip, march fee and seal bond (20,000). Defence refunds (ClaimDefence) repay the part of a late Reveal's priority fee above the tip, within the season's caps; they are claimable for 6 bells after settlement.
- **The attack a keeper defends against** is priced in [`DESIGN.md`](../DESIGN.md) §6.4, §8.6 (the M1 lock table) and §22.2 (the final C4 model): at the pool cap with ≥ 150 rotating payers, excluding one side's reveals for a 600-s window costs 11.7–47.9× the value of the busiest bell (valuation (a)) [model].

## 9. Gaps before a keeper can run on a public network

These are known and listed for the owner; none is needed for the M1 exit, which runs on the local stack.

1. ~~No TLS client~~ (2026-11-18, devnet-readiness B1): `https://` GETs and JSON-RPC POSTs go through `fclient::https` (the system `curl`, hardened: no URL or body on its argument vector, verified TLS ≥ 1.2, no redirects, bounded time and size). No TLS crate was added (Q-D2 for r0ze); `fclient::https` is the one module a `rustls` client would replace. Tested against loopback mocks only, never a public cluster.
2. ~~Feed through `frontier_feed` only~~ (B2): `keeper.toml` `feed = "rpc"` reads the feed through `findex::RpcPoll` (`keeper_core::clusterfeed`), with `feed_poll_ms` (2,000), `feed_max_backoff_ms` (60,000), `rpc_min_gap_ms` (150 with `feed = "rpc"`: one pacer for every RPC call; HTTP 429/503 backs all off), and optional `feed_origin` / `feed_witness`. The polled log is in memory and finalized (≈ 13 s behind confirmed); a restart re-reads the history.
3. ~~No address listing~~ (B4): `frontier-keeper --config keeper.toml --print-addresses` prints `role\tindex\tpubkey` for the reveal and delay pools, the funders and (with `beneficiary_key_file`) the claim key; `frontier-keeper --print-relay-addresses relay-master.seed [--relay-pool-size 150]` prints the relay pool. Public keys only, offline.
4. ~~No operator tool~~ (B3): `frontier-operator` (a bin of `frontier-node/crates/stack`) sends AnnounceSeason, CreateSeason, InitBeaconLogs and InitShards to a real network (see [`PLAYTEST-RUNBOOK.md`](PLAYTEST-RUNBOOK.md) G4). Tested on a local chain only.
5. **Keeper A's operator roles on a real network** also need the BLS12-381 syscalls on that cluster (quicknet verification in PostAnchor, PostSeed, ConsumeGenesisSeed, ConsumeRingSeed); M1 checked them only in LiteSVM and the local node.

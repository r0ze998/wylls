# Lane C — ⑨ capacity / ⑩ custody: is there a vertical slice that only needs wiring? (2026-11-16)

Base: `claude/canonical-candidate-20261116` @ `d16048aa` (remote checked). Branch: `claude/lane-c-ws09-10-connect-audit-20261116`.

**Static reading only.**
- No code changed, and nothing was run, built or imported.
- The UI production work stays on its own branches, unmerged: P1/P2 `a3148408`, P3 `b8b3ca50`.

## Answer: no such slice exists on the candidate

For the page or the gateway to connect to ⑨/⑩, two things must exist together:
- an **adopted** contract;
- a provider in the **default (deployable) build**.

On `d16048aa`, every program-side provider for ⑨ and ⑩ exists only behind a preview feature, and every number is provisional. So there is nothing that only needs wiring. I implemented nothing. Connecting a preview would amount to adopting it.

## Evidence (file:line on `d16048aa`)

| Item | State | Where |
|---|---|---|
| ⑩ instructions (11, OpenLot … WithdrawLot, 0xC2–0xCC) | Only in `custody-preview`. That build embeds `RULESET_HASH_V4` and program version 5, and refuses every S1 Season. **The default S1 build refuses these tags (`BadData`)**. Marker `PSF_CUSTODY_PREVIEW_BUILD`: "never deployable until LiteSVM tests, measured budgets and the verifier's V26 exist" | `permutation-frontier/Cargo.toml` `[features]`; `src/lib.rs` ~148–175; `src/proc/mod.rs:68` |
| ⑨ instructions (14, 0xF0–0xFD) | Only in `capacity-preview`. Program version bit `0x1000`, provisional. No PS2 record (the kinds are not allocated). "Not deployable". It cannot be built with `rights-experimental` or `nft-experimental` (`compile_error!`: the version is undecided) | `Cargo.toml`; `lib.rs` 244–262; `proc/mod.rs:58` |
| `Holding::lend_workshops` | In the rules. Its only program caller is `proc/capacity.rs` (preview). **In the default build `LENT_WORKSHOPS` is always 0** | `git grep lend_workshops` |
| ABI numbers | The allocation is "**仮** (provisional): not final until integrated", up to rev 7. Custody: tags 0xC2–0xCC, records 105–113, errors 100–104, AccountKind 23 Lot. Capacity: 0xF0–0xFD; the kinds for CapacityPool/Job are undecided | `workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md` §2, rev 4 |
| Collisions | `PROGRAM_VERSION_CUSTODY = 5` also equals the unintegrated S2's `PROGRAM_VERSION_S2 = 5` (rev 4: S2 is to move at integration). S2's old proposal has `UseRun` at 0xC8, inside custody's 0xC2–0xCC (`abi-inventory-20261106.txt:38`: tag 200 is claimed by ⑨ SettleJob (document), ⑩ ConsumeLot and S2 UseRun) | allocation rev 3 §1, rev 4; inventory |
| Verifier | `V26:custody-guard`: any custody trace in a season without custody is a **FAIL**, and in a custody season at best **UNVERIFIABLE**. The check itself is incomplete (caravan routes and wear, records) | `frontier-node/crates/verify/src/checks/v26_custody.rs` 1–30 |
| Page | The generated v2 tables carry the custody tags, the `Lot` account (kind 23) and errors 100–104. `fi18n.mjs:201–` has the error text. **No builder and no screen** for custody or capacity. `fagent.mjs` and the gateway's `agent/custody.mjs` are the agent wallet's test-USDC custody, a different thing and next to money | `abi-v2-tags.mjs`, `abi-v2-layouts.mjs`, `fi18n.mjs` |

## Why "connect what exists" would be unsafe

- **Sending a custody or capacity instruction to an S1 program:**
  - the program refuses it (`BadData` / unknown tag);
  - and even if a build accepted it, V26 would make that season FAIL.
- **Building a preview into a world:**
  - that is a different program version and ruleset hash;
  - that is the adoption decision itself, which belongs to ④ and the owner, not to this lane.
- **Showing lent workshops on the page:**
  - the default build never writes the field, so a display would never change;
  - the projection that would read it is P1, already on its own branch.

## What is decided, and what is still open (recorded, not decided here)

**Recorded owner decisions (2026-11-06)**, from `workstreams/09-capacity/CONNECT-10.ja.md` §5.5:
- D1: arms made from another owner's lot belong to the user.
- D2: unused ore goes back to the lot owner.
- D6: a lot in the same province may be used directly.
- D4: a captor takes what is at the facility.

Open:
- D3: whether wood and arms may sit in lots.
- ⑩'s vault seizure.

**Note.** `workstreams/10-custody/README.ja.md` still lists "the product's owner, several resources, seizure" as undecided. That predates §5.5, but whether the two documents agree was not re-checked against the owner.

**Adoption still needs** (from the marker text and the allocation doc):
1. ④ fixes the numbers: tags, record kinds, errors, AccountKinds, program version. That includes resolving custody's version 5 against S2, and the 0xC8 overlap if S2 is ever integrated.
2. An SBF build, LiteSVM tests and measured compute budgets for each preview.
3. A complete V26 (custody), and a capacity verifier, so that a season can PASS.
4. Rights/ownership:
   - D3;
   - the vault seizure;
   - which signer is required at each step: the plan is that A signs only the first three, and later steps are signed by B or settled by a crank.
5. A deployable program that dispatches them by default. Only then can the page add builders, screens and the error mapping. The error mapping already exists.

## Safe groundwork possible now (not done; for the coordinator to choose)

- **Page, after ④ fixes the numbers:** a read-only `Lot` decode and a holding's "lent copies" line. Each is a few lines, with no sending.
- **Without the numbers:** nothing on the page adds value yet. The error text is already there.
- **For the integrator:** a list of the files a custody adoption touches, all shared and outside this lane:
  - `frontier-abi` v2 tags, errors and layouts;
  - the program dispatch in `lib.rs`;
  - the version presets;
  - V26;
  - the generated `abi-v2-*.mjs`.

## Not verified

- Branches newer than the candidate that adopt either preview. I read the candidate, and the workstream directories on it, only. `preserve/*`, `integrate/custody-r4-20261107` and `integrate/ws09-10-audit-20261107` were seen in `ls-remote` but not diffed.
- That no later owner decision changed D1–D6.

## Addendum (2026-11-17): every saved ⑨/⑩ tip compared with the candidate

Local objects were read first. The three tips missing locally were read through the GitHub compare/commits/blob API. No fetch, clone or export was done.

| Ref | Tip | Date | Against `d16048aa` | What it holds that the candidate lacks |
|---|---|---|---|---|
| `integrate/custody-r4-20261107` | `3fa1f4a7` | 11-07 11:27 | **ancestor** | nothing |
| `integrate/ws09-10-audit-20261107` | `c1e8137e` | 11-07 09:23 | **ancestor** | nothing |
| `integration/ws09-13-v16-d0949fd4` | `ef63544c` | 11-06 00:28 | **ancestor** | nothing |
| `preserve/resident-custody-integrated-20261107` | `1d050f79` | 11-07 11:32 | **ancestor** | nothing (⑳ resident custody, not ⑩) |
| `preserve/resident-custody-wide-draft-20261107` | `c94a5df7` | 11-07 11:41 | **ancestor** | nothing |
| `claude/elegant-bohr-co2uhr` (⑨ owner) | `66d1a21e` | 11-08 17:40 | diverged: +2 / −486, merge base `b1157847` | Only `patches/to-04-16576826/0001` and its SHA256SUMS, plus three `results/*.log`. The patch's code is **already in the candidate**: it is commit `b1157847` itself. `git apply --check -R` passes per file for rules `capacity.rs`, `proc/capacity.rs`, `capacity_runtime_tests.rs` and the kernel `ledger.rs`. |
| `claude/great-babbage-3ogkqu` (⑩ owner) | `b128e611` | 11-08 18:39 | diverged: +32 / −447, merge base `02be5f41` | The 300 files are mostly ④'s candidates merged in ("keep reachable"). ⑩'s own code: `v26_custody.rs` at the tip (patch 0007, "a send with no path Province listed is not judged") has blob `cedf1fbb`, **identical to the candidate's**. Missing from the candidate are docs and patch files only: `patches-candidate/0005–0007` and their SHA256SUMS. |
| `integrate/nft-custody-auth-prep-20261107` | `ab5a210f` | 11-07 02:41 | +1 / −793 | One refactor of 2 files for ⑳ resident routing. That is not ⑩, so it is out of this scope. |

**Result.** No ref carries an adopted provider or contract that the candidate lacks, so there is still no connection to implement.

## The three properties read in the preview code (not run; no defect found)

**Unreturned amounts are kept.**
- `ClaimJob` (`proc/capacity.rs` ~752–833) adds a lot-fed job's unused ore to `link.owed`.
- `lots::pay_owed` (~1138–1165) returns only whole units (`owed / MILLI × MILLI`) through custody's `return_unused`. That moves `CONSUMED → HELD` without counting `IN_TOTAL` twice.
- A frozen or full lot leaves the amount owed (`Forfeited | Capacity → Ok(false)`).
- `RetireJob` refuses while `owed != 0` (~976).
- After a facility loss, `claim` still runs (`lost` skips the live check), and `pay_owed` is reached before the `Already` return. So an amount already owed can still be paid.

**No double consumption.**
- `DepositToJob` from a lot calls custody `consume` only when `cap::deposit` applied an event. A retried deposit id is `Already`, so the lot is not consumed again.
- `consume` checks the order's kind, id, grantee, expiry and `qty_left`, and checks for overflow, before any write (`spend_order` mutates only after its checks).
- A second source is refused (`NotImplemented`): another lot, or the user's own ore already in the hopper. `hopper` is cumulative (`in_total`), so `hopper[0] − link.taken` measures the user's own ore correctly.

**A refusal leaves everything unchanged.**
- Every handler read writes its accounts (`put_lot`, `put_job`, `put_link`, `put_pool`, `v.write`) only after all kernel calls succeed.
- An `Err` aborts the transaction anyway.
- The rules' `return_unused` and `consume` check before they mutate.

**Not read.** The rest of `proc/custody.rs` (ship, inbound, withdraw, reconcile, forfeit), cancel/lose beyond what is quoted, and the rules' `settle_job`. These were not audited line by line. ⑨'s and ⑩'s own property tests (300 × 400 steps, 3,000 random runs) cover them, but **I ran none of them**.

## Still undecided (unchanged from above, none taken here)

- ④: final tags, kinds, errors and AccountKinds; custody version 5 against S2's 5; the 0xC8 overlap.
- The owner:
  - D3, whether wood and arms may sit in lots;
  - vault seizure (⑩'s `forfeit` is "a proposal, not a decision");
  - two sources for one job, which is refused today as `NotImplemented`.
- Release conditions: an SBF build, LiteSVM tests, measured budgets, a complete V26, and a capacity verifier.
- A deployable program that dispatches the tags by default.

## Addendum 2 (2026-11-17): cancel and loss traced through owed amounts and closing (static; not run)

The trace followed each path from the program handler (`proc/capacity.rs`), through the kernel (`permutation-rules/src/frontier/capacity.rs` and `custody.rs`), to the order of account writes. Line numbers are on `d16048aa`.

| Path | What happens | Judgement |
|---|---|---|
| CancelJob (`proc` 861–889 → `cap::cancel` 1135–1162) | Settles to `now` and sets `Fin::Cancelled`. Retrying is `Already`; a job already final is `AlreadyFinal`. Job and pool are written only on `Applied`, and the link is not touched. The refund waits for ClaimJob, which puts a lot's ore into `link.owed` (Addendum 1). | sound |
| ClaimJob after Cancel, then RecordFacilityLoss | Claim sets `refunded = true`, so `lose` computes `refund = [0, 0]`: nothing is returned twice. | sound |
| RecordFacilityLoss first (`proc` 895–958 → `cap::lose` 1245–1312) | Every job of the pool is required, in order (`UnknownJob` otherwise). Under a policy that gives the captor the inputs, `refunded = true` and the inputs go to `forfeited_in`; the captor's Holding is credited. The owner's decision D4 is that the captor takes it and nothing returns to the lot. A later claim refunds nothing, and the output is claimed for the captor exactly once. Ore that was already in `link.owed` before the loss stays owed, and remains payable (Addendum 1). | sound (D4 as decided) |
| A loss where the user keeps all, or no captor | `refunded` stays false, and ClaimJob refunds later into `link.owed`. | sound |
| RetireJob (`proc` 966–988 → `cap::retire` 1316–1351) | Requires the job final and fully handed out (`claimed == settled`, plus refunded or nothing left). The program also refuses while `link.owed != 0`. | sound |
| A sub-unit owed rest | `pay_owed` returns whole units only, so a rest below 1000 milli stays in the job's link forever. The job then never retires, and the pool keeps its occupancy row. | **known and documented**: ⑨ `INTEGRATION-04.ja.md` §2 and ⑩ doc 15 decision 2. Holding the rest on the lot needs a Lot layout field, a new `RULESET_HASH_V4`, ④'s allocation and an owner decision. Not changed. |

### A defect not found in the documents: closing the lot strands what a job still owes it

1. M's lot holds 10 ore. M gives B a use order for 10.
2. B's `DepositToJob` consumes all 10. `spend_order` frees the order when `qty_left` reaches 0, so the lot has `held == 0`, no live order and no inbound caravan. `Lot::empty` is therefore true.
3. **M, or the vault's owner**, sends CloseLot. Rules `custody::close` (467–497) allows either. `proc/custody.rs` `close_lot` (1187–1235) then closes the account with `init::close_to`.
4. B's job ends, or is cancelled, with 4 ore unused. ClaimJob puts 4000 into `link.owed`.
5. `lots::pay_owed` cannot pay it.
   - With the closed account, `lot_of` → `present_v2` fails, so a claim that lists the lot pair fails as a whole.
   - If M reopens a lot at the same deterministic address (`lot_address`: p, q, tile, vault generation, owner tag, resource), its `consumed` is 0, and `return_unused` refuses with `Quantity`.
   - Without the pair, the owed amount stays in the job forever. The job never retires, and the pool keeps its row.

**What breaks.** The ore that was not used belongs back to M (D2), and it is now unrecoverable: it is held by nobody. And the **vault's owner** can cause this, against ⑩'s claim that the keeper cannot reach a lot's goods.

**Reachable only in a build with both previews** (`capacity-preview` and `custody-preview`). The default S1 build refuses these tags.

**Why not fixed here.** Every remedy is a rule choice, outside this lane:
- (a) the lot records returns still pending, and `empty` waits for them. This is a new Lot field (RSV), so the layout and `RULESET_HASH_V4` change: ④ and the owner.
- (b) CloseLot of an open lot is refused while anything consumed for a workshop could come back. The lot cannot tell this without (a).
- (c) define where the owed ore goes when its lot is gone: M's Holding, M's vault stock, or a new lot. That is the owner's decision.

A stopgap that only makes `pay_owed` report "not payable" for a closed lot would leave the ore stranded as before. So no code was changed, and no regression case was written: a case would only pin the defect. Once one of (a)–(c) is chosen, the case is the scenario above.

### What actually needs deciding next (in order)

1. **The owner:** where unused lot ore goes when its lot has closed, (c). And whether a lot may close while returns are pending, (a)/(b). This defect needs that decision before either preview can be adopted.
2. **④ and the owner:** where a sub-unit rest is held (already open: ⑨ INTEGRATION-04 §2). The same lot-side field would serve (a).
3. Then the adoption items already listed: final numbers, version 5 against S2, SBF/LiteSVM/budgets, V26, a capacity verifier, and a deployable dispatch.

## Addendum 3 (2026-11-17): the CloseLot stranding, two designs compared (static; nothing adopted or changed)

### Facts both designs rest on (`d16048aa`)

| Fact | Where |
|---|---|
| Lot is 576 B. The tail `RSV` @560 is 16 B: written as zeros (`custody.rs:1168`) and ignored by `Lot::decode`. V26's state audit checks only the Vault/Caravan custody fields for nonzero | `abi-v2-layouts.mjs` Lot; `custody.rs` 974–1168; `v26_custody.rs:116–126` |
| The lot's address is derived from `(p, q, tile, vault_gen, owner_tag, resource)`. Lot carries `OWNER_CITIZEN` and `OWNER_TAG` | `frontier-abi/src/v2/addr.rs:127`; `proc/custody.rs:154–166` |
| The job's `Link` holds only `fed`, the lot **address**, `taken`, `returned` and `owed`, and **no owner**. The owner can still be proved from the address's inputs (the six seeds) plus the Citizen carrying `owner_tag` | `proc/capacity.rs:88–129` |
| ClaimJob is **the user's only** (`j.user != signer → NotUser`). The lot's owner cannot trigger a return, so until B claims, M's unused ore is not even computed | rules `capacity.rs` `claim` |
| `CONSUMED` is both "used for good" and "out, may come back": `return_unused` lowers it. After every return it stays above 0 for what was really used | `custody.rs` 820–872 |

**Why "refuse CloseLot while `consumed > 0`" does not work.**
- It cannot tell the two meanings apart.
- A lot that ever fed a job could never close, even with nothing left to come back, so its vault quota would be locked forever.
- And it still says nothing about where the sub-unit rest should go.

### A — a lot that may still receive a return cannot close

**Shape.** Use 12 of the 16 RSV bytes:
- `pending` (u32): the number of jobs fed from this lot that are not yet settled;
- `owed_rest` (i64 milli): the sub-unit rests of finished jobs, gathered on the lot.

**When `pending` and `owed_rest` move:**
- DepositToJob (the first feed of a job) does `pending += 1`.
- The job's final settlement (the full return, or a forfeit to a captor under D4) does `pending −= 1`, and moves the sub-unit rest from `link.owed` into `owed_rest`.
- `owed_rest` is paid back in whole units as it fills up.

**`Lot::empty` additionally needs `pending == 0`**, which closes the stranding.

| Aspect | A |
|---|---|
| ABI | No new account kind or tag. **The meaning of Lot changes, so the kernel changes**: `empty`, `balanced`, `consume` and `return_unused`. That means a new `RULESET_HASH_V4` and changes to V26's replay and state audit. The program's writes and the accounts that some capacity instructions list change too, because the last settlement must write the lot. All capacity tags are provisional anyway |
| Data / owner proof | None new: the goods never leave the lot's books |
| Where the return goes | Into the same lot, at the same place. No new destination, no teleport, and the D6 "same province" rule is kept |
| Sub-unit rest | **Solved by the same field.** The rests of several jobs add up on the lot, which removes the job-side remainder that blocks retiring today (⑨ INTEGRATION-04 §2, ⑩ doc 15 decision 2) |
| Full lot | `return_unused` refuses (`Capacity`) and the amount stays owed. `pending` holds, so the lot cannot close while it is full of pending returns. That is consistent |
| Seizure | A forfeited lot still has `pending > 0`, and "closed by anyone after forfeit" must also wait for it. **Where a forfeited lot's pending returns go is the same open question as ⑩'s seizure proposal** |
| Double return | Unchanged guards: `return_unused ≤ consumed`, and `link.owed` is decremented in the same write. `pending` falls exactly once, at final settlement |
| Keeper | The vault owner can no longer close a lot that is waiting for a return |
| Liveness | M's lot cannot close until B claims. Today M's ore is equally stuck; A only makes it visible. It needs a decision too: a permissionless or owner-callable "settle the return" after the job is final |
| Migration | The previews were never deployable: no season of the custody or capacity build exists outside local test worlds, and a new V4 hash refuses old ones anyway. Old RSV bytes are zero, so an existing lot would read `pending = 0`. Not safe for jobs already open, so local worlds would have to restart |
| Depends on | ④ (accepting a new V4, possibly account lists); ⑨ and ⑩ (kernel and program); V26; the owner (seizure, liveness) |

### B — CloseLot is allowed; the return goes to an owner-bound claim account

**Shape.** When ClaimJob finds the lot closed or reopened, it moves `link.owed` into a **ReturnClaim** account in the same write. The account's address is seeded by the lot's six seeds, so it names the owner by construction. A new **ClaimReturn** instruction then pays it out to M:
- M signs as the Citizen whose tag is `owner_tag`;
- M presents the six seeds;
- the program checks that `lot_address(seeds) == link.lot`.

| Aspect | B |
|---|---|
| ABI | **New**: an AccountKind, a seed tag and magic, 1–2 instruction tags, a record kind for the claim and its payout, and errors. ⑩'s band 0xC2–0xCC and ⑨'s 0xF0–0xFD are full. 0xCD–0xCE are taken by the land preview and 0xCF is free: **④ must allocate**. Lot and CloseLot themselves are unchanged |
| Data / owner proof | Proof by the address's inputs and the Citizen's tag. **Not verified**: whether a citizen tag can ever pass to another wallet (rejoin, expulsion). If it can, B pays the wrong person |
| Where the return goes | **A new choice**: M's home Holding (exact in milli, but the ore appears at home: a "teleport" against D6's same-province rule), M's vault at the lot's tile (may be gone or seized), or a new lot. **The owner decides** |
| Sub-unit rest | The claim holds milli exactly, and a Holding credit is in milli, so nothing is stranded. Only the claim's payout, not the job, needs to settle. The job-side rest problem stays for lots that are still open, unless B is also used for them |
| Full destination | It depends on the destination. A vault or lot can be full (the claim waits); a Holding credit cannot |
| Seizure | The lot is closed, so ⑩'s seizure does not reach the claim. **Whether a captor of M's vault should get it is a new rule choice** |
| Double return | Owed moves to the claim and the claim pays once, then closes. That needs its own replay in V26 (a new verifier surface) |
| Keeper | The vault owner may still close an empty lot, but M's return is preserved |
| Liveness | Same as A: it still waits for B's ClaimJob unless a permissionless trigger is added |
| Migration | Same as A (no deployed seasons). Lots already closed in local worlds: their jobs could move their owed amount into a claim on the next ClaimJob, if B is defined that way |
| Depends on | ④ (new numbers); ⑨ and ⑩; V26 (new account, new replay); the owner (destination, seizure, tag permanence) |

### Recommendation: A

- It adds no account kind, tag or destination.
- The goods stay where custody says they are.
- One field also solves the known sub-unit-rest problem.
- It takes the keeper's power to strand a return away, instead of compensating for it.

B is stronger only if the owner wants lots to close freely; it then needs ④'s new numbers and a destination rule. The cost of A is a kernel and V26 change under a new V4 hash, which any adoption of these previews needs anyway.

**Both A and B leave one choice to the owner: who may trigger the return once a job is final.** Today only the user can.

### The question for the owner (one choice)

> When ore from someone's storage has gone into another player's workshop job, and some of it may still come back, should that storage be **unable to close until every possible return is settled** (recommended: the returned ore, fractions included, goes back into the same storage), **or should it be allowed to close**, with what comes back held in a separate account that only the original owner can collect (you would then also pick where it is paid out: home village, the storehouse, or a new storage)?

## Addendum 4 (2026-11-17): ship → inbound → settle / reconcile, and withdraw (static; nothing changed)

Read from `proc/custody.rs` and rules `custody.rs`, on `d16048aa`.

| Path | Checks read | Judgement |
|---|---|---|
| ShipLot (`proc` 765–850) | Both lots are read at canonical addresses (`lot_of` → `expect_key`), and the destination must have the same `owner_tag` and resource and be a different lot. `spend_ship` checks the destination before spending ("a wrong one spends nothing"), that the owner ships by wallet only to a lot, that a carrier stays within its ship order to that order's destination, and `available ≥ qty`. The destination's `begin_inbound` reserves the kept cargo after wear: a duplicate caravan id is `Stale`, and `held + incoming + qty ≤ quota`. Both lots are written after every check, and the wear is logged as `Worn` | sound. A fully worn send (`kept = 0`) is refused whole (`Quantity`): fail-closed |
| WithdrawLot (`proc` 852–941) | The destination place must be owned by the signer (`NotOwner`). `spend_ship(By::Owner, OwnPlace)` checks `available`. An ordinary caravan follows, and `out_total` covers the whole quantity with the wear logged | sound |
| SettleCustody (`proc` 943–1065, permissionless) | The caravan must be `MOVING` and custody-marked, past `ARRIVE_TS`, with every listed path bell resolved and no raid open. The lot's address is rebuilt from the caravan's destination and `CUSTODY_OWNER_TAG`. **The vault account must be the canonical one** (`vault_of_lot` → `expect_key`), so a caller cannot pass another account to force a `DestinationGone` loss. `finish_inbound` needs the live inbound entry. A seized or absent vault means `DestinationGone`, logged with the holder. The caravan closes in the same instruction, so it cannot be settled twice | sound |
| ReconcileLot (`proc` 1112–1185) | Forfeit runs only for an open lot whose vault is of a later generation. SeizeVault (`caravan.rs` ~1856–1864) changes only the owner and the generation, and keeps `CUSTODY_QUOTA` and `CUSTODY_LOTS`, so `forfeit`'s `quota −= lot.quota` and `lots −= 1` are right, and `stores + held ≤ cap` holds. Inbound entries survive forfeit and settle as `DestinationGone`. A dropped inbound needs the caravan to be `Taken`, or absent (a custody caravan closes only through SettleCustody, which clears the entry in the same instruction). A present custody caravan is refused (`InTransit`). Nothing changed is `AlreadyDone` | sound |
| CloseVault with lots (`caravan.rs` ~1946–1951) | Refused while any custody quota or lot remains (`LotNotEmpty`) | sound |

**Result: no new defect** in shipping, inbound reservation and release, settlement, reconciliation or withdrawal.

**The one related gap is the same seizure question as before.**
- After ReconcileLot forfeits a lot, `return_unused` refuses (`State`, which maps to `Forfeited` for `pay_owed`), so a ⑨ job's owed ore can never return.
- Anyone may then close the empty forfeited lot.
- That is the CloseLot stranding of Addendum 2 reached through a seizure.
- Under design A, the forfeited lot's pending returns would need the seizure rule decided: the captor (as D4 does for the facility) or the original owner. ⑩'s seizure handling is still "a proposal, not a decision".

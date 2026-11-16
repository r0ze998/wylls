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

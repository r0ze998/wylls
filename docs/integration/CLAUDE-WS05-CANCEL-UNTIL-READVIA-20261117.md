# ⑤ RunReceipt `cancel.until` stored; acts-port answers say how their state was read (2026-11-17)

Branch `claude/ws05-cancel-until-readvia-20261117`, from candidate `claude/canonical-candidate-20261116` at `d16048aa`
(local and origin equal). Independent of ⑤ `claude/ws05-runreceipt-from4-20261116` (`fc43eb72`) and ③
`claude/ws03-registry-correlation-20261117` (`eaf2b97d`), both untouched.

**Static implementation, NOT run, NOT integrated.** Nothing was executed (no test old or new, node syntax check,
import, scanner, fixture, relay, world or runner); the two guard-refused frontier tests were not run in any form.
Commands: source/history reads, file edits, `git diff --check`, git save/push. ④ (main) and ⑨/⑩ (C) read only.

## Files

- Edited (⑤ `workstreams/05-ai-participation/model-api/src/`): `run-receipt.mjs` (`cancelPhase`), `acts-port.mjs`
  (`READ_VIA`, `fourActsPort`, `loadFourActsPort`, `localActsPort`), `status-query.mjs` (`statusByActs`).
- New: `model-api/test/cancel-until-readvia.test.mjs`.
- Read: ⑤ `FATE-ACTS-5.ja.md`, `ACTS-REAL-5.ja.md`, `DECISIONS-PROPOSAL-9.ja.md`, tests `citizen`, `acts-fate`,
  `acts-port`, `acts-runexec`, `integration/same-citizen-contention`; ③ `keyfree/{cold-open,integration,run}`;
  ④ `docs/EXECUTION-CONTRACT-20261106.ja.md` §3.3/§7.3, `clients/acts.mjs`, `src/acts.rs`.

## 1. Receipt-level `cancel.until`: not an open shape decision — a missing write

- The field exists: `RECEIPT_FIELDS['cancel.until']` (`run-receipt.mjs`), shape `{lastValidBlockHeight}` (a block
  height, `DECISIONS-PROPOSAL-9.ja.md:12`), ④'s `AwaitingSigned{until}`.
- ⑤'s own record says it is filled: `FATE-ACTS-5.ja.md:33` "fate の読み手があれば、`signedAt` と `cancel.until`
  （`{lastValidBlockHeight}`）を埋める".
- The code computed it but never stored it: `cancelPhase` returned `until` (the latest lifetime of the run's open sent
  acts, null when any is unknown) and wrote only `r.cancel.phase`; `r.cancel.until` stayed the null `cancel()` set, so
  `get()` / `refreshFates()` receipts never carried it. My earlier report called this a shape decision; that was wrong.
- Change: `cancelPhase` writes `r.cancel.until = out.phase === 'AwaitingSigned' ? out.until : null` (and null on the
  early Completed branch). Same value as its return; aggregation unchanged (the run's, not an act's; act ids stay on
  the acts).
- Existing pins on paper: `citizen.test.mjs:186-187` read the return (unchanged); `:314` reads the stored until after a
  Completed with no acts → null (unchanged); `acts-fate.test.mjs:86` is the registry's receipt, not the RunReceipt;
  `same-citizen-contention.test.mjs:155` reads the return. No test deep-compares a receipt's `cancel` object.
- `missingFrom4` still lists `cancel.until` (unchanged): it records which fields ④ itself gives; the value here comes from
  the gateway's fate answer read by ⑤.

## 2. Top-level `run4Id`: a contract gap, not implemented

④'s receipt gives `run4Id` per **act** (`act-` + sha256(agent ‖ 0 ‖ key), EXECUTION-CONTRACT §3.3: "同じ行動はいつも同じ
id"); ⑤'s RunReceipt asks at the **run** level for "④'s own Run id, to join ⑤'s run to ④'s records". No contract
names a per-run ④ id: ⑤ registers under the caller run id `p05-autopilot:<agentId>` (`actsRunIdOf`), which is ⑤'s,
not ④'s. Filling the top-level field with an act id or with ⑤'s run id would mix them. Needed: ④ (main) to name a
per-run id, or ⑤'s contract to drop the run-level field in favour of the act-level ones (`toP05Act`).

## 3. Read mode: connected where ⑤ already knows it; chain: not identifiable

- ④'s receipt names no chain, cluster, simulator or read mode (`acts.rs:268-291`). ④'s client reads the wallet route
  with a gateway port, ④'s test bridge with `bridge: true`, and the store alone without a port (`clients/acts.mjs:46-79`).
- ⑤ knows it at the port: `loadFourActsPort` creates the client (with or without `gatewayPort`, never `bridge`);
  `localActsPort` reads by ⑤'s fate reader only when given one; a status with `read: false`, a register and a list never
  read. So each answer now carries `readVia`: `'gateway'` (this call read GET /f/agent/fate once), `'store-only'`, or
  null (a `fourActsPort` built from a client whose port it was not told — ③'s keyfree tests do this; unchanged for them).
- `statusByActs` (⑤'s status answer to ③) passes `readVia` beside `connection`.
- No chain field is added. A gateway read is the wallet's answer about whatever chain it sends to; `connection: 'real'`
  remains "④'s client answered", and nothing here is chain evidence.
- Existing tests check these answers field by field (`acts-port.test.mjs:30,124`, `acts-runexec.test.mjs:59,165`, ③
  `keyfree/cold-open.test.mjs:83,92`, `integration.test.mjs:86`): an added field changes none of them on paper.
- Not carried into the RunReceipt here: on the ⑤ from4 branch (`fc43eb72`) `actFrom4` copies `connection`/`port`; it
  would also copy `readVia` when the two are integrated (a one-field follow-up there, not done here to keep the branches
  independent).

## Regression source (written, NOT run)

`model-api/test/cancel-until-readvia.test.mjs`: U1–U4 (stored until while AwaitingSigned; latest of several, null when
one is unknown; null once Completed; nothing stored without a cancel, run4Id null) and V1–V2 (readVia per answer for ④'s
client port and the substitute). Stubs only; `loadFourActsPort` not called. Each assertion traced by hand.

## Unchanged

Auth, budget, sending, retry/hold, session guard, ABI, ③, ④, any runner/list/guard. WS4/6/12/13/19 and C's 9/10 not
edited. Common change to report (not made): ④'s act receipt could carry its own read mode and chain/cluster — a ④
contract change for main.

## Checks NOT run (all open)

The new test, `citizen.test.mjs`, `acts-fate.test.mjs`, `acts-port.test.mjs`, `acts-runexec.test.mjs`,
`integration/*.test.mjs`, ③ `keyfree/**`; no syntax check, import or guard scan.

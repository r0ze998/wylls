# FB1 notes: anchors and the end of the run (findings A1 and A2 of the integ-B review)

Unit FB1, branch `frontier/ai-fb1` (cut from `frontier/ai-integ` 0cc0973), local commits only, nothing pushed. Local test chain only; no model, no chain and no stack were started for this unit (JS tests with fake JSON-RPC doubles and fake servers on 127.0.0.1:0). Files touched: `permutation-gateway/citizens/registrar.mjs`, `citizens/bin/ai-citizens-run.sh`, `citizens/report.mjs` (one new section and one check line: the task asked the report to count closed against anchored bells), `test/citizens-fb1-anchors.test.mjs` (new). `citizens/lock.mjs` is not touched. No Rust, no program, no section 11.1 file.

## What was wrong (read in the code, then confirmed in the files of smoke-b2 and smoke-b3)

**A1, a sent signature was lost.** `claimAnchor` takes over a claim whose pid is our own (`isLive` needs `c.pid !== pid`), so the second attempt in one process gets a FRESH claim with `signature: null`. When that attempt failed before `onSigned` (for example `sendTransaction` refused), `anchorPass` read the fresh claim, found no signature and released the claim: the signature of the first attempt (`claim.previous.signature`) was gone, and a later pass with an advanced blockhash would have sent a SECOND memo for the same bell.

Evidence that it happened live: in `smoke-b2` and `smoke-b3` the directory `keys/anchor-claims/` holds claims for bells 0 to 84 and NONE for bell 85, although a memo for bell 85 was sent (log line `anchor 85: memo <sig>: no status after 40 tries`). The released claim is the lost signature. After it, `registrar-run.log` has 5 (b2) and 11 (b3) lines `Transaction simulation failed: This transaction has already been processed`: on a paused chain the blockhash does not advance, so the retry was byte-identical to the first memo and was refused. A second distinct memo for bell 85 therefore did NOT go out in those two runs (I did not find one; only the code path was open). What I can claim: the lost-signature path is real, it is visible in both runs' files, and the new test reproduces the double send with a chain whose blockhash advances.

**A2, the last bell had neither an anchor nor a gap.** Timeline from file times (JST, same day):

| run | stack `complete` (chain paused) | `anchors/index.json` written | `talk/85.json` and `minds/85.json` written |
|---|---|---|---|
| smoke-b2 | 16:04:07 | 16:04:07 | 16:04:52 |
| smoke-b3 | 17:36:50 | 17:36:54 | 17:37:35 |

So the closer (bell closes at the start of the next bell plus 20 game seconds, on a clock that runs at the fleet's 10x while the drain runs at 20x) closed bell 85 about 41 to 45 s AFTER the chain was paused and after `publish` wrote the index. The still-running `registrar run` then sent a memo to a paused chain, which never produced a block: no status. Result: 86 bells closed (talk files 0 to 85), 85 anchored (0 to 84), index `last_bell` 84, no gap for 85. verify-minds M3 passed both runs over bells 0 to 84 and never saw bell 85.

**Correction of the earlier claim.** For smoke-b2 and smoke-b3 the correct line is "86 closed bells, 85 anchored, 0 gaps; bell 85 closed after the season-end index on a paused chain and has no anchor and no gap file". The integ-B condition "anchors for every closed bell" is not met by those runs. Neither run was re-run for this unit, so this fix has not been seen in a live run ("not run").

## What was fixed (registrar.mjs)

1. `anchorPass` carries `claim.previous.signature` into the attempt's own claim (`recordClaimSignature`) BEFORE anything is polled or sent. The catch keeps the claim whenever any signature exists (the claim's, else the carried one) and re-records it if needed; only a failure with no signature at all releases the claim.
2. An earlier signature is polled, bounded (`pollTries` x `pollIntervalMs`, default 8 x 250 ms): `landed` anchors the bell from it; `failed` (the chain executed it with an error, so the memo does not exist) is the one case that allows a new memo; no status fails the pass without sending. After `ANCHOR_RETRY_BELLS` (3) later bells the bell becomes an `anchor_gap` whose reason is `memo <sig> was sent and no status came; it is not sent again while it may still land`.
3. `sendBlocked` / `gapWhenBlocked` options: nothing is sent while the chain is paused. `chainPaused(rpc)` asks the local chain's own `frontier_status`; any error or a chain without the method counts as not paused (old behaviour). `registrar run` checks it in every loop; `publish` once. A bell that closes after the season-end index on a paused chain is written as an `anchor_gap` at once, with reason `the chain was paused (the season is complete): no block can confirm a memo`.
4. `publish`: `--wait-last-secs N` waits (bounded) until every closed bell has both its talk and its minds file (the closer writes them in one tick: this is the half-closed window), runs one more anchor pass, waits for bells another live process holds, then `publishSeasonEnd` gives every closed bell without an anchor file an `anchor_gap` (the reason names a sent-but-unconfirmed signature, else the paused-chain or default reason) and writes the signed index. A bell a live process still holds (`skip`) is left alone. Last output line: `anchors: A anchored, G gap(s) of N closed bells; season-end trigger written`.
5. CLI flags `--memo-tries` and `--memo-interval-ms` (run, publish) shorten the bounds for tests; defaults are production values (40 x 250 ms for the status after a send).
6. `ai-citizens-run.sh`: publish is called with `--wait-last-secs ${AI_WAIT_LAST_SECS:-60}`, its output is printed and its closed/anchored/gap line goes into the END detail of RUNS.md (`anchors: ...`).
7. `report.mjs`: new `anchors` section (`anchorsSection`): closed bells (talk or minds file), anchored, gaps, closed bells with no anchor file, the index `last_bell`, bells closed after the index; a markdown section "Anchors" and the check `every_closed_bell_has_an_anchor_or_gap`. It reads files only: whether a memo is on the chain with the right text stays verify-minds M3.

## Tests (`test/citizens-fb1-anchors.test.mjs`, 10 tests) and what they did on the OLD code

The test file was run against the unmodified source of 0cc0973 before any edit (log kept in the session scratch, `fb1-old.log`): 10 tests, 2 passed, 8 failed.

| test | old code |
|---|---|
| A1 failure after the signature, a retry that throws before `onSigned`, a third pass with an advanced blockhash sends nothing (counts `sendTransaction`) | FAIL: the claim was released in pass 2 (`expected true, actual false`), pass 3 sent a second memo |
| A1 dead process's unlanded signature is carried and polled, nothing sent, gap with the signature | FAIL: sent a memo (`expected 0, actual 1`) |
| A1 boundary: a signature that failed on the chain frees the bell for one new memo | passes on old and new (boundary of the new rule) |
| A1 boundary: a landed signature is used as it is | passes on old and new |
| A2 nothing is sent to a paused chain; `gapWhenBlocked` | FAIL: option ignored, memo sent |
| A2 `publishSeasonEnd` gaps for every closed bell without an anchor, `skip`, reasons | FAIL: gaps `[]` |
| A2 `publish` waits for a half-closed bell and anchors it (real `main`, fake RPC and herald servers) | FAIL: index ended at the earlier bell |
| A2 `publish` on a paused chain: no memo, gap, count line | FAIL: a memo was sent, no gap |
| A2 run script passes `--wait-last-secs` and writes `ANCHOR_NOTE` | FAIL |
| A2 report `anchorsSection` and markdown | FAIL: no such export |

On the new code all 10 pass. Whole JS suite on the final tree: `cd permutation-gateway && npm test`: 1475 tests, 1475 pass, 0 fail, 0 skipped (52 s). The unit's neighbours (`citizens-registrar`, `citizens-ac10a-r9`, `citizens-report`, `citizens-run-check`) are inside that run and were also run alone: 84 pass.

## Rebutted or reduced

- "Wait for talk/<last> and minds/<last>" as literally worded cannot catch smoke-b2/b3's bell 85: it was not closed yet when `publish` ran (41 to 45 s later). The wait therefore covers the half-closed window (talk file without minds file), which is the part that can be fixed in code; the bell that closes after the index is handled by the paused-chain gap in `registrar run` and by the report line `closed_after_index`. I did not make the run script wait a full bell (about 60 s real at 10x) for the next bell: on a paused chain it could not be anchored anyway.
- A re-send while an earlier signature exists is not allowed even when that signature's blockhash has expired; the bell becomes a gap instead. Detecting expiry needs block height, which the local chain double does not give reliably; a missing anchor named as a gap is the safer outcome. A signature that FAILED on the chain is the only exception.
- `lock.mjs` needed no change (the carry works through `claim.previous` and `rewriteHeld`).

## Left (not done here, for the integrator or the owner)

- Bells that the closer closes after the chain is complete and paused cannot be anchored without producing blocks. Honest options: accept the named gap (what the code now does), or resume the chain for a few seconds for the last anchors (touches the chain after `complete`, the stack's job; not done), or let the fleet's drain finish before the closer's clock falls behind (a scale question, not touched). A live run is needed to see the new end step; none was run ("not run"). The plan's smoke-b4 is the place.
- Other findings of the review (B1 to G2) belong to other units; not touched.
- `report.mjs` is also edited by the C-fixes: the integrator merges the one section and the one check line added here (both are additive).

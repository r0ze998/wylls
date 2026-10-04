# FB2 notes: run report fixes C1-C5 (Wylls AI, integ-B review)

Unit FB2, branch `frontier/ai-fb2` (from `frontier/ai-integ` 0cc0973). Files: `permutation-gateway/citizens/report.mjs`, `test/citizens-report-fb2.test.mjs` (new), small edits to `test/citizens-report.test.mjs` and one fixture line of `test/citizens-integ-b.test.mjs`. No Rust, no program, no section 11.1 file, no live run, no model call. Local test chain only.

## What was fixed, and the test that fails on the old code

All 11 tests of `test/citizens-report-fb2.test.mjs` were run against the unfixed `report.mjs` of 0cc0973 and all 11 failed (the value in brackets is the first failing assertion on the old code); with the fix 11 of 11 pass.

| # | Fix | Test | Old code |
|---|---|---|---|
| C1 | A job refused before the model is not a model decision, whatever its kind: `feed_lag` (every kind), and also `not_ready`, `below_gate`, `budget`, `season_end` on a council job (the same bug class: a ballot or motion `{mode: autopilot, reason: not_ready}` was counted and was in neither list). A `feed_lag` line over all kinds with `by_kind`. Output invariant `invariant_valid_plus_fallbacks_equals_model_decisions` and a check `valid_plus_fallbacks_equal_model_decisions`; a model decision that is neither valid nor a fallback is counted in `model_decisions_unclassified` so the invariant can turn false. | `C1: a council job refused with feed_lag ...` (the case `{kind:'ballot', mode:'autopilot', reason:'feed_lag'}` and motion, not_ready), `C1: ... neither valid nor a fallback ...` | 8 model decisions instead of 4 |
| C2 | GET counters: `/^gets:/` only; `follow_fetch_gets` (the same figure as `gets:fetch_path`, getcount.rs) is never added. `per_step_per_ai` computed from `per_bot` (per AI: steps, no_session, GETs, per step; min, mean, max; check that the per-AI sums equal the total). Without `per_bot` it says so (`per_step_per_ai_note`). Herald load is listed under `not_measured` and printed as "not measured": no file of a run records it. | `C2: GETs are the gets:* counters only ...`, `C2: without per_bot ...` | 62 GETs instead of 50 (follow_fetch_gets added) |
| C3 | A model march is counted from the CHOSEN candidates of the record: `choice.ids` with candidate kind `march`, not Call-flagged (a Call is the Strike Order's, `via: strike_order`), not `recall:<handle>`; per record `min(chosen own-march candidates, sent departs)`. `MARCH_INTENTS` no longer contains `recall` (note: a recall, a follow and a march are all `depart` in the tx, so the tx alone cannot tell them apart; that is why the choice is read). A model record with a sent depart whose choice is unreadable (sealed and not opened, or `--public-only`) is `model_marches_unclassified`: neither counted nor ruled out; the brain-counter check is then `null` (unknown), not true or false. Host ids for Y come from own-march candidates and from opened destinations with `via` model only. Also `excluded_from_model_marches` and the brain's `model_strike_order_marches_sent`. | `C3: a model march is a chosen own-march candidate that was sent ...` (follow depart under a hold choice, recall, Call, refused), `C3: Y does not count a follow ...`, `C3: ... unclassified ...` | 4 model marches instead of 1; Y counted a follow as a second Y |
| C4 | `steps_equal_records_plus_no_session` compares brain steps with records of kinds `session`, `reaction`, `autopilot` only (`STEP_KINDS`); reflection, motion and ballot are mind jobs. When the brain wrote `no_session` itself, same-bell repeats (`answers_reused`) are added to the equation (a derived `no_session` already contains them). The sibling check `brain_first_call_answers_equal_records` had the same flaw and is now `brain_first_call_answers_equal_step_records`. An equation string is printed. | `C4: brain steps are compared with ...`, `C4: the check can still fail ...` | check false for a bookkeeping reason; and it did not fail when it should |
| C5 | `y_clash_without_opening` renamed `y_proxy_clash_any_opening` (computed over every model march, opened or not); `y_proxy_clash_unopened_only` added; the proxy note copied to `y_strict_definition` and to a `y_proxy_note`, plus `y_basis: episode_proxy`; episode `bell >= march bell` required; the report and the Markdown say Y is an episode proxy and that the herald clash rows (`engaged: true`) are not read, and `not_measured` lists them. | `C5: the Y proxy is named and disclosed ...`, `C5: y_proxy_clash_unopened_only ...` | Y = 2 instead of 1 for a reused host id; old caption "the record was not opened" printed next to opened records |
| R5/R6 | The Markdown prints `no_session` (with its source), the step-record equation, GETs per step, GETs per step per AI (table) and the herald-load line. | `C2: GETs are ...` (checks the Markdown lines) | lines absent |

Public-only change (follows from C3, not a regression): in `--public-only` runs the 7 slice-4 departs are now `unclassified` (0 model marches), where the old report said 7. The old figure counted any model-mode depart, recalls and follows included. The old test `--public-only` was updated to say so.

## The report on real runs (read-only, files of 2026-10-04; output in the scratchpad, not committed)

Old code against the new code, same files (`ai-integ/.local/frontier/ai/smoke-b2`, `smoke-b3`; smoke-b3 had been written by a run that was still going at the time of the review, I read whatever was in the files when I ran this):

| run | measure | old | new |
|---|---|---|---|
| smoke-b2 | model decisions / valid / fallbacks | 49 / 44 / 0 | 44 / 44 / 0 (the 5 `ballot` `feed_lag` jobs are in the feed_lag line only) |
| smoke-b2 | steps = step records + no_session (+ repeats) | false | true (423 = 388 + 31 + 4; 31 records are mind jobs) |
| smoke-b2 | first-call answers = records | false | true (388 = 388 step records) |
| smoke-b2 | model marches / Y (episode proxy) | 9 / 8 | 9 / 8 (all 9 chosen as own march, none a Call or a recall) |
| smoke-b2 | GETs per step, per AI | 5.54, per AI null | 5.54, per AI 5.01 to 6.14 (mean 5.54), per-AI sums equal the total |
| smoke-b3 | model decisions / valid | 52 / 52 | 52 / 52 |
| smoke-b3 | steps equation | false | true (421 = 387 + 31 + 3) |
| smoke-b3 | GETs per step | 5.6 | 5.6, per AI 5.07 to 6.28 |

Neither real run has a follow, so the double count of `follow_fetch_gets` and the follow-as-march error did not show in them; they would have in a main run. The valid rate of smoke-b2 changes from 89.8 % (44 of 49) to 100 % (44 of 44), n = 44 is far below the 300 of G1: underpowered, the 95 % interval (92 to 100 %) is the only statement. This is not a claim about strength: it is a corrected denominator.

## What I rebutted

Nothing of C1-C5 was rebutted; all five findings are real and were reproduced by a test on the old code. Two parts of the review's wording I did not follow literally:

- C5 asked for `episode.bell <= planned arrival + slack` as well; the task text asks for `bell >= march bell` only, so only that is implemented (see "left").
- The review said the model counter `model_marches` and the report agree by construction; they do not: the mind counts every CHOSEN march candidate (a Call included, `api.mjs` `marchedIds`), the brain counts a SENT march that is not a follow or a recall. The check against the mind counter is now `chosen_march_candidates_equal_mind_counter` and compares like with like; the check against the brain counter compares sent marches.

## Deviations and things changed beyond the letter of the task

- `GATE_CLOSED` reasons (`not_ready` above all) are also excluded from model decisions of council kinds, not only `feed_lag` (same invariant; real code path: `api.mjs` council job `fail('not_ready')`).
- Renamed keys: `y_clash_without_opening(_note)` to `y_proxy_clash_any_opening(_note)`; checks `brain_first_call_answers_equal_records` to `..._step_records`, `model_marches_equal_mind_counter` to `chosen_march_candidates_equal_mind_counter`. A reader of an old `report.json` will not find the old names. `docs/frontier/ai-citizens/AC9-REPORT-slice-4.json` (a committed report of wave A) still carries the old key `y_clash_without_opening`; it was not regenerated (it is a record of what that run printed).
- Added fields: `step_records_in_pub`, `job_records_in_pub`, `steps_equation`, `model_marches_unclassified*`, `chosen_march_candidates_all_kinds`, `excluded_from_model_marches`, `records_with_model_march`, `y_basis`, `y_proxy_note`, `y_proxy_clash_unopened_only`, `herald_load`, `model_strike_order_marches_sent_brain`, `per_bot`.
- `test/citizens-integ-b.test.mjs` (the wave-B brain-counter test) built its fake run as `new Array(90).fill(0)`; records are views with a `kind`, so the fixture now uses `{kind: 'session'}`. The assertions are unchanged.
- A Call-flagged candidate is recognised by `council: true`, `flags.council` or `facts.target_kind === 'call'` (brain.rs builds all three); a model-chosen Call goes out with `why: call` and `via: strike_order` (follow.rs `note_sent`), read, not run against a live Strike Order.

## What is left, said plainly

- Y is still a proxy. The herald clash rows (`engaged: true`) are not read; the proxy needs a recorded loss (episodes.mjs creates `clash_own_*` only when `x > 0 || y > 0` and the loss is known) and so can miss a clash; it can credit a later clash of a reused host id to an earlier march of the same host (only the lower bound `bell >= march bell` is applied; an upper bound from the planned arrival was not added). A herald-row check needs a herald and a finished run: not run.
- Per-record march count `min(chosen own-march candidates, sent departs)` can overcount in one case: a record that chose a recall or a follow beside a march, with the march refused and the recall sent. No such record exists in smoke-b2, smoke-b3 or slice-4; no test pins this.
- Herald load is still not measured (R6 is partly met: the brain's own GETs per step per AI are; the first observation of a step and the script bots' GETs are not in them, and `gets:reobserve` is a lower bound).
- The report still excludes reflections from "model decisions" (contract 10.1 lists reflection among them); they are printed on their own line and the Markdown says so. The citations count (22 vs the mind counter's 14, sessions only) is not split by kind yet.
- The Markdown and JSON of smoke-b2 and smoke-b3 under `ai-integ/.local/...` were not regenerated (not my paths); the regenerated copies are in the scratchpad only.

## Commands and results

| command | result |
|---|---|
| `node --test test/citizens-report-fb2.test.mjs` (fixed code) | 11 pass, 0 fail |
| same file against the unfixed `citizens/report.mjs` of 0cc0973 (copied in and back) | 0 pass, 11 fail |
| `node --test test/citizens-report.test.mjs test/citizens-report-fb2.test.mjs test/citizens-integ-b.test.mjs` | 24 pass, 0 fail |
| `cd permutation-gateway && nice -n 5 npm test` (head of frontier/ai-fb2 before the notes commit; the last edit after it changed one text constant and re-ran the three files above) | 1476 tests, 1476 pass, 0 fail, 46 s |
| Rust (`cargo test`, fmt, clippy) | not run: no Rust file changed |
| live smoke, llama-server, verify-minds | not run: no live process was started, no port bound |

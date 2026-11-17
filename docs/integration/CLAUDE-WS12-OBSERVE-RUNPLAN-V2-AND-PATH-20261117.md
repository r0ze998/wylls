# ⑫ observation tests: fail-closed run plan v2 (NOT run), and ④ findex → observe → ⑫ on the aggregate (2026-11-17)

**Base:** the aggregate `claude/aggregate-approved-20261117` at `8e16ff4f`. It now carries the 22-path observe unit (`5da2c63c`) and its manifest. Read with `git show` only.

**Not done:**
- no test, import, CLI run, `cargo`, request, world, key or signing;
- `bash -n` (a parse) only.

**v2 is not an approval to run.** The v1 plan (`77ba0748`, script `aac8c5be`) is **withdrawn**.

## 1. Are these two files one of the refused runs? Re-checked: no

| | The two ⑫ files | The refused runs |
|---|---|---|
| **Target** | 12's held report of 4's page (`adapters/ws04-observation.mjs`), and 13's `observe-canonical` command with every I/O a fake | world start, runner, walls-items, muster, the ⑬ guard (`keyless-guard.mjs` with `@solana/web3.js`), G, H |
| **Purpose** | that a hand-made page is shown held, reason for reason, and that the command reads, starts and sends nothing it is not handed | real worlds, gateway agents, key paths |
| **Dependencies** | 23 files (§2); none imports a world, the harness, a runner, the gateway tests, `keyless-guard`, `@solana/*` or any package | — |

**The name scan:** "harness" and "runner" appear only in comments of `observe-canonical.mjs`, `live-canonical.mjs` and `assembly.mjs`, which say that neither is used.

**Not a split, copy or rename:** these runs come from no refused run. The guard is 12's own `nokey-guard.mjs`, not 13's.

## 2. Run plan v2: what changed from v1

**Script:** scratchpad `scripts/run-ws12-observe-a7cd14b6-v2.sh`, **SHA-256 `0cef6efe350d32c0540c41ff4252d3021904ce8cde224596c4e0fc8ad8047f93`**, 122 lines, bash 3.2.

**Unchanged from v1:** the extraction (the same 23 paths and blobs, list SHA-256 `6a5adfae…c3f2`, archive SHA-256 `9390eadb…b6ae`), Node 23.11.0 (`01ca46d5…`), the guard (`cf451817…`), and the command per file.

| v1's gap | v2 |
|---|---|
| a non-zero exit, a timeout or a leftover process was logged, and **the second file still ran** | each is `fail`: every group of the run gets TERM, then KILL, and is reaped (`wait`). The run ends `RESULT: FAILED`, and **the second file is never started**. |
| a `pgrep` error (rc ≥ 2) counted as "no process" | only rc 1 is "none". rc 0 is a finding; any other rc is a failure ("not checkable"). This applies to the "another `node --test`" check and to the leftover check. |
| free space checked only at start and end | checked **every 2 s while a file runs**: below 22 GiB is a stop (so the 21 GiB floor is never reached), and `df` failing is a failure. 23 GiB is still needed to start. |
| the process group was assumed | after the start, the job must lead its own group (`pgid = pid`) and be this script's child (`ppid = $$`). Otherwise fail. Only that group is ever signalled. |
| sockets: a before/after list whose failure was ignored | every 2 s, `lsof -a -g <group> -i`: any network file held by the run's group is a failure, and lsof failing (stderr, or an unexpected rc) is a failure. The global listening list is still taken before and after; its failure is a failure. A difference made by other programs is logged, not passed off as the run's. |
| a changed worktree was only logged | a failure. Also failures: the extraction changing (file count or any blob), anything left in the runs' `TMPDIR`, and an interrupt (trap). |
| — | the monitor's own temporary files go to a separate folder, so `TMPDIR` holds only what the tests leave |

**Only one ending reads `PASSED`:** both files exit 0, nothing is left, no network file appeared in either group, and the worktree, extraction and space checks hold.

**Expected:** 9 and 6 passing cases. No retry.

**Before any run, compare the 23 blobs with the aggregate tip of that day.** At `8e16ff4f` all 23 are equal.

## 3. ④ findex → `runexec observe` → `observe-canonical` → ⑫, as now on the aggregate (bounded review)

**The real producer is the aggregate's findex.** It is not the writer-side branch, which was not taken.

| Link | What the aggregate's code does | Fits? |
|---|---|---|
| **The index format** | findex `index.rs` creates `tx(seq, slot, sig, …, err, …)`, `record(seq, idx, kind, …, body)`, `event(ev, seq, idx)` and `meta(k, v)`; `observation.rs` selects exactly those columns | yes |
| **The markers** | findex writes `schema = 2` and `strict_ps2_v2_reject_psw1 = 1`. It sets `strict_ps2_blocked = 1` on creation and rebuild, and to 0 only through the coordinator's `mark_complete`. observe reads only `schema 2`, `strict 1`, `blocked 0` and no `expedition_records_v1`. | yes. An index not marked complete is **refused** (`ObservationNotRead`), so it is never shown as a page. That is the held answer, not a defect. |
| **Failed transactions** | findex stores the `tx` row with its `err` and **returns before writing any record** (`index.rs` `if r.err.is_some() { return Ok(()) }`). observe refuses a row joined to an `err` transaction. | yes: such a row cannot come from this findex |
| **The manifest** | without the writer side, findex writes no `observed` key, so observe reads no epochs, and every row is `before_first_epoch` | yes, held: a diagnostic, not an error (manifest §4) |
| **Output** | runexec prints the page or `{error, message}` as **one compact JSON line** (`println!("{v}")`), with exit 0, 1 or 2; the client parses the last line | yes |
| **The consumer** | `ws04Read` and 12's held report: nothing admitted, 4's reasons verbatim, the epochs as given, the mode and generation checks of `a7cd14b6` | yes |

**Result: no defect within the adopted contracts, so no code this round.**
- No cursor diagnostic was added.
- No unadopted rule was turned into code.

## 4. What is still not connected (finite)

| # | Open item | Kind | What would move it |
|---|---|---|---|
| 1 | **④'s observe code has never been compiled or run on the aggregate tree.** The 16/16 ran in `6005b380`'s tree, where gateway, store and acts differ. | evidence | **next unit (static, implementable now):** pre-run evidence for one `cargo test --locked --offline --test observation --test observe_cli --test store_observation` on `8e16ff4f`, with the v3 cargo guards. Then its own approval. |
| 2 | ⑫'s two files at `a7cd14b6` | evidence | plan v2 above, then its own approval |
| 3 | ⑬'s client, port and preflight tests (`ws04-observe`, `live-canonical`, `assembly`) | evidence | they run under 13's guard, whose `@solana/web3.js` tree is not approved. **Held**; not routed around. |
| 4 | **No epochs from a real store** | owner / parent decision | adopting findex's writer side (`a99b961f`) is a separate unit with its own crate tests. Not taken here. |
| 5 | **A real herald, RPC and findex store at once** | real connection | needs a running world, which is not authorized. The command holds every receipt until the RPC's cluster and the store's world are declared. |
| 6 | **A resident reading the observation** | — | not in scope: the preflight refuses every non-read port (settled). |
| 7 | **Rows' cursor order in 12** | 12's owner | an option (`77ba0748` §4), not adopted |

## Hand-over

- **This report** is the only file on `claude/ws12-observe-runplan-v2-20261117` (on `8e16ff4f`).
- **No code unit; the aggregate is unchanged by this lane.**

# ⑫ observation tests at `a7cd14b6`: pre-run evidence (NOT run), and a counter-review of CLI → held consumer (2026-11-17)

**Fixed source:** `claude/ws12-13-observe-consistency-20261117` at `a7cd14b6`. This is the unit that the manifest `78ceb25e` (candidate tree `075701cd`) hands to Lane D.

**Not done:**
- no `node --test`, no `import` of these modules, no CLI run, no request, no `cargo`;
- `bash -n` (a parse of the run script) only;
- the earlier one-run approval (8/8, 4/4 at `8e2e3e85`) is spent and is **not** reused.

## 1. What a run would cover

| File | Cases | Earlier run |
|---|---|---|
| `workstreams/12-memory/test/ws04-observation.test.mjs` | **9** (8 run before + 1 new) | 8/8 at `8e2e3e85` |
| `workstreams/12-memory/test/ws04-observe-cli.test.mjs` | **6** (4 run before + 2 new) | 4/4 at `8e2e3e85` |

## 2. Static evidence (read as text)

### Imports and top-level effects

**The closure of both files** is 21 modules: the 19 of the command's closure (manifest §1) plus the two tests. Nothing else is reached:
- only relative imports and `node:` built-ins (`test`, `assert/strict`, `fs`, `util`, `url`, `child_process`, `path`, `crypto`, `sqlite`);
- no bare package, so no `node_modules`;
- no dynamic `import()`.

**At top level, nothing is read, written, opened, started or sent.**
- The only top-level statement that runs code is the command's own entry guard: `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) …`.
- Under `node --test <file>`, `argv[1]` is the test file, so `main()` is not started by the import.

**Two things are touched at load:**
- `permutation-gateway/citizens/memory/config.mjs` defines `readJson` (a function, not called at load).
- `12-memory/adapters/canonical.mjs` imports `node:sqlite`. That gives an `ExperimentalWarning` (seen in the earlier run); no database is opened by the import.

### Every I/O path, and what each test hands in

| Path in the code | Real I/O if not handed in | In these tests |
|---|---|---|
| `main(argv, {io, print, execFile})`: `io.getJson`, `io.rpc` (else `fetch`) | HTTP GET, HTTP POST | **every `main` call passes `io`** (`run()` and the normal-Season case): counted fakes. No `fetch` is reachable. |
| `observeLive`: `io.readStore ?? readWs04Store` | `new DatabaseSync(path, {readOnly})` | **every `io` has `readStore`**: a refusing stub (`run()`) or the counted fixture reader (normal-Season case). `??` falls back only for `null`/`undefined`, never for a function that throws. The real reader is not reachable. |
| `ws04ObserveClient`: `execFile` (else `node:child_process`) | a subprocess | **every `main` call passes `execFile`**: a fake that calls back. It is never called on a usage error (asserted). |
| `readDecl(--binding / --rpc-binding)` | file read | no test passes either option |
| `--ws04-observation <file>` | file read | given only in usage-error cases. Each returns 64 **before** the read: the sources check (two sources), and the new empty-value check. |
| `createMemory({world, partitions})` (no `path`) | none | the journal writes only with a path (`store.mjs` `if (!this.path) return`). `_rescanTail` runs only after a failed write. |
| test text reads | file read | `ws04-observation.test` reads `../adapters/ws04-observation.mjs` and `../adapters/live-observation.mjs`; `ws04-observe-cli.test` reads `../fixtures/ws04-receipts/happy.json`. All three are inside the extraction (§3). |

### The guard

- **Node:** `--import ./workstreams/12-memory/tools/nokey-guard.mjs` is 12's own guard (blob `11ba0510`, SHA-256 `cf451817…`). It is unchanged at `8e2e3e85`, `a7cd14b6` and the aggregate `19c9cbbe`, and imports only `node:crypto` and `node:module`.
- **Not used:**
  - 13's `test/keyless-guard.mjs` (the refused ⑬ guard, with its `@solana/web3.js` tree);
  - world, runner, walls-items, muster, G or H;
  - the refused gateway tests.
- **Not one of the refused runs:** these two files are 12's, and the runs are not split from, copied from or renamed from any refused run.

### Counter-examples traced (the code's answer, static)

- **A refusing `readStore` stub:** thrown inside `observeLive`, it becomes the reason `ws04_store_unreadable:<message>`. The observation stays held, and no SQLite fallback happens (the stub is a function).
- **Argument checks come before anything is started or read:**
  - usage errors: two page sources, `--runexec` without a source and the reverse, `--ws04-after`/`--ws04-limit` without a runexec source, and an empty value of any page option;
  - all of them return 64 with zero `getJson`, `rpc`, `readStore` or `execFile` calls (asserted).
  - **A bad `--ws04-after`/`--ws04-limit`** is refused by the client before `execFile`, as `ws04Read: not_read, BadRequest`. The herald part still runs, as the command documents.
- **Empty stdout, non-JSON, or a crash:** `Spawn`, never `NoRecord`.
  - A JSON error line with a non-zero exit is runexec's own code.
  - A non-string `error` is `Spawn`.
- **u64:** runexec prints `owner` and `raider` as bare numbers, and `parseJsonU64` keeps them exact (decimal strings).
  - A sequence or cursor past 2^53 becomes a string, so 12 reports `_malformed` or `unsafe`.
  - It is never rounded into text.
- **Unknown fields:**
  - an unknown `kind` is `event_kind:<…>`;
  - an unknown epoch `why` or a missing key is `archive_epoch_malformed`;
  - an unknown `generation` is `ws04_observation_store_malformed`;
  - none is guessed, and every row stays held.

## 3. The one-run plan (needs its own approval)

**Script:** scratchpad `scripts/run-ws12-observe-a7cd14b6.sh`, **SHA-256 `aac8c5be7df56c9a5e6e53dab0d07aa564fa02fa3a38a1030de2ec68022ad42d`**, 77 lines, bash 3.2.

**The extraction:**
- **only these 23 paths** of `a7cd14b6` (list SHA-256 `6a5adfae…c3f2`), all `100644`;
- `git archive` SHA-256 **`9390eadb560e160a55e309a2225ce2ef73c5fb5a409b296f51df2b587bc5b6ae`**;
- each extracted file is checked against its blob, and exactly 23 files must be present;
- the folder is a new one in the scratchpad, not the worktree.
- **No package configuration:** no `package.json` or `node_modules` in it or in any ancestor folder (checked now and by the script). So no `type`, `imports` or loader can come from outside.

| Path | Blob |
|---|---|
| `workstreams/12-memory/test/ws04-observation.test.mjs` | `5a2d9fdae81e` |
| `workstreams/12-memory/test/ws04-observe-cli.test.mjs` | `8e76baf52695` |
| `workstreams/12-memory/tools/nokey-guard.mjs` | `11ba051053a6` |
| `workstreams/12-memory/fixtures/ws04-receipts/happy.json` | `28f8efefe732` |
| `workstreams/13-citizens/bin/observe-canonical.mjs` | `65bbbb9b6f4d` |
| `workstreams/12-memory/adapters/live-observation.mjs` | `2b61e13a41d0` |
| `workstreams/12-memory/src/index.mjs` | `4dd83d4b2878` |
| `workstreams/12-memory/src/store.mjs` | `2b5e908a99ea` |
| `workstreams/12-memory/src/records.mjs` | `21694b1f2962` |
| `workstreams/12-memory/src/fold.mjs` | `940ae3e8fe9b` |
| `workstreams/12-memory/src/view.mjs` | `85fc4517894d` |
| `workstreams/12-memory/src/advise.mjs` | `18a89a4c4eb7` |
| `workstreams/12-memory/adapters/canonical.mjs` | `7eec019cdd20` |
| `workstreams/12-memory/adapters/ws08-world.mjs` | `3b1c2b1f3f6e` |
| `workstreams/12-memory/adapters/ws04-receipts.mjs` | `9ff78bbba541` |
| `workstreams/12-memory/adapters/ws04-observation.mjs` | `a78ece45f1c0` |
| `workstreams/13-citizens/resident/ports/live-canonical.mjs` | `528e869739bc` |
| `workstreams/13-citizens/resident/frame.mjs` | `a1c3203799ac` |
| `workstreams/13-citizens/resident/ports/ws12-canonical.mjs` | `003ce5c2b15e` |
| `workstreams/13-citizens/resident/assembly.mjs` | `2ce5ce6e9665` |
| `workstreams/13-citizens/resident/ports/ws04-observe.mjs` | `21b36aaec657` |
| `permutation-gateway/citizens/memory/config.mjs` | `ddd7ff341965` |
| `permutation-gateway/citizens/mind/sanitize.mjs` | `c82d8c2424fd` |

**Checks, each a stop:**
- **Paths:** every output path is free.
- **Free space:** at least 23 GiB.
- **Node:**
  - the binary is `/opt/homebrew/Cellar/node/23.11.0/bin/node`, SHA-256 `01ca46d5…`, version `v23.11.0`;
  - 20.19.4 on `PATH` has no `node:sqlite`, so it is not used.
- **Guard:** its hash.
- **Environment:** `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TEST_CONTEXT`, `LD_*` and `DYLD_*` are all unset.
- **No other `node --test`** is running.
- **Extraction:** the archive and blob hashes.
- **Before:** the worktree HEAD, status hash and staged count, and the listening TCP sockets, are recorded.

**The two runs:**
- Each file runs once, in order, from the extraction:
  `env -i HOME=<tmp> TMPDIR=<tmp> PATH=/usr/bin:/bin node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test workstreams/12-memory/test/<file>`
- Each runs in its own process group, with a 120 s cap; on timeout or interrupt the whole group gets TERM, then KILL.
- Leftover group members are checked.

**After:**
- the listening sockets diffed;
- the dedicated `TMPDIR` counted;
- the extraction still 23 files (the tests write nothing);
- the worktree state compared;
- free space recorded.

**Expected:** 9 and 6 passing cases. **No retry**; a failure is reported as it is.

**Not used:** Node's permission model (`--permission`) was considered and left out. `node --test` starts each file in a child process, so it would need `--allow-child-process`, or `--test-isolation=none` and a different command from the approved method. A first and only run is not the place to try that.

## 4. Counter-review: observation CLI → held consumer (no new code)

**Checked:**
- the real inputs: arguments, the page file, runexec's stdout and exit code;
- the failures: usage errors, not read, refused, unsafe, unknown;
- provenance: 4's reasons verbatim, the store pairing and epochs as given, `ws04Read` beside the observation, the top-level status that of the herald/RPC/store only.

**`a7cd14b6` is the fixed unit, and no further defect within the adopted contract was found.**

**Found, not fixed** (it would change already-run expectations):
- **What:** 12 does not check that rows' `event_cursor` increases strictly, or that `next_local_cursor` is the last row's. runexec's reader guarantees both and errors otherwise (`cursor <= previous`), so only a hand-made page file or another version could break them.
- **What happens then:** each row is still shown, held, with its own locator. Nothing is admitted, merged or counted by 12.
- **Why not fixed:** naming it would change the expectations of three test cases, two of them among the 8/8 already run (their fixtures repeat one cursor, or end before `next_local_cursor`).
- **Left as an option** for 12's owner, not a defect fix.

**Not repeated:** the Resident assembly question (settled), and any trust, clock or ownership rule.

## Hand-over

- **This report** is the only file on `claude/ws12-observe-prerun-20261117` (on `a7cd14b6`).
- **For Lane D's adoption:** the run's 21 code and test blobs (all but the guard and the fixture) are the blobs the candidate tree `075701cd` carries. The guard and the fixture are already identical in the aggregate. Once D has made its tip, compare each of the 23 blobs with that tip before any run.

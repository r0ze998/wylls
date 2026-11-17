# ① coop screen: the personal "confirmed amount" is a lower bound and says "以上" (Lane C, 2026-11-17)

Branch `claude/lane-c-ws01-personal-lower-20261117`, from the fixed integration candidate `claude/integ-ws01-display-count-20261117` at `5d9b0cdb`. Neither the fixed branch nor the aggregate it went into is changed.

Written, not run: nothing was imported, syntax-checked, tested, served or loaded in a browser.

## The path traced (source only)

The request → arrival → joint progress path:
- `record.mjs` `fold`: requests, responses and links.
- `arrival.mjs` `arrivalsOf`/`arrivalOf`: amounts from chain records only; the herald copy only for state.
- `goal.mjs` `allocate`, `countOf`, `coopView`: the joint, nation and personal views.
- `board.mjs` `/coop/view`.
- `coop-ui.mjs`: `renderJoint`, `renderNation`, `renderPersonal`, `renderRequests`, `renderArrivals`.

Areas already audited in earlier steps (bounds, `underBy`, the counting helper, serving) were not repeated.

| Place | Finding |
|---|---|
| `arrival.mjs` | Consistent with ④:<ul><li>Amounts come only from `CARAVAN_SETTLED`/`CARAVAN_RAIDED` chain records (`source: 'chain-log'`).</li><li>A herald-only state is never counted; its amount is "分からない".</li><li>Being at a different place is `DestinationMismatch` (held, no amount), never "taken".</li><li>`KnownZero` comes only from a burn, a take, an owner rewrite or LOST.</li><li>A record of all-zero cargo is not called zero.</li></ul> |
| `renderNation` | Consistent. "証明できる到着 N 本" counts counted arrivals and states no amount |
| **`renderPersonal` (`coop-ui.mjs:120`)** | **Mismatch, fixed (display only).** It showed `personal.myVerified` as "自分が届けた確定の量：木材 196". `myVerified` is the sum of the viewer's counted amounts (`goal.mjs`), and each is a `RuleDerived`/`Recorded` lower bound `[b, b+1)` (④ `QUANTITY-CONTRACT` §3). So the line stated a lower bound as an exact amount. The arrival column already says "届いた 木材 196 以上" (`ws04.mjs` `deliveredText`) and the joint line says "数えた入荷量の下限", so the personal line was the only place without the bound |

## The change

- **`coop/fulfil-bounds.mjs`** (sha256 `b3e6b1d5…371ff6f3`) adds `lowerBoundText(o, ja)`. Each resource reads "{name} {b} 以上", and 0 reads "0 以上".
  - A value that is not a safe non-negative integer reads "量が分からない", never inferred.
  - A missing or empty object reads "—", as before.
- **`coop/coop-ui.mjs`** (sha256 `9b42a635…e4319d6b`): the personal line reads "自分が届けた確定の到着の量（数えた入荷量の下限。資源ごと）：木材 196 以上". `data-testid="my-verified"` is kept.
- **Not changed:**
  - `goal.mjs` `myVerified`, including its `v > 0` filter, as data;
  - counted amounts, the joint count, the verdict, `fulfilmentOf`;
  - sending, signing, permissions and ownership;
  - main's ④, ⑫ and ⑬ and D's ③ and ⑤;
  - the 25 deleted media files.
- **Existing tests:**
  - `test/coop.test.mjs:150, 623` compare `myVerified` data, so they are unaffected.
  - `test/coop.browser.mjs:175` and `test/coop.browser.nokey.mjs:171` wait for `[data-testid=my-verified]:has-text("木材 196")`, a substring that "木材 196 以上" still contains. These tests were not run.

## Regression (written, not run)

`workstreams/01-national-strategy/test/coop.personal-lower.test.mjs` (sha256 `89e9a473…17738ba0`) has five tests:
1. "以上" for positive amounts and for 0.
2. The browser tests' substring is still present.
3. A missing, empty or wrong-shaped object gives "—".
4. Invalid values give "量が分からない", never "以上".
5. Unknown names and a missing `ja`.

## Static audit

| Item | Finding |
|---|---|
| Closure | The test imports `node:test`, `node:assert/strict` and `../coop/fulfil-bounds.mjs`, which has no imports and only declarations: constants and exported functions |
| Effects | No `fs`, `fetch`, `process`, `child_process`, `worker_threads`, dynamic `import()`, `new Function`, `require`, `document`, `window`, or key or sign API. No `node-key-tests.txt` entry is needed and the lists are unchanged |
| Serving | `coop-ui.mjs` already imports `fulfil-bounds.mjs`; only the imported names grew. No new file reaches the browser |
| Refused work | It touches no walls, muster, G, runner or world code, and it is not a substitute for any refused run |
| Candidate command (for the coordinator; not run) | `node --test workstreams/01-national-strategy/test/coop.personal-lower.test.mjs` |

## Not verified, and next concrete steps

- **Not run:**
  - the screen;
  - `coop.browser.mjs` and `coop.browser.nokey.mjs`, which are browser tests;
  - `coop.test.mjs` and `coop.e2e.test.mjs` (board, chain fake, key list);
  - a real world.
- **Shared gap with the fixed candidate:**
  - the board, chain-fake and screen checks of `coopView` and the page (the ordinary ① subset, after the coordinator's audit);
  - ①'s decision on the `underBy` meaning and the fixture.
- **Observation (not changed, data):** `myVerified` drops resources whose total is 0 (`v > 0`). So a viewer whose counted arrivals all recorded 0 sees "—", although per §3 that is "0 以上". Changing it would change `coop.test.mjs:150, 623` (`deepEqual` on `myVerified`) and the data the board serves. It is left for ① to decide.

## Run record (the coordinator's run; Lane C ran nothing)

| Item | Result |
|---|---|
| Who and when | The coordinator, once, at `62d7c184`, after reading the whole new test and the whole `fulfil-bounds.mjs`, and checking the dependencies, side effects, and that it is not the same as any refused test. Not to be rerun |
| Command | `node --test workstreams/01-national-strategy/test/coop.personal-lower.test.mjs`, with Homebrew's `node` (Node 23.11.0); no injected environment variables; 51,600,000 KiB free |
| Result | 5/5 pass; fail 0, cancelled 0, skipped 0; exit 0; 53.154458 ms |
| What it verifies | Only the wording helper `lowerBoundText` |
| Not verified | The real screen (the personal panel), the browser tests, the board, the chain fake, and a real world |

## Hand-over to D (for the aggregate; this branch does not update it)

- **Base:** the fixed ① candidate `claude/integ-ws01-display-count-20261117` at `5d9b0cdbdd3e0e9fffb4f6e6d9b18a89543ed29e`, which is unchanged.
- **Unit:** one code commit, `62d7c184` (`fix(01 coop personal)…`), plus the report commit that holds this record. A fast-forward from `5d9b0cdb`.
- **Four paths against `5d9b0cdb`** (git blob ids at `62d7c184`):

| Status | Blob | Path |
|---|---|---|
| M | `0ec40a6b0cc0` | `workstreams/01-national-strategy/coop/fulfil-bounds.mjs`. Adds `lowerBoundText`; the existing exports are byte-identical in behaviour |
| M | `6a64cb6ddad4` | `workstreams/01-national-strategy/coop/coop-ui.mjs`. One import name, and one line in `renderPersonal` |
| A | `5fedaf0ebaa5` | `workstreams/01-national-strategy/test/coop.personal-lower.test.mjs`. Pure; ran 5/5 |
| A | (this file) | `docs/integration/CLAUDE-LANE-C-WS01-PERSONAL-LOWER-20261117.md` |

- **Real consumer difference:** only the browser's ① page.
  - The personal panel line `[data-testid=my-verified]` changes from "自分が届けた確定の量：木材 196" to "自分が届けた確定の到着の量（数えた入荷量の下限。資源ごと）：木材 196 以上".
  - No change to `goal.mjs`, `board.mjs`, `/coop/view` data (`personal.myVerified`), the ⑮ export, counts, the verdict, sending or permissions.
  - No new file reaches the browser.
- **Left undecided, not changed:** `myVerified` drops resources whose total is 0 (`v > 0`), which is data and ①'s decision.

## Pre-run audit of the remaining ① consumer checks (source only; nothing run, 2026-11-17)

**Question:** is any of `test/coop.test.mjs`, `test/coop.e2e.test.mjs` or the browser checks an independent candidate that does not overlap the refused walls, muster, G, runner or world work?

**Method.**
- Each file's static import closure was resolved by reading the sources (a regex over `import … from` and `import(…)`); no file was executed.
- Each closure was compared with what the refused tests exercise:
  - `web-frontier-build-walls-items.test.mjs` exercises `hud/rulebook.mjs`, `screens/holding.mjs`, `hud/orderparts.mjs` and `lang.mjs`;
  - `web-frontier-muster-province-full.test.mjs` exercises `fland.mjs`, `fi18n.mjs` and `lang.mjs`.
- Each closure was also checked against the repository's own key classification (`scripts/ci/scan-node-key-tests.mjs` `PAT`, and `scripts/ci/node-key-tests.txt`).

| Candidate | Closure | Overlap with the refused tests' subjects | Key classification | Verdict |
|---|---|---|---|---|
| `test/coop.browser.mjs` | 46 files; uses Playwright Chromium | `lang.mjs` only | Signs with keys by design (Dev Wallet `keyFromSeed`, `testSigner`; its own header says "鍵が要る：未実施") | **Held**: key use |
| `test/coop.browser.nokey.mjs` | 86 files; uses Playwright Chromium; `seal.mjs` has a dynamic `import()` | **`fland.mjs`, `hud/rulebook.mjs`, `fi18n.mjs`, `lang.mjs`**, through `coop/send.mjs` (`storesAt`, `settled`) | — | **Held**: suspected overlap with refused subjects |
| `test/coop.e2e.test.mjs` | 87 files; `seal.mjs` has a dynamic `import()` | **`fland.mjs`, `hud/rulebook.mjs`, `fi18n.mjs`, `lang.mjs`**, through `test/scenario-e2e.mjs` → `coop/send.mjs` | On `node-key-tests.txt` | **Held**: suspected overlap, and a key-listed file |
| `test/coop.test.mjs` | 65 files; built-ins `node:http`, `node:net`, `node:fs`, `node:os`, `node:crypto`; no `child_process`, `process.env` or dynamic `import()` | `lang.mjs` only (`herald.mjs` → `land.mjs` → `lang.mjs`; its top level reads `localStorage` and `navigator` defensively, `null` in Node) | **On `node-key-tests.txt`**: in its closure, `coop/record.mjs` (`subtle.generateKey`, `subtle.importKey`, `subtle.sign`, `signMessage`), `web/session.mjs` and `web/frontier/fplay.mjs` name key APIs. The test itself uses `test/nokey.mjs` (`fixedSigner`, `unsignedRecord`, `verifyUnsigned`) and passes `verify: verifyUnsigned` | **Held**: the repository runs listed files only in the manual key-tests job, and `node-keyfree.sh` refuses them. Running it any other way would go around that list and guard |

**What `coop.test.mjs` would do if it were ever run (recorded; not a permission).**
- Local HTTP servers on `127.0.0.1` port 0 (a fake herald and the board): `test/coop.test.mjs:416-426`.
- `fetch` only to those local URLs, including the path checks `../etc/passwd` and `frontier-node/Cargo.toml`, which must be 404.
- The board's `upgrade` path calls `net.connect` only to the configured herald, here the local fake (`coop/board.mjs:319`).
- The board's command-line start, with its default ports 41873 and 41940, runs only when `board.mjs` is the entry point (`coop/board.mjs:331`), not on import.
- Writes stay inside `fs.mkdtempSync(os.tmpdir()/ws01-coop-…)` directories: the record store, its appends, a deliberately torn line, and `observed.json` removed inside the directory. The directories are not removed afterwards.

**Result.** There is no runnable independent candidate under the current rules, so none is proposed for running, and this audit is not to be repeated.

**What remains, concretely (proposals; each needs its owner or the coordinator).**
1. **The reason every ① board or count test is key-listed (①, with the CI list owner).**
   - `coop/record.mjs` holds both the pure record logic (`fold`, `recordId`, `ownerTagOf`, `RESOURCES`) and the key helpers (`testSigner`, `signRecord`: `subtle.generateKey`, `importKey`, `sign`).
   - Any test importing `fold` is therefore classified as a key test. Even `coop.nokey.test.mjs` and `coop.ws15.test.mjs` are listed.
   - Moving the key helpers into their own module would let the scan classify the key-free ① tests as key-free, so they could run under `node-keyfree.sh` with `no-keys-guard.mjs`.
   - This touches ① sources and the generated list (`scan-node-key-tests.mjs --write`), so it is not done here.
2. **The `send.mjs` dependency on `fland.mjs` and `hud/rulebook.mjs` (①).** This is what puts the e2e and the no-key browser checks next to the refused subjects. Whether those two checks can be cleared depends on the coordinator's reading of that overlap, not on a code change.
3. **Undecided data (①):** the `myVerified` 0 exclusion, the `underBy` fixture (kept as made, or regenerated), and the request page with the personal panel on a real screen.

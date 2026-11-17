# ⑦ moments and providers by pin generation, with the life's provenance wired in (Lane C, 2026-11-17)

**An independent candidate.** Branch `claude/lane-c-ws07-moments-generation-20261117`, from the shared aggregate at `8e16ff4f22069f87b12effa6b47ec20194d288b7` (its origin tip when read).

**Why this base:** that tip carries the chronicle bundle's `permutation-server/web/frontier/controller.mjs` **by blob** (`fa7cb8dd…`, byte-identical to `009ecb9c`'s; `009ecb9c` is not an ancestor) and the chronicle and away code in `app.mjs`. So the life dependency can be connected in real code here.

**What it supersedes:** `claude/lane-c-ws07-moments-world-20261117` (`ddd418bc`), including its separate `refreshChronicle` patch file. That branch is not to be merged; this one replaces it.

**Nothing changed elsewhere:** the aggregate, the chronicle, away and moments-world branches. **Written, not run:** no test, syntax check, import, page or world. The parent approved this unit; main has no reservation on `fchainio.mjs`, `controller.mjs` or `app.mjs`, and it does not overlap D's ⑥.

## What came over from the moments-world branch (3-way, cleanly)

`git diff 6a7aea0f ddd418bc` for `app.mjs`, `controller.mjs` and `CONTRACTS.ja.md`, applied with `git apply --3way` onto `8e16ff4f`. Every hunk applied cleanly. It brings:
- **`controller.mjs`:**
  - `providerWorld`;
  - `latestEnvelope` (same world only);
  - `loadEnvelope` (world before the read, drop before any write, `r.world`);
  - `refresh` (`currentViewer` with its world);
  - `applyMeResult` (`FS.holdingsWorld`).
- **`app.mjs`:**
  - `checkMoments` (provider records, the life baseline);
  - `constructionsNow(life = FS.life)`.
- **The ⑦ contract's moments section.**

## The ABA defect, and its fix (this commit)

**Retracted:** `ddd418bc`'s report said that after A → B → A, holdings, envelopes and life "count only when their provider recorded A again", with the chronicle "resetting and retagging". That was wrong.
- Every world key was the identity string alone (cluster, program, season account), and it is the same for the first A and the last A.
- So a read started under the first A and answered after B and the return to A passed every check, and was written.
- So did a `holdingsWorld`, `env.world` or `lifeWorld` of the first A, which was taken as read for the last A. The same held for the report and away scopes.

**Fix: a monotonic pin generation** (`permutation-server/web/frontier/fchainio.mjs`, `setPin`):
- `pinGen` moves by one only when a pin **succeeds** with another identity than the last successful one. It is compared after every refusal (`PinMismatch`, `RulesetMismatch` throw first).
- A re-pin of the same identity, which happens on each season poll, keeps it. A failed pin keeps it.
- A → B → A gives generations 1, 2, 3.
- The frozen pin carries `gen`.

**Propagated** (the in-memory boundaries carry `gen|cluster|program|season account`):

| Boundary | Where |
|---|---|
| Provider reads and their records | `controller.mjs` `providerWorld()`: `loadEnvelope` (drop and `env.world`), `refresh` (`currentViewer`, so `applyMeResult` and `FS.holdingsWorld`) |
| The chronicle and the life | `controller.mjs` `refreshChronicle`'s `worldNow` (the adopted chronicle code; a one-line change): its reset (`FS.chronicleWorld` differs), its after-await stop, and the life's provenance below |
| Moments | `app.mjs` `momentWorld()` |
| Reports | `app.mjs` `reportWorld()` (`openReport` drop and keep, `loadSeason` close) |
| The away reading | `app.mjs` `awayScopeNow()` (the scope includes the generation, so a reading or a click of the first A is refused under the last). **The saved mark keeps the world itself** (`awayWorld()`, no generation), so it still matches after a reload, where the generation starts again |

## The life's provenance, connected (this commit; no patch file)

In the adopted `refreshChronicle` (`controller.mjs`):
- The reset also clears `FS.lifeWorld = undefined`.
- Right after `FS.life = updateLife(...)`, which comes behind the after-await check of the same generation and world, it sets `FS.lifeWorld = w0`.
- `checkMoments` looks at the life and its builds only when `FS.lifeWorld === momentWorld()` (or in the page's first world). The first such look is their baseline.

## Corrected existing pins (with reasons in place)

- `permutation-gateway/test/web-frontier-ws07-chronicle-world-text.test.mjs`: the `reportWorld` and `worldNow` lines (with the generation), and the reset line (with `FS.lifeWorld = undefined`).
- `permutation-gateway/test/web-frontier-ws07-away-return-text.test.mjs`: the `awayScopeNow` line (with the generation).
- Every other literal pin in both files was checked to still be in the source.

## Static reverse review (every await followed by a write in the changed range)

| Case | Result |
|---|---|
| Same world, re-polled | Same generation: nothing resets; same-world envelope order (`latestEnvelope`) as before |
| A failed pin | No generation step; the last pin stays |
| First state of the page | The first generation; moments fence nothing; envelopes read before the pin carry `world: null` and are not looked at once pinned |
| A → B | Generation 2: forget; holdings, envelopes and life only once read for generation 2 |
| A → B → A | Generation 3: anything of generation 1 (late answers, `holdingsWorld`, `env.world`, `lifeWorld`, a report, an away reading or click) differs, so it is dropped or not looked at. The chronicle resets (generation 3 differs from its record) |
| Same coordinates in the new generation | No key fence: the first look with that generation's data is a baseline (no news); the next ordinary change is told |
| A late answer of an earlier generation | Dropped before any write: `loadEnvelope`, `refresh`, `refreshChronicle`, `openReport`, the away reader's scope check |
| Failed or empty reads | Nothing tagged until a read succeeds; an empty chronicle page still builds and tags the life map |
| Saved away marks after a reload | Matched by the world itself, as before |
| Variables | `pinGen` and `pinIdentity` are module-level in `fchainio` (page lifetime); `identity` is local. Every key builder has the same format |

## Regression (written, not run)

`permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs` is key-free: it imports only `node:test`, `node:assert` and `node:fs`, and reads the sources as text. It covers:
- **G1:** the generation step after every refusal.
- **P1:** the same generation-qualified key for the providers, the chronicle, the moments and the report, and the generation in the away scope.
- **P2–P5:** carried over.
- **L1:** the wired `lifeWorld`.
- **M1–M5:** carried over.

Plus the corrected pins above.

## Limits (not changed)

- `refreshPrize`, `refreshMarches` and `refreshConquest` write their own state after awaits without a generation check.
- Holdings written by `cq-outpost` do not set `FS.holdingsWorld` (the moments then wait for `refresh`).
- Effects already playing finish their few seconds.
- Without a pin, every key is `null` (no generation is made up).

## Manifest (for D; the aggregate is not changed here)

- **Base:** `8e16ff4f22069f87b12effa6b47ec20194d288b7`.
- **Branch:** `claude/lane-c-ws07-moments-generation-20261117`, one commit (the tip).

| Status | Mode | Base blob | Blob | Path |
|---|---|---|---|---|
| M | 100644 | `bbb7563c47cc` | `ff84a132b0a81e0e0227b820a25cf184fe4c5993` | `permutation-server/web/frontier/fchainio.mjs` |
| M | 100644 | `fa7cb8ddfb2b` | `4a1c05fac2467feafe4416e5c0e17f35ddf57986` | `permutation-server/web/frontier/controller.mjs` |
| M | 100644 | `f0f079a68f84` | `70f80fe35589e5963170694cf8d759d6cbec5417` | `permutation-server/web/frontier/app.mjs` |
| M | 100644 | `370b5b7509f0` | `cfce55316fbd2e4b0e7d4568ce4e0f244960e18a` | `workstreams/07-player-experience/CONTRACTS.ja.md` |
| M | 100644 | `c6c97e7f339e` | `b90ed1ec70355d6b64b662babaa9042331c46b2e` | `permutation-gateway/test/web-frontier-ws07-chronicle-world-text.test.mjs` |
| M | 100644 | `70a2ec79600e` | `0430c933530d5f3a5591722719578b78fde6f513` | `permutation-gateway/test/web-frontier-ws07-away-return-text.test.mjs` |
| A | 100644 | `—` | `c31e36241bfca65200de730f1ec0fa972fc5fc3a` | `permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs` |
| A | 100644 | — | (this file) | `docs/integration/CLAUDE-LANE-C-WS07-MOMENTS-GENERATION-20261117.md` |

- **Applying in D:** a fast-forward of this branch onto `8e16ff4f22069f87b12effa6b47ec20194d288b7`, or `git diff 8e16ff4f22069f87b12effa6b47ec20194d288b7 <tip>` applied with `--3way` onto a later aggregate. The base-blob column is each file's preimage.
- **Likely conflict points:**
  - `controller.mjs`: `providerWorld`/`latestEnvelope`/`loadEnvelope`/`refresh`/`applyMeResult`, plus `refreshChronicle`'s `worldNow` and two `lifeWorld` lines;
  - `app.mjs`: `momentWorld`/`checkMoments`/`constructionsNow`, `reportWorld`, `awayScopeNow`;
  - `fchainio.mjs` `setPin`;
  - the end of `CONTRACTS.ja.md`.
- **Supersedes:** `ddd418bc` (do not merge that branch or its patch file).
- **Not run or verified:**
  - every test, including the existing `web-frontier-controller.test.mjs` and `web-frontier-land-freshness.test.mjs` (pins checked as text only);
  - the page; a real A → B → A;
  - the saved away marks across a reload.
- **Candidates (independent, key-free text checks; each needs its own approval):**
  - `node --test permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs`;
  - `node --test permutation-gateway/test/web-frontier-ws07-chronicle-world-text.test.mjs`;
  - `node --test permutation-gateway/test/web-frontier-ws07-away-return-text.test.mjs`.

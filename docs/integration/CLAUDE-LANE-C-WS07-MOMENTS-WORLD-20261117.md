# ⑦ moments: two looks are compared only within one pinned world (Lane C, 2026-11-17)

**Branch:** `claude/lane-c-ws07-moments-world-20261117`, from the shared aggregate at `6a7aea0fd1fe4deabdc86b5d846dced7aa3e2408` (its origin tip when read). The aggregate, the chronicle bundle (`009ecb9c`), the away bundle and every other branch are unchanged.

**Written, not run:** no test, syntax check, import, page or world. The parent approved this unit.

## The real path (source at `6a7aea0f`)

- `app.mjs` `checkMoments`, every second, builds a look with `people/moments.mjs` `momentSnapshot` from four sources:
  - `FS.life` (harvests);
  - `constructionsNow()` (holdings queues and `FS.life` builds);
  - `FS.provinces` (hosts, arrivals, camps, sites);
  - `FS.nowBell` / `FS.chronicle`.
- `detectMoments(momentPrev, next)` compares it with the last look:
  - `village` when a site's faction differs;
  - `built` when a previous construction is gone;
  - `depart`, `muster`, `arrive`, `camp`, `harvest`.
- `checkMoments` derives `lost` and `taken` from `ownSitesSeen` against the current holdings, and emits `moment` on the effects bus, which `fx/stage.mjs` and `fx/sheetfx.mjs` play.
- **The providers do not empty themselves when the pinned world changes:**
  - `loadSeason` re-pins on every season poll;
  - `FS.provinces` is only ever `.set` per province (`controller.mjs` `loadEnvelope`);
  - `FS.holdings` is replaced when the viewer's record is read;
  - `FS.life` is mutated in place by `updateLife`.

## The defect

`momentPrev` and `ownSitesSeen` had no world boundary. After a pin change, the first new look was compared with the old world's look, and with the old world's provinces, holdings and life still in the providers. Another world's site or construction at the same coordinates could be told as:
- a village **lost** or **taken**;
- a **building finished**;
- a host **departing**.

That breaks the existing rule that a first load is not news.

## The fix (`app.mjs`, `checkMoments` only)

- **`momentWorld()`:** cluster, program and `addresses.season` from `FS.pin`. That is the account `fchainio.setPin` derives and checks against the herald's record; `setPin` has no `seasonAddress` field. With no pin it is `null`: "no pin" is a state of its own, and nothing is made up.
- **A change of world** (a pin that comes or changes; the page's first world fences nothing):
  - forgets `momentPrev` and `ownSitesSeen`;
  - records `momentFence`: the province envelopes present (by object identity), the holdings array when there were holdings, and the keys of constructions under way.
- **Until the holdings array is replaced** (the viewer's record is read in this world, or `resetViewer`'s `[]`), no look is taken: neither a baseline nor news. A page with no viewer has nothing to wait for.
- **After that:**
  - only province envelopes replaced since the change are looked at;
  - a construction under way at the change is left out until it has gone, so its end is never "built" here;
  - the first look is a new baseline, with no moments.
- **Unchanged:**
  - `detectMoments` and `momentSnapshot`;
  - the `lost`/`taken`/`own` rules;
  - looks within one world (nothing is fenced then, so behaviour is as before);
  - the effects;
  - rules, assets, sending and permissions.

## Static reverse review

| Case | Result |
|---|---|
| Normal, same world | No fence (empty sets, holdings `null`): every province, every construction, as before |
| The page's first world, including before a pin | Nothing fenced; the first look is the baseline (unchanged) |
| No pin, then a pin (boot) | A change: provinces present then are fenced (normally none, since the season is read before the provinces), the holdings fence only if there were holdings |
| Pin changes to another world | Forget, fence, wait for holdings, then fresh provinces only; first look is a baseline |
| A province not yet read again | Fenced; not looked at, so not compared |
| First sight of a fresh province | Not news: `muster` and `arrive` need `prev.seen`, `village` needs a previous site, `depart` a previous host (unchanged rules) |
| Old construction ends after the change | Its key is fenced until it is gone; no "built" |
| Harvests from `FS.life` | Old entries do not change, so no moment; a new world's harvest record is a real new event and is told (see the dependency below) |
| Wallet change | `resetViewer` replaces holdings; within one world no fence is involved (unchanged) |
| Variables | `momentFence` and `buildKeys` are module-level beside `momentPrev`/`ownSitesSeen`. `held`, `fresh0`, `builds0` and `nowKeys` are local. `fresh` (the moments) keeps its name. No other function changed |

## Limits and dependencies (not changed here)

- **The chronicle bundle (`009ecb9c`, not in this base)** resets `FS.chronicle` and `FS.life` on a world change. Without it, `FS.life` mixes worlds. That does not create false moments here (old entries do not change), but the life drawn on the map is mixed until it is merged.
- **Shared file, proposed range, not edited** (`controller.mjs`):
  - `latestEnvelope` keeps the previous envelope when the new one's `seq`/`slot`/`bell` is lower. A new season's are, so a new world's province can be refused and the old one kept. Here it stays fenced, so there is no false moment, but the province is never looked at in the new world, and other screens keep showing it.
  - A `refresh` started under the old pin can land after the change and replace `FS.holdings` with the old world's holdings, which would release the fence on stale data.
  - Both need the providers to know the world they read for. That is a range for the coordinator to approve first.
- **Effects already playing** (`fx/stage.mjs`, a few seconds each) are not cleared on a change; the stage has no reset API.

## Regression (written, not run)

`permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs` is a key-free text check: it imports only `node:test`, `node:assert` and `node:fs`, and reads `app.mjs` as text. It covers:
- **M1:** the world source, and "no pin" not being a stop;
- **M2:** forget and fence on a change;
- **M3:** the order: wait for holdings, fresh provinces, constructions, then the look;
- **M4:** the comparison unchanged.

Running it needs its own approval. Candidate: `node --test permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs`.

## Providers bound to the world they read for (second commit, 2026-11-17; nothing run)

The parent approved this range in `controller.mjs`: `refresh`/`currentViewer`, the write boundary of `loadEnvelope`, and the providers' own record of the world they read for. Main confirmed it has no reservation on `controller.mjs`.

| # | Where | Before | After |
|---|---|---|---|
| P1 | `controller.mjs` `providerWorld()` (new, module-level) | — | The pinned world from `io.pinned()` (cluster, program, `addresses.season`), built exactly like `app.mjs` `momentWorld()`. `null` with no pin |
| P2 | `latestEnvelope` | `seq`/`slot`/`bell` were compared across worlds. A new season's numbers are lower, so a new world's province could be refused and the old one kept | `if (next && previous.world !== next.world) return next;`. Only envelopes of the same world are ordered; the same-world order is as before. Untagged envelopes (both `undefined`) compare as before, so the existing assertions in `web-frontier-controller.test.mjs` and `web-frontier-land-freshness.test.mjs` keep their meaning. The body still stands alone, as the freshness test builds it in isolation |
| P3 | `loadEnvelope` | An answer was applied whatever world was pinned when it arrived | It takes the world before the read and drops an answer of another world (`return null`) **before any write**: province, prototype land, keep. It tags the envelope `r.world = world`. The pinned text from `if (bell !== 'latest') return r;` through `FS.provinces.set(key,accepted);` is byte-identical |
| P4 | `refresh` / `currentViewer` | Request number and wallet only | Also the world the refresh began under. Every check after an await (the viewer's record, provinces, quota…) now also refuses another world, before `applyMeResult` |
| P5 | `applyMeResult` | — | Records `FS.holdingsWorld = providerWorld()` beside `FS.holdings`. Its only caller (`refresh`) applies it after `currentViewer()`, so it is the world the refresh began under |

**The moments fence now uses those records, not object identity** (`app.mjs` `checkMoments`):
- It waits while the viewer has holdings and `FS.holdingsWorld !== world`. A replaced array is no proof; a page with no holdings does not wait.
- It looks only at envelopes with `env.world === world`, for every world, including the first: a province read before a change, or for another world, is never looked at.
- Constructions and a holding's `life` that stood at a change are left out until they have gone.

**Corrections to the first commit's report (static falsification):**
- **"Harvests from `FS.life`: old entries do not change, so no moment" was wrong.** Without the chronicle bundle, the chronicle's cursor is not reset on a change. A new world's records at coordinates already in the old `life` raise that record's `harvests`, and `detectMoments` tells a rise in `n` as a harvest whatever its bell: possibly the log being read up, not news.
  - Now the `life` keys present at the change are fenced until they have gone.
  - With the chronicle bundle (`009ecb9c`), `FS.life` becomes `undefined` on a change, the fenced keys go at once, and harvests read up from the log fall under the existing first-load rule (`prev.logged` and the bell window).
- **"A rolled-back envelope stays fenced" is replaced:** across worlds there is no rollback any more (P2), and the fence uses the provider's `world`, not identity.
- **The limit "a `refresh` started under the old pin can release the fence" is closed** by P4/P5.

**Static reverse review (all awaits followed by a write, in the changed range):**

| Case | Result |
|---|---|
| Normal, same world | Envelopes tagged with the world and ordered as before; `currentViewer` true; moments see every province (all tagged with this world) |
| Empty or failed read | `loadEnvelope` returns `null` as before (a failure is not tagged or written); `refresh` stops at its existing checks |
| Same world, older answer arrives later | Same world, so `latestEnvelope` keeps the newer (unchanged) |
| New world, lower seq | Another world, so the new envelope wins (P2) |
| Answer started under the old pin | Dropped before any write (P3); `refresh` stops at `currentViewer` (P4); the holdings' world is not set (P5); the fence keeps waiting |
| First state of the page | No fence; envelopes read before the pin carry `world: null` and are not looked at once a pin comes |
| A province not yet read for this world | Not looked at |
| Holdings written by `cq-outpost` (`controller.mjs` ~line 2409, not in the approved range) | `FS.holdingsWorld` not set there; the fence waits for `refresh`'s `applyMeResult` (safe) |
| Variables | `providerWorld` is module-level (pure, reads `io.pinned()`); `world` is a new local in `refresh` and `loadEnvelope` (no other `world` there); `momentFence`, `buildKeys` and `momentWorld` as before; `life0`, `lifeNow`, `fresh0`, `builds0` and `nowKeys` are local |
| Other writers of `FS.provinces` | None but `loadEnvelope` (searched). `fx/demo.mjs` copies the map and spreads envelopes (`{...env}`), so the tag is kept; `fmap`, `survey` and `roster` maps are their own |

**Still not covered (outside the approved range):** `refreshPrize`, `refreshMarches`, `refreshConquest` and `refreshChronicle` write their own state after awaits without a world check. The chronicle's own fix is the chronicle bundle (`009ecb9c`, which also edits `refreshChronicle`). Effects already playing at a change finish their few seconds.

**Differences from the fixed base in `controller.mjs`:** `providerWorld` (new), `latestEnvelope` (one line), `loadEnvelope` (world taken, a drop and a tag), `refresh` (`world` and `currentViewer`), `applyMeResult` (one line). It does not overlap the chronicle bundle's `refreshChronicle` edit.

## Correction: life and builds by their provider's record, not by a key that seems to have gone (third commit, 2026-11-17; nothing run)

**Retracted (the second commit was wrong here):**
- The fence that left out a holding's life and the constructions under way "until they have gone", seen by `checkMoments` noticing a key disappear, does not hold.
  - The chronicle bundle (`009ecb9c`) `refreshChronicle` sets `FS.life = undefined` and rebuilds it in the same task after its awaits, so a tick is never guaranteed to see the gap.
  - A coordinate present in both worlds never seems to go, so its later harvests and builds would be left out for good.
- **The claim above that "with the chronicle bundle the fenced keys go at once" is wrong.** Both fences are removed.

**Now, by provenance only** (`app.mjs`):
- **The world record of each provider decides:**
  - `env.world` (provinces);
  - `FS.holdingsWorld` (holdings);
  - **`FS.lifeWorld`** (a holding's life: set by `refreshChronicle` once it has rebuilt the life from this world's pages since its reset).
- **Waiting for holdings:** until the viewer's holdings are read for this world (when there are any), no look is taken.
- **Until the life is read for this world:** neither its harvests nor its builds are looked at. `constructionsNow(life = FS.life)` takes the life as a parameter; other callers are unchanged by the default.
- **The first look that has this world's life is its baseline:** `momentPrev`'s `harvest` and `builds` are set to that look's, with `logged: false` for that one comparison. A coordinate that comes back in the new world is not news the first time, and the first ordinary change after it is told as usual.
- **The page's first world — and a first pin on a page that had none — fences nothing,** as before.

**The `refreshChronicle` change lives in the chronicle bundle, so it is given as a limited patch, not edited here.** This base (`6a7aea0f`) does not include `009ecb9c`, and this branch does not touch `refreshChronicle`.
- File: `docs/integration/CLAUDE-LANE-C-WS07-MOMENTS-WORLD-refreshChronicle-lifeWorld.patch`.
- It is against `009ecb9c`'s `permutation-server/web/frontier/controller.mjs` (blob `fa7cb8dd…`, result `34bff634…`), with an `index` line for a 3-way apply.
- It makes four changed lines:
  - the reset also sets `FS.lifeWorld = undefined`;
  - after `FS.life = updateLife(...)`, `FS.lifeWorld = w0;` plus a comment.
  
  It sits behind the bundle's own "same herald and world" check after each await.
- Checked here, without touching any working file: `git apply --cached --3way --check` on a scratch index of `009ecb9c` applies cleanly. Its hunks are inside `refreshChronicle` only and do not overlap this branch's `controller.mjs` edits.
- **Dependency:** without the chronicle bundle **and** this patch, `FS.lifeWorld` is never set. After a real world change, harvest and life-build moments stay off until the page is reloaded: conservative, never false. The first world is unaffected.

**Static falsification of the cases:**

| Case | Result |
|---|---|
| Normal, same world (the first world) | No fence: life, builds, every province, as before |
| No pin, then a pin, on a page that had none | Still the first world, so nothing is fenced. Envelopes read before the pin carry `world: null` and are not looked at |
| A → B | Forget. Wait for holdings of B; only B's envelopes; life only when `FS.lifeWorld === B`, its first look being the baseline |
| A → B → A | Each change forgets and resets readiness. Holdings, envelopes and life count only when their provider recorded A again (the chronicle bundle resets and retags on each change) |
| B's coordinates equal to A's | No fence by key: the first B look with B's life is the baseline; the next B harvest or build is told |
| A late answer started under the old pin | Dropped before any write (`loadEnvelope`, `refresh`'s `currentViewer`, `refreshChronicle`'s check) |
| Failed or empty chronicle read | `FS.lifeWorld` is not set until a page is read, so life is not looked at; an empty page still builds a map and tags it |
| Provinces arriving in any order | Each counts once read for this world; first sight is not news (unchanged rules) |
| Variables | `momentFence = {world, first, waitHoldings, lifeReady}`; `lifeReady` and `fresh0` are local; `buildKeys` and the key fences are removed (searched: no use left) |

**Regression (written, not run), `web-frontier-ws07-moments-world-text.test.mjs`:**
- M2 rewritten: the first world and a first pin fence nothing.
- M3 rewritten: the order holdings → life readiness → this world's envelopes → look → life baseline, and `constructionsNow(life)`.
- New **M5**: no key or identity fence left.
- New **M6**: the patch's four changed lines.

## Manifest (for D; the aggregate is not changed here)

- **Base:** `6a7aea0fd1fe4deabdc86b5d846dced7aa3e2408`.
- **Branch:** `claude/lane-c-ws07-moments-world-20261117`. Commits: `5e29cf64`, `61f2498f`, then this commit (the correction), which is the final tip.

| Status | Mode | Blob | Path |
|---|---|---|---|
| M | 100644 | `608a87c671036a94839d301f47b146d98a874b60` | `permutation-server/web/frontier/app.mjs` |
| M | 100644 | `6b0a0737e91c7b6e03789ece5414b3d46d6875c0` | `permutation-server/web/frontier/controller.mjs` |
| M | 100644 | `96f06ed23dfa8ec6f3092ecae2414955f56d3b1d` | `workstreams/07-player-experience/CONTRACTS.ja.md` |
| A | 100644 | `8949e7477e3fd9c5e90bdab2e994ab70c9440fc1` | `permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs` |
| A | 100644 | `28f07f79aa5f21392b443b6311a5faed1ce3832d` | `docs/integration/CLAUDE-LANE-C-WS07-MOMENTS-WORLD-refreshChronicle-lifeWorld.patch` |
| A | 100644 | (this file) | `docs/integration/CLAUDE-LANE-C-WS07-MOMENTS-WORLD-20261117.md` |

- **Dependency:** the chronicle bundle (`009ecb9c`) plus the patch above. Apply it onto that bundle's `controller.mjs` (3-way checked clean against `009ecb9c`). Without both, harvest and life-build moments stay off after a real world change (never false).
- **Likely conflict points:**
  - `controller.mjs`: `latestEnvelope`, `loadEnvelope`, `refresh`, `applyMeResult` (this branch) and `refreshChronicle` (the chronicle bundle plus the patch); these do not overlap.
  - `app.mjs` around `checkMoments` and `constructionsNow`.
  - The end of `CONTRACTS.ja.md`.
- **Not run or verified:** every test, including the existing `web-frontier-controller.test.mjs` and `web-frontier-land-freshness.test.mjs` (pins checked as text only); the page; a real world change; the patch applied to a real merged tree.
- **Candidate (independent, key-free; needs its own approval):** `node --test permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs`.

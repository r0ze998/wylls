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

## Manifest (for D; the aggregate is not changed here)

- **Base:** `6a7aea0fd1fe4deabdc86b5d846dced7aa3e2408`.
- **Branch:** `claude/lane-c-ws07-moments-world-20261117`. Commits: `5e29cf64` (moments fence), then this commit (provider world identity, with the fence on the provider's tags), which is the final tip.

| Status | Mode | Blob | Path |
|---|---|---|---|
| M | 100644 | `152a5bb090e279be6d20d81fe13d875dead6c3f5` | `permutation-server/web/frontier/app.mjs` |
| M | 100644 | `6b0a0737e91c7b6e03789ece5414b3d46d6875c0` | `permutation-server/web/frontier/controller.mjs` |
| M | 100644 | `b2e4a8af086919dd7f780432c97c88ca20e7e88f` | `workstreams/07-player-experience/CONTRACTS.ja.md` |
| A | 100644 | `bf9967c3ea6d6cb824db41cc43231c399a4b5a2c` | `permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs` |
| A | 100644 | (this file) | `docs/integration/CLAUDE-LANE-C-WS07-MOMENTS-WORLD-20261117.md` |

- **Likely conflict points:**
  - `controller.mjs`: `latestEnvelope`, `loadEnvelope`, `refresh`, `applyMeResult`. The chronicle bundle edits `refreshChronicle`, which does not overlap.
  - `app.mjs` around `checkMoments`. The chronicle and away bundles change `app.mjs` elsewhere, each with its own world helper by the same rule.
  - The end of `CONTRACTS.ja.md` (shared with the away bundle).
- **Not run or verified:** every test, including the existing `web-frontier-controller.test.mjs` (key-listed) and `web-frontier-land-freshness.test.mjs`, whose pins were checked as text only; the page; a real world change; effects already playing.
- **Candidate (independent, key-free; needs its own approval):** `node --test permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs`.

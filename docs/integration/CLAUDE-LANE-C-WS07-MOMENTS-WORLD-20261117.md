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

## Manifest (for D; the aggregate is not changed here)

- **Base:** `6a7aea0fd1fe4deabdc86b5d846dced7aa3e2408`.
- **Branch:** `claude/lane-c-ws07-moments-world-20261117`, one commit (the tip).

| Status | Mode | Blob | Path |
|---|---|---|---|
| M | 100644 | `1695e891f7f270cf7e5830372729613b37da1023` | `permutation-server/web/frontier/app.mjs` |
| M | 100644 | `21992dbd119229e2adb798e28acd1cf500aa7c35` | `workstreams/07-player-experience/CONTRACTS.ja.md` |
| A | 100644 | `cbaec35def26d2c3b9ea9e95bb9000abcf5d3759` | `permutation-gateway/test/web-frontier-ws07-moments-world-text.test.mjs` |
| A | 100644 | (this file) | `docs/integration/CLAUDE-LANE-C-WS07-MOMENTS-WORLD-20261117.md` |

- **Likely conflict points:** `app.mjs` around `checkMoments`. The chronicle and away bundles change `app.mjs` elsewhere (`openReport`/`loadSeason`, the away path), each with its own world helper by the same rule. The end of `CONTRACTS.ja.md` is shared with the away bundle.
- **Not run or verified:** every test; the page (moments on the map); a real world change; the effects already playing at a change.

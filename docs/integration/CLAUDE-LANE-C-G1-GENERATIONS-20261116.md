# Lane C — G1: holdings vs province envelope generations in the land chip (2026-11-16)

Base: `claude/canonical-candidate-20261116` @ `d5b8e382`. Branch: `claude/lane-c-g1-generations-20261116`.
Changed: `permutation-server/web/frontier/land.mjs` (`landSummary`, one guard).
New: `permutation-gateway/test/web-frontier-land-generations.test.mjs` and this report.

## The ordering in the page (read only; pinned as text by the test)

1. **`refresh()` adopts the holdings first, then reads the envelopes.**
   - `applyMeResult(me)` sets `FS.holdings = me.holdings` at once (`controller.mjs`, applyMeResult).
   - `refresh()` then runs `await loadEnvelope(o.p, o.q)` for the active holding's province, then the others, one at a time.
2. **The chip is drawn on its own timer.**
   - A 250 ms interval calls `invalidate('chip')` every fourth tick (`app.mjs` ~4275).
   - `renderChip` → `renderHudTick` → `landSummary(FS, settledHolding(activeHolding), faction)`.
   - Nothing waits for `refresh()`.
3. **So the code can draw the chip with the newer holdings against the older envelope** for as long as each envelope read takes.

## The demonstrated inconsistency

**The rule.** The program's divisor is the nation's villages among the province's sites (`permutation-rules/src/frontier/land.rs` `bonus_bps`: `sites…holding.is_some_and(g == f)`). The page counts them from the envelope's `siteMirror` (state 1, the viewer's faction).

**The case.** A village is just founded (or newly held) in a province where the nation already has one. The holdings list it, but the envelope read before the founding does not. For example, with 5 claimed tiles and one village of ours in the old envelope:

| | Figure |
|---|---|
| Base `d5b8e382`, run in the scratchpad from `git show` | the new village's chip says **+10%** (5 × 200 / 1), with per-hour from that |
| What the program pays both villages | **5%** (5 × 200 / 2) |

**The fix (`land.mjs`).**
- When the holding has a `site` inside the mirror, and the envelope's `siteMirror[site]` is not state 1 of the viewer's faction, `landSummary` returns null.
- The home line is withheld until an envelope that lists the village is read, which normally happens later in the same `refresh()`.
- No figure is corrected or guessed, and no rule or wording changed.
- The "other provinces" part of the chip is unchanged.

**Not shown to have happened.** No world or browser was run. The test shows what the page draws *if* a render falls between `applyMeResult` and the matching `loadEnvelope`. The code permits that window, but how often it happens was not observed.

## Other cases traced

- **Switching village (rail).** Both the holdings and every holding's envelope come from the same `refresh()` and the same store. Switching changes only `FS.activeHolding`, so no generation gap arises. This was covered in the previous lane test (`web-frontier-land-freshness`).
- **Re-reading.** `latestEnvelope` keeps the newest envelope, so an older one cannot replace it (previous lane test). The gap above is between two different records (`/h/me` vs envelope), and `latestEnvelope` does not order those.
- **A site the envelope shows as another nation's** (taken, or a capture pending: `fexpedition-ready.mjs:131`, mirror moved to the captor while the holding is still listed). The line is now withheld too.
  - The program's divisor reads the same mirror, so it would not count this village either.
  - Whether the program pays such a holding any land yield is **not verified**. Withholding states nothing about it.
  - This is a behaviour change from before, when the province's figure was shown.

## Remaining gap (not fixable in `land.mjs`; owner: main CC, controller/app)

**G1b: a village *lost* in the active village's province.**
- The newer holdings no longer have it, but the older envelope still lists it. The active village's own site is fine, so the divisor is one too high and the bonus too low until the envelope arrives.
- `land.mjs` cannot tell this apart from a correct envelope, because nothing on the page relates the `/h/me` read to an envelope read.
- **Concrete proposal (not applied; controller.mjs is read-only for this lane):**
  - In `applyMeResult`, record `FS.holdingsRead = ++holdingsReads`.
  - In `loadEnvelope`, when it stores a `'latest'` envelope, stamp `accepted.afterHoldings = FS.holdingsRead`.
  - Then `landSummary` (or app.mjs) would draw the home line only when `env.afterHoldings >= FS.holdingsRead`.
  - This uses no rule or timing, only the page's own read order. It would also cover the founded-village case without relying on the site mirror.

## Checks run

- `node --check` passes on `land.mjs`.
- Each test file was run singly:

| Test file | Result |
|---|---|
| `web-frontier-land-generations.test.mjs` (new) | 4 of 4 pass |
| `web-frontier-land-freshness.test.mjs` | 6 of 6 pass |
| `web-frontier-land-chip-settled.test.mjs` | 5 of 5 pass |

- I checked the base behaviour with a scratchpad copy of base `land.mjs` (imports pointed at the repo): `{"claimed":5,"tiles":7,"bonusPct":10,"perHour":4}`.
- The test imports only `land.mjs` (which pulls in `sdk/bytes.mjs`, `lang.mjs` and `util.mjs`; no side effects at import in Node). It reads controller/app/rules as text.
- No keys, signing, network, process or persistent storage are involved.

## Not verified

- The real timing of the window: no world, launcher, server or browser was run.
- Screen fixtures (`permutation-gateway/screens/*`) whose holdings' sites are not mirrored as the viewer's would now draw no home line. They were not run.
- `web-frontier-land-preview.test.mjs` was not run, because it imports the local-play launcher module. Its landSummary fixtures pass holdings without `site`, which the guard leaves unchanged.

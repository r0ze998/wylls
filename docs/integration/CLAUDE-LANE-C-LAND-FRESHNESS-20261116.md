# Lane C — land chip / province envelope freshness (2026-11-16)

Base: `claude/canonical-candidate-20261116` @ `aa12ce74`. Branch: `claude/lane-c-land-freshness-20261116`.
The task's editable scope was `frontier/land.mjs`, `frontier/herald.mjs`, a new test, and this report. I changed neither page file.

## Result

**No demonstrated inconsistency** in `land.mjs` or `herald.mjs`. Every case I checked follows the active holding and the newest envelope.

## What the code does (read only)

| Path | Where | What it means for freshness |
|---|---|---|
| Chip inputs | `app.mjs:2357–2364` | Every render reads `hud.activeHolding(FS)`. It then calls `landSummary(FS, settledHolding(lh), lf)` and `landElsewhere(FS, lh, lf)`, and passes both to `renderLandChip`. Nothing is cached apart from `setHtmlIfChanged` on the output HTML. |
| Envelope store | `controller.mjs:749–772` | `loadEnvelope` stores `latestEnvelope(held, next)`, and only for `'latest'` reads. It compares `seq`, then `slot`, then `bell` as BigInts, so a slower older read is dropped. The whole envelope is replaced, so a newer envelope with no `land` removes the record. |
| Record parse | `herald.mjs:158` | `parseLand(env.land, {p: P, q: Q, seasonId})` checks against the envelope's own province and season. A wrong key, wrong bytes, another season or version 0 gives `land: null`. |
| `land.mjs` | whole file | Holds no module-level state. `landSummary` reads only `${h.p},${h.q}`, and `landElsewhere` skips exactly that key. |

## Coverage

The new test is `permutation-gateway/test/web-frontier-land-freshness.test.mjs`. It ran on its own: **6 tests, 6 pass, 0 fail**.

1. **Switching the active village (A ↔ B, two provinces, plus a third read by the map).**
   - The home figures follow the active village: claimed, tiles and bonus%.
   - Per-hour equals `landYieldPerHour(active production, its province's bps)`.
   - "Other provinces" counts exclude the active province and include the previous one.
   - Switching back gives identical figures.
   - A second village in the same province keeps that province's line, with its own per-hour.
2. **Record loss.**
   - When a newer envelope has no `land`, the home line goes and the far count stays.
   - When `land: null` (rejected by the herald), that province drops from the far count.
   - When every record is gone, there is no chip.
3. **A mis-keyed or stale record is never shown.** This covers the key of another province, the bytes of another province, another season, and version 0. It also checks statically that the herald line exists.
4. **Out-of-order refreshes.** The test rebuilds `latestEnvelope` from the controller source text; the module itself is not imported. It checks:
   - an older read after a newer one keeps the newer figure;
   - an older read with a record does not bring a lost record back;
   - the far count follows the same rule;
   - `seq` "10" beats "9";
   - `loadEnvelope` stores the result (static check).
5. **Static checks.** The app computes the chip from `hud.activeHolding` on each render, and `land.mjs` has no module state.
6. **English chip for both villages.** No CJK text, no settle/keeper/beacon/seed, and no American spellings.

**Import review.** The test imports `land.mjs` (which pulls in `sdk/bytes.mjs`, `lang.mjs` and `util.mjs`) and `lang.mjs`.
- None of these has side effects at import in Node: `lang.mjs` boots only `if (inBrowser)`, and localStorage access is guarded.
- `herald.mjs` is **not** imported, because it imports `sdk/frontier/resident.mjs` (a restricted name). `controller.mjs` and `app.mjs` are not imported either; they are read as text.
- No keys, signing, network, process or storage are involved.

## Gaps for the next audit (not demonstrated, not changed)

- **G1: villages and the holding come from different records.**
  - `landSummary` counts "its nation's villages there" from the envelope's `siteMirror`, but takes per-hour from the holding.
  - If the holding is newer than the envelope (a village just founded, envelope not yet refreshed), the divisor can be 0 or 1 too low for one refresh.
  - The bonus would then show 0% or too high a figure until the envelope arrives.
  - This would need a runtime trace to show. It is a timing question between the two records, not a land.mjs defect.
- **G2: the map's outlines are out of this scope.** `map/fmap.mjs` (`recordLands`, `landMarksOf` via `this.landKeys`) reads `src.landOf` each frame, but its key list and the still-layer cache depend on map invalidation. I did not check it.
- **G3: the prototype land path is separate.** `FS.proto` (`controller.mjs` `protoLand`, signatures per key) is a separate store and was not covered.

## Not verified at runtime

- No browser, world, launcher or localnet was run.
- The real interleaving of `refresh()` and the camera's province reads was not observed.
- Only the logic above was exercised with fixtures.

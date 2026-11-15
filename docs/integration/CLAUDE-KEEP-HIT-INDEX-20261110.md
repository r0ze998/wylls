# Near-view keep hit test: bucket index

Continues [CODEX-LARGE-WORLD-CHART-20261109.md](CODEX-LARGE-WORLD-CHART-20261109.md)
("near-view keep hit testing still scans all rows"). Changes the original map,
not a demo. No gameplay limit, gate, `AUTOMATIC_SEND=false` or the radius-128
constraint is changed.

## Change

- New `permutation-server/web/frontier/map/keepindex.mjs` (pure, no imports):
  `KeepHitIndex` files each keep's anchor (`KeepBoard.place(row).x/.y`, which
  does not depend on the zoom) into square buckets of `PROVINCE_CIRCUMRADIUS`
  world px; `keepHitBox` is the box round the pointer that holds every anchor
  the exact test can take (tile `0.9 R`, walls `0.95 u` across, `−0.5 u …
  1.5 u·rise` up, +1 px slack).
- `KeepBoard.at` now runs its unchanged per-row test (`keepHit`) over only the
  rows from the buckets, sorted back into the rows' own order, so the result
  and the first-wins tie order equal the full scan. `atScan` keeps the full
  scan as the reference. Non-finite zoom / tilt / point, or a box wider than
  64 cells (very far zoom), falls back to the full scan.
- Freshness: rebuilt when the book's rows Map is another one (every
  `KeepBook.read`, `reset`, sample, world change) or its size changed. Each
  query also checks its candidates are still the Map's rows at the same
  anchor and rebuilds when not. Nothing in the page changes the Map in place
  today; a caller that does must call `KeepBoard.rowsChanged()`. Two cases
  are invisible otherwise: a row moved in place into an empty box, and a row
  deleted and set again in the same Map (same row object, same size, but the
  Map order changes, and that order breaks ties).
- Fog/unknown-region rules are unchanged: `at` never applied them (callers
  do; keeps are public, `fmap.mjs` draws them on unsurveyed land).

## The real tap path: `FrontierMap.keepAt` (second step)

Scope widened explicitly to `map/fmap.mjs`. New `map/keepscreen.mjs`:

- Under the tilt the row scale is linear in screen y: with `t = tan θ / P` and
  `c` the box's middle row (client px), `k = 1 + (at.y − c)·t`. A keep that
  `keepAt` can take has `at.y ≤ Y + max(2m, 1.55·U·k)` (`U = u·z`, `m` = 12 /
  22), which bounds `k ≤ max(1 + (Y + 2m − c)t, (1 + (Y − c)t) / (1 − 1.55·U·t))`
  (needs `1.55·U·t < 1`). The press widened by `hw/up/down` at that bound holds
  every hittable foot, also off screen. Keeps beyond the horizon (`k ≤ 0`) are
  seen above `c − 1/t`; a press not clearly below that line scans everything.
  The rectangle (wholly below the horizon) goes back through `unproject`; a
  perspective map keeps it convex, so the AABB of its four corners (+1 px
  slack) holds every candidate anchor. `keepAt`'s own test then runs unchanged,
  over those rows in the rows' order.
- Full scan (`keepAtScan`'s answer) whenever: non-finite numbers; `project`,
  `unproject` or `standAt` not the prototype's; the board's `place` replaced;
  a needed method missing; `geo` not equal to `tiltGeo` for the map's
  perspective at sample points; `standAt`'s `k` at the corners not the line's;
  a corner not coming back through `project` within 0.01 px; bound or horizon
  not satisfied; more than 64 buckets; any exception in the candidate step.
- Unchanged: the 12 / 22 px minimums, tilt / `standAt`, zoom, first-wins ties,
  and the coarse chart (only `chartKeeps`' drawn marks; the index is not asked
  there, so the large-chart test's `placements === 3` is unaffected).

## Tests (written, not run here)

`permutation-gateway/test/web-frontier-keep-hit-index.test.mjs`: equality
with `atScan` over 8 zooms × 5 tilts × edge/random points; exact tie order
(synthetic integer places, since no two real keeps tie this close); delete +
reinsert in the same Map followed by `rowsChanged`;
radius 128 (49,537 rows): ≤ 8 candidates, ≤ 64 cells, one build; new reading /
removal / reset / sample; in-place replacement, row move, `rowsChanged`,
add/delete; non-finite and wide-box fallbacks; `keepHitBox`; index order,
duplicates, cell bound and rebuild rules.

`permutation-gateway/test/web-frontier-keep-at-index.test.mjs`: `keepAt` equal
to `keepAtScan` and to a verbatim copy of the old loop, flat / 26°, desktop /
phone, two client rects, fine / coarse pointer, box edges, presses off the
picture, drawn camera between views; ties; radius 128 (49,537 keeps) with few
candidates; coarse chart untouched; fallback fixtures (old minimal
project/standAt map, replaced standAt, other perspective, missing geo /
unproject, throwing geo); a brute-force check of `keepScreenRect`.

The implementer ran no shell commands, tests or browsers; every result below
was measured by the supervisor, who ran the tests under the no-key-node guard.

- Earlier runs: hit-index 7/8 (old tie fixture, since replaced); keep-at 4/5
  (inverted condition in the brute-force fixture, since fixed).
- **Final run: 22/22 passed, 0 failures, 0 guard violations**:
  keep-hit-index 8/8, keep-at-index 6/6, large-chart 8/8.
- Real tap path at radius 128: 144 presses on 49,537 keeps, at most
  **1 candidate row** each.

Not covered: no browser or whole-page run of this change, and no frame-time
measurement. Commit and integration are left to the supervisor.

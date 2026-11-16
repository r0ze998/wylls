# Ordinary PC play: move → arrive → land colour/count → production — what is checked where (Claude, 2026-11-16)

PC 1440 first (owner). "Fixture" = the real page on the keyless fixture or a blank page with the real stylesheet; "unit" =
Node; "world" = a real local TEST-ONLY chain (none run since land5). Restricted areas are not in any of these.

| step | checked by (fixture / unit) | seen in a world | gap left |
|---|---|---|---|
| choose, train, form | `first-session.screen.mjs` 2/2 (cards and words, nothing pressed) | live23–34 | — |
| march order | `first-session` (to "Send this order", not sent), `local-march-maptap` 5/5, `march-block-reasons` 16/16 (every reason once, in sight), `conquest-press` 10/10 | live29–34, land4–5 | a send that lands is world-only |
| arrival / away | `web-frontier-away-tag` (unit), ws07 `away-entry` 4, `sendstates` 2, `unread` 3, `reveal` 1, `contracts` 8, `guide-s1` 3 (2026-11-16, each alone) | live32–34 | covered 2026-11-16 by `land-arrival.screen.mjs` B (fixture replay: the village's tag says on the march · turn N, then arrived on turn N, EN/JA); `ws07-away` itself not run (wallet/session words in it) |
| land colour on the map | `web-frontier-land-marks` 7 (painter calls on land4's real records: holder fill/line, take rim + arc, fade rim) | land5 (real page, recorded) | covered 2026-11-16 by `land-arrival.screen.mjs` A (fixture replay: the map's canvases move towards the viewer's colour at the tile; card owner + take count; chip) — a real world shows it only in land5's recording |
| land count | chip unit tests: home line (`landSummary`), far land (`landElsewhere`, c46b6768) | land5 (home line only) | far-land part not yet seen in a world |
| production | `web-frontier-economy-display` 10/10 (strip, harvest, promotion vs Rust tables), chip yield per hour (7e2ecdb9, `landYieldPerHour` = `yield_for`) | — | the credited amount against the stores (land doc item 2) and the chip figure in a world |

Done in this round: the chip's per-hour figure (the strip's rates do not include the land yield, so the chip now says it).
Both fixture gaps above are now covered by `land-arrival.screen.mjs` (4/4, EN/JA @ 1440). What remains is world-only: a send that
lands, the credited land yield against the stores, the far-land part and the per-hour figure seen in a world.

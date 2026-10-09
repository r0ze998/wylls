# The nations' colours in the baked art

Since 2026-10-09 the six nations wear the colours of their leaders' clothes: Aster red `#cc303b`, Borealis sky cyan `#31bedb`, Cinder yellow `#eac21b`, Dunmar purple `#a34cd8`, Ember white `#edeee7`, Fjordal orange `#f19232` (`permutation-server/web/frontier/palette.mjs`, which also holds each nation's trim, tint, ink and the two mark colours). Everything the client draws by code reads that table. The change awaits the owner's yes (`docs/frontier/DECISIONS.md` ZL3, which also says how to go back).

Ember's white needs one more column. White on the chart's parchment is nothing (1.2:1, no hue of its own), so what is laid on parchment for a nation (the wash and line of its home wedge) takes `NATION_LAND`: the cloth's colour for five nations, a blue slate `#58727e` for Ember, whose border keeps a white core. White stays for cloth, roofs and the wash over painted land.

The sprites that were baked in the earlier colours (red, teal, ochre, purple, blue, magenta) were repainted, not rendered again:

| Set | Files | Bytes before | Bytes after |
|---|---:|---:|---:|
| `art/units` (the sheets at two sizes, the cards) | 60 | 3,836,408 | 3,944,564 |
| `art/specials` (`seat_`, `relic_`, `waystone_` of each nation) | 54 | 170,444 | 165,112 |
| `art/holdings` (the villages of the far bitmaps) | 126 | 641,312 | 587,974 |
| `art/factions` (washes and borders) | 342 | 311,186 | 308,148 |
| total | 582 | 4,959,350 | 5,005,798 |

`_src/recolour_nations.mjs` did it: a pixel near the nation's old hue, saturated enough to be dyed cloth or paint, moves to the new hue, saturation and lightness (Ember's blue becomes an off-white with grey shade); skin, wood, leather, steel, the grass base and shadows keep their colours. The files were encoded again with `cwebp` at the settings of the art's own exports. The script starts from the old colours, so it must not be run over its own output.

`art/hosts` (the earlier host figures) is not drawn by the client any more and was left alone.

A fresh render takes the new colours from its own source: `units/_src/units3d.py` `FILL` and `DARK` now carry them. The tile pipeline that made the seats, relics, waystones, washes and borders lives on another branch (`codex/frontier`, `docs/frontier/art/tiles/_src`) and still carries the earlier colours.

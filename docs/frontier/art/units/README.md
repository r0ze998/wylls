# Units as painted miniatures (style A)

Design session of 2026-10-02. The owner's verdict on the canvas figures and the flat portraits: "the silhouettes and the touch do not fit the world". The map is a 2.5D diorama rendered in Blender (`docs/frontier/art/tiles`, branch `codex/frontier`). The units now come out of the same pipeline:

- **Cycles**, with the tiles' settings: the same world light (0.42), the same sun (2.7, 2.5°, warm, direction (0.55, 0.5, −1)) and the same grade.
- **The map camera's elevation** (asin 0.76), orthographic, so shadows fall where the tiles' shadows fall.
- **Vertex-colour materials with AO and fine noise**, like the tiles' `build` and `cloth`. There are new roles for skin, fabric, leather, metal, mail, sculpted hair, wood, a varnished paint and the base.

The figures are stocky tabletop miniatures, about 4.5 heads tall, each on a low earth-and-grass base with the faction's colour on its rim.

## The six peoples (the faces' culture)

| Faction | Mark | Headgear and dress |
|---|---|---|
| 0 Aster (Wardens of Stone) | red-ochre keystone on the brow, painted on the helm when one is worn | kettle helm with brim and nasal, pauldrons, red tabard with the gold keystone |
| 1 Borealis (Tide) | two wave lines on the cheek | leather sea cap with teal band and brass rim, a gull feather for riders; shell-bead necklace, braids |
| 2 Cinder (Flame) | soot band across the eyes, an ember dot on the chin | bronze helm with cheek guards and a red horsehair crest; lamellar; flame-shaped topknot |
| 3 Dunmar (Verdant) | dotted bridge and leaf marks on the cheeks | leaf-edged hood, twig circlet with antler tines, leaf mantle, full beards |
| 4 Ember (Lumen) | compass star on the temple | surveyor's felt cap with brass rim and goggles, robe with gold trim, brass compass |
| 5 Fjordal (Iron) | iron-grey stripes under the eyes | spectacle helm with mail aventail, fur collar, braided beard with iron rings |

Unit types read by silhouette:

- spearman: spear and round shield painted with the people's sign
- archer: bow and quiver, hooded
- horseman: stocky cob and a raised sabre
- pikeman: long pike
- crossbowman: crossbow
- knight: barded horse, plate and a lance in the faction's colour, heater shield
- scout: cloak and staff
- settler: bundle and spade

## Outputs (`permutation-server/web/frontier/art/units/`)

| File | Contents |
|---|---|
| `@1x/units_<f>.webp`, `@2x/units_<f>.webp` | One sheet per people. Rows are the 8 unit types (`MINI_KINDS`). Columns are face +1 then face −1, each × (standing, step A, step B). Cells are 160 px (@1x) and 320 px (@2x), 2.0 figure units square, with the feet at (0.42, 0.74) of the cell. Each cell includes the base and its cast shadow. |
| `cards/<f>_<kind>.webp` | The unit portrait: the miniature on its base, photographed a little from above (240 × 300). |

`people/minis.mjs` draws the sheets: `paintMini`, with the gold ring for the viewer's own tokens, and `miniCardUrl` for the cards. `units.mjs` (`paintToken`) and `battle.mjs` fall back to the canvas figures until a sheet has loaded.

## Rebuild

```bash
cd docs/frontier/art/units/_src
blender -b --factory-startup --python units3d.py -- atlas 32        # the sheets (PNG, ../out)
blender -b --factory-startup --python units3d.py -- cards 48        # the cards
./export.sh                                                         # WebP into permutation-server/web/frontier/art/units
```

The command takes Blender 5.2 and about 15 minutes on an M-series GPU. `_src/common.py` and `_src/render_a.py` are copies of the tile pipeline's helpers from `codex/frontier` at `docs/frontier/art/tiles/_src`, so this folder builds on its own branch.

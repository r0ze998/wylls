# art: the handover pack (2026-10-10) in the client

This file records what of the owner's handover pack is in this folder, where each file came from, and what was done to it. The older families of this folder (terrain, holdings, rivers, the first leader pack, the first unit sheets) are described in `docs/frontier/art/`.

**Source.** `Wylls-Claude-Handoff`, the pack the owner prepared on 2026-10-10 (`Claude実装引き継ぎ_20261010/展開済み/Wylls-Claude-Handoff` on the owner's desktop; its own file list with SHA-256 is `ファイル一覧.json`, its instructions `00_案内/実装指示.md`). Brought in on 2026-10-11 on branch `frontier/uxs-art`.

**Where it shows.** Only where the season runs the conquest program (`art/pack.mjs artPackOn`: layout 2, program version 3 or more). The basic game, the sample world and tests without a season draw the earlier art. `?art=off` in the address shows the earlier art on a conquest season too; `?fx=…&art=on` shows the pack on any page under the demo tag.

## What is here

| Family | Files here | From (in the pack) | Treatment | Drawn by |
|---|---|---|---|---|
| Soldiers, 8 kinds × 6 nations, sheets | `units/mobs-v1/@1x/units_<0..5>.webp` (960 × 1280, cells of 160 px), `units/mobs-v1/@2x/units_<0..5>.webp` (1920 × 2560, cells of 320 px) | `03_モブ8種6陣営/atlas/faction-<0..5>@1x.webp`, `…@2x.webp` | copied byte for byte, renamed to this client's sheet names | `people/minis.mjs` `paintMini` (the one host painter) |
| Soldiers, cards | `units/mobs-v1/cards/<0..5>_<kind>.webp` (240 × 300), 48 files | `03_モブ8種6陣営/cards/*.webp` | copied byte for byte | `people/minis.mjs` `miniCardUrl` |
| Icons: 8 resources (v3) | `ui/illustrated/{food,wood,stone,ore,horse,gold,science,influence}-{32,64,128}.webp` | `05_UIアイコン13種/01_資源_v3/png/<key>-<size>.png` | PNG to WebP: `cwebp -q 92 -alpha_q 100 -m 6 -sharp_yuv` | `hud/icons.mjs` `icon`, `artIcon`, `resourceIcon`; sizes in `art/art.css` |
| Icons: 5 states (v1) | `ui/illustrated/{troops,stamina,walls,works,territory}-{32,64,128}.webp` | `05_UIアイコン13種/02_機能・状態_v1/png/<key>-<size>.png` | the same | the same |
| Effects: 6 uses, 11 clips | `vfx/first-v1/<effect>/<variant>/atlas-128.webp`, `atlas-256.webp` (8 columns, 24 frames a second); effects `select`, `depart`, `impact`, `hit`, `build_complete` (variant `neutral`) and `capture` (variants `aster` … `fjordal`) | `07_エフェクト6種/clips/<effect>/<variant>/atlas-128.png`, `atlas-256.png` | PNG to WebP: `cwebp -q 86 -alpha_q 100 -m 6` (alpha kept lossless) | `fx/sheetfx.mjs` (frame counts, lengths and anchors from each clip's `clip.json`) |
| Characters: idle, attack, hit, victory | `leaders3d/motion-v2/sprite/<key>_{idle,attack,hit,victory}.webp` (rows of 256 px frames: 4, 8, 4, 12) | `01_リーダー最新版/sprite/<key>_<motion>.webp` | copied byte for byte | `people/leader-motion.mjs` through `leader-motion-data.mjs` |
| Characters: walk | `leaders3d/motion-v2/sprite/<key>_walk.webp` (8 frames of 256 px) | `02_歩行最新版/<key>_walk.webp` (Aster: `Walk_Kimodo`, the corrected walk; the other five: `Walk`, as the pack's `歩行対応表.json` says) | copied byte for byte | the same |
| Characters: the same clips at 512 px | `leaders3d/motion-v2/sprite@2x/<key>_{idle,walk,attack,hit,victory}.webp` (idle 8 frames, walk 8, attack 8, hit 4, victory 12) | NOT in the pack. Rendered from the pack's models (`01_リーダー最新版/models/<key>.glb`) by the other tool's session on 2026-10-10 with the pack's own render recipe at 512 px, WebP q60 with lossless alpha; its record is `docs/frontier/art/leaders3d/latest-design-audit.json` in that session's working tree (`wylls-territory`, uncommitted there). Copied here byte for byte from that tree's `art/leaders3d/motion-v1/sprite@2x/`. The five walks other than Aster's are the earlier 512 px renders of `Walk`. | none here | the same (a figure drawn 205 device px wide or more asks for this set) |

Not brought in (left for a later pass): the terrain v2 set, the tile motion sheets, the extra-tile prototypes and the building boards (design boards, not game assets); the `.glb` and `.blend` models; the single effect frames, posters and previews; the 24, 48 and 256 px icon sizes; the 1254 px hexagon icons (their 128 px reductions were already here as `leaders3d/hex-v1/`).

## Sizes

| Folder | Files | Bytes |
|---|---:|---:|
| `units/mobs-v1/@1x` | 6 | 1,367,064 |
| `units/mobs-v1/@2x` | 6 | 3,967,500 |
| `units/mobs-v1/cards` | 48 | 1,061,238 |
| `ui/illustrated` | 39 | 156,412 |
| `vfx/first-v1` | 22 | 983,292 |
| `leaders3d/motion-v2/sprite` | 30 | 1,782,868 |
| `leaders3d/motion-v2/sprite@2x` | 30 | 1,350,710 |
| **added by the pack** | **181** | **10,669,084** |

The folder was 20,653,659 bytes before and is about 31.3 MB with the pack. The brief's old aim of 3 MB for the characters' folder cannot hold with two motion packs on disk (the first one stays for the basic game); `permutation-gateway/test/web-frontier-art-pack.test.mjs` pins the new totals.

Nothing of the pack is fetched before something draws it: a sheet of soldiers when a host of that nation is on screen (the 160 px sheet, about 0.22 MB; the 320 px one only when a figure is drawn larger than 150 device px, as in a staged battle), a character's sheet when that character is drawn, an effect's atlas the first time the effect plays, the icons of the resource strip with the strip (five files of about 1.3 kB each) and `art/art.css` with the first icon.

## Licences

The pack's own licence texts are in its `09_生成元とライセンス` (the models' generator Hunyuan3D-2, the Kimodo checkpoint under the NVIDIA Open Model licence, the Kimodo code under Apache-2.0, Three under MIT, the Wylls code under MIT). The pack says not to label all assets MIT; this folder labels none of them. The texts themselves are not copied into the client.

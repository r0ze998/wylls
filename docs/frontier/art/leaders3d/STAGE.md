# The six leaders in the play client

What `permutation-server/web/frontier/art/leaders3d/` holds, where each file came from, and how the two sets that were made here were made. Written 2026-10-09 on branch `frontier/ux-leaders`. (The other line of work, branch `codex/first-village`, keeps its own notes about the 3D models and its preview pages; this file is about the play client only.)

| Folder | Files | Bytes | Source | Used by |
|---|---|---:|---|---|
| `motion-v1/sprite/` | 24: `<key>_{idle,walk,attack,hit}.webp`, frames of 256 × 256 in a row (4, 8, 8, 4) | 1,135,426 | the owner's package "6人の動き", **byte for byte** (the test pins the digest) | the map painter `people/leader-motion.mjs`, which only the demo `?fx=leaders` uses |
| `stage-v1/` | 6 stills `<key>.webp` (288 × 360), 6 sheets `<key>_idle.webp` (4 frames of 288 × 360 in a row) and 6 sheets `<key>_attack.webp` (8 frames) | 99,100 + 290,304 + 656,676 | **rendered here** from the package's `models/<key>.blend` (see below) | `leaderFigure`: the title, the nation choice, the first-village banner, the report's quotation, the wait view |
| `portrait-v1/` | 6: `<key>.webp`, 320 × 320, transparent | 112,518 | `01_リーダー最新版.zip`, `previews/<key>-portrait.png` (900 × 900), reduced | `leaderSvg` above 64 px (the portrait card) |
| `hex-v1/` | 6: `<key>@128.webp` | 47,900 | `リーダー六角形アイコン/<key>.png` (1254 × 1254), reduced | `leaderSvg` up to 64 px, `leaderHex`: the crest chip, standings, the versus band, the inspector, a phone's banners |

Keys, in faction order: `aster` (red), `borealis` (sky cyan), `cinder` (yellow), `dunmar` (purple), `ember` (white), `fjordal` (orange). Total 2,341,924 bytes (2.34 MB; the aim was under 3 MB). Nothing is fetched before a screen shows it: a first visit's title needs the six stills (99 KB) and then, where motion is allowed, the six idle sheets (290 KB), which are asked for only after the stills have come; an attack sheet (105 to 114 KB) comes when its banner is looked at or its nation chosen; the map sprites only under `?fx=leaders`.

Why the map sprites are in the client although no screen of normal play asks for them (1,135,426 bytes on disk, none on the wire): they are the owner's package as delivered, the painter that draws them (`people/leader-motion.mjs`) is ported and tested, and the other line of work keeps them at the same path. They are there for the day the game has a leader on the map, or the battle staging is given one; until then only the demo switch reads them. If that day does not come they can be removed with the painter in one commit.

Removed on 2026-10-09 after review: the 256 px icons (`hex-v1/<key>@256.webp`, 117,282 bytes), which no screen asked for (the icon is never shown above 64 px; the portrait card takes over there), and half of each idle sheet (8 frames to 4: between its two most different frames the breath moves 1 to 2% of the pixels).

The `.glb` and `.blend` models are **not** in the client: the redesign has no 3D viewer.

## Why there is a stage set

The package's sprites are rendered from the game's overhead view (the head turned up 36 degrees so the face shows on the map). At that angle a figure is about 105 px tall in its 256 px frame and looks at the ground: right for a tile, weak for a title or a banner, where the leader should face the player. The package also ships the rigged models with the four clips, and its own render script with the lights. The stage set is the same models and clips seen from the front: the leaders' real geometry, materials, lights and motion, another camera.

## How the stage set was rendered

`_src/stage_render.py` (Blender 5.2, headless). It opens `models/<key>.blend`, never saves it, removes cameras and lights, and sets up what the package's `source/render_motion.py` sets up for its review renders: Eevee, 32 samples, no ray tracing, transparent film, the Standard view transform, the world colour (0.5, 0.6, 0.8) at 0.42, a warm sun from the upper left (energy 2.7, angle 8 degrees), a soft area light in front of the face (190 W) and a quiet rim behind the hair (140 W). Then an orthographic camera:

```
blender -b --python stage_render.py -- <models dir> <frames dir> aster,borealis,cinder,dunmar,ember,fjordal idle:8,attack:8 0.4 576 720 2.1 0.98 32 8
```

* the model turned 0.4 rad about the vertical (a three-quarter view: the thrust of the attack clip reads; from straight in front it points at the camera);
* the camera 8 degrees above level, 2.1 m of height in the frame, centred 0.98 m up: a figure of 1.85 m is 88% of the frame's height, its feet at 98.5% (`STAGE_FOOT` in `people/leader-art.mjs`);
* frames of 576 × 720, reduced to 288 × 360 (so every edge is supersampled once more);
* `idle`: rendered as 8 frames across the 2 s loop (the end frame, equal to the first, is left out); the sheet takes every second one (4 frames, as the package's own idle sprite has); `attack`: 8 frames across the 0.8 s clip, both ends included (it starts and ends in the stance). The same sampling as `leader-motion-data.mjs motionSpriteFrame`, which the page uses to choose a frame.

`_src/stage_sheets.mjs` puts the frames in a row and encodes everything as lossy WebP with alpha in Chromium (quality 0.80 for the sheets, 0.84 to 0.88 for the single pictures). It is a tidied copy of the tool the files were made with.

To add a clip (for example `hit`): render it with `…,hit:4`, add it to `CLIPS` in the sheet script and to `STAGE_CLIPS` in `people/leader-art.mjs`, and extend `figurePose` in `people/leader-sprite.mjs`.

## What the art does not decide

The leaders' names, titles and lines are unchanged (`people/leaders.mjs LEADERS`; the lines are in `hud/milestones.mjs`, `screens/report.mjs`, `map/waitview.mjs`). They were written for the earlier portraits. Three of the six characters now read as a different person from the name they carry: "Sedra Ashfane" (Cinder) is a grey-bearded man in plate, "Brannoc Elm, chief warden of the Verdant" (Dunmar) a young hooded woman, "Torvald Hride, Jarl" (Fjordal) a long-haired youth. The doctrine words sit oddly on the new colours too ("Verdant" on purple, "Flame" on yellow). Names, titles and doctrine words are the owner's to change (`docs/frontier/DECISIONS.md` ZL5); until that is answered the screens that name a leader are not final.

A figure is never mirrored: Aster's badge, Cinder's clasp and Ember's emblem sit on one side, as the models have them. The icon is not shown below 30 px, where the face no longer reads.

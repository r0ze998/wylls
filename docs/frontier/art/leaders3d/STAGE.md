# The six leaders in the play client

What `permutation-server/web/frontier/art/leaders3d/` holds, where each file came from, and how the two sets that were made here were made. Written 2026-10-09 on branch `frontier/ux-leaders`. (The other line of work, branch `codex/first-village`, keeps its own notes about the 3D models and its preview pages; this file is about the play client only.)

| Folder | Files | Bytes | Source | Used by |
|---|---|---:|---|---|
| `motion-v1/sprite/` | 24: `<key>_{idle,walk,attack,hit}.webp`, frames of 256 × 256 in a row (4, 8, 8, 4) | 1,135,426 | the owner's package "6人の動き", **byte for byte** (the test pins the digest) | the map painter `people/leader-motion.mjs`, which only the demo `?fx=leaders` uses |
| `stage-v1/` | 6 stills `<key>.webp` (288 × 360) and 12 sheets `<key>_{idle,attack}.webp` (8 frames of 288 × 360 in a row) | 99,100 + 547,102 + 656,676 | **rendered here** from the package's `models/<key>.blend` (see below) | `leaderFigure`: the title, the nation choice, the first-village banner, the report's quotation, the wait view |
| `portrait-v1/` | 6: `<key>.webp`, 320 × 320, transparent | 112,518 | `01_リーダー最新版.zip`, `previews/<key>-portrait.png` (900 × 900), reduced | `leaderSvg` above 64 px (the portrait card) |
| `hex-v1/` | 12: `<key>@128.webp`, `<key>@256.webp` | 47,900 + 117,282 | `リーダー六角形アイコン/<key>.png` (1254 × 1254), reduced | `leaderSvg` up to 64 px, `leaderHex`: the crest chip, standings, the versus band, the inspector, a phone's banners |

Keys, in faction order: `aster` (red), `borealis` (sky cyan), `cinder` (yellow), `dunmar` (purple), `ember` (white), `fjordal` (orange). Total 2,716,004 bytes (2.72 MB). Nothing is fetched before a screen shows it: a first visit's title needs the six stills (99 KB) and, where motion is allowed, the six idle sheets (547 KB); the attack sheets come when a nation is chosen; the map sprites only under `?fx=leaders`.

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
* `idle`: 8 frames across the 2 s loop (the end frame, equal to the first, is left out); `attack`: 8 frames across the 0.8 s clip, both ends included (it starts and ends in the stance). The same sampling as `leader-motion-data.mjs motionSpriteFrame`, which the page uses to choose a frame.

`_src/stage_sheets.mjs` puts the frames in a row and encodes everything as lossy WebP with alpha in Chromium (quality 0.80 for the sheets, 0.84 to 0.88 for the single pictures). It is a tidied copy of the tool the files were made with.

To add a clip (for example `hit`): render it with `…,hit:4`, add it to `CLIPS` in the sheet script and to `STAGE_CLIPS` in `people/leader-art.mjs`, and extend `figurePose` in `people/leader-sprite.mjs`.

## What the art does not decide

The leaders' names, titles and lines are unchanged (`people/leaders.mjs LEADERS`; the lines are in `hud/milestones.mjs`, `screens/report.mjs`, `map/waitview.mjs`). They were written for the earlier portraits. Three of the six characters now read as a different person from the name they carry (see the track's report); names are the owner's to change.

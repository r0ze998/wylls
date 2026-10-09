# The six leaders in the play client

What `permutation-server/web/frontier/art/leaders3d/` holds, where each file came from, and how the two sets that were made here were made. Written 2026-10-09 on branch `frontier/ux-leaders`. (The other line of work, branch `codex/first-village`, keeps its own notes about the 3D models and its preview pages; this file is about the play client only.)

| Folder | Files | Bytes | Source | Used by |
|---|---|---:|---|---|
| `motion-v1/sprite/` | 24: `<key>_{idle,walk,attack,hit}.webp`, frames of 256 × 256 in a row (4, 8, 8, 4) | 1,135,426 | the owner's package "6人の動き", **byte for byte** (the test pins the digest) | the map painter `people/leader-motion.mjs`, which only the demo `?fx=leaders` uses |
| `motion-v1/sprite@2x/` | 24: the same names, frames of 512 × 512 in a row (8, 8, 8, 4: the idle has eight) | 1,014,998 | **rendered on 2026-10-10 by the package's own script from the package's own models** (see "The sharp set of the map sheets" below) | the same painter, for a character drawn 205 device px wide or more (`leaderMotionPick`): beside a village, in the wait view, at the landing, in a battle scene |
| `stage-v1/` | 6 stills `<key>.webp` (288 × 360), 6 sheets `<key>_idle.webp` (4 frames of 288 × 360 in a row) and 6 sheets `<key>_attack.webp` (8 frames) | 99,100 + 290,304 + 656,676 | **rendered here** from the package's `models/<key>.blend` (see below) | `leaderFigure`: the title, the nation choice, the first-village banner, the report's quotation, the wait view |
| `portrait-v1/` | 6: `<key>.webp`, 320 × 320, transparent | 112,518 | `01_リーダー最新版.zip`, `previews/<key>-portrait.png` (900 × 900), reduced | `leaderSvg` above 64 px (the portrait card) |
| `hex-v1/` | 6: `<key>@128.webp` | 47,900 | `リーダー六角形アイコン/<key>.png` (1254 × 1254), reduced | `leaderSvg` up to 64 px, `leaderHex`: the crest chip, standings, the versus band, the inspector, a phone's banners |

Keys, in faction order: `aster` (red), `borealis` (sky cyan), `cinder` (yellow), `dunmar` (purple), `ember` (white), `fjordal` (orange). Total 3,356,922 bytes (3.36 MB) since 2026-10-10; it was 2,341,924 before the sharp set of the map sheets, and the aim, under 3 MB then, is 3.5 MB now (DECISIONS ZQ3). Nothing is fetched before a screen shows it: a first visit's title needs the six stills (99 KB) and then, where motion is allowed, the six idle sheets (290 KB), which are asked for only after the stills have come; an attack sheet (105 to 114 KB) comes when its banner is looked at or its nation chosen; the map sprites only under `?fx=leaders`.

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

## The sharp set of the map sheets (2026-10-10)

**Why.** On 2026-10-10 the owner decided that the character beside the village is to be larger (DECISIONS ZQ1). It is now drawn about 82 px tall at the hero frame of a 1440 screen and about 146 px in a battle the camera is sent to: twice that many device px on a dense screen. A frame of the package's sheets holds a figure of about 105 px, so it would be enlarged up to nearly three times, and soft. The package ships the models and the script its sheets were rendered with; the sharp set is that script's own larger picture of the same frames.

**What the package's script already does.** `source/render_motion.py` (mode `render`) renders, for every leader and clip, three views with the same lights: a front review, a "map" review and the "map" sprite cell. The two map views share everything but the pixel size: the orthographic camera (elevation asin 0.76, scale 2.0, shifted so that the feet stand at 0.5, 0.76 of the frame), the model's wrapper (scale 0.95 / 1.85, turned 0.55 rad), the head pitch of 36 degrees, 24 samples. The sprite cell is 256 px (what the package's sheets were assembled from); the review frame is 512 px. The script samples the review at `round(duration × --review-fps)` frames, a loop at i / count of its length and a one-shot at i / (count − 1): exactly as it samples the sprite, with another count.

**What was run.** The script unmodified, read from the package, four times, with the `--review-fps` that makes the review's frames land on a sheet's instants, writing only under a scratch folder (`--output`):

```
blender -b --python "<package>/source/render_motion.py" -- render --models "<package>/models" --output <work> --clips idle   --review-fps 4    # 2 s × 4 = 8 frames (the package's sheet: every second one)
blender -b --python "<package>/source/render_motion.py" -- render --models "<package>/models" --output <work> --clips walk   --review-fps 8    # 1 s × 8 = 8 frames
blender -b --python "<package>/source/render_motion.py" -- render --models "<package>/models" --output <work> --clips attack --review-fps 10   # 0.8 s × 10 = 8 frames
blender -b --python "<package>/source/render_motion.py" -- render --models "<package>/models" --output <work> --clips hit    --review-fps 7    # 0.55 s × 7 = 3.85, rounded: 4 frames
```

Blender 5.2.2 (the script asks for `BLENDER_EEVEE`). The package is opened and never saved; the script itself checks each model's digest before and after, and the digests of all 62 files of the package were taken before and after the runs and are equal. `_src/motion_sheets_2x.mjs render <package> <work>` runs these four lines.

**Assembly.** `_src/motion_sheets_2x.mjs assemble <work> <…/art/leaders3d/motion-v1/sprite@2x> 75` puts `<work>/renders/<key>/<clip>/map/frame-NNN.png` in a row (ffmpeg `hstack`, no resampling) and encodes each row as lossy WebP with a lossless alpha plane (`cwebp -q 75 -m 6 -alpha_q 100 -sharp_yuv`). 24 files, 1,014,998 bytes: an idle sheet 37 to 42 KB, a walk sheet 49 to 55 KB, an attack sheet 50 to 54 KB, a hit sheet 24 to 26 KB. (Lossless they are 3.76 MB; at quality 60 0.92 MB, at 90 1.57 MB. At 60, 70, 80 and 90 no difference to the lossless row was seen in a picture at one and a half times the size; 75 is the middle.) The files are pinned by a digest in `web-frontier-leader-art.test.mjs`: a new render differs in its noise and needs the digest and the byte counts updated.

**The proof that they are the package's pictures.** `_src/motion_sheets_2x.mjs compare <work> <package>/sprite` (144 frames: every frame of the package's 24 sheets; the mean difference of premultiplied RGBA, of 255, over the pixels either picture covers):

| Compared with the package's 256 px frame | Mean | Worst frame | Largest | Pixels off by more than 8 |
|---|---:|---:|---:|---:|
| the 256 px cell this run rendered (the same script, this machine: the noise floor) | 0.52 | 0.72 | 24 | 0.7% |
| the 512 px frame halved (a 2 × 2 box in linear light) | 3.2 | 3.6 | 58.5 | 26% |
| both reduced to 64 px | 0.89 | 1.13 | 10.3 | 0.06% |
| the next 512 px frame of the clip, at 64 px (another pose) | idle 0.96, walk 7.5, attack 8.9, hit 13.1 | | | |

The outline's area differs by 0.02%. So a halved 2x frame has the package frame's pose, outline and light; it is not the package's frame pixel for pixel, because the 512 px render resolves the models' textures one level finer than the 256 px render does (the difference is in the fine detail and falls to the noise as both are reduced). That finer detail is what the set is for.

**What the Idle clip holds.** Across its 2 s no figure's outline moves by a whole pixel of a 512 px frame (the head's top row is the same in all eight frames for four of the six, and moves one row for Ember and Fjordal), 0.2 to 1.1% of a figure's pixels change, and the fifth frame is the first again (the clip breathes twice in its 2 s). The eight frames are in the sheet because they are the clip; they do not make a standing figure read as alive, and the play client adds a small breath of its own to a standing figure for that (DECISIONS ZQ4; `leader-motion-data.mjs LEADER_BREATH`). A livelier idle is an Idle clip with more motion in it.

**Which set a screen fetches.** The painter asks for the set the size on the device calls for: the 2x set when the cell is drawn 205 device px wide or more (four fifths of a 1x frame's own size), the 1x set below. A finer sheet that has been asked for serves a smaller figure too, so one figure fetches one sheet. At the hero frame a cell is about 210 px wide on a plain screen and 400 on a dense one, so a player with a village fetches the viewer's 2x idle sheet and nothing else of this folder; the 1x sheets are fetched where a figure is first drawn small (the demo `?fx=leaders`, a far view of the wait) and as the stand-in if a 2x sheet fails.

## What the art does not decide

**Since the owner's decision of 2026-10-09 (DECISIONS ZP1 to ZP3) the six are the players, and there are no leader names or titles:** `LEADERS` is gone (`people/leaders.mjs CHARACTERS` lists the six by nation), the lines in `hud/milestones.mjs`, `screens/report.mjs` and `map/waitview.mjs` are the nation's words with no named speaker, and the doctrine words are unchanged. The package's map sheets (`motion-v1/sprite`, 24 files) are now used in normal play: the idle sheet for a player's character beside that player's village, the walk sheet at the first village's landing (`people/onboard.mjs`), and the idle, attack and hit sheets for the two sides' players in a battle scene (`people/battle.mjs`). They are fetched lazily: one nation's idle sheet (about 25 KB) for the viewer, a walk sheet (about 66 KB) only when a landing is on its way, three sheets a nation (about 120 KB) when a battle is staged. (Since 2026-10-10 these figures are drawn larger and from the 2x set, see above: 37 to 42 KB, 49 to 55 KB and 111 to 122 KB.) (Before that decision this paragraph recorded that the names and titles were unchanged, written for the earlier portraits, and that three no longer fitted the face beside them; ZL5 asked the owner, and ZP3 is the answer.)

A figure is never mirrored: Aster's badge, Cinder's clasp and Ember's emblem sit on one side, as the models have them. The icon is not shown below 30 px, where the face no longer reads.

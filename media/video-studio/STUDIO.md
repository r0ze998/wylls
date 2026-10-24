# Wylls video studio: guide for scene authors

Videos are written as code (HTML, Canvas, SVG, Three.js) and rendered frame by frame. Read this file, [PLAN.md](PLAN.md) and [FACTS.md](FACTS.md) before writing a scene.

## Files

```
media/video-studio/
  lib/wy.css        fonts (Noto Sans/Serif JP, Cinzel, Cormorant Garamond, Inter, JetBrains Mono), brand tokens, panels, pills
  lib/wy.js         runtime: WY.scene, virtual clock, easing, text split/reveal, nations, sigils, crests, logo, sprites
  lib/wy-audio.js   procedural score (A.music) and SFX (whoosh, hit, boom, drum, tick, chime, sparkle, riser, swell, seal, lock, coin, glitch, ok, bad, march, clash, drone, type, click, pop, note)
  lib/wy-map.js     WYMap: isometric hex world from the game's own tile art (terrain, villages, keeps, camps, fog), marches, seals, clashes
  lib/wy-kit.js     WYKit: endCard, status badge, subtitles, dust, flash
  lib/vendor/       three.module.min.js (0.160), gsap.min.js (3.12.5)
  scenes/NN-slug/index.html   one video each (+ optional local .js/.css and STORYBOARD.md)
  render.mjs        renderer
  assets/ui/        screenshots of the real web client (see assets/ui/INDEX.md when it exists)
  out/              renders (not committed)
```

Do **not** edit `lib/*` (other authors render with it at the same time). Put helpers in your scene folder. If `lib` has a bug that blocks you, work around it locally and say so in your report.

## A scene

```html
<!doctype html><html><head><meta charset="utf-8"><title>05 six nations</title>
<link rel="stylesheet" href="../../lib/wy.css">
<script src="../../lib/wy.js"></script><script src="../../lib/wy-audio.js"></script>
<script src="../../lib/wy-map.js"></script><script src="../../lib/wy-kit.js"></script>
</head><body><script>
WY.scene({
  width: 1920, height: 1080, duration: 60, fps: 60,
  setup(stage) { /* build DOM, canvases; WY.img(...) preloads */ },
  render(t) { /* set every visual property from t; same t => same frame */ },
  audio(A) { A.music({ style: 'heroic', bpm: 96, key: 'D', sections: [[0,.3],[8,.8]], end: 56, outro: 'hit' }); A.whoosh(1.2); A.hit(8); }
});
</script></body></html>
```

- **render(t) must be a pure function of t.** Frames are rendered out of order when stills are taken. Don't accumulate state across calls (no `x += v`); compute from t. Don't use Date/performance/setTimeout for animation. `Math.random` is seeded in render mode but use `WY.rng(seed)` in setup for stable layouts.
- Three.js: `import * as THREE from '../../lib/vendor/three.module.min.js'` in a `<script type="module">`, create the renderer with `preserveDrawingBuffer: true`, and call `renderer.render()` inside `render(t)`. Software GL is slow: keep geometry modest, and use 30 fps for heavy 3D scenes.
- GSAP: build a timeline with `gsap.timeline({ paused: true })` and assign it to `WY.tl`; the runtime seeks it.
- Images: `WY.img(WY.ART + 'leaders3d/stage-v1/aster.webp')` (WY.ART points at `permutation-server/web/frontier/art/`); repo files via `WY.REPO + 'docs/img/wylls-world.png'`.
- Leaders: `const L = WY.leader('aster', 'victory'); L.draw(ctx, L.frameAt(t, 12, false), cx, baseY, size)`. Clips: idle 8, walk 8, attack 8, hit 4, victory 12 frames at 512 px. The figure fills only the middle of the frame, so draw it large (size 700–1100 px) for a hero shot. `leaders3d/stage-v1/<key>.webp` (288×360 front-facing still) and `portrait-v1/<key>.webp` (320×320 bust) are the best-looking stills.
- Nations: `WY.NATIONS[i]` has `en, fill, dark, light, deep, ink, on, mark, land`; `WY.crest(i, px)` returns the shield SVG; `WY.sigilPath(i, r)` returns a path. The order is Aster, Borealis, Cinder, Dunmar, Ember, Fjordal.
- Map: `const w = WYMap.build({ rings: 8, seed: 11 })`, then `WYMap.draw(ctx, w, { x, y, zoom, W, H }, { t, appear: tile => 0..1, fog: tile => 0..1, wash, owner })`. `w.keeps` holds one keep per nation (`.owner`). Also `WYMap.drawMarch(ctx, cam, a, b, k, { sealed, color })`, `drawSeal`, `drawClash`, `toScreen`. Zoom 0.4–0.5 shows the whole world; 1.0–1.6 is a close-up.

## Render and review (do this loop at least twice per video)

```sh
cd media/video-studio
node render.mjs scenes/NN-slug --sheet 16          # contact sheet: out/stills/NN-slug-sheet.jpg
node render.mjs scenes/NN-slug --stills 3.2,11,24  # exact frames: out/stills/NN-slug/t3.20.png
node render.mjs scenes/NN-slug                     # final: out/NN-slug.mp4 (waits for a free render slot)
```

Look at the sheet and the stills with the Read tool and critique them as a picky motion designer would: overlaps, text cut off by the frame, text too small to read on a phone, empty or dead frames, inconsistent margins, muddy contrast, unreadable Japanese line breaks, timing that is too fast to read. Fix them and look again. Check the start (t = 0.0) and the last frame as well. A final render takes several minutes; render the final only after the stills look right. After the final render, run `ffprobe` on the file and check its duration and stream list.

## Quality bar

The bar is the best "made with Opus 5.5" motion pieces: designed, not slideshow.

- **Always moving.** Nothing sits fully still for more than about 1.5 s: use a slow camera push or drift (`WY.drift`), parallax layers, breathing light or dust. Use real easing (`outExpo`, `outQuint`, `inOutCubic`, `outBack` for pops) and never linear tweens for UI.
- **Transitions with intent:** match cuts, wipes along a march path, the seal stamp as a cut point, hex-tile dissolves, a whip-pan with motion blur, light flashes on hits. Put audio hits on the cuts (`A.hit`, `A.whoosh` a little before the cut).
- **Language: English only** (see PLAN.md). Display: Cinzel / Cormorant Garamond; body: Inter 500–700 at 36–48 px (16:9) or 52–64 px (9:16). Reading time: at least 0.4 s per word + 0.8 s. Japanese glyphs only as small decorative accents.
- **Typography (former JA rules, still valid for any accent glyphs).** Japanese headlines use `var(--serif-jp)` 700–900 at 72–120 px, and body text uses `var(--sans-jp)` 500–700 at 36–48 px (16:9) or 52–64 px (9:16). Latin display text uses Cinzel or Cormorant. Keep it to two lines at most per beat, use 「」 for quotes, and break lines by hand at natural phrase boundaries (use `<br>`; never let the browser break in the middle of a word). Give each line reading time of at least 0.25 s per Japanese character, plus 0.8 s.
- **Colour.** Use the client's materials: forest-green panels with brass trims, parchment, dark wood, and the six nation colours with their sigils (never colour alone). The gold `#ffd24d` means "yours". Use a vignette and subtle grain for cinematic scenes.
- **Safe areas.** For 16:9, keep 80 px margins. For 9:16, keep key text out of the top 220 px and the bottom 320 px.
- **Sound.** Every video has a score (`A.music`) shaped by sections (intensity 0..1), and SFX on visual events. End with `outro: 'hit'` or `'ring'` before the end card, and let the end card breathe for at least 4 s.
- **End card.** `WYKit.endCard(stage, { lang, line })` closes every video (rendered from its start time).
- **Real UI.** Where a screenshot in `assets/ui/` shows the thing you explain, use it, with a slow push-in and a highlight box, labelled with its status.

## Honesty rules (non-negotiable)

Every claim comes from FACTS.md and keeps its status. Put a `WYKit.status(...)` badge on screen while a claim with a status is shown: `local` for runs on a local test chain, `devnet` for the earlier prototype only, `code`, `design`, `planned`, `sim` and `test`. Read FACTS.md §11 "Not claimed" and do not imply any item on it, even through visuals (for example, no "LIVE ON MAINNET" vibe, no prize money raining down, no human and AI together in one world, and no leader names). The AI citizen in take-1 is **Senasha** (a real AI-citizen name from the run). The six nation characters have no names. Do not invent quotes; if you show a model-written reason or memory line, use the exact text from the repo or label it clearly as an illustration (例).

## Report

When you are done, report the following for each video: the final file path, duration, and a one-paragraph description. Also list anything you were unsure about factually.

# fx: effects, motion and sound

The effects layer of the Frontier client (design brief `docs/frontier/ux/UX-DESIGN.md`, section 8). Plain ES modules, no asset files: everything is drawn by code and every sound is synthesised.

Rule of the house: **an effect is driven by a real record**. The one exception is the demo switch below, and it shows a corner tag for as long as it is active.

## Files

| File | What it is |
|---|---|
| `clock.mjs` | The effects clock, the only reader of `performance.now()` in this folder. Seconds; `setRate`, `freeze`, `play`, `seek`, `step`, `hitStop(ms)`. Published as `globalThis.__fxNow`. |
| `ease.mjs` | `outCubic`, `outBack`, `outElastic`, `inOutQuad`, `spring` and friends; `phase(t, beats)` to write an effect as anticipation, impact, decay. |
| `rand.mjs` | `hashSeed(id)`, `rng(seed)`, `noise1`. Nothing here calls `Math.random`. |
| `particles.mjs` | A fixed pool, seeded by the event id, in the map's world space. Motion is closed-form, so a frozen or rewound clock shows the same picture. Kinds: dust, spark, ember, smoke, shard, leaf, coin, mist, ink. |
| `bus.mjs` | `emit(type, payload)` / `on(type, fn)`. `emit('fx', {name: 'flash', q, r})` plays a named effect without importing the engine. |
| `motion.mjs` | `motion()` → `'full' | 'reduced' | 'off'`: the calmer of the system's reduced-motion setting and the player's `effects` preference (`fui.mjs`). |
| `engine.mjs` | The engine: ground pass, top canvas, `#fx-hud`, the world shake, named effects. |
| `effects.mjs` | The first vocabulary: `flash`, `ripple`, `dust`, `spark`, `label`, `glow`, `banner`, `toll`, `number`, `chip`. |
| `audio.mjs` | WebAudio synthesis: `bell`, `seal`, `clash`, `tick`, `shimmer`, `drum`. Silent until the first user gesture; mute remembered (`ps-ffx:v1`). `globalThis.__fxAudio = {toggle(), muted, play(name)}`. |
| `demo.mjs` | The demo switch `?fx=`. Loaded only when the address asks for it. |
| `index.mjs` | `startFx({map, canvas, effects})`: the page's one call. |
| `fx.css` | Styles of the top canvas and the HUD nodes. Linked by script; no CSS animation in it (every moving value is a custom property written from the clock). |

## Where an effect is drawn

* **ground**: inside the tile painter, after the territory wash and before the grid and the props (`map/sprites.mjs` calls `paintGround(ctx, {zoom})`). Trees and buildings stand on it. When the map is not painting tiles (far view, vector tiles) the same effects are drawn on the top canvas instead.
* **top**: a transparent canvas (`#fx-top`) laid exactly over `#frontier-map`, in world space. It reads the map's drawn view every frame, so it follows pan and zoom. Its frame loop runs only while something is live. **screen** effects are drawn on the same canvas in CSS pixels.
* **hud**: `#fx-hud`, an `aria-hidden` layer over the viewport for DOM effects (result title, floating numbers, a burst from a chip).

The world shake (2 to 8 px, 120 to 250 ms) moves `#frontier-map` and `#fx-top` only, through the CSS `translate` and `scale` properties, so it composes with any `transform` on the canvas and never moves the HUD. `#frontier-map[data-fx]` holds the count of live effects.

## Using it

```js
import { fx } from './fx/engine.mjs';
import { audio } from './fx/audio.mjs';

fx.play('flash', { p, q, tile, color: '#f3d58a', seed: `built|${id}` });   // or {q, r} axial, or {x, y} world px
fx.play('label', { q, r, text: L`−${n}`, color: '#ff9d86', size: 28 });
fx.play('banner', { title: L`…`, sub: L`…`, tone: 'win' });
fx.play('toll', { x: 0, y: 0 });                    // from the Engine
fx.emit('dust', { x, y, n: 24, seed: eventId });    // raw particles
fx.shake(5, 180, { seed: eventId });
fx.clock.hitStop(70);                               // hold every effect for 70 ms
audio().play('clash', { seed: eventId, delay: 0.1 });
```

Your own effect: `fx.add({layer, dur, draw(ctx, s), seed, info, dom})`, or `fx.define(name, (args, env) => spec | [specs])`. `s` gives `t` (seconds since start), `k` (0..1), `zoom`, `px` (one screen pixel in world units), `mode`, `size`, `view`, `stage`, `toScreen`, `toViewport`. Always pass the id of the causing record as `seed`.

Rules for a new effect:

1. Beats, not a linear fade: a short wind-up, the brightest frames at 60 to 100 ms, a long ease-out tail.
2. Reduced motion: no travel, shake or particles; show the state at once with a 200 ms opacity change (`REDUCED_FADE`). With effects off only `info: true` effects are added. `fx.emit` and `fx.shake` already do nothing outside full motion.
3. Tolerate a context whose methods return nothing (tests draw into a proxy): use `?.` on `ellipse`, gradients, `fillText`.
4. Text through `L`; never a direction, line or arrow for another nation's sealed march.

## The demo switch

```
…/index.html?fx=strike&fxrate=0.25          slow motion, loops
…/index.html?fx=bell&fxt=0.5                frozen 0.5 s after the start
…/index.html?fx=glow&fxat=16,-7             on that tile (axial q,r) or fxat=p,q,tile
…/index.html?fx=strike&fxmotion=reduced     show a motion level
```

`window.__fx.list() / play(names) / seek(t) / step(dt) / rate(n) / motion(level) / state() / sound(name)`. Samples: the ten effects by name, plus `bell` (toll, chip, banner, the bell's sound) and `strike` (flash, spark, dust, ripple, label). Combine `?at=p,q,tile,zoom` to place the camera. Frame-by-frame capture: seek, wait a frame, shoot.

## For whoever merges the map and HUD work

* `fx.mount` takes `camera()` (default `map.drawn ?? map.drawnView ?? map.view`), `size()`, `invalidate()`, `groundInPainter()` (default `map.lod === 'tile' && map.art`), `stage` (the element whose box is "the map on screen" for HUD effects; give the clipping wrapper when the canvas is overscanned) and `toViewport(x, y)` (world → viewport px when the map is not a flat affine view). `startFx` passes `stage` through.
* `#fx-top` is inserted right after `#frontier-map` and is absolutely positioned from the map canvas's offset box, so it must share the canvas's offset parent. If the map canvas gets a CSS 3D transform of its own, give `.fx-top` the same transform (a shared class or wrapper).
* The speaker button: `__fxAudio.toggle()`, `__fxAudio.muted`, `__fxAudio.onChange(fn)`.

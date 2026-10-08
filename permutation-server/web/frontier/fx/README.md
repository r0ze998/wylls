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
| `effects.mjs` | The first vocabulary: `flash`, `ripple`, `dust`, `spark`, `label`, `glow`, `banner`, `toll`, `number`, `chip`, and `burst` (particles of one kind). |
| `audio.mjs` | WebAudio synthesis: `bell`, `seal`, `clash`, `tick`, `shimmer`, `drum`. Silent until the first user gesture; mute remembered (`ps-ffx:v1`). `globalThis.__fxAudio = {toggle(), muted, play(name)}`. |
| `stage.mjs` | **The set pieces** (brief §8.3): subscribes to the bus and plays what the page reports: the bell, this turn's own results, own actions, seal and depart, moments. `playToll`, `playResult`, `playBusy / Sent / Landed / Refused`, `playSealed`, `playMoment` are the compositions (the demo calls the same ones). |
| `battle.mjs` | The battle on the page: `stageBattle(fx, play, opts)` puts `people/battle.mjs`'s painter above the dimmed map and adds particles, shake, sound, the verdict title, the aftermath, a burning camp and the far view's crossed swords. `verdictTitle(scene, viewerFaction)`. |
| `pieces.mjs` | The parts of the set pieces: `mark`, `pending`, `pulse`, `stamp`, `route`, `sealed`, `walker`, `unseal`, `swords`, `alarm`, `pillar`, `forming`, `raise`, `fly`, `pip`, `burn`. |
| `draw.mjs` | Shared drawing: the wax seal, the ribbon of a route, the round tick / cross mark, the far view's pip, a standard. |
| `idle.mjs` | Idle life at the near view: water glints, cloud shadows, chimney smoke. Painted inside the tile painter; nothing in reduced motion. |
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

## The set pieces and their events

The page says what happened on the bus; `stage.mjs` decides what it looks and sounds like. Emitters import only `fx/bus.mjs`.

| Event | Who emits it | Payload | What plays |
|---|---|---|---|
| `bell` | `app.mjs` `ringToll` (the turn number grew) | `{turn, home: {p, q, tile} \| null}` | brass ripple from the Engine (from home when the Engine is off screen), the banner 「鐘が鳴りました — ターン N」 carried by `#bell-toll`, a burst on `#bell-chip`, the bell |
| `feed` | `app.mjs` `tickFeed` (fresh notifications) | `{turn, fresh: [hud/feed items + tile, faction]}` | this turn's own results after the toll, 0.7 s apart: own arrivals unseal, own battles strike, warnings close in |
| `turn:urgent` | `app.mjs` `ringToll`, once a turn at 30 s left | `{turn, secondsLeft}` | one ember beat on `#bell-chip`, a tick |
| `battle` | `app.mjs` `playBattle` | `{play, focus, zoom, viewerFaction, lossText, numText}` | `stageBattle` |
| `moment` | `app.mjs` `checkMoments` (`people/moments.mjs detectMoments`) | `{kind, p, q, tile, own, …}` | built, harvest, muster, arrive, camp, village, depart |
| `action:busy` / `sent` / `landed` / `refused` | `controller.mjs` `act` and `sendTheMarch` | `{id, name, faction, tile}` (+ `route`, `dest`, `unit` for a march) | a ring turning on the tile; a ripple; a burst in the nation's colour with a tick mark; a red beat with a cross |
| `march:sealed` | `controller.mjs` `sendTheMarch` | the march's `action:busy` payload | the wax seal at 56 px on the end of the ribbon, the column sets off, the ribbon rests (ground layer, still) until the next `bell` |

Emitted by `stage.mjs` for the HUD:

* `turn:results` `{turn, items, fresh, startsIn, gap}`: `items` is the turn's whole list in the order shown (`kind`: `'arrival' | 'battle' | 'incoming'`, with `id, p, q, tile, text, battle`), `fresh` what this call added, `startsIn` seconds until the first of them plays on the map.
* `res:gain` `{p, q, site, tile}`: the harvest tokens of an own village landed in `#res-strip` (or at once when there is no strip): count up now.

Truth rules kept here: a moment is played only for a record the page holds; `depart` (another nation's host, or any host seen leaving) is dust all round, a seal and a word, never a route, a heading or a column; the ribbon of a route is drawn only for the viewer's own march and its seal says 「封印済み · あなたにだけ見えます」; the loss numbers of a battle are a running total that ends on the record's own figure; a side whose losses are unknown shows no number; a camp that is merely gone (`camp` moment) says 「野営地がなくなった」 and does not burn: fire is only for a camp a clash destroyed.

### The battle

`people/battle.mjs` keeps `PHASE` (7.0 s) and its exports and adds the choreography: `BATTLE_HITS` (three exchanges and the deciding blow at the fates), `poseTime` (each contact holds the figures 70 ms and gives the time back), `formation(pose, n)`, `figuresFor(troops)`, `battlePlan(scene)`, `battleVerdict(scene)`, `battleScale(zoom, fit)`. `paintBattle(ctx, play, {zoom, at, top, fit, lossText, fateText, numText, nameText})` is a pure function of the time. When the effects layer has taken a scene it sets `play.staged`, and the map's own call (map/sprites.mjs) then draws nothing and only reports whether the scene still plays, so the host sprites stay hidden on the tile exactly as before.

## The demo switch

```
…/index.html?fx=strike&fxrate=0.25          slow motion, loops
…/index.html?fx=bell&fxt=0.5                frozen 0.5 s after the start
…/index.html?fx=glow&fxat=16,-7             on that tile (axial q,r) or fxat=p,q,tile
…/index.html?fx=strike&fxmotion=reduced     show a motion level
```

`window.__fx.list() / play(names) / seek(t) / step(dt) / rate(n) / motion(level) / state() / sound(name)`. Samples: the first ten effects by name, plus `kinds` (every particle kind side by side) and `strike` (flash, spark, dust, ripple, label); and the set pieces on labelled sample data: `battle`, `battle-camp`, `battle-held`, `battle-others`, `battle-fast`, `bell`, `turn` (the toll and three results), `results`, `action` (tracked, sent, landed), `landed`, `refused`, `pending`, `seal`, `built`, `harvest`, `harvest-other`, `muster`, `arrive`, `camp`, `village`, `village-lost`, `depart`. `&fxcam=<zoom>` centres the camera on the demo tile (`?fxat=19,-8&fxcam=2.1&fx=battle` is the battle as the page shows it after flying in). Combine `?at=p,q,tile,zoom` to place the camera. Frame-by-frame capture: seek, wait a frame, shoot.

## For whoever merges the map and HUD work

* `fx.mount` takes `camera()` (default `map.drawn ?? map.drawnView ?? map.view`), `size()`, `invalidate()`, `groundInPainter()` (default `map.lod === 'tile' && map.art`), `stage` (the element whose box is "the map on screen" for HUD effects; give the clipping wrapper when the canvas is overscanned) and `toViewport(x, y)` (world → viewport px when the map is not a flat affine view). `startFx` passes `stage` through.
* `#fx-top` is inserted right after `#frontier-map` and is absolutely positioned from the map canvas's offset box, so it must share the canvas's offset parent. If the map canvas gets a CSS 3D transform of its own, give `.fx-top` the same transform (a shared class or wrapper).
* The speaker button: `__fxAudio.toggle()`, `__fxAudio.muted`, `__fxAudio.onChange(fn)`.
* `map/sprites.mjs` calls two passes: `fxGround(ctx, {zoom, tiles})` after the territory wash (ground effects, the sealed ribbon, water glints) and `fxOver(ctx, {zoom, tiles})` after the props and holdings, before the hosts (cloud shadows, chimney smoke). `tiles` are the painter's own (`{x, y, q, r, name, cloud, fog, site, state, owner}`); idle life skips tiles whose `fog` is `'unopened'` or `'distant'` or that are cloud, so under the survey model it should be given only what is in sight (or mark the rest with those values).
* The camera: `playBattle` calls `map.flyTo({x, y, zoom}, 500)` when the map has it, else `setView`. On a phone the fly should centre above the sheet; the battle itself is tile-anchored and shrinks to the map's width (`battleFit`).
* The HUD can replace the two bursts on `#bell-chip` and `#res-strip` (`chip` effects in `stage.mjs`) with its own dial swing and count-up: listen to `bell`, `turn:urgent`, `turn:results` and `res:gain` on the bus.
* A still effect (`fx.add({still: true, layer: 'ground', …})`) is drawn with every map paint and never keeps the frame loop awake: the place for anything that rests on the land for minutes.

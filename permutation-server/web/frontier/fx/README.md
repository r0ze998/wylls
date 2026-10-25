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
| `engine.mjs` | The engine: ground pass, top canvas, `#fx-hud`, the world shake, named effects; `anchor(x, y)` (the one way from the map to the screen), `free()` (what the HUD leaves free), `piece()` / `hush()` (what the map is told while a set piece plays). |
| `safe.mjs` | The HUD-free rectangle: `freeOf(doc, stage)` → `{bounds, centre, stage, place(), span()}`, from `globalThis.__wyllsHud.freeRect()` when the HUD gives one, else measured from the HUD's known pieces. Pure core `freeFrom(stageRect, boxes)`. |
| `effects.mjs` | The first vocabulary: `flash`, `ripple`, `dust`, `spark`, `label`, `glow`, `banner`, `toll`, `number`, `chip`, `burst` (particles of one kind) `tag` (a caption on a small bell-metal tag with a leader to its tile) and `waiting` (the same tag under its own name, for a state that lasts until it is settled: 「送信中…」 over a tile). `dust` takes `ring` (a low skirt from the rim of a disc, round something that stands there). |
| `audio.mjs` | WebAudio synthesis: `bell`, `seal`, `clash`, `tick`, `shimmer`, `drum`. Silent until the first user gesture; mute remembered (`ps-ffx:v1`). `globalThis.__fxAudio = {toggle(), muted, play(name)}`. |
| `stage.mjs` | **The set pieces** (brief §8.3): subscribes to the bus and plays what the page reports: the bell, this turn's own results, own actions, seal and depart, moments. `playToll`, `playResult`, `playBusy / Sent / Landed / Refused`, `playSealed`, `playMoment` are the compositions (the demo calls the same ones). |
| `battle.mjs` | The battle on the page: `stageBattle(fx, play, opts)` puts `people/battle.mjs`'s painter above the dimmed map and adds particles, shake, sound, the verdict title, the aftermath, a burning camp and the far view's crossed swords. `verdictTitle(scene, viewerFaction)`. |
| `pieces.mjs` | The parts of the set pieces: `mark`, `pending`, `pulse`, `stamp`, `route`, `sealed`, `walker`, `unseal`, `swords`, `alarm`, `pillar`, `forming`, `raise`, `fly`, `pip`, `burn`. |
| `draw.mjs` | Shared drawing: the wax seal, the flat ribbon of a route (`ribbonEdges`, `ribbon`), a caption tag on the canvas (`canvasTag`, for what rests on the land), the round mark (a tick, or an ember ring with a bar, on a chip of bell metal), the far view's pip, a standard. What stands on the board is drawn through `stood(ctx, x, y, draw)`: upright on the tilted map (`map.standAt`). |
| `idle.mjs` | Idle life at the near view: water glints, cloud shadows, chimney smoke. Painted inside the tile painter; nothing in reduced motion. |
| `demo.mjs` | The demo switch `?fx=`. Loaded only when the address asks for it. |
| `index.mjs` | `startFx({map, canvas, effects})`: the page's one call. |
| `fx.css` | Styles of the top canvas and the HUD nodes. Linked by script; no CSS animation in it (every moving value is a custom property written from the clock). |

## Where an effect is drawn

* **ground**: inside the tile painter, after the territory wash and before the grid and the props (`map/sprites.mjs` calls `paintGround(ctx, {zoom})`). Trees and buildings stand on it. When the map is not painting tiles (far view, vector tiles) the same effects are drawn on the top canvas instead.
* **top**: a transparent canvas (`#fx-top`) laid exactly over `#frontier-map`, in world space. It reads the map's drawn view every frame, so it follows pan and zoom. Its frame loop runs only while something is live. **screen** effects are drawn on the same canvas in CSS pixels.
* **hud**: `#fx-hud`, an `aria-hidden` layer over the viewport for DOM effects (result title, floating numbers and words, captions on tags, a burst from a chip). Everything here that belongs to a place on the map is put there through `s.anchor(worldX, worldY)` and kept inside `s.free` (see below).

The world shake (2 to 8 px, 120 to 250 ms) moves `#frontier-map` and `#fx-top` only, through the CSS `translate` and `scale` properties, so it composes with any `transform` on the canvas and never moves the HUD. `#frontier-map[data-fx]` holds the count of live effects.

## Using it

```js
import { fx } from './fx/engine.mjs';
import { audio } from './fx/audio.mjs';

fx.play('flash', { p, q, tile, color: '#f3d58a', seed: `built|${id}` });   // or {q, r} axial, or {x, y} world px
fx.play('label', { q, r, text: L`−${n}`, size: 28 });                        // ivory with an ink outline; 1.3 → 1.0 in 120 ms
fx.play('tag', { p, q, tile, text: L`伐採場が完成`, icon: 'hammer', tone: 'gold' });  // a caption: bell metal, the serif, a leader
fx.hush({ p, q, tile }, 2.4);                       // that tile's own labels make way meanwhile
fx.play('banner', { title: L`…`, sub: L`…`, tone: 'win' });
fx.play('toll', { x: 0, y: 0 });                    // from the Engine
fx.emit('dust', { x, y, n: 24, seed: eventId });    // raw particles
fx.shake(5, 180, { seed: eventId });
fx.clock.hitStop(70);                               // hold every effect for 70 ms
audio().play('clash', { seed: eventId, delay: 0.1 });
```

Your own effect: `fx.add({layer, dur, draw(ctx, s), seed, info, dom})`, or `fx.define(name, (args, env) => spec | [specs])`. `s` gives `t` (seconds since start), `k` (0..1), `zoom`, `px` (one screen pixel in world units), `mode`, `size`, `view`, `stage`, `anchor(x, y)` / `unanchor(x, y)` (world ↔ client px), `free` (the HUD-free rectangle). Always pass the id of the causing record as `seed`.

Rules for a new effect:

1. Beats, not a linear fade: a short wind-up, the brightest frames at 60 to 100 ms, a long ease-out tail.
2. Reduced motion: no travel, shake or particles; show the state at once with a 200 ms opacity change (`REDUCED_FADE`). With effects off only `info: true` effects are added. `fx.emit` and `fx.shake` already do nothing outside full motion.
3. Tolerate a context whose methods return nothing (tests draw into a proxy): use `?.` on `ellipse`, gradients, `fillText`.
4. Text through `L`; never a direction, line or arrow for another nation's sealed march.
5. Words are HUD nodes, not canvas text: a caption is a `tag`, a number or a word a `label`, a title a `banner`. They go through `s.anchor` and `s.free.place`, so they are upright over a tilted map and never under the top strip, the dial, the dock, a sheet or a phone's columns of buttons. (Two things stay on the canvas because they belong to the scene or rest on the land: a battle's numbers and bars, and the sealed ribbon's tag.)
6. A hit is light added to what is struck (`HIT_TINT` 0.6, two frames) with a small star, never a white silhouette. Dust is `puff` particles in a colour that belongs to who raised it.

## The set pieces and their events

The page says what happened on the bus; `stage.mjs` decides what it looks and sounds like. Emitters import only `fx/bus.mjs`.

| Event | Who emits it | Payload | What plays |
|---|---|---|---|
| `bell` | `app.mjs` `ringToll` (the turn number grew) | `{turn, home: {p, q, tile} \| null}` | brass ripple from the Engine (from home when the Engine is off screen), the banner 「ターン N」 with 「新しいターン」 under it (1.6 s) carried by `#bell-toll`, a burst on `#bell-chip`, the bell |
| `feed` | `app.mjs` `tickFeed` (fresh notifications) | `{turn, fresh: [hud/feed items + tile, faction]}` | this turn's own results after the toll, 0.7 s apart: own arrivals unseal, own battles strike, warnings close in |
| `turn:urgent` | `app.mjs` `ringToll`, once a turn at 30 s left | `{turn, secondsLeft}` | one ember beat on `#bell-chip`, a tick |
| `battle` | `app.mjs` `playBattle` | `{play, focus, zoom, viewerFaction, lossText, numText}` | `stageBattle` |
| `moment` | `app.mjs` `checkMoments` (`people/moments.mjs detectMoments`) | `{kind, p, q, tile, own, …}` | built, harvest, muster, arrive, camp, village, depart |
| `action:busy` / `sent` / `landed` / `refused` | `controller.mjs` `act` and `sendTheMarch` | `{id, name, faction, tile}` (+ `route`, `dest`, `unit` for a march) | a ring turning on the tile; a ripple; a burst in the nation's colour with a tick mark; a red beat with a cross |
| `march:sealed` | `controller.mjs` `sendTheMarch` | the march's `action:busy` payload | the wax seal at 56 px on the end of the ribbon, the column sets off (four figures at the size of the map's hosts, most of a figure apart, walk 2.6 tiles along it in 2.8 s; a standing file in reduced motion), the ribbon rests with its tag (ground layer, still) until the next `bell` |
| `reveal` | `app.mjs` `surveyNow` | `{n}` (tiles and times from `map.source().survey.reveals`) | ink lifts off each tile as the map dissolves it from chart to paint, a pale ring runs ahead, one tag counts the survey |

Said by the map of its own records (`map/fmap.mjs boardChanged`, `promotionWatch`, `pickTile`; UX design 14): nothing for what a page finds when it opens, only for what changes while it is watched.

| Event | Payload | What plays |
|---|---|---|
| `survey:gain` | `{n, q, r, seq, faction}` (the survey's own count of newly surveyed tiles and the hex of the piece that caused it: `map/survey.mjs surveyGain`) | one chip rises from the piece: 「+N マス測量」 (`playGain`); it stands in for the reveal's caption |
| `board:arrival` | `{host, p, q, tile, faction, lead}`: a march of the viewer's has arrived and its seal is open | the seal opens with a flash on the destination, once (not again if this turn's `feed` result opened it there); the map eases the camera there when the player is not busy |
| `board:formed` | `{host, p, q, tile, unit, faction}`: a host that was forming up stands | dust and a ring on its tile, a drum (`playFormed`) |
| `board:left` | `{host, p, q, tile, faction, lead}`: a standing host of the viewer's is on a sealed march | nothing here; `people/onboard.mjs` hears it for the character's walk out |
| `promotion` | `{p, q, tile, faction, tier, from, to, grew}`: a village of the viewer's has a higher tier | the map floods the new ring (`map/villagework.mjs promotionAt`); here the crest, sparks and 「村のまわりが広がりました」 (`playPromotion`) |
| `pick:open` / `pick:change` / `pick:close` | `{kind, n, max, label}` / `{kind, picked}` | nothing here: for the HUD's confirm chip |

`action:landed` of a `Train` also plays `playRecruits` (a short file walks up the gate road into the village; `unit` and `n` on the payload are used when the page gives them). The `harvest` moment of an own village flies its goods from the village's fields when the map shows sheaves there (`map.fieldPoints`).

Emitted by `stage.mjs` for the HUD:

* `turn:results` `{turn, items, fresh, startsIn, gap}`: `items` is the turn's whole list in the order shown (`kind`: `'arrival' | 'battle' | 'incoming'`, with `id, p, q, tile, text, battle`), `fresh` what this call added, `startsIn` seconds until the first of them plays on the map.
* `res:gain` `{p, q, site, tile}`: the harvest tokens of an own village landed in `#res-strip` (or at once when there is no strip): count up now.

Truth rules kept here: a moment is played only for a record the page holds; `depart` (another nation's host, or any host seen leaving) is dust all round, a seal and a word, never a route, a heading or a column; the ribbon of a route is drawn only for the viewer's own march and its seal says 「封印済み · あなたにだけ見えます」; the loss numbers of a battle are a running total that ends on the record's own figure; a side whose losses are unknown shows no number; a camp that is merely gone (`camp` moment) says 「野営地がなくなった」 and does not burn: fire is only for a camp a clash destroyed.

### The battle

`people/battle.mjs` keeps `PHASE` (7.0 s) and its exports and adds the choreography: `BATTLE_HITS` (three exchanges and the deciding blow at the fates), `poseTime` (each contact holds the figures 70 ms and gives the time back), `formation(pose, n)`, `figuresFor(troops)`, `battlePlan(scene)`, `battleVerdict(scene)`, `battleScale(zoom, fit)`. `paintBattle(ctx, play, {zoom, at, top, fit, lossText, fateText, numText, nameText})` is a pure function of the time. When the effects layer has taken a scene it sets `play.staged`, and the map's own call (map/sprites.mjs) then draws nothing and only reports whether the scene still plays, so the host sprites stay hidden on the tile exactly as before.

A battle the camera is sent to fills the stage (wave 2): `battleLayout(stage, {title})` sizes the figures to the free stage (120 px at 1440 × 900, about 63 px on a 390 px phone, where the two sides also stand closer), `battleFrame(fx)` says where the tile's centre belongs so the whole block is in the middle, and `paintBattle` takes `layout` and `place` (which keeps a number on the free part of the screen). A blow is `HIT_TINT` (0.6) of light added to the struck figures for two frames with a star at the contact; loss numbers are `LOSS_PX` (28) ivory with an ink outline, at full opacity and 1.3 times their size on the contact frame, 1.0 after 120 ms; dust is `dustColors(sideColors(nation))`. A battle that plays in passing (no camera move) keeps to its tile as before.

## The keeps of a conquest season (the board's own part)

A conquest season (the program's version 3) has a keep in every province from ring 2 outward; a hostile host that holds a keep's tile for 72 turns in a row takes the province for its nation. The board draws them in `map/keeps.mjs` (the records' reader `KeepBook`, the painters, the board's part `KeepBoard`), read from the chain's records as the herald serves them and from nothing else: the control record (`/h/control`: holder, contender, turns held) laid on the overview's provinces, the keep's tile (`/h/overview2`), and the keep events of `/h/conquest/{day}.json`. Nothing of it is drawn in any other season, nor in the sample world's arrival-control land. A battle at a keep and the capture of its province are two records 72 turns apart, and the board never joins them: the capture plays from the capture's own record.

What the map says once on the bus, when the records change while the page is watched (what a page finds when it opens is simply there):

| Event | Payload | When |
|---|---|---|
| `keep:captured` | `{p, q, from, to, turn, mine, lost, before, after}` | the capture's record (`keep_taken`) is read; or, where the day's file cannot be read, the control record's change of holder after a short wait. `mine`: the viewer's nation took it; `lost`: the viewer's nation lost it; `before` / `after`: provinces the taking nation held |
| `keep:contest` | `{p, q, held, of, by, mine}` | a contest began, or a turn was added to it (`held` of `of` turns, by nation `by`) |
| `keep:broken` | `{p, q, held, of, by, mine}` | the contender is gone from the control record and the holder is the same |
| `keep:tap` | `{p, q, tile, reachable, why}` | a keep of the lit reach was pressed |

For the hand (documented at the methods in `map/fmap.mjs`):

* `map.setKeepReach(list | null)`: `list` = `[{p, q, tile, arriveTurn, holder, defenders, reachable, why}]`. A `reachable` keep lights (a breathing gold ring, 「ターン N に到着」); the others stay dim and answer a tap with `why`. Until the page calls it, the board lights the reach of the fighting host in hand by itself (`map/keepmount.mjs keepReachOf`: the composer's own planner, at most 4 provinces).
* `map.keepAt(clientX, clientY)` → `{p, q, tile}` or null: the keep whose fortress or tile is under a point of the page.
* `map.flyToKeep({p, q})` → whether there is such a keep.
* A press on a keep's walls reaches the page as a press on the keep's own tile, with `hit.keep = {p, q, reachable}`.

`app.mjs` has one block for all of it (`// >>> keep-board`): `mountKeepBoard({ map })`.

Samples (`fx/keep-demo.mjs`; sample records in the herald's own shapes, laid at a real keep near the viewer's village, under the demo's tag): `?fx=keep-reach`, `keep-contest`, `keep-captured`, `keep-lost`; `&fxkz=<zoom>` or `&fxkz=far` for the camera.

## The demo switch

```
…/index.html?fx=strike&fxrate=0.25          slow motion, loops
…/index.html?fx=bell&fxt=0.5                frozen 0.5 s after the start
…/index.html?fx=glow&fxat=16,-7             on that tile (axial q,r) or fxat=p,q,tile
…/index.html?fx=strike&fxmotion=reduced     show a motion level
```

`window.__fx.list() / play(names) / seek(t) / step(dt) / rate(n) / motion(level) / state() / sound(name)`. After landing (UX design 14), on sample RECORDS laid over the page's own (`map.setSample`, so the board draws them through the same functions as real ones): `athome`, `afield` (hosts away from home: pennon, stamina ring, pip, the watch, the character at the head of the first), `sealed`, `sealed-two` (the viewer's sealed ribbon and its marker), `arrival` (the seal opens at 1.2 s: host and character on the destination, the chart dissolves, 「+N マス測量」, the camera eases there), `ghost` (a muster pending, then formed), `flags` (an exploration under way), `leave` (the character walks out with its column), `scaffolds`, `annex`, `annex-farm-mine`, `sheaves`, `harvest-fields`, `recruits`, `promotion`, and the two picks `pick-muster`, `pick-explore`. Samples: the first ten effects by name, plus `kinds` (every particle kind side by side) and `strike` (flash, spark, dust, ripple, label); and the set pieces on labelled sample data: `battle`, `battle-camp`, `battle-held`, `battle-others`, `battle-fast`, `bell`, `turn` (the toll and three results), `results`, `action` (tracked, sent, landed), `landed`, `refused`, `pending` (these three with the HUD's own status chip beside them, in a notice stack of the demo's), `seal`, `reveal`, `built`, `harvest`, `harvest-other`, `muster`, `arrive`, `camp`, `village`, `village-lost`, `depart`; and `leaders` (the six nations' leaders on six tiles by the demo tile: they walk a tile, strike and take a hit; `people/leader-demo.mjs`. The game has no leader on the map: this sample exists for judging the figures on the real board). `&fxcam=<zoom>` centres the camera on the demo tile (`?fxat=19,-8&fxcam=2.1&fx=battle` is the battle as the page shows it after flying in). Combine `?at=p,q,tile,zoom` to place the camera. Frame-by-frame capture: seek, wait a frame, shoot.

## The HUD-free rectangle, the tilted stage, and what the map is told

* `fx.free()` → `{bounds, centre, stage, place(cx, cy, w, h, pad, from), span(y0, y1, {stage})}` in client px, measured at most four times a second. `bounds`: the map without the bands across it (top strip, dock or sheet, an open drawer). `centre`: the stage round the middle line that no piece of the HUD touches (under the dial; between the plate and the map buttons, or between a phone's two columns): where a title goes. `stage`: the same once the HUD's corner pieces have stepped back for a set piece: what a battle is sized to. `place` moves a box off every piece by the shortest way (a way that would put a piece between the box and `from`, the leader's foot, comes last). Where the boxes come from (`safe.mjs freeOf`), in this order: one rectangle a page gives as `globalThis.__wyllsHud.freeRect()` (client px; then that rectangle is all three); else the HUD's own list of its pieces, `globalThis.__wyllsHud.noGo()` (`hud/insets.mjs noGoRects`, the same list the map's labels keep out of; `HUD_IDS` says which ids step back for a set piece, and the strip's two plaques count as one band); else the page measured by selector (`HUD_PIECES`). The play page publishes the list, so that is what is used there.
* `fx.anchor(worldX, worldY)` → client px. It asks `map.project(x, y)` (a point or a pair) when the map has it; else the mount's `toViewport`; else the flat view over the canvas's box. `fx.unanchor` is the inverse (`map.unproject`). Nothing else in fx/ turns a world point into a screen point for a HUD node.
* `fx.mount({…, parent})` puts the top canvas into `parent`; `fx.mount(stageEl)` on a mounted engine moves it there (`fx.reparent`). `startFx` (fx/index.mjs) mounts on the map's ground canvas when the map has a stage: the top canvas is inserted right after `#map-ground` inside `#map-stage`, is sized and drawn exactly like it (`map.groundSize()`, `map.groundView()`: larger than the picture, so `s.size` is that canvas's and `s.stage` is the map's box on screen), and shares the tilt; what must stay upright is in `#fx-hud`.
* `fx.piece(name, {dur, delay, tiles, stage})` and `fx.hush({p, q, tile}, seconds, delay)`: while they are live the engine calls `map.hideLabelsAt("p,q,tile", true)` for each tile (and `false` after), and for a piece with `stage: true` (a battle the camera was sent to) `map.setPiece(true)` / `(false)`. It also sets `<body data-fx-piece="battle">` and emits the bus event `piece {name, on, tiles}`. The map's part (map/fmap.mjs): `hideLabelsAt` puts that tile's plate and pills away, `setPiece` fades all of the map's words out and back (they lie on the flat canvas above this one, so a battle's dim would not reach them) and hides the pointer home. fx.css fades the HUD's corner pieces (`#hud-tl, #rail, #minimap, .map-tools, .home-pointer`) to nothing under that attribute (they keep their presses and come back on focus; the next-thing button stays with its plaque); if the HUD renames them, change that one rule, `HUD_IDS` and `HUD_PIECES` in `safe.mjs`.

## For whoever merges the map and HUD work

* `fx.mount` takes `camera()` (default `map.drawn ?? map.drawnView ?? map.view`), `size()`, `invalidate()`, `groundInPainter()` (default `map.lod === 'tile' && map.art`), `parent` (where the top canvas goes), `stage` (the element whose box is "the map on screen" for HUD effects; give the clipping wrapper when the canvas is overscanned) and `toViewport(x, y)` (only for a map that has no `project`). `startFx` passes `stage` through.
* `#fx-top` is absolutely positioned from the map canvas's offset box, so it must share the canvas's offset parent (it does when both are in `#map-stage`).
* The speaker button: `__fxAudio.toggle()`, `__fxAudio.muted`, `__fxAudio.onChange(fn)`.
* `map/sprites.mjs` calls two passes: `fxGround(ctx, {zoom, tiles})` after the territory wash (ground effects, the sealed ribbon, water glints) and `fxOver(ctx, {zoom, tiles})` after the props and holdings, before the hosts (cloud shadows, chimney smoke). `tiles` are the painter's own (`{x, y, q, r, name, cloud, fog, site, state, owner}`); idle life skips tiles whose `fog` is `'unopened'` or `'distant'` or that are cloud, so under the survey model it should be given only what is in sight (or mark the rest with those values).
* The camera: `playBattle` calls `map.flyTo({p, q, tile, zoom}, 500)`; `stageBattle` then calls `map.flyTo({x, y, zoom}, 500, {exact: true})` itself so that the whole block of the scene (title, numbers, figures, bars) sits in the middle of the free stage. Under the tilt the view for that second call comes from the map itself, `map.viewShowing(worldPoint, clientX, clientY, zoom)`; without it (a flat map in a test) it is plain arithmetic.
* The toll's banner is carried by `#bell-toll`; it is handed back `hidden`. This turn's results and their card (`turn:results`, `startsIn`) begin at `TOLL_CLEAR` (2.88 s after the stroke), when the banner has faded under a tenth. `.turn-strip` is made opaque in fx.css.
* The reveal: `reveal {n, words}` from `app.mjs` (`words: false` for a viewer without a village: the candidate sites of the wait come out of the chart without the caption that counts a survey); the tiles and their start times are read from `map.source().survey.reveals` (hexKey → effects-clock ms) with `keyHex` of `map/survey.mjs`.
* The HUD can replace the two bursts on `#bell-chip` and `#res-strip` (`chip` effects in `stage.mjs`) with its own dial swing and count-up: listen to `bell`, `turn:urgent`, `turn:results` and `res:gain` on the bus.
* A still effect (`fx.add({still: true, layer: 'ground', …})`) is drawn with every map paint and never keeps the frame loop awake: the place for anything that rests on the land for minutes.

## The real pipeline (wave 3) and the live fixture

The demo switch plays samples; the page's own triggers are seen on the screenshot fixture's live mode: `srv.live(true, {delay, landMs})` on `permutation-gateway/screens/server.mjs` (`liveworld.mjs` keeps the world; a preview's boot page takes `&live=1`). The fixture's clock starts at the page's first `/h/season`, the turn ends `delay` seconds later (8), and from then on the fake herald shows a building of the viewer done (twelve seconds into the turn), the stores risen, the viewer's sealed march revealed at the camp and a clash of two turns ago at the viewer's village; the fake relay takes Harvest, Build, Muster, Explore and Depart, lands them `landMs` later and the herald shows them; the turn's second Depart is refused. `srv.advance()` ends the turn at once; `srv.world().orders` lists what the relay answered. Covered by `screens/fixtures.screen.mjs`, `test/web-frontier-live.test.mjs` (the page's controller against it, in node) and four tests and two scenes of the browser suites.

What the first real turn changed here:

* **A battle of the viewer's is one of the turn's own results.** `app.mjs tickFeed` marks a battle notification with `scene` (the scene's seconds at the chosen speed: the page plays battles by itself) and `focus` (the opt-in pan to combat). `stage.mjs` gives every result of a poll its time: `turn:results` items carry `at` (effects-clock second), `secs` and `plays`; a battle that plays (`scene`, and on the map on screen or `focus`) gets no crossed-swords mark, later results wait for it (`SCENE_REST`), and at its second the bus says `turn:scene {…item}`, on which `app.mjs` calls `playBattle(…, {auto: true, focus})`. `autoBattles` skips a clash the notifications announce. A second poll's results queue behind what is still playing.
* **A tile a battle has is the battle's.** `stage.mjs` holds the tiles of a staged scene until it ends; a moment on one of them (a building's light and caption) is played when the field is clear.
* **On a phone a battle has the stage even in passing** (`battle.mjs`: `takes`): no camera move, but `<body data-fx-piece>` is set, the notices step back with the corner pieces (`fx.css`, under 760 px; `safe.mjs HUD_IDS.narrowGhost`), and the scene's own numbers are placed with `free.placeStage` (off what stays, not off what stepped back). A key's focus brings the notices back (`:has(:focus-visible)`); a finger's press on the card's "see" does not.
* **A caption needs its tile in sight.** `tag` is not shown when a sheet, a drawer or the strip lies over its tile, nor when a full sheet leaves no map (`free.covered`).
* **Figures in a group keep less of their baked shadow**: `people/minis.mjs paintMini({shade})` (default 1), 0.42 in a battle (`people/battle.mjs FIGURE_SHADE`), 0.45 for a file or a muster (`pieces.mjs FILE_SHADE`). The shock at a contact is in the two nations' own colours, the outcomes stand on bell-metal tags (`battle.mjs plateText`, `FATE_PX`), dust carries the nation's colour (`fx/battle.mjs dustColors`).
* `fx.pending()` → `[{name, seed, in}]`: the effects still to start (tests read a composition's timing from it).

Capturing a real strip: open `/__boot?stage=holding&lang=ja&live=1&to=…`, subscribe `on('*', …)` of `fx/bus.mjs` in the page to log the events with `fx.clock.now()`, and for each frame wait for the effects clock, `fx.clock.freeze()`, photograph, `fx.clock.play()` (the tool used for the strips of this wave: the scratch folder's `shots/w3-ux-fx/live.mjs`). Timers of the page that are not on the effects clock (the polls, the chain clock) keep running while a frame is held.

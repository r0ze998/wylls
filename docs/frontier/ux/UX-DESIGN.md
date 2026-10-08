# Wylls: presentation redesign ("The Surveyor's Table")

Design brief for the game client under `permutation-server/web/frontier/` (branch `frontier/ux`, cut from `frontier/ai-run`, local only). Written 2026-10-09. This document is the normative spec for the redesign units; where it and older web design text disagree about presentation, this document wins. It changes **how the game is shown**, never a rule, an instruction, a record or a number of the game.

## 0. The owner's brief (2026-10-09, the owner's own points)

1. A large gap to the design quality of simulation / strategy games on the market.
2. Opening the game shows the whole map, which is meaningless.
3. Battle effects, and the effects of anything the player does, are poor.
4. The camera angle / angle of view is wrong.
5. Nothing in the presentation makes one want to play.
6. The area the player first lands on must become the player's own colour; the tiles around it on which an action is possible must light up when selecting.
7. Nowhere near release quality.
8. The player cannot tell where they are.
9. At first only the player's surroundings may be visible; the whole map must not be.

The owner's references (level of presentation, **not** a look to copy; frames and notes in the scratchpad `ux/ref/`): Realms Eternum season 1 (the unexplored world is one parchment map plane; a player's known land is a small patch of living hexes on it; oblique camera), the Eternum three.js playtest and Realms Blitz (the unknown is dark; known land is lit; tiles that can be acted on glow; small dark HUD with thin gold lines; large effects). Measured state of the current client and the market conventions are in the scratchpad `ux/understand/*.md` (renderer, shell, flow, effects, tests, visibility, capture, market).

## 1. The idea

**The frontier is an unfinished map lying on a dark table. What your people have seen is painted and alive; the rest is ink on parchment; beyond the opened rings is the cloud sea.** The bell at the centre is the one thing everyone hears.

* World surface, three materials: **living diorama** (the existing painted tile art) for what you see; **surveyor's chart** (parchment, sepia ink lattice and drawn terrain glyphs) for opened land you have not surveyed; **cloud sea** (the existing cloud art) for rings that are not open.
* HUD material: **bell metal**: dark ink-teal with thin brass lines. It floats over a full-screen world and stays small.
* Documents (battle reports, sealed orders, the chronicle, the guide) are **parchment**: paper is used only for things that are papers in the world.
* The player's mark is **gold**. Gold means "yours" and nothing else (section 5.3).
* The Wylls world is kept: the bell, the Engine at the Concord, six nations with their colours and sigils, villages, hosts, sealed marches. No new lore, no new game terms.

## 2. Hard constraints (from the code, the tests and recorded decisions)

* Presentation only. Off limits: `permutation-server/web/session.mjs`, `web/sdk/**`, `frontier/abi.mjs`, `frontier/wasm/**`, `frontier/council.html`, `frontier/council/**`, `permutation-gateway/citizens/**`, `test/citizens-*`, `docs/frontier/ai-citizens/**`, `frontier-node/**`, `frontier-abi/**`, `frontier-wasm/**`, `frontier-sim/**`, `permutation-rules/**`, `permutation-frontier/**`, `permutation-chain/**`, every `package.json` and lockfile, the older pages one level above `frontier/`. Additive only: `web/map.mjs`, `web/lang.mjs`. Keep the exports of `fgeo`, `fcodec`, `herald`, `fland`, `fmarch`, `fsession`, `wasm`, `faddr`, `people/identity`, `people/roster`.
* CSP: no inline `<style>`, `<script>` or `style=""` in HTML or in strings given to `innerHTML`; no CDN, no remote font or image; dynamic styling only through classes, data attributes and `el.style.setProperty('--x', …)`. Assets: svg, png, webp, woff2 only, referenced relative to the module or stylesheet. **No downloaded assets.** New textures are drawn by code (canvas) or authored as SVG in this repository.
* Strings: Japanese inline through `` L`…` `` / `` Lh`…` `` / `t()` with an English entry in `lang/en-frontier.mjs` or `lang/en-frontier-play.mjs`; canvas text also through `L`. Words: 国 / 村 (nation / village), host, seal, the Engine; AI citizens are shown exactly like people (no mark).
* Truth: effects and moments are driven by real records only (the demo switch of section 8.6 is the one labelled exception). Another nation's sealed march shows only that it left, its origin and its arrival turn: no line, arrow, heading or destination. The viewer's own destination may be drawn and is marked as visible only to them.
* Accessibility: text contrast at least 4.5:1, strokes 3:1; a nation is never identified by colour alone (sigils stay); targets at least 44 px below 760 px wide and 24 px above; visible focus; the canvas stays keyboard-operable; reduced motion is a complete mode (section 8.5); state changes synchronously and animation is visual only (the interaction tests read state right after input).
* Tests are part of the work: `node --test test/web-*.test.mjs screens/logic.screen.mjs screens/fixtures.screen.mjs` from `permutation-gateway` (fast), the screenshot matrix and interaction suite under `permutation-gateway/screens`. A test that pins the old presentation (first view, fog table, layout hooks) is rewritten in the same commit, never deleted, and the commit message says so. DOM hooks stay: `#bell-chip`, `#lang-box`, `#frontier-map`, `#panel`, `#panel-body`, `#tabs`, `nav.tabs`, `#attn-pill`, `#quota-chip`, `#intro`, `data-act`, `data-tab`, `data-map`, `data-sheet`, `data-sheet-handle`, `data-lod`, `data-terrain`.
* Three pages share the shell: `index.html` (play), `practice.html`, `spectate.html`. Spectate keeps the whole public world.

## 3. Visibility: the survey model (brief 2, 8, 9)

Nothing here is a rule of the game and nothing is secret: every account is public and the spectator page shows all of it. The play map draws **what the viewer has surveyed**. One function decides it for every surface (tile view, far views, minimap, labels, hover tips, search, inspector): `map/survey.mjs`.

| Level | Meaning | Drawn as |
|---|---|---|
| L0 cloud sea | ring not opened (the land does not exist yet) | existing cloud and bank sprites |
| L1 chart | opened ring, never in the viewer's sight | parchment with a sepia hex lattice and small drawn terrain glyphs (mountain, forest, water, plain) from the public ring seeds; **no** villages, hosts, names, nation wash, borders, battle marks |
| L2 surveyed | seen before, not in sight now | the painted tile, muted (saturation about 0.35, brightness about 0.7); villages with nation and tier; no hosts of other players, no live activity |
| L3 in sight | within sight of the viewer's villages and hosts now | everything, alive |

* Sight (presentation parameters, one table in `survey.mjs`): a village sees `3 + worked_radius(tier)` tiles (hamlet 4); a combat host 2; a scout host 3. Each tile the viewer explored, and its six neighbours, stay surveyed. The viewer's own march destinations (from the march book) are surveyed.
* Memory: surveyed = every tile ever at L3 this season. Rebuilt on load from villages, hosts, the viewer's own explore events and the march book; a compact per-season, per-wallet set in `localStorage` is merged in as a convenience of this device.
* The Engine at the Concord is always drawn as a landmark (everyone hears the bell); nothing around it is.
* Stages. Before joining: the chart only, behind the nation choice (section 9). Joined, waiting for the village: camera on the home wedge, the wedge outlined in the nation colour, the up to three candidate sites lit as small L3 discs with a dashed marker. Provisional village: L3 disc, own land with a dashed gold rim and the provisional tag. Final village: solid gold rim; hosts and explored tiles extend sight.
* Hosts: the viewer's own hosts are always drawn; every other host only at L3.
* The "show everything" checkbox leaves the play screen. Its honest replacement: a legend entry and one help line (JA 「地図には、あなたが見て測量した範囲を描いています。隠しているのではありません。チェーンの記録はすべて公開で、観戦ページでは全体を見られます。本当に見えないのは、封印した進軍の行き先と構え（到着のターンが終わるまで）と、探索の結果（そのターンの乱数が出るまで）だけです。」), and a link to the spectator page. Words to avoid: 隠す, 秘密, 敵から見えない, "fog of war hides". (This amends recorded default I-35 / O-M1-14 on the owner's point 9 of 2026-10-09; note it in `docs/frontier/DECISIONS.md` when the work is merged.)
* Reveal is a reward: tiles entering L3 for the first time dissolve out of the chart over about 900 ms, staggered outward by ring distance.
* The minimap, labels, tips and search use the same function. On the minimap: chart colour for L1, cloud for L0, the viewer's position as a pulsing gold pip.

## 4. Camera (brief 2, 4, 8)

* **Opening view is stage-aware** (one place replaces `fit()` as the default): village → fly to the active village's tile at the hero zoom (about 1.15 on a dpr-2 screen, 1.3 on dpr-1; hex about 95 px wide), centred in the part of the canvas no sheet covers; candidate sites → the first candidate's province; joined → the home wedge; not joined → the chart behind the nation choice; spectate and practice → as today. Priority: `?at=` > battle focus > home > fit. The fly starts when the first `/h/me` answer is in, lasts about 1.4 s (ease-out), and is cancelled by any pointer, wheel or key input.
* **Every camera move is a move**: `flyTo(target, ms)` with easing for home, minimap presses, go-to from lists, battle focus; drag inertia; pan softly clamped to the opened world plus a margin; wheel zoom eased. The logical view (what tests and picking read) changes at once; the drawn view interpolates toward it.
* **Useful zoom range, three semantic views**: near = the diorama (zoom ≥ 0.5); middle = villages and hosts over the painted land; far = **the chart**: the whole opened world as a drawn map on which only the surveyed land is painted. The far view is allowed at any time (it shows no one else's things) and is reached by wheel, by a "world chart" control and by M. The blurred far bitmap between zoom 0.2 and 0.5 is sharpened and crossfaded.
* **Tabletop tilt**: the ground is shown as a board seen from a seat, not a flat sheet: a CSS 3D transform of the map layer (perspective about 1600 px, tilt 14° to 20° at the near view, easing to 0° at the far view so the chart lies flat), an overscanned canvas inside a clipping wrapper, explicit inverse mapping for every pointer event, culling by the projected trapezoid. A haze gradient toward the top edge (horizon), a soft vignette and a slow cloud shadow complete the depth. The angle is a constant chosen from screenshots; `?tilt=<deg>` overrides it for trials; `?tilt=0` is the flat fallback and must stay correct. The baked art allows no more than about 22°.
* Units and props are depth-sorted together (a host north of a mountain is behind it).
* Phone: home and every fly centre on the part of the canvas above the sheet.

## 5. The land (brief 6, 8)

### 5.1 Your land in your colour
* The tiles worked by the viewer's own village (the same radius the wash already uses) are filled with the nation colour at 0.38 alpha fading inward, under the props, and outlined with a three-stroke border: dark ink underlay, nation colour, and a bright gold line that breathes slowly. Nation-mates' land keeps the quieter nation wash; other nations quieter still.
* A standard (pole and swallow-tail pennon in the nation colour with the sigil, gold finial) stands on the viewer's village at every zoom; at the far view it becomes a gold beacon pip with the village name.
* Provisional: dashed gold rim and the tag 「仮」/ "provisional". Words: 「村のまわり」/ "your village's land" (it is worked land, not conquered territory).
* Landing moment (first time the village exists on this device): fly to the tile, the colour floods outward ring by ring (about 90 ms per ring), the standard drops in with dust, the leader's first line, then the first objective.

### 5.2 Tiles you can act on light up
* Selecting an own village or an own host on the map lights the action tiles **at once** (no panel button first): march reach (move = pale teal-white, attack = ember red, back to an own village = gold), and for a scout the explore targets (sky blue). Fill at least 0.35, a 2.5 px rim with an outer glow, rolled out by ring distance (30 ms per ring), then breathing. Drawn after the ground and before props so trees and buildings stand on it, with a thin outline after the survey pass.
* Hover: a bright hexagon under the pointer; over a lit tile also the route as a ribbon with the arrival turn ("到着：ターン 44"). A tap on a lit tile starts the order card for that target; a tap on an unlit tile answers on the map ("ここへは届きません") and never fails silently.
* The selection ring is bright (gold for own, ivory for others), not dark ink.

### 5.3 Where am I
* The village plate (section 6) is always on screen: one press flies home, H does the same, a second press cycles villages.
* When the home village is off screen, a gold pointer sits at the screen edge on the line to it, with the distance in tiles; pressing it flies home. It exists on phones too.
* Names instead of coordinates wherever a person reads ("ラマールの町 — アステル" before "州 2,0").
* Gold is reserved: own rim, standard, home pointer, minimap pip, own-host ring. The guide ring becomes ivory; pins take the nation-neutral ink.

## 6. HUD and layout (brief 1, 5, 7)

The world gets the screen: at 1440×900 at least 80% of the viewport is map when nothing is open; on a phone the sheet rests at a peek of about 25%.

* **Top strip** (floating, translucent bell metal, 48 px): left, the nation crest and name; then resources with drawn icons and tabular numbers (a change counts up and flashes); right, the **turn dial**: a round bell face showing 「ターン 42」 and the time left, with a ring that drains; amber from 120 s and red from 30 s as today; at the toll it swings. Then the "next thing" button (the existing attention list: it names the most important pending thing and flies there), sound, language.
* **Village plate** (bottom left): leader or person chip, village name and tier, the active countdown, a home glyph. Above it at most two to-do lines. This replaces the left rail.
* **Action dock** (bottom centre on desktop; the bottom tab bar on phones): the existing tabs as icon-and-label buttons (map, village, hosts, marches, more). "Map" closes the drawer.
* **Drawer** (`#panel`): closed when nothing is selected or open. It slides in from the right (desktop) or is the existing sheet (phone) for a selection, an order being composed, a report, practice, the join flow or a dock press. Inside, parchment cards; the long forms are cut to cards with the common action first.
* **Minimap** (bottom right, round, brass rim): survey-aware; lens chips beside it.
* **Search**: an icon that opens the field.
* **Icons**: one authored SVG sprite (`art/ui/icons.svg`: grain, wood, stone, ore, horse, bell, sword, banner, scroll, compass, home, eye, seal, shield, scout, hammer, speaker, speaker-off, chart, plus, minus, close). 24 px grid, 1.75 px round strokes. No Unicode glyphs as icons.
* **Type**: four sizes (12, 14, 17, 24) and two families: the existing UI sans for controls and numbers, a serif stack for names and titles (`"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", Georgia, serif`). Tabular numerals for every number that changes.
* **Tokens** (added to `:root`; the paper tokens stay for documents):
  `--metal: #10221f; --metal-2: #18302b; --metal-glass: rgba(16,34,31,.82); --brass: #c9a24a; --brass-hi: #f0d48a; --brass-lo: #7d6428; --ivory: #f4efe0; --hud-ink: #e9e4d4; --hud-ink-2: #a9b8b1; --you: #f3d58a; --chart: #e6d9b8; --chart-ink: #7a6a46; --ember: #e2553d; --sky: #7fc4e8; --reach: #d8f3ea; --shadow: 0 6px 24px rgba(0,0,0,.35)`.
* **Turn wording**: the clock and counters read 「ターン」/ "Turn" with the bell icon beside them; 鐘 / bell stays as the thing in the world that tolls ("鐘が鳴りました — ターン 43"). Only the HUD clock, the toll banner, the to-do heading and toast stamps change; mechanics copy and the glossary keep both words with one line that ties them ("鐘が鳴るたびにターンが進みます").
* Internal words leave the play screen: テスト用ビーコン, キーパー, frontier.wasm, ランポート, 区画 N, マス N, M1 (they may stay under "more → details").

## 7. First minute (brief 2, 5)

1. **Title** (exists; keep its mood): the Engine's bell, six leaders, three lines. The call to action depends on the stage ("国を選ぶ" / "村へ戻る").
2. **Choose a nation**: six standing banners over the chart, each with the leader's portrait, the creed in one line, and the home wedge lit on the chart behind when hovered or focused. One choice, one confirm. No site picker (owner decision V2).
3. **The wait for the village** (the built behaviour: a drawn lottery, about 11 to 21 minutes): the camera rests over the home wedge; the candidate sites are marked; a visible countdown to the next turn; the practice battle is offered on the same screen. Nothing pretends the village exists.
4. **Landing** (section 5.1), then **one objective at a time** anchored on the map (an ivory ring and a single button), replacing the seven-chip guide card; the list of steps is available on demand.

## 8. Motion, effects, sound (brief 3, 5)

### 8.1 Engine
`frontier/fx/`: `clock.mjs` (the only reader of `performance.now()`; rate, freeze, seek), `ease.mjs` (outCubic, outBack, outElastic, inOutQuad, spring), `particles.mjs` (pooled, seeded by event id, world space; dust, spark, ember, smoke, shard, leaf, coin, mist, ink), `bus.mjs` (emit / subscribe), `engine.mjs` (a ground pass inside the tile painter after the territory wash; a top pass on a second transparent canvas above the map that runs its own frame loop only while something is live; a persistent `#fx-hud` layer for screen-space effects), `audio.mjs` (section 8.4). Pure, context-tolerant (the map tests draw into a proxy).

### 8.2 The recipe for every action (milliseconds)
Press answers within 100 ms (pressed state, sound). On the tile: flash 60 to 100 ms, 20 to 30 particles under 1 s, a label rising 0.6 to 1.2 s. Panels in 220 ms ease-out, out 160 ms. Pending and refused are states with a picture, not only text: a status chip with a progress ring while a transaction is tracked; a refusal shakes the control and shows a toast at the map with a retry.

### 8.3 The set pieces
* **Seal and depart**: the route draws on as a ribbon, a wax seal stamps at 56 px with squash and a brass ring, dust at the origin, the column sets off; the route stays as a sealed ribbon (own view only) until the turn.
* **The bell** (the game's heartbeat): at the toll a brass ripple crosses the map from the Engine (or from home when the Engine is off screen), the dial swings and refills with a flash, the banner 「鐘が鳴りました — ターン 43」, then this turn's own results play in order (own arrivals unseal with a flash, own battles, incoming), each offering "見る" to fly there. In the last 30 s the dial pulses.
* **Battle** (inside the existing 7.0 s phase contract): the camera flies in (500 ms) and the rest of the map dims; formations by stance and group size by troops (log scale); anticipation 150 ms, contact frames with 60 to 80 ms hit-stop, white hit flash, knockback, dust and sparks in both nations' colours, arrows with trails; world-layer shake 2 to 8 px for 120 to 250 ms on each exchange (never the HUD); loss numbers at 24 px or more and a draining strength bar per side; at the verdict a title across the map (勝利 / 撃退 / 壊滅 …) in the winner's colour; aftermath: the tile pulses in the winner's colour, a destroyed camp burns down. At the far view a crossed-swords pulse on the province.
* **Report**: a wide parchment card over the map with before/after troop bars and the outcome stamp, details on demand.
* **Build / harvest / muster / explore**: the building scales in with dust and a short brass shower; harvest icons fly to the resource strip, which counts up; a mustered host forms up; explored tiles dissolve from chart to painted land.
* **Idle life**: water shimmer, cloud shadows drifting, chimney smoke at villages, pennons moving. Cheap, off in reduced motion, never the only signal.

### 8.4 Sound
Synthesised with WebAudio (no audio files): the bell (inharmonic partials with long decay), the seal thunk, clash hits, a soft tick for presses, a shimmer for reveal, a low drum for incoming. Starts only after the first user gesture; a speaker button in the top strip mutes it (remembered); master level modest.

### 8.5 Reduced motion
One helper `motion()` (the media query plus the user's setting "effects: full / reduced / off"). Reduced: no travel, shake, particles or camera tweens; state changes at once with a 200 ms opacity change; numbers, verdicts and banners still appear; nothing relies on an animation to be visible.

### 8.6 Demo switch
`?fx=<name>[,<name>]&fxt=<seconds>&fxrate=<n>` plays a named effect from built-in sample data with the clock frozen or scaled, for screenshots and the demo video; `window.__fx.seek / step / play`. A corner tag "effects demo" is shown while it is active. It never fires in normal play.

## 9. Performance

Draw only when dirty or while an effect is live. Before any always-on animation at the near view, the static ground (ground pass and grid) of each province is cached in an offscreen bitmap as the far view already does; tiles are indexed by key; only the animated layers repaint on the timer. Budget: 8 ms a frame at 390 px wide, 12 ms at 1440 px; device pixel ratio capped at 2.

## 10. Definition of done

For each of the owner's nine points there is a before and an after screenshot at 1440×900 and 390×844, Japanese and English, from the real default URL (no preview flags), in the stages not joined, joined, village; the fast tests and the screenshot matrix pass with the deliberate test changes listed; the flat fallback (`?tilt=0`) and reduced motion are correct; no off-limits file changed (`git diff --stat frontier/ai-run -- <the list in section 2>` is empty); nothing claims secrecy, a rule or an event that does not exist.

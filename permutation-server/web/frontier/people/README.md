# People: players, their characters and crowds

The chain keeps no names. Each person's NAME is derived from the owner's `citizen_tag`, which is the first 8 bytes of the Citizen address (contract §4.1). Each person's FACE is the character of their nation: the six characters are the players (owner decision of 2026-10-09, `docs/frontier/DECISIONS.md` ZP1). Humans and AI citizens go through the same functions and look the same.

| Module | What it gives |
|---|---|
| `identity.mjs` | `identityOf(tag)` returns `{given, house, face}`. `displayName(id, {full, language})` gives `Kaito` or `Kaito Saford` / `カイト・サフォード`. `IDENTITY_VERSION` freezes the tables. |
| `faces.mjs` | A player's face: `playerFace(faction, {size, own})` (markup: the hexagon icon up to 64 px, the portrait card above) and `paintPlayerFace(ctx, faction, x, y, d, {own})` (a canvas). `own` adds the gold ring that says "yours". Every screen that shows a player asks here. |
| `avatar.mjs` | `sigilPath` and the faction colours. (`avatarSvg` / `avatarImage`, the flat generated portraits, are still in the file and are called by no screen: a test pins that.) |
| `leaders.mjs` | `CHARACTERS` (the six, by nation: no names, no titles), `DOCTRINE_PITCH`, and the one way a character's picture reaches a screen: `leaderSvg(faction, {size, own})`, `leaderHex`, `leaderFigure` (see "The six characters" below). "leader" in file and function names is from the day the six were drawn as the nations' leaders. |
| `leader-art.mjs` | Where the characters' pictures are (`leaderHexUrl`, `leaderPortraitUrl`, `leaderStillUrl`, `leaderStageUrl`), the stage clips (`STAGE_CLIPS`), the hexagon icon for a canvas (`leaderHexImage`), the ring that says "yours" (`YOURS`, `HEX_OUTLINE`). |
| `leader-sprite.mjs` | The sprite player: `leaderFigure(faction, {motion, once, when})` writes a canvas that the player paints; `spriteFrame`, `figurePose`, `createSpritePlayer`. It also hands the icons and busts their pictures. |
| `leader-motion.mjs` | The map's painter of a character, `paintLeaderMotion(ctx, x, y, height, {leader, motion, share, looping, face, alpha, own})`, with its data in `../leader-motion-data.mjs` (the package's sheets: idle, walk, attack, hit). Used by `onboard.mjs`, `battle.mjs` and the demo. |
| `onboard.mjs` | A player's character on the board: `setBoardCharacters(list)` (the page says who stands where), `characterTokens` (people/units.mjs adds them to a province's tokens), `paintCharacter`, `characterSpots`, the landing's walk. See "The characters on the board". |
| `outcome.mjs` | What became of a side of a clash, in one place: `sideOutcome(members)` and `verdictKey({own, foe, role})`. The battle's title, the tag under each side's losses and the report's stamp all ask it. |
| `leader-demo.mjs` | The demo `?fx=leaders`: the six on six tiles by the viewer's village, walking, striking, taking a hit. Loaded by `fx/demo.mjs` only. |
| `leaders.css` | The characters on the page and the nations' colours where a stylesheet carries them. Linked by the three pages after `frontier.css`. |
| `roster.mjs` | `createRoster({base})`, with `.ensure(ring)` and `.ownerOf(p, q, site, bell?)`. It reads the herald's `/h/roster/{ring}/latest.bin`; `frontier-node/crates/herald/src/roster.rs` defines the format. Without the file, no names are shown. |
| `scene.mjs` | `departuresAt(chronicle, overviews, bell)` gives the origin and arrival bell only. Also `exploresAt`, `namer(roster, {bell})` and `seedOwn(roster, holdings)`. |
| `crowds.mjs` | `paintPeople(ctx, {tiles, zoom, t, departures, explores, columnLabel})` and `paintNameTags(ctx, {tiles, zoom, nameOf, centre})`. Both work in world coordinates. |
| `ui.mjs` | `personChip(identity, faction, {own})` (the nation's character and the player's own name), `leaderCard` (a nation's card; no screen of the redesign calls it; the other line of work's join screen does, so it stays), `highlights(chronicle, overviews, roster)` and `renderHighlights`. |
| `minis.mjs` | The hosts' miniatures: `paintMini`, THE painter of a host's figure. See "Host art". |
| `profile.mjs` | The optional name the player sets, signed by the wallet and kept off the chain (`makeProfile` / `verifyProfile`). Where profiles are stored is an M2 decision. |

## Rules

- A sealed march shows only that it **left** and its **arrival bell**. Its column circles its own tile, with no line, no arrow and no heading. `departuresAt` never returns a destination.
- Level of detail, measured in screen pixels of hex radius:
  - Under 22: no figures.
  - 22–34: one resident per holding.
  - 34 and above: every resident and carrier.
  - Name tags: cities and strongholds from 30, every holding from 52, at most 60 per frame, nearest the view centre first.
  - At most 900 figures per frame.
- Spectators fetch one roster file per ring at most once a minute. The herald caches it per fold version, and nothing else reaches the server.

## The six characters

The pictures are the owner's six characters (art of 2026-10-09). `docs/frontier/art/leaders3d/STAGE.md` lists every file, where it came from and its size. Faction order: Aster red, Borealis sky cyan, Cinder yellow, Dunmar purple, Ember white, Fjordal orange. The same six colours are the nations' colours everywhere in the client (`../palette.mjs`).

**The six are the players** (owner decision of 2026-10-09, DECISIONS ZP1 to ZP3). A character is the look of every player of its nation; choosing a nation is choosing your character. A character has no name and no title: a nation is shown by its name, its sigil, its doctrine and its character, and the lines that were a leader's lines are the nation's words, with no named speaker. A player's own name is the player's (`identity.mjs`, unchanged).

One source of truth for the pictures, `leaders.mjs`; one for a player's face, `faces.mjs`:

| Call | Gives | Where |
|---|---|---|
| `playerFace(f, {size, own})` | A player's face: up to 64 px the hexagon icon, above it the portrait card; `own` puts it in the gold ring (a second hexagon outside the icon's own frame: bright gold, an ivory core, a dark keyline). Nothing for a side that is no nation. | the village plate, the inspector's lord and its hosts' owners, the report's two sides and its rows, the spectator's highlights, the "your name" card |
| `leaderSvg(f, {size})` | The same pictures for a NATION (no ring). `shape: 'hex' \| 'card'` asks for one at any size; `sigil: true` adds the nation's sigil to the icon. | standings, the legend's key, the crest chip of the top plaque (`hud.leaderCrest`), the inspector's nation chip, a phone's nation banners |
| `leaderFigure(f, {motion, once, when})` | The character standing, three-quarter view: a canvas of one stage cell (288 × 360) that the sprite player paints; `leaders.css` and `frontier.css` say how tall it is where it stands. | the title (the six in a row), the nation banners, the confirm line, the first-village banner and the other milestones, the report's quotation, the wait view's stage |

All of it is markup with attributes only (the page allows no style attribute). A picture that has not loaded leaves its place empty at its final size. The icon is shown at 30 px or more (below that the face is a blot of colour: `faces.mjs FACE_MIN`), and a stage figure is never mirrored (Aster's badge, Cinder's clasp and Ember's emblem sit on one side).

**No picture is named in markup on a page.** The servers send every file with `Cache-Control: no-store`, so a picture named in markup is fetched again, and blinks, each time that markup is written again. The sprite player holds the pictures instead: one fetch a file a page, none for a part of the page that is put away. It paints the figures' canvases, and it gives each icon and bust (an SVG `<image data-art="…">`, `leader-art.mjs artImage`) its picture as a data URL; once a picture is held, markup carries it at once. Without a page (the tests) markup names the file.

**Motion on the page.** `leader-sprite.mjs` is the only player of the stage figures. Time comes from the effects clock (`globalThis.__fxNow`), so the demo switch can freeze and step it. `idle` breathes (4 frames, 2 s, each a little out of step with the next); `attack` is the flourish (8 frames, 0.8 s), played once per `once` name and followed by breathing. A flourish begins when its sheet is here and the press is 150 ms old; a banner that would play one has the sheet fetched when it is focused or pressed, or when a pointer has rested on it; `when: 'look'` moves a figure only while its `[data-nation]` holder is hovered, focused or chosen. A figure out of view is not touched, and with nothing moving the loop stops. Reduced motion (the system's setting or the player's own, `fx/motion.mjs`) is a complete mode: every figure is its still, the flourish does not play and no sheet is fetched.

## The characters on the board (`onboard.mjs`)

In normal play the viewer's own character stands beside the viewer's active village, and another player's character stands beside that player's village while that village is selected. This shows real things (a player, that player's village) and invents no event: a character never leaves its village, never marches, and is no unit of the game. The package's walk sheet is used for the first village's landing and inside the demo only.

The page says who stands where (`app.mjs boardCharactersNow` → `setBoardCharacters`, every frame: `{p, q, tile, faction, own, tier, pending}`). The tile painter's token pass (`map/sprites.mjs`) asks `units.mjs provinceTokens`, which appends one token for each character whose village is drawn in that province (`characterTokens`); `paintToken` hands such a token to `paintCharacter`. So a character is sorted by depth with the hosts, cut behind what stands in front of it, fades with the far haze, and is repainted on the animated layer only. No hook of `map/**` was added for it. It is drawn at the size the package was approved at (`LEADER_DRAW_SCALE` 1.30 of a host's token unit, as in the package's `game-fit.png`), upright on the tilt (`map/tilt.mjs standing`), on a soft shadow and a ring on the ground: bright gold with an ivory core and a dark keyline for the viewer's own (`leader-art.mjs YOURS`), ivory for another player's.

Where it stands (`characterSpots(own, tier)`): outside the palisade at the village's right-hand foot, by the village's tier and the scale it is drawn at, clear of the plate, the standard, a building's scaffold and the hosts before the gate; if hosts stand there, the left-hand foot, then the ground before the gate. At a landing (`fx` bus `landing`, said by the map when the colour starts to flood) the character waits for the land, walks in from its left on the walk sheet (`LANDING_WALK`) and stands. Sheets are fetched lazily (the viewer's nation's idle sheet as soon as the nation is known, the walk sheet while a landing is on its way, another nation's idle sheet when its village is selected) and decoded before they are called ready; a figure comes in over 0.3 s from the first frame its sheet is here, so it never pops. Reduced motion: the first frame of the idle sheet, no walk, there at once. Below the zoom at which the map draws hosts as figures (`map/sprites.mjs HOST_FIGURE_MIN_R`) no character is drawn either.

In a battle scene (`battle.mjs`) each nation's side has its player's character behind its formation, facing the enemy: the attack sheet on an exchange its side wins, the hit sheet on one it loses, idle between (`exchangeWinners`, `characterAct`); a camp has none.

## Host art

The owner will hand over the armies' art later. **One function draws a host's figure everywhere: `minis.mjs paintMini(ctx, x, y, s, kind, opts)`.** The board's tokens (`units.mjs paintToken`), the columns and musters of the set pieces (`fx/pieces.mjs figureFlat`) and the battle scene (`battle.mjs paintFigureFlat`) all call it and nothing else reads the sheets (a test pins both). It takes the feet's place `(x, y)`, the token's height unit `s` (world px: about `RADIUS * 0.66` on the board, a layout's figure height in a battle), the unit kind, and `{faction, face (±1), step (0..1), walking, alpha, lunge, own (the gold ring), pulse, shade (how much of a baked ground shadow is kept), camp (a fighter of the neutral camp), flash (a blow's light)}`; it returns false until its sheet is here, and the caller then draws the old canvas figure (`units.mjs unitFigure`) or only a shadow.

To plug in new art, change `minis.mjs` and nothing else. Today's sheets are `art/units/@1x|@2x/units_<faction>.webp`: one sheet a nation, 6 columns (facing right: standing, step A, step B; then the same three facing left) by 8 rows (`MINI_KINDS`: spearman, archer, horseman, pikeman, crossbowman, knight, scout, settler), square cells of 160 px (@1x) and 320 px (@2x; chosen when a cell is drawn larger than 150 device px). A cell spans `MINI_CELL_U` (2.42) token heights, so a standing figure is about 1.15 `s` tall; the feet stand at `MINI_ANCHOR` (0.42 of the cell's width, 0.74 of its height); the base's radius is `miniBaseR(kind)`. New sheets with the same layout only need the files replaced (and the constants if the cell, the anchor or the figure's share of the cell differ). A different layout (more frames, a strip per motion as the characters' package has, no facing-left columns) needs `miniCell` (which cell for `{face, walking, step}`), `miniSheet` (which file) and the `drawImage` in `paintMini` changed, and `tintCell` / `campCell` / `softCell` follow because they cut the same cell. If the new art carries no baked cast shadow, `softCell` and the `shade` option can go and `paintMini` should draw a soft ellipse at the feet instead; if it carries no base disc, draw `units.mjs baseDisc` first. The unit cards of the panels are separate files (`art/units/cards/<faction>_<kind>.webp`, `miniCardUrl`).

```bash
node --test permutation-gateway/test/web-frontier-players.test.mjs permutation-gateway/test/web-frontier-leader-art.test.mjs permutation-gateway/test/web-frontier-leader-sprite.test.mjs \
  permutation-gateway/test/web-frontier-leader-motion.test.mjs permutation-gateway/test/web-frontier-leader-demo.test.mjs
```

## Using it from another page (replay)

The map draws people itself when its source has `people()`:

```js
import { createRoster } from './people/roster.mjs';
import * as scene from './people/scene.mjs';
const roster = createRoster({ base });            // roster.ensure(d) for each open ring
source.people = () => ({
  departures: scene.departuresAt(records, overviews, bell),
  explores: scene.exploresAt(records, overviews, bell),
  nameOf: scene.namer(roster, { bell }),          // only owners founded by `bell`
  columnLabel: d => `Arrives at bell ${d.arriveBell}`,
});
```

A canvas overlay that draws its own scene can call `paintPeople` and `paintNameTags` directly instead, with tiles of the form `{x, y, p, pq, idx, site, state, owner, tier, fog}`.

## The lords and the life of each holding (`life.mjs`)

The chronicle is public. Each holding's record is built from these entries:

- HARVEST, BUILD (item, `done_at`) and TRAIN (unit, n, `done_at`), keyed by P, Q, site.
- MUSTER, DEPART and EXPLORE, through the host id.
- SETTLE.

Every record the page reads is folded in with `updateLife(map, records)`. `lifeAt(rec, bell, now)` then says what is visible:

| Field | Meaning |
|---|---|
| `lord`, `doing` | The lord is out (they acted in the last 2 bells) and what they are doing |
| `building`, `training` | Work is under way: `now < done_at` |
| `harvesting`, `working` | Carriers for 1 bell after a harvest; field hands for 6 bells after it |
| `liveliness` | How many townsfolk are out |

`crowds.paintPeople` draws from this. Pass these four options:

- `life`, the map
- `bell`
- `now`, in chain seconds
- `lordOf(p, q, site)`, which returns the holder's identity so the lord wears their own face

The page also ties `paintNameTags({present})` to the same map, so lords who are out are named from afar.

### In the replay page: the life of a past bell

The replay already reads the season's records bell by bell. Fold them into one map as the playhead moves, and ask for that bell:

```js
import { updateLife } from './people/life.mjs';
import { bellEnd } from './clock.mjs';
const life = new Map();
// whenever the playhead passes bell b: fold that bell's records (the replay reads them anyway)
updateLife(life, recordsOfBell(b));
source.people = () => ({
  ...otherPeopleInputs,
  life, bell: shownBell,
  now: bellEnd(genesisTs, shownBell) - 60,       // inside the bell shown
  lordOf: (p, q, site) => { const o = roster.ownerOf(p, q, site, shownBell); return o ? identityOf(o.tag) : null; },
});
```

Going back in time needs the map rebuilt from the start, or a snapshot per bell. A record only moves a holding forward, so folding from bell 0 up to the shown bell is always correct. The design session checks this with a script that rebuilds bell 592 from the 41040 log.

Tiers come from the roster. Its 16-byte site carries the tier, and `roster.tierOf(p, q, site)` reads it. The far view uses them without loading provinces.

### The season replay's people and battles (people/replay.mjs, UI plan F3)

The replay page reads per-bell overviews and, at tile detail, the envelopes of the bell shown — and nothing else. `createReplayPeople` turns that into the map's `people()` input: holders' names founded by the bell shown (the roster), tier names, and the battles of the bell the playhead enters (ClashInputs of the envelope, the province before and after), played fast:

```js
import { createReplayPeople } from '../people/replay.mjs';
import { createRoster } from '../people/roster.mjs';
const roster = createRoster({ base, onChange: () => map.invalidate() });  // roster.ensure(d) for each open ring
const rp = createReplayPeople({ roster });
// in source():
people: () => rp.at(S.shown, { envelopes: visible.map(([p, q]) => S.provinces.at(p, q, S.shown)), before: (p, q) => S.provinces.at(p, q, S.shown - 1)?.province ?? null }),
// in enter(b):
rp.enter(b);
```

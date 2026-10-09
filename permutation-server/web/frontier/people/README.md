# People: players, leaders and crowds

The chain keeps no names. Each person is derived from the owner's `citizen_tag`, which is the first 8 bytes of the Citizen address (contract §4.1). Humans and shades go through the same function and look the same.

| Module | What it gives |
|---|---|
| `identity.mjs` | `identityOf(tag)` returns `{given, house, face}`. `displayName(id, {full, language})` gives `Kaito` or `Kaito Saford` / `カイト・サフォード`. `IDENTITY_VERSION` freezes the tables. |
| `avatar.mjs` | `avatarSvg(id, faction, {size})` returns markup. `avatarImage(id, faction, onLoad)` returns an `<img>` for canvases. Also `sigilPath` and the faction colours. |
| `leaders.mjs` | `LEADERS` (six names and titles), `DOCTRINE_PITCH`, and the one way a leader's picture reaches a screen: `leaderSvg(faction, {size})`, `leaderHex`, `leaderFigure` (see "The six leaders" below). |
| `leader-art.mjs` | Where the leaders' pictures are (`leaderHexUrl`, `leaderPortraitUrl`, `leaderStillUrl`, `leaderStageUrl`), the stage clips (`STAGE_CLIPS`), the hexagon icon for a canvas (`leaderHexImage`). |
| `leader-sprite.mjs` | The sprite player: `leaderFigure(faction, {size, motion, once, when})` writes a still that the player moves; `spriteFrame`, `figurePose`, `createSpritePlayer`. |
| `leader-motion.mjs` | The map's painter of a leader figure, `paintLeaderMotion(ctx, x, y, height, {leader, motion, share, looping, face, alpha, own})`, with its data in `../leader-motion-data.mjs`. Ready, not wired into play. |
| `leader-demo.mjs` | The demo `?fx=leaders`: the six on six tiles by the viewer's village. Loaded by `fx/demo.mjs` only. |
| `leaders.css` | The leaders on the page and the nations' colours where a stylesheet carries them. Linked by the three pages after `frontier.css`. |
| `roster.mjs` | `createRoster({base})`, with `.ensure(ring)` and `.ownerOf(p, q, site, bell?)`. It reads the herald's `/h/roster/{ring}/latest.bin`; `frontier-node/crates/herald/src/roster.rs` defines the format. Without the file, no names are shown. |
| `scene.mjs` | `departuresAt(chronicle, overviews, bell)` gives the origin and arrival bell only. Also `exploresAt`, `namer(roster, {bell})` and `seedOwn(roster, holdings)`. |
| `crowds.mjs` | `paintPeople(ctx, {tiles, zoom, t, departures, explores, columnLabel})` and `paintNameTags(ctx, {tiles, zoom, nameOf, centre})`. Both work in world coordinates. |
| `ui.mjs` | `personChip`, `leaderCard`, `highlights(chronicle, overviews, roster)` and `renderHighlights`. |
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

## The six leaders

The pictures are the owner's six characters (art of 2026-10-09). `docs/frontier/art/leaders3d/STAGE.md` lists every file, where it came from and its size. Faction order: Aster red, Borealis sky cyan, Cinder yellow, Dunmar purple, Ember white, Fjordal orange. The same six colours are the nations' colours everywhere in the client (`../palette.mjs`).

One source of truth, `leaders.mjs`:

| Call | Gives | Where |
|---|---|---|
| `leaderSvg(f, {size})` | Up to 64 px: the hexagon icon (square). Above: the portrait card, the bust before a cloth of the nation's colour (4 : 5). `shape: 'hex' | 'card'` asks for one at any size; `sigil: true` adds the nation's sigil to the icon. | standings, the versus band of a report, the plate when the viewer has no face of their own, faction cards |
| `leaderHex(f, {size, sigil})` | The hexagon icon. | the crest chip of the top plaque (`hud.leaderCrest`), the inspector's nation chip, a phone's nation banners |
| `leaderFigure(f, {size, motion, once, when})` | The leader standing, three-quarter view, `size` px tall: a still that the sprite player moves. | the title (the six in a row), the nation banners, the confirm line on a phone, the first-village banner and the other milestones, the report's quotation, the wait view's head |

All of it is inline SVG with attributes only (the page allows no style attribute). A picture that has not loaded leaves its place empty at its final size. The flat vector busts are gone; nothing falls back to them.

**Motion.** `leader-sprite.mjs` is the only player. Time comes from the effects clock (`globalThis.__fxNow`), so the demo switch can freeze and step it. `idle` breathes (8 frames, 2 s, each leader a little out of step with the next); `attack` is the flourish (8 frames, 0.8 s), played once per `once` name and followed by breathing; `when: 'look'` moves a figure only while its `[data-nation]` holder is hovered, focused or chosen. A figure out of view is not touched, and with nothing moving the loop stops. Reduced motion (the system's setting or the player's own, `fx/motion.mjs`) is a complete mode: every figure is its still, the flourish does not play and no sheet is fetched.

**Truth.** The game has no leader that walks the map. A figure on the page stands beside the leader's name or line. The map painter `paintLeaderMotion` (feet anchor, height in the unit a host's token uses, drawn 1.30 times as large, facing, clip and time share, the gold ring for the viewer's own) is ready for a time when the game has such an actor; today only `?fx=leaders` uses it, under the corner tag of the effects demo. `web-frontier-leader-demo.test.mjs` checks that nothing else imports it.

```bash
node --test permutation-gateway/test/web-frontier-leader-art.test.mjs permutation-gateway/test/web-frontier-leader-sprite.test.mjs \
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

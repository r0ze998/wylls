// The six are the players (UX design 13; DECISIONS ZP1 to ZP3): every place that shows a player's face shows the
// character of that player's nation, the viewer's own in the gold ring; the flat generated portrait is on no screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { playerFace, paintPlayerFace, FACE_MIN } from '../../permutation-server/web/frontier/people/faces.mjs';
import { leaderHex, HEX_OUTLINE, YOURS } from '../../permutation-server/web/frontier/people/leader-art.mjs';
import { leaderSvg } from '../../permutation-server/web/frontier/people/leaders.mjs';
import { personChip, renderHighlights, isOwnIdentity } from '../../permutation-server/web/frontier/people/ui.mjs';
import { identityOf } from '../../permutation-server/web/frontier/people/identity.mjs';
import { contrast } from '../../permutation-server/web/frontier/palette.mjs';
import * as P from '../../permutation-server/web/frontier/palette.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
const flat = x => String(x);

test('a player\'s face is the character of the player\'s nation: the hexagon icon up to 64 px, the portrait card above; no nation, no face', () => {
  for (let f = 0; f < 6; f++) {
    const face = playerFace(f, { size: 36 });
    assert.match(face, new RegExp(`^<svg [^>]*width="36" height="36" class="leader leader-hex" data-leader="${KEYS[f]}" aria-hidden="true"`));
    assert.doesNotMatch(face, /data-own|leader-own|class="avatar/);
    assert.equal(face, leaderHex(f, { size: 36 }), 'one source for the icon');
    assert.match(playerFace(f, { size: 96 }), /class="leader leader-card-art"/, 'large: the portrait card');
    assert.match(playerFace(f, { size: 20 }), new RegExp(`width="${FACE_MIN}" height="${FACE_MIN}"`), 'never smaller than the icon reads');
    assert.doesNotMatch(face, /style=/);
  }
  for (const none of [6, -1, null, undefined, 2.5, '1']) assert.equal(playerFace(none), '', 'a camp or an unknown owner has no face');
});

test('the viewer\'s own face carries the gold ring: a second hexagon outside the icon, bright gold with an ivory core on a dark keyline', () => {
  for (let f = 0; f < 6; f++) {
    const own = playerFace(f, { size: 48, own: true });
    assert.match(own, new RegExp(`class="leader leader-hex leader-own" data-leader="${KEYS[f]}" data-own="1"`));
    assert.ok(own.includes(`<path d="${HEX_OUTLINE}" stroke="${YOURS.key}" stroke-width="11"/><path d="${HEX_OUTLINE}" stroke="${YOURS.gold}" stroke-width="6.5"/><path d="${HEX_OUTLINE}" stroke="${YOURS.core}" stroke-width="1.6"/>`));
    assert.match(own, /<image [^>]*x="9\.94" y="9\.64" width="80" height="80"\/>/, 'the icon at four fifths inside the ring');
    // the ring is told from every nation's own frame: by the dark keyline between them, and by its colour against the nation's
    assert.ok(contrast(YOURS.gold, YOURS.key) >= 7, 'gold on its keyline');
    const card = leaderSvg(f, { size: 120, own: true });
    assert.match(card, /class="leader leader-card-art leader-own"[^>]*data-own="1"/);
    assert.ok(card.includes(`stroke="${YOURS.gold}" stroke-width="5"`));
  }
  // yellow Cinder and orange Fjordal: the ring is not their cloth's colour
  assert.notEqual(YOURS.gold.toLowerCase(), P.NATION_FILL[2].toLowerCase());
  assert.notEqual(YOURS.gold.toLowerCase(), P.NATION_FILL[5].toLowerCase());
});

test('a person chip: the nation\'s character and the player\'s own name; the viewer\'s is marked', () => {
  setLang('ja');
  const id = identityOf(0x1234567890abcdefn);
  const chip = flat(personChip(id, 3, { full: true }));
  assert.match(chip, /^<span class="person"><svg [^>]*width="30" height="30" class="leader leader-hex" data-leader="dunmar"/);
  assert.match(chip, /<span class="person-name" data-name>[^<]+<\/span><\/span>$/, 'the player\'s own name stays');
  const mine = flat(personChip(id, 3, { own: true, size: 44 }));
  assert.match(mine, /^<span class="person person-own"><svg [^>]*width="44" height="44" class="leader leader-hex leader-own" data-leader="dunmar" data-own="1"/);
  assert.doesNotMatch(chip + mine, /class="avatar|<linearGradient id="av/);
  // a side that is no nation: the name alone
  assert.match(flat(personChip(id, 6)), /^<span class="person"><span class="person-name" data-name>/);
  assert.equal(personChip(null, 3), '');
  // AI citizens look exactly like people: the face depends on the nation alone
  const other = identityOf(0xfedcba0987654321n);
  const svgOf = m => m.slice(0, m.indexOf('</svg>'));
  assert.equal(svgOf(flat(personChip(other, 3))), svgOf(chip), 'two players of one nation wear the same face');
  // the viewer's own identity is told by the citizen tag
  assert.equal(isOwnIdentity({ holdings: [] }, id), false);
  assert.equal(isOwnIdentity({}, null), false);
});

test('the spectator\'s highlights: who did it wears the nation\'s character; a clash of several nations has a dot', () => {
  setLang('ja');
  const id = identityOf(77n);
  const out = flat(renderHighlights([{ kind: 'depart', bell: 40, faction: 1, identity: id, text: 'x' }, { kind: 'clash', bell: 40, faction: null, identity: null, text: 'y', clash: true }]));
  assert.match(out, /<li class="hl-depart"><svg [^>]*width="30" height="30" class="leader leader-hex" data-leader="borealis"/);
  assert.match(out, /<li class="hl-clash"><span class="hl-dot" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(out, /class="avatar/);
});

test('a face on a canvas: the icon, and for the viewer\'s own the ring round it; nothing for no nation or before the picture is here', () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === 'drawImage' ? (...a) => calls.push(['drawImage', ...a.slice(1)]) : typeof k === 'string' && /^(save|restore|beginPath|moveTo|lineTo|closePath|stroke)$/.test(k) ? (...a) => calls.push([k, ...a]) : undefined), set: () => true });
  assert.equal(paintPlayerFace(ctx, 6, 0, 0, 20), false);
  assert.equal(paintPlayerFace(ctx, 2, 0, 0, 20), false, 'no Image in a test: the caller draws its stand-in');
  assert.equal(calls.length, 0);
});

test('no screen of the client draws the flat generated portrait any more', () => {
  const files = [];
  const walk = dir => { for (const e of readdirSync(new URL(dir, WEB), { withFileTypes: true })) { if (e.isDirectory()) { if (!['council', 'art', 'wasm'].includes(e.name)) walk(`${dir}${e.name}/`); } else if (e.name.endsWith('.mjs')) files.push(`${dir}${e.name}`); } };
  walk('');
  const users = files.filter(f => f !== 'people/avatar.mjs' && /\bavatarSvg\(|\bavatarImage\(/.test(readFileSync(new URL(f, WEB), 'utf8')));
  assert.deepEqual(users, [], 'avatarSvg / avatarImage are called nowhere (the file keeps the colours and the sigils)');
  // the identity module's exports are as they were (other code imports them)
  const idSrc = readFileSync(new URL('people/identity.mjs', WEB), 'utf8');
  for (const name of ['identityOf', 'displayName', 'tagOf', 'placeName', 'withProfile', 'tagKey', 'IDENTITY_VERSION', 'SKIN', 'HAIR', 'EYES']) assert.match(idSrc, new RegExp(`export (const|function) ${name}\\b`), name);
});

// ------------------------------------------------------------------ the character on the board (people/onboard.mjs)
import { project, RADIUS, FLATTEN } from '../../permutation-server/web/map.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { LEADER_MOTIONS, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE, LEADER_SPRITE_ANCHOR, LEADER_FIGURE, BOARD_CHARACTER_SCALE, LEADER_BREATH } from '../../permutation-server/web/frontier/leader-motion-data.mjs';
import { HERO, VILLAGE_SCALE } from '../../permutation-server/web/frontier/map/plates.mjs';
import { VILLAGE } from '../../permutation-server/web/frontier/map/village.mjs';
import { provinceTokens } from '../../permutation-server/web/frontier/people/units.mjs';

let life = 0;
// A page's Image for the rest of this file (the board module and the map painter share one sheet cache, whichever
// test first asks for a sheet), and every picture asked for so far.
const requests = [];
// (a sheet of the 2x set has frames of 512 px, and eight of them for the idle: leader-motion-data.mjs LEADER_SHEET_SETS)
const loadAll = () => { for (const img of requests) { const m = LEADER_MOTIONS.find(x => img.src?.endsWith(`_${x.key}.webp`)), fine = /sprite@2x\//.test(img.src ?? ''); if (m && !img.width) img.load((fine ? 512 : 256) * (fine && m.key === 'idle' ? 8 : m.frames), fine ? 512 : 256); } };
/** A fresh copy of the board module (its registry) and a context that records its calls. */
async function board() {
  globalThis.Image = class { constructor() { requests.push(this); } load(w, h) { this.width = w; this.height = h; this.onload?.(); } };
  const tag = `?board=${++life}`;
  const O = await import(`../../permutation-server/web/frontier/people/onboard.mjs${tag}`);
  const calls = [], state = { globalAlpha: 1, stack: [] };
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'globalAlpha') return state.globalAlpha;
      if (k === 'save') return () => state.stack.push(state.globalAlpha);
      if (k === 'restore') return () => { state.globalAlpha = state.stack.pop(); };
      return (...a) => { calls.push([k, ...a]); };
    },
    set(_, k, v) { if (k === 'globalAlpha') state.globalAlpha = v; else calls.push(['set', k, v]); return true; },
  });
  return { O, ctx, calls, requests, loadAll, draws: () => calls.filter(c => c[0] === 'drawImage') };
}

// (The tests of this part were rewritten on 2026-10-10 for the owner's decision "make it larger" (DECISIONS ZQ1, ZQ2):
// they pinned a figure at the package's own size standing at the palisade's right-hand foot under the standard, with
// no look at the ground. They now pin the size rule, the spot of the larger figure and the rule of the ground.)
const HOME = tileHex(2, 0, 7), C0 = project(HOME.q, HOME.r);
/** The spot `[dx, dy]` (hex radii) as a world point by the fixture's village. */
const world = ([dx, dy]) => ({ x: C0.x + dx * RADIUS, y: C0.y + dy * RADIUS });

test('the size rule: one number and one size in the world; beside a village a character is as large as that village is drawn', async t => {
  const { O } = await board(t);
  assert.equal(BOARD_CHARACTER_SCALE, 2, 'twice the size the package was approved at (the owner, 2026-10-10: "make it larger")');
  assert.equal(LEADER_DRAW_SCALE, 1.3, 'the package\'s own number stays');
  assert.equal(O.CHARACTER_SCALE, BOARD_CHARACTER_SCALE);
  assert.equal(O.CHARACTER_UNIT, RADIUS * 0.66 * 2, 'a host\'s token unit at an ordinary zoom, twice');
  assert.equal(O.characterUnit(), O.CHARACTER_UNIT); assert.equal(O.villageShare(true), 1); assert.equal(O.villageShare(false), VILLAGE_SCALE / HERO.scale);
  assert.equal(O.characterUnit(O.villageShare(false)), O.CHARACTER_UNIT * VILLAGE_SCALE / HERO.scale, 'another player\'s: in proportion to its smaller village');
  assert.equal(B.CHARACTER_STAND.unit, O.CHARACTER_UNIT, 'and the same size behind a line in a battle scene');
  // the body, from the sheets' own measure (hex radii)
  const body = O.characterBody(), cell = 0.66 * 2 * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  assert.ok(Math.abs(body.cell - cell) < 1e-12);
  assert.deepEqual([body.up, body.down, body.half], [LEADER_FIGURE.up * body.cell, LEADER_FIGURE.down * body.cell, LEADER_FIGURE.half * body.cell]);
  assert.equal(O.characterHeight(60), 60 * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE * LEADER_FIGURE.up);
  // beside the viewer's town: about as tall as the town's tower, under the standard's pole, and more than twice a
  // host's figure (a host's token unit is 0.66 of a hex radius)
  const tower = VILLAGE.top[1] * HERO.scale * 0.8, pole = 1.5 * 1.15;
  assert.ok(body.up > tower * 0.95 && body.up < tower * 1.25, `the head stands ${body.up.toFixed(2)} radii up, the tower's roof about ${tower.toFixed(2)}`);
  assert.ok(body.up < pole && body.up > 2 * O.TOKEN_UNIT);
  assert.ok(Math.abs(O.STANDARD_SHARE - body.up / pole) < 1e-12, 'and that share of the pole is the wait view\'s rule');
  // the picture's box for the map's scratch (world px)
  assert.deepEqual(O.characterCell(), { cell: O.CHARACTER_UNIT * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE, ax: LEADER_SPRITE_ANCHOR[0], ay: LEADER_SPRITE_ANCHOR[1] });
  assert.equal(O.characterCell(0.5).cell, O.characterCell().cell / 2);
});

test('where a character stands: a body clear of the palisade, of the standard\'s pole, of the scaffold and of the hosts, in every tier; the last spot is on its own tile', async t => {
  const { O } = await board(t);
  const here = O.hexAt(C0.x, C0.y);
  assert.deepEqual(here, { q: HOME.q, r: HOME.r });
  for (const own of [true, false]) for (let tier = 0; tier < 4; tier++) for (const unit of [O.TOKEN_UNIT, O.TOKEN_UNIT * 1.3]) {
    const spots = O.characterSpots(own, tier, unit), B = O.characterBody(O.villageShare(own)), where = `tier ${tier}${own ? ' (own)' : ''} unit ${unit.toFixed(2)}`;
    assert.equal(spots.length, 5);
    const [[rx0, ry0], [lx0, ly0], [fx, fy], [gx, gy], [hx, hy]] = spots;
    const rx = VILLAGE.ring[tier] * (own ? HERO.scale : VILLAGE_SCALE), cy = (own ? HERO.at.y : -RADIUS * 0.04) / RADIUS, foot = cy + rx * FLATTEN * 0.8;
    // right and left of the village: the whole body outside the palisade
    assert.ok(rx0 - B.half >= rx + 0.09 && -lx0 - B.half >= rx + 0.09, `${where}: outside the palisade`);
    assert.equal(ry0, ly0); assert.ok(ry0 > cy && ry0 < foot, `${where}: beside the houses, not behind them and not before the gate`);
    if (own) {
      assert.ok(rx0 - B.half >= HERO.standard.x / RADIUS + 0.1, `${where}: to the right of the standard's pole, a hand clear of it`);
      assert.ok(ry0 - B.up > HERO.standard.y / RADIUS - 1.5 * 1.15 + 0.5, `${where}: the head under the standard's cloth`);
      assert.ok(-lx0 - B.half >= -HERO.scaffold.x / RADIUS + 0.4, `${where}: to the left of the scaffold and its ring`);
    }
    // level with the hosts, outside them on either side
    assert.equal(fx, -gx); assert.equal(fy, gy); assert.ok(fy > foot, `${where}: before the palisade's foot`);
    // the last: on the village's own tile, at the foot of the gate road
    assert.deepEqual(O.hexAt(C0.x + hx * RADIUS, C0.y + hy * RADIUS), here, `${where}: the last spot is on the village's own tile`);
    assert.ok(Math.abs(hx) < 0.1 && hy + B.down * 0.5 <= 0.76 + 1e-9);
    // no spot covers a host that stands before the gate (every arrangement of one to three groups)
    const hostSpots = own ? HERO.hosts : [[[0.44, 0.4]], [[0.44, 0.4], [-0.1, 0.62]], [[0.44, 0.4], [-0.1, 0.62], [-0.5, 0.36]]];
    for (const groups of hostSpots) for (const [dx, dy] of groups) {
      const host = { x: C0.x + dx * RADIUS, y: C0.y + dy * RADIUS * FLATTEN * 1.6 };
      for (const sp of spots.slice(0, 4)) assert.equal(O.coversHost(world(sp), host, unit * RADIUS, O.villageShare(own)), false, `${where}: spot ${sp.map(v => v.toFixed(2))} and the host at ${dx},${dy}`);
    }
  }
  // (the hosts' places by another's village, as the token painter has them: the list above is that table)
  assert.match(readFileSync(new URL('people/units.mjs', WEB), 'utf8'), /const SPOTS_HOLDING = \[\[\[0\.44, 0\.4\]\], \[\[0\.44, 0\.4\], \[-0\.1, 0\.62\]\], \[\[0\.44, 0\.4\], \[-0\.1, 0\.62\], \[-0\.5, 0\.36\]\]\];/);
  // the viewer's own town at the hero frame: the first four spots are on the tiles next door
  for (const sp of O.characterSpots(true, 1).slice(0, 4)) assert.notDeepEqual(O.hexAt(world(sp).x, world(sp).y), here);
  assert.deepEqual(O.hexAt(world(O.characterSpots(true, 1)[0]).x, world(O.characterSpots(true, 1)[0]).y), { q: HOME.q + 1, r: HOME.r }, 'the first: the tile to the east');
  // a host's body and a character's: side by side is clear, one over the other is not
  const u = O.TOKEN_UNIT * RADIUS, half = O.characterBody().half * RADIUS;
  assert.equal(O.coversHost({ x: 0, y: 0 }, { x: half + u * 0.7, y: 0 }, u), false);
  assert.equal(O.coversHost({ x: 0, y: 0 }, { x: half + u * 0.4, y: 0 }, u), true);
  assert.equal(O.coversHost({ x: 0, y: 0 }, { x: 0, y: -O.characterBody().up * RADIUS - u * 0.3 }, u), false, 'a host well behind its head');
});

test('the rule of the ground: a character does not stand in water, in a wood or on a mountain; with none of the tiles next door open it stands on its own village\'s tile', async t => {
  const { O } = await board(t);
  const spots = O.characterSpots(true, 1).map(world), hexes = spots.map(p => O.hexAt(p.x, p.y)), key = h => `${h.q},${h.r}`;
  const first = O.characterSpot(C0, true, [], 1);
  assert.deepEqual([first.x, first.y, first.hex, first.home], [spots[0].x, spots[0].y, hexes[0], false], 'no word about the ground: every hex is open');
  // the tile to the east is water: the character takes the next spot whose ground is open
  const asked = [];
  const except = (...closed) => (q, r) => { asked.push(`${q},${r}`); return !closed.includes(`${q},${r}`); };
  const second = O.characterSpot(C0, true, [], 1, { open: except(key(hexes[0])) });
  assert.deepEqual([second.x, second.y], [spots[1].x, spots[1].y]); assert.ok(second.x < C0.x, 'to the left of the village');
  assert.ok(asked.includes(key(hexes[0])), 'the ground is asked about by the hex the feet stand on');
  assert.ok(!asked.includes(`${HOME.q},${HOME.r}`), 'and never about the village\'s own tile');
  // east and west closed: level with the hosts, outside the right-hand one
  const third = O.characterSpot(C0, true, [], 1, { open: except(key(hexes[0]), key(hexes[1])) });
  assert.deepEqual([third.x, third.y], [spots[2].x, spots[2].y]);
  // every tile next door is water, wood or mountain: the village's own tile, at the foot of the gate road
  const last = O.characterSpot(C0, true, [], 1, { open: () => false });
  assert.deepEqual([last.x, last.y, last.home, last.hex], [spots[4].x, spots[4].y, true, { q: HOME.q, r: HOME.r }]);
  // open ground that a host stands on is left for the next spot; closed ground is never taken for want of a better one
  const taken = O.characterSpot(C0, true, [{ x: spots[0].x + 4, y: spots[0].y }], 1, { open: () => true });
  assert.deepEqual([taken.x, taken.y], [spots[1].x, spots[1].y]);
  const crowded = O.characterSpot(C0, true, spots.slice(0, 4), 1, { open: except(key(hexes[1])) });
  assert.equal(crowded.home, true, 'hosts on every open spot: its own tile');
  // the same for another player's village; the map's word for the ground reaches the tokens
  const other = O.characterSpot(C0, false, [], 1, { open: () => false });
  assert.equal(other.home, true);
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 0, own: true, tier: 1 }]);
  const [dry] = O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]), open: () => true });
  const [wet] = O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]), open: () => false });
  assert.deepEqual([dry.hex, dry.character.home], [hexes[0], false]);
  assert.deepEqual([wet.x, wet.y, wet.hex, wet.character.home], [spots[4].x, spots[4].y, { q: HOME.q, r: HOME.r }, true]);
  // the landing's walk starts on open ground too: from behind where that is open, else a short way out on its own tile's side
  assert.deepEqual(dry.character.from, O.LANDING_WALK.from);
  const start = O.hexAt(dry.x + O.LANDING_WALK.from[0] * RADIUS, dry.y + O.LANDING_WALK.from[1] * RADIUS);
  const [short] = O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]), open: (q, r) => !(q === start.q && r === start.r) });
  assert.deepEqual(short.character.from, [O.LANDING_WALK.from[0] * O.LANDING_WALK.short, O.LANDING_WALK.from[1] * O.LANDING_WALK.short]);
  assert.deepEqual(wet.character.from, O.LANDING_WALK.home, 'a character on its own tile comes from before the gate');
  O.setBoardCharacters([]);
});

test('the map says which ground is open and cuts a character behind what stands in front of the hex its feet are on (map/sprites.mjs)', () => {
  const src = readFileSync(new URL('map/sprites.mjs', WEB), 'utf8');
  // open ground: painted land the viewer has surveyed, with no water, wood or mountain, nothing built or camped on it, not the Concord
  assert.match(src, /const openGround = \(hq, hr\) => \{ const u = byHex\.get\(keyOf\(hq, hr\)\); return !!u && !u\.cloud && u\.lv >= L2 && LOW_PROPS\.has\(u\.name\) && u\.name !== 'water' && u\.site === undefined && !u\.camp && !\(u\.centre && u\.ring <= 1\) && u\.ring !== 0; \};/);
  assert.match(src, /const LOW_PROPS = new Set\(\['grassland', 'plains', 'hills', 'water'\]\);/);
  assert.match(src, /provinceTokens\(\{[^\n]*unit: 0\.66 \* zoomBoost\(RADIUS \* zoom\), open: openGround \}\)/);
  assert.match(src, /const h = tok\.hex \?\? tileHex\(tok\.p, tok\.q, tok\.tile\);/);
  // its picture is larger than a host's: the scratch it is cut on is its own cell
  assert.match(src, /const box = tok\.character \? characterCell\(tok\.character\.share \?\? 1\) : null/);
  // it is drawn further out than the hosts' figures are (a phone's selection framing), and has no pill
  assert.match(src, /export const HOST_FIGURE_MIN_R = 35;/); assert.match(src, /export const CHARACTER_FIGURE_MIN_R = 20;/);
  assert.match(src, /if \(!figures && !\(tok\.character && RADIUS \* zoom \* \(tok\.character\.share \?\? 1\) >= CHARACTER_FIGURE_MIN_R\)\) continue;/);
  assert.equal((src.match(/if \(!tok\.character\) pills\.push\(\{ tok, s: size \}\);/g) ?? []).length, 2);
});

test('the tokens: the viewer\'s character by the active village, another player\'s by a selected village; none where no village is drawn or a battle plays', async t => {
  const { O } = await board(t);
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 0, own: true, tier: 1 }, { p: 2, q: 0, tile: 26, faction: 2, own: false, tier: 1 }, { p: 3, q: 1, tile: 4, faction: 5, own: false }, { p: 2, q: 0, tile: 9, faction: 9 }, null]);
  assert.equal(O.boardCharacters().length, 3, 'only what names a village and a nation');
  const toks = O.characterTokens({ p: 2, q: 0, villages: new Set([7, 26]), heroTiles: new Set([7]) });
  assert.equal(toks.length, 2);
  const [mine, other] = toks;
  const [sx, sy] = O.characterSpots(true, 1)[0];
  assert.deepEqual([mine.x, mine.y], [C0.x + sx * RADIUS, C0.y + sy * RADIUS]);
  assert.deepEqual([mine.kind, mine.faction, mine.tile, mine.character.key, mine.character.own, mine.hosts], ['character', 0, 7, 'aster', true, []]);
  assert.deepEqual([mine.hex, mine.character.share, mine.character.home], [{ q: HOME.q + 1, r: HOME.r }, 1, false], 'it stands on the tile next door, at the full size');
  assert.deepEqual([other.character.key, other.character.own, other.character.share], ['cinder', false, VILLAGE_SCALE / HERO.scale]);
  const h2 = tileHex(2, 0, 26), c2 = project(h2.q, h2.r), [ox, oy] = O.characterSpots(false, 1)[0];
  assert.deepEqual([other.x, other.y], [c2.x + ox * RADIUS, c2.y + oy * RADIUS]);
  assert.equal(mine.own, false, 'the ring is the character\'s own: the map never takes it for a host of the viewer');
  // a village the viewer has not surveyed is not drawn: nobody stands there
  assert.equal(O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]) }).length, 1);
  // a battle scene has the tile: the scene shows the characters
  assert.equal(O.characterTokens({ p: 2, q: 0, villages: new Set([7, 26]), heroTiles: new Set([7]), skipTiles: new Set([7]) }).length, 1);
  assert.equal(O.characterTokens({ p: 9, q: 9, villages: new Set([7]) }).length, 0);
  // close in a host's token unit is larger (the zoom's boost); the character keeps its size and its place beside the standard
  const [near] = O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]), unit: O.TOKEN_UNIT * 1.3 });
  assert.deepEqual([near.x, near.y], [mine.x, mine.y]);
  assert.ok(O.characterSpots(true, 1, O.TOKEN_UNIT * 1.3)[2][0] > O.characterSpots(true, 1)[2][0], 'the spots level with the hosts are further out when the hosts are larger');
  O.setBoardCharacters([]);
  assert.equal(O.characterTokens({ p: 2, q: 0, villages: new Set([7, 26]), heroTiles: new Set([7]) }).length, 0, 'an empty list clears the board');
});

test('the pose: a landing\'s walk to the spot, then the idle loop; reduced motion is a still, at once', async t => {
  const { O } = await board(t);
  const W = O.LANDING_WALK;
  assert.deepEqual(O.characterPose(null, 0), { motion: 'idle', share: 0, looping: true, walk: 0, alpha: 1 });
  assert.equal(O.characterPose(null, 1).share, 0.5, 'the idle loop takes two seconds (the package\'s README)');
  const start = O.characterPose(W.delay, 0);
  assert.deepEqual([start.motion, start.walk, start.alpha], ['walk', 1, 0]);
  const mid = O.characterPose(W.delay + W.secs / 2, 0);
  assert.equal(mid.motion, 'walk'); assert.ok(mid.walk > 0.4 && mid.walk < 0.6); assert.equal(mid.alpha, 1);
  assert.ok(Math.abs(mid.share - W.secs / 2) < 1e-9, 'the walk clip loops once a second');
  let last = 2; for (let k = 0; k <= 20; k++) { const p = O.characterPose(W.delay + (W.secs * k) / 20, 0); if (p.motion !== 'walk') break; assert.ok(p.walk <= last, 'it never steps back'); last = p.walk; }
  assert.deepEqual([O.characterPose(W.delay + W.secs, 3).motion, O.characterPose(W.delay + W.secs, 3).walk], ['idle', 0], 'arrived: it stands');
  assert.deepEqual(O.characterPose(0.5, 7, { full: false }), { motion: 'idle', share: 0, looping: true, walk: 0, alpha: 1 }, 'reduced motion: the first frame of the idle sheet, no walk');
});

/** What a recording context was asked to draw (asking it for its transform is no drawing). */
const drawn = calls => calls.filter(c => c[0] !== 'getTransform');

test('painting: nothing until the sheet is here (no stand-in, no pop), then the soft shadow and the ring on the ground and the figure upright at its one size', async t => {
  const { O, ctx, calls, draws, requests, loadAll } = await board(t);
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 4, own: true, tier: 1 }, { p: 2, q: 0, tile: 26, faction: 1, own: false }]);
  // the page asks ahead for what the hero frame of this screen draws from: a cell some 210 px wide on a plain screen
  // (four fifths of a 256 px frame and more: the 2x sheet, with its eight idle frames), 400 on a dense one
  assert.equal(O.heroSheetSet(1), '2x'); assert.equal(O.heroSheetSet(2), '2x'); assert.ok(O.heroCellPx(1) > 205 && O.heroCellPx(1) < 256 && O.heroCellPx(2) > 380);
  const asked = requests.map(r => String(r.src).split('/motion-v1/')[1]).filter(Boolean);
  assert.ok(asked.includes('sprite@2x/ember_idle.webp') && asked.includes('sprite@2x/borealis_idle.webp'), 'the idle sheets are asked for as soon as the page says who stands');
  assert.ok(!asked.includes('sprite/ember_idle.webp') && !asked.includes('sprite/borealis_idle.webp'), 'one sheet a figure: the package\'s 256 px sheet is not fetched beside it');
  assert.ok(!requests.some(r => /_walk|_attack|_hit/.test(r.src)), 'and nothing else');
  const [mine, other] = O.characterTokens({ p: 2, q: 0, villages: new Set([7, 26]), heroTiles: new Set([7]) });
  const s = 30;
  assert.equal(O.paintCharacter(ctx, mine, { s, t: 0, now: 10, level: 'full' }), false);
  assert.equal(drawn(calls).length, 0, 'before its sheet: nothing at all');
  loadAll();
  assert.equal(O.paintCharacter(ctx, mine, { s, t: 0, now: 10, level: 'full' }), true);
  assert.equal(draws().length, 0, 'the first frame the sheet is here the figure is still clear: it comes in, it does not pop');
  calls.length = 0;
  let stood = null;
  assert.equal(O.paintCharacter(ctx, mine, { s, t: 0.6, now: 10 + O.FADE_IN, level: 'full', up: (x, y) => { stood = [x, y]; return { sh: 0.1, vs: 1.2 }; } }), true);
  assert.deepEqual(stood, [mine.x, mine.y], 'upright about its feet on the tilted board');
  const d = draws();
  assert.equal(d.length, 1);
  // its one size in the world: twice the package's 1.30 of a host's token unit, whatever the token height of this zoom
  const width = O.CHARACTER_UNIT * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  assert.deepEqual(d[0].slice(2), [2 * 512, 0, 512, 512, -width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width], 'the third of the eight idle frames at 0.6 s, from the 2x sheet');
  calls.length = 0;
  O.paintCharacter(ctx, mine, { s: 39, t: 0.6, now: 11, level: 'full' });
  assert.deepEqual(draws()[0].slice(6), [-width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width], 'close in the hosts are drawn larger; the character keeps its size');
  calls.length = 0;
  O.paintCharacter(ctx, mine, { s, t: 0.6, now: 11, level: 'full', up: () => ({ sh: 0.1, vs: 1.2 }) });
  const order = calls.map(c => c[0]);
  assert.ok(order.indexOf('ellipse') >= 0 && order.indexOf('ellipse') < order.indexOf('transform') && order.indexOf('transform') < order.indexOf('drawImage'), 'the shadow and the ring lie on the ground, the figure stands on them');
  const strokes = calls.filter(c => c[0] === 'set' && c[1] === 'strokeStyle').map(c => c[2]);
  assert.deepEqual(strokes, [YOURS.key, YOURS.gold, YOURS.core], 'the viewer\'s own: the gold ring, an ivory core, a dark keyline');
  // the ring is as wide as the figure's stance, and its line is not twice as heavy for a figure twice as large
  const rings = calls.filter(c => c[0] === 'ellipse').slice(-3);
  for (const r of rings) assert.deepEqual(r.slice(1, 5), [mine.x, mine.y, O.CHARACTER_UNIT * O.RING.rx, O.CHARACTER_UNIT * O.RING.rx * O.RING.ry]);
  const widths = calls.filter(c => c[0] === 'set' && c[1] === 'lineWidth').map(c => c[2]);
  assert.ok(Math.abs(widths[1] - (O.CHARACTER_UNIT / Math.SQRT2) * 0.066) < 1e-9);
  // it breathes: a little taller and narrower about its feet (the package's idle clip is nearly still)
  const breath = 0.5 - 0.5 * Math.cos((0.6 / LEADER_BREATH.secs) * Math.PI * 2);
  assert.deepEqual(calls.filter(c => c[0] === 'scale').pop().slice(1), [1 - LEADER_BREATH.narrow * breath, 1 + LEADER_BREATH.rise * breath]);
  // another player's character: an ivory ring (never gold), in proportion to its smaller village
  calls.length = 0;
  O.paintCharacter(ctx, other, { s, t: 0, now: 20, level: 'full' }); calls.length = 0;
  O.paintCharacter(ctx, other, { s, t: 0, now: 21, level: 'full' });
  assert.deepEqual(calls.filter(c => c[0] === 'set' && c[1] === 'strokeStyle').map(c => c[2]), [YOURS.key, '#f4efe0']);
  assert.ok(Math.abs(draws()[0][8] - width * VILLAGE_SCALE / HERO.scale) < 1e-9);
  // reduced motion: a still, there at once, and it does not breathe
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 4, own: true, tier: 1 }, { p: 2, q: 0, tile: 30, faction: 1, own: false }]);
  const [, fresh] = O.characterTokens({ p: 2, q: 0, villages: new Set([7, 30]), heroTiles: new Set([7]) });
  calls.length = 0;
  assert.equal(O.paintCharacter(ctx, fresh, { s, t: 1.7, now: 30, level: 'reduced' }), true);
  assert.deepEqual(draws().map(x => x[2]), [0], 'the first frame of the idle sheet');
  assert.equal(calls.filter(c => c[0] === 'scale').length, 0);
});

test('the shadow under a character is a soft pool: darkest at the feet, gone at its edge; a flat one where the context has no gradients', async () => {
  const M = await import('../../permutation-server/web/frontier/people/leader-motion.mjs');
  const log = [], stops = [];
  const ctx = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, fill() { log.push(['fill', ctx.fillStyle]); }, translate(...a) { log.push(['translate', ...a]); }, scale(...a) { log.push(['scale', ...a]); }, arc(...a) { log.push(['arc', ...a]); }, ellipse(...a) { log.push(['ellipse', ...a]); },
    createRadialGradient: (...a) => { log.push(['gradient', ...a]); return { addColorStop: (k, c) => stops.push([k, c]) }; } };
  M.paintContactShadow(ctx, 100, 50, 60, 0.5);
  assert.deepEqual(stops, [[0, 'rgba(10,18,15,.5)'], [0.45, 'rgba(10,18,15,.3)'], [1, 'rgba(10,18,15,0)']]);
  assert.deepEqual(log.filter(c => c[0] === 'translate' || c[0] === 'scale' || c[0] === 'arc'), [['translate', 100 + 60 * 0.05, 50 + 60 * 0.03], ['scale', 60 * 0.36, 60 * 0.15], ['arc', 0, 0, 1, 0, Math.PI * 2]]);
  assert.equal(ctx.globalAlpha, 0.5);
  const flat = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, fill() {}, ellipse(...a) { log.push(['flat', ...a]); } };
  M.paintContactShadow(flat, 0, 0, 10, 1);
  assert.equal(log.filter(c => c[0] === 'flat').length, 1); assert.ok(Math.abs(flat.globalAlpha - 0.3) < 1e-12);
});

test('the landing: the standard falls first; then the character comes forward on the walk sheet, from behind and a little to the left, and stands', async t => {
  const { O, ctx, calls, draws, requests, loadAll } = await board(t);
  const W = O.LANDING_WALK;
  // (the walk begins when the standard is on the ground: map/ownland.mjs LANDING, with the fixture's two rings of land)
  const L = (await import('../../permutation-server/web/frontier/map/ownland.mjs')).LANDING;
  assert.ok(W.delay * 1000 >= L.floodAt + 2 * L.ring + L.borderGap + L.standardGap + L.drop * L.impact - 60, 'not before the standard lands: it never walks through the place the standard falls on');
  assert.ok(W.from[0] < 0 && W.from[1] < -1, 'from behind (further up the board) and a little to the left');
  // a walking pace for a figure of its size: the clip takes two steps a second, a step some two fifths of its height
  const pace = Math.hypot(W.from[0], W.from[1]) / W.secs, tall = O.characterBody().up + O.characterBody().down;
  assert.ok(pace > 0.5 * tall && pace < 0.95 * tall, `it walks ${pace.toFixed(2)} radii a second, ${tall.toFixed(2)} tall`);
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 0, own: true, tier: 0, pending: true }]);
  assert.ok(requests.some(r => r.src.endsWith('sprite@2x/aster_walk.webp')), 'the walk sheet is asked for while the landing is on its way');
  loadAll();
  const [tok] = O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]) });
  assert.equal(O.paintCharacter(ctx, tok, { s: 30, t: 0, now: 100, level: 'full' }), false, 'the landing is reported and has not begun: nobody stands on land that is not in its colour yet');
  assert.equal(drawn(calls).length, 0);
  O.noteLanding('2,0,7', 101);
  assert.equal(O.landingAge('2,0,7', 102), 1); assert.equal(O.landingAge('9,9,9', 102), null);
  O.paintCharacter(ctx, tok, { s: 30, t: 0, now: 101 + W.delay + 0.3, level: 'full' });
  calls.length = 0;
  O.paintCharacter(ctx, tok, { s: 30, t: 0, now: 101 + W.delay + 0.6, level: 'full' });
  const d = draws();
  assert.equal(d.length, 1); assert.match(d[0][1].src, /sprite@2x\/aster_walk\.webp$/);
  const moved = calls.find(c => c[0] === 'translate');
  assert.ok(moved[1] < tok.x && moved[2] < tok.y, 'on its way: behind its place and a little to the left');
  assert.equal(calls.filter(c => c[0] === 'scale').length, 0, 'a walking figure does not breathe');
  calls.length = 0;
  O.paintCharacter(ctx, tok, { s: 30, t: 0.2, now: 101 + W.delay + W.secs + 0.1, level: 'full' });
  assert.match(draws()[0][1].src, /sprite@2x\/aster_idle\.webp$/);
  assert.deepEqual(calls.find(c => c[0] === 'translate').slice(1), [tok.x, tok.y], 'arrived');
  // a landing that never begins does not hide the character for ever
  O.setBoardCharacters([{ p: 2, q: 0, tile: 8, faction: 0, own: true, pending: true }]);
  const [late] = O.characterTokens({ p: 2, q: 0, villages: new Set([8]), heroTiles: new Set([8]) });
  assert.equal(O.paintCharacter(ctx, late, { s: 30, t: 0, now: 200, level: 'full' }), false);
  assert.equal(O.paintCharacter(ctx, late, { s: 30, t: 0, now: 200 + O.PENDING_MAX + 0.1, level: 'full' }), true);
});

test('a province\'s tokens carry the characters after its hosts (people/units.mjs provinceTokens): one painter path, no pill of their own', async () => {
  // (the module the token painter itself imports: its registry is the page's)
  const O = await import('../../permutation-server/web/frontier/people/onboard.mjs');
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 0, own: true, tier: 1 }]);
  try {
    const hosts = [{ id: '1', faction: 0, unit: 0, tile: 7, state: 1, troops: 600, stamina: 120 }];
    const toks = provinceTokens({ p: 2, q: 0, hosts, holdingTiles: new Set([7]), heroTiles: new Set([7]), heroSpots: HERO.hosts, viewerFaction: 0 });
    assert.deepEqual(toks.map(x => x.kind), ['spearman', 'character']);
    const [host, chr] = toks;
    assert.equal(O.coversHost(chr, host), false, 'the character covers no host');
    assert.equal(chr.status, null); assert.equal(chr.troops, null);
    // the map's word about the ground, and the hosts' size at this zoom, reach the character's spot
    const [, wet] = provinceTokens({ p: 2, q: 0, hosts, holdingTiles: new Set([7]), heroTiles: new Set([7]), heroSpots: HERO.hosts, viewerFaction: 0, unit: 0.66, open: () => false });
    assert.equal(wet.character.home, true);
    // hosts of another tile of the province count too: a host on the tile to the east has that ground
    const east = hosts.concat([{ id: '2', faction: 3, unit: 0, tile: O.hexAt(chr.x, chr.y) && tileOf(chr), state: 1, troops: 300, stamina: 120 }]);
    const moved = provinceTokens({ p: 2, q: 0, hosts: east, holdingTiles: new Set([7]), heroTiles: new Set([7]), heroSpots: HERO.hosts, viewerFaction: 0 }).find(x => x.kind === 'character');
    assert.ok(moved.x !== chr.x || moved.y !== chr.y, 'it gives way to a host that stands where it would');
    // skipped where a battle scene has the tile
    assert.deepEqual(provinceTokens({ p: 2, q: 0, hosts, holdingTiles: new Set([7]), heroTiles: new Set([7]), heroSpots: HERO.hosts, skipTiles: new Set([7]) }), []);
  } finally { O.setBoardCharacters([]); }
});
/** The tile of province (2, 0) whose hex a token's feet stand on. */
function tileOf(tok) { for (let i = 0; i < 61; i++) { const h = tileHex(2, 0, i); if (h && h.q === tok.hex.q && h.r === tok.hex.r) return i; } return -1; }

// ------------------------------------------------------------------ the players in a battle scene; one outcome word per result
import * as B from '../../permutation-server/web/frontier/people/battle.mjs';
import { sideOutcome, verdictKey } from '../../permutation-server/web/frontier/people/outcome.mjs';
import { verdictTitle } from '../../permutation-server/web/frontier/fx/battle.mjs';
import * as rep from '../../permutation-server/web/frontier/screens/report.mjs';
import { VERDICTS, FATES } from '../../permutation-server/web/frontier/fi18n.mjs';
import { FACTION_FILL } from '../../permutation-server/web/frontier/people/avatar.mjs';

const M = (o = {}) => ({ id: 'x', faction: 0, unit: 0, stance: 0, before: 100, after: 100, fate: 'Stays', kind: 'arrival', ...o });
const clash = (attackers, defenders, extra = {}) => ({ p: 2, q: 0, bell: 41, tiles: [{ idx: 7, attackers, defenders, ...extra }] });
/** The fixture's turn: Cinder arrives 900 strong at the viewer's village and nothing of it is left; the garrison loses 80. */
const liveClash = () => clash([M({ id: 'a', faction: 2, stance: 1, before: 900, after: 0, fate: 'Destroyed' })], [M({ id: 'g0', faction: 0, stance: 3, before: 1080, after: 1000, kind: 'garrison' })]);

test('what became of a side is asked of one function: destroyed only when nothing is left, withdrawn when a part left with troops', () => {
  assert.equal(sideOutcome([M({ after: 0, fate: 'Destroyed' })]), 'Destroyed');
  assert.equal(sideOutcome([M({ after: 0, fate: 'Destroyed' }), M({ before: 300, after: 300, fate: 'Retreated' })]), 'Retreated', 'a part turned back: the side withdrew');
  assert.equal(sideOutcome([M({ after: 0, fate: 'Destroyed' }), M({ after: 60 })]), 'Stays', 'a part holds the field: the side stays');
  assert.equal(sideOutcome([M({ kind: 'garrison', fate: null, after: 80 })]), 'Stays', 'a garrison has no fate of its own: it stays unless nothing of it is left');
  assert.equal(sideOutcome([M({ kind: 'camp', fate: null, after: 0 })]), 'Destroyed');
  assert.equal(sideOutcome([M({ fate: null, after: null })]), null, 'not known yet');
  assert.equal(sideOutcome([]), null);
  assert.equal(sideOutcome([M({ after: 40, fate: 'Bounced' }), M({ before: 500, after: 420, fate: 'Withdrew' })]), 'Withdrew', 'the fate of the largest part that left');
  // the viewer's word
  assert.equal(verdictKey({ own: 'Stays', foe: 'Destroyed', role: 'defend' }), 'won');
  assert.equal(verdictKey({ own: 'Stays', foe: 'Retreated', role: 'defend' }), 'repelled');
  assert.equal(verdictKey({ own: 'Stays', foe: 'Bounced', role: 'attack' }), 'won');
  assert.equal(verdictKey({ own: 'Stays', foe: 'Stays' }), 'held');
  assert.equal(verdictKey({ own: 'Destroyed', foe: 'Stays' }), 'fell');
  assert.equal(verdictKey({ own: 'Retreated', foe: 'Stays' }), 'turned');
  assert.equal(verdictKey({ own: 'Stays', role: 'attack' }), 'arrived'); assert.equal(verdictKey({ own: 'Stays', role: 'defend' }), 'held');
  assert.equal(verdictKey({ own: null }), 'none'); assert.equal(verdictKey({ own: 'Stays', foe: null }), 'none');
});

test('one outcome word per result: the title across the map, the tag under each side\'s losses and the report\'s stamp never disagree', () => {
  setLang('ja');
  const tagsOf = scene => B.battlePlan(scene).tiles[0].sides.map(s => s.fate);
  const rowsOf = (scene, viewer) => [...scene.tiles[0].attackers, ...scene.tiles[0].defenders].map(x => ({ ...x, mine: x.faction === viewer }));
  // the last check's case: 0 attackers left. The title said 撃退 over a tag that said 壊滅した.
  const live = liveClash();
  assert.deepEqual(tagsOf(live), ['Destroyed', 'Stays']);
  assert.equal(verdictTitle(live, 0).title, '勝利', 'the defender\'s word when nothing of the attackers is left');
  assert.equal(verdictTitle(live, 2).title, '壊滅', 'the attackers\' own word');
  assert.equal(VERDICTS[rep.verdictOf(rep.summaryOf(rowsOf(live, 0))).key], '勝利'); assert.equal(VERDICTS[rep.verdictOf(rep.summaryOf(rowsOf(live, 2))).key], '壊滅');
  // every pairing of fates: 撃退 stands only over attackers who left with troops; 壊滅 only on a side with nothing left
  const fatesA = [['Destroyed', 0], ['Retreated', 60], ['Bounced', 40], ['Stays', 70]], fatesD = [['Destroyed', 0], ['Withdrew', 50], ['Stays', 80]];
  for (const [fa, aa] of fatesA) for (const [fd, ad] of fatesD) for (const mixed of [false, true]) {
    const A = [M({ id: 'a', faction: 2, after: aa, fate: fa }), ...(mixed ? [M({ id: 'a2', faction: 2, before: 400, after: 0, fate: 'Destroyed' })] : [])];
    const scene = clash(A, [M({ id: 'd', faction: 0, after: ad, fate: fd, kind: 'resident' })]);
    const [tagA, tagD] = tagsOf(scene);
    for (const viewer of [0, 2]) {
      const title = verdictTitle(scene, viewer), stamp = VERDICTS[rep.verdictOf(rep.summaryOf(rowsOf(scene, viewer))).key];
      const own = viewer === 2 ? tagA : tagD, foe = viewer === 2 ? tagD : tagA, where = `${fa}${mixed ? '+Destroyed' : ''} against ${fd}, viewer ${viewer}`;
      if (title) assert.equal(title.title, stamp, `the title is the report's stamp: ${where}`);
      if (title?.title === '撃退') assert.ok(viewer === 0 && foe !== 'Destroyed' && foe !== 'Stays', `撃退 only when the attackers left with troops: ${where}`);
      if (title?.title === '壊滅') assert.equal(own, 'Destroyed', `壊滅 only when nothing of the viewer's is left: ${where}`);
      if (title?.title === '勝利') assert.ok(own === 'Stays' && foe !== 'Stays', where);
      if (own === 'Destroyed' && title) assert.equal(title.title, '壊滅', where);
      if (foe === 'Destroyed' && own === 'Stays') assert.equal(title?.title, '勝利', where);
    }
  }
  // the tag's words are the report's table
  assert.equal(FATES.Destroyed, '壊滅した'); assert.equal(FATES.Stays, '戦場に残った');
});

test('who has the better of each contact follows the record\'s losses; the last blow is the holder\'s', () => {
  const sides = scene => B.battlePlan(scene).tiles[0];
  assert.deepEqual(sides(liveClash()).wins, [1, 1, 1, 1], 'the attackers lost everything: the defenders have every exchange');
  const even = sides(clash([M({ faction: 2, before: 100, after: 50 })], [M({ id: 'd', before: 100, after: 50, kind: 'resident' })]));
  assert.deepEqual(even.wins, [-1, 1, -1, 1], 'both hold with the same share lost: turn and turn about');
  const close = sides(clash([M({ faction: 2, before: 100, after: 50, fate: 'Retreated' })], [M({ id: 'd', before: 100, after: 70, kind: 'resident' })]));
  assert.equal(close.wins[3], 1, 'the defenders hold: the last blow is theirs');
  assert.equal(close.wins.filter(w => w === 1).length, 3); assert.equal(close.wins.filter(w => w === -1).length, 1, 'the attackers took three tenths of the defenders: one exchange is theirs');
  const taken = sides(clash([M({ faction: 2, before: 400, after: 380 })], [M({ id: 'd', before: 100, after: 0, fate: 'Destroyed', kind: 'resident' })]));
  assert.deepEqual(taken.wins, [-1, -1, -1, -1]);
  assert.deepEqual(sides(clash([M({ faction: 2, before: 100, after: null, fate: null })], [M({ id: 'd', kind: 'resident' })])).wins, [0, 0, 0, 0], 'losses not known: nobody strikes');
  assert.deepEqual(sides(clash([M({ faction: 2 })], [])).wins, [], 'nobody stood against the arrivals');
});

test('a side\'s character: the attack on an exchange its side wins, the hit on one it loses, idle between; a camp has none', () => {
  const T = B.battlePlan(liveClash()).tiles[0], [A, D] = T.sides;
  assert.deepEqual([A.character, D.character], ['cinder', 'aster'], 'each nation\'s side has its player\'s character');
  const camp = B.battlePlan(clash([M({ faction: 0, before: 600, after: 510 })], [M({ id: 'camp', faction: 6, before: 420, after: 0, fate: 'Destroyed', kind: 'camp' })])).tiles[0];
  assert.deepEqual(camp.sides.map(s => s.character), ['aster', null], 'a camp has no player');
  const h = B.BATTLE_HITS, C = B.CHARACTER_CLIP;
  // before the melee: idle, on the scene's own time (a two-second loop)
  assert.deepEqual(B.characterAct(T.wins, 1, 1.0, 1.0), { motion: 'idle', share: 0.5, looping: true });
  // the defenders win the first exchange: their character strikes, timed so the blow meets the contact; the attackers' takes it from the contact on
  const strike = B.characterAct(T.wins, 1, h[0], h[0]);
  assert.equal(strike.motion, 'attack'); assert.equal(strike.looping, false); assert.ok(Math.abs(strike.share - C.attack.lead / C.attack.secs) < 1e-9);
  assert.equal(B.characterAct(T.wins, 1, h[0] - C.attack.lead - 0.01).motion, 'idle');
  assert.equal(B.characterAct(T.wins, -1, h[0] - 0.01).motion, 'idle', 'the blow has not landed yet');
  assert.deepEqual(B.characterAct(T.wins, -1, h[0]), { motion: 'hit', share: 0, looping: false });
  assert.equal(B.characterAct(T.wins, -1, h[0] + C.hit.secs + 0.01).motion, 'idle', 'idle between');
  for (const j of [1, 2, 3]) { assert.equal(B.characterAct(T.wins, 1, h[j]).motion, 'attack'); assert.equal(B.characterAct(T.wins, -1, h[j] + 0.1).motion, 'hit'); }
  assert.equal(B.characterAct(T.wins, 1, B.PHASE.fates + 1).motion, 'idle'); assert.equal(B.characterAct(T.wins, -1, B.PHASE.fates + 1).motion, 'idle');
  assert.equal(B.characterAct([0, 0, 0, 0], 1, h[1]).motion, 'idle', 'losses not known: it only stands');
  // the scene keeps its phase contract and its length
  assert.deepEqual(B.PHASE, { emerge: 0, deploy: 1.2, melee: 2.2, fates: 4.0, losses: 5.6, end: 7.0 });
  assert.ok(h.every((x, j) => j === 0 || x - h[j - 1] >= C.attack.lead + 0.2), 'a strike is over before the next one begins');
});

test('the scene paints both characters behind their lines, facing the enemy, at the size they have beside their villages; the sheets are asked for when the scene is staged', () => {
  // (rewritten on 2026-10-10: the characters were a figure's height unit large and stood 1.3 of it behind the line's
  // middle; they now have their one size in the world, a body clear of their rear rank, and the sheets of that size)
  const play = B.startBattle(liveClash(), 0, 1);
  const before = requests.length;
  // a battle the camera is sent to: figures 100 px tall at zoom 2.1; the characters' unit is CHARACTER_STAND.unit world px
  const zoom = 2.1, layout = B.battleLayout({ width: 1000, height: 700 }, { title: 128 });
  const stage = B.battleStage(B.battlePlan(play.scene).tiles[0], zoom, 1, layout);
  const cu = B.characterStandUnit(stage.s, stage.rest, layout.half / zoom);
  assert.equal(cu, B.CHARACTER_STAND.unit, 'on a wide stage: the size it has beside its village');
  B.preloadBattle(play.scene, cu * zoom);
  const asked = requests.slice(before).map(r => String(r.src).split('/motion-v1/')[1]).filter(Boolean);
  for (const f of ['cinder_attack.webp', 'cinder_hit.webp', 'aster_attack.webp', 'aster_hit.webp']) assert.ok(asked.includes(`sprite@2x/${f}`) || requests.some(r => r.src.endsWith(`sprite@2x/${f}`)), f);
  assert.ok(!asked.some(a => a.startsWith('sprite/')), 'drawn that large, only the 2x sheets are fetched');
  loadAll();
  const log = [], state = { globalAlpha: 1, stack: [] };
  const ctx = new Proxy({}, { get(_, k) { if (k === 'globalAlpha') return state.globalAlpha; if (k === 'save') return () => state.stack.push(state.globalAlpha); if (k === 'restore') return () => { state.globalAlpha = state.stack.pop(); };
    if (k === 'getTransform') return () => ({ a: zoom, b: 0, c: 0, d: zoom, e: 0, f: 0 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} }); if (k === 'measureText') return t => ({ width: String(t).length * 10 }); return (...a) => { log.push([k, ...a]); }; },
    set(_, k, v) { if (k === 'globalAlpha') state.globalAlpha = v; else log.push(['set', k, v]); return true; } });
  const paint = at => { log.length = 0; B.paintBattle(ctx, play, { zoom, at, top: true, layout, fateText: f => f, lossText: n => `−${n}` }); return log.filter(c => c[0] === 'drawImage' && /motion-v1\/sprite@2x\//.test(c[1]?.src ?? '')); };
  // between the phases: both stand
  let figs = paint(1.6);
  assert.deepEqual(figs.map(c => c[1].src.split('/').pop()).sort(), ['aster_idle.webp', 'cinder_idle.webp']);
  // how large: the cell of the one size, from frames of 512 px
  const cell = cu * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  for (const c of figs) { assert.deepEqual(c.slice(3, 6), [0, 512, 512]); assert.ok(Math.abs(c[8] - cell) < 1e-9 && Math.abs(c[9] - cell) < 1e-9); }
  assert.ok(cu > stage.s * 0.95 && cu < stage.s * 1.5, 'beside figures a hundred px tall it is the larger, not a giant');
  // where: behind each formation, the whole body clear of the rear rank; the attackers' on the left
  const at = file => { const i = log.findIndex(c => c[0] === 'drawImage' && c[1]?.src?.endsWith(file)); for (let j = i; j >= 0; j--) if (log[j][0] === 'translate') return log[j]; return null; };
  const cinder = at('cinder_idle.webp'), aster = at('aster_idle.webp'), half = cell * LEADER_FIGURE.half;
  assert.ok(cinder[1] + half <= stage.cx - (stage.rest + B.CHARACTER_STAND.rear) * stage.s + 1e-9 && aster[1] - half >= stage.cx + (stage.rest + B.CHARACTER_STAND.rear) * stage.s - 1e-9, 'behind their lines, a body clear');
  assert.ok(aster[1] + half <= stage.cx + layout.half / zoom && cinder[1] - half >= stage.cx - layout.half / zoom, 'and inside the stage');
  assert.ok(cinder[2] < stage.cy && aster[2] < stage.cy, 'a little upstage');
  // facing the enemy: the defenders' character, on the right, is turned to the left
  const flips = log.filter(c => c[0] === 'scale' && c[1] === -1 && c[2] === 1);
  assert.equal(flips.length >= 1, true);
  // a contact the defenders win: Aster strikes, Cinder takes the blow
  figs = paint(B.BATTLE_HITS[1] + 0.05);
  assert.deepEqual(figs.map(c => c[1].src.split('/').pop()).sort(), ['aster_attack.webp', 'cinder_hit.webp']);
  // the star of that contact: Aster's long points and Cinder's short ones, a dark keyline, an ivory heart (it was plain ivory)
  const fills = log.filter(c => c[0] === 'set' && c[1] === 'fillStyle').map(c => String(c[2]));
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},`; };
  assert.ok(fills.some(f => f.startsWith(rgb(FACTION_FILL[0]))) && fills.some(f => f.startsWith(rgb(FACTION_FILL[2]))), 'the star carries the two nations\' colours');
  // reduced motion's frame (the field as the fates left it): both stand
  figs = paint(B.PHASE.fates + 1.5);
  assert.deepEqual(figs.map(c => c[1].src.split('/').pop()).sort(), ['aster_idle.webp', 'cinder_idle.webp']);
});

test('a side\'s character on a narrow stage is as wide as the room behind its rear rank, and never smaller than a figure of the scene', () => {
  const U = B.CHARACTER_STAND.unit, cellOf = u => u * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  assert.equal(B.characterStandUnit(24, 1.6), U, 'no edge (a battle in passing on a wide screen): its one size, whatever the scene\'s figures');
  assert.equal(B.characterStandUnit(24, 1.6, 0), U);
  // a phone's stage: 390 px wide, figures 64 px tall, lines resting 1.2 of that from the middle, at zoom 2.1
  const zoom = 2.1, s = 64 / zoom, edge = 195 / zoom, u = B.characterStandUnit(s, 1.2, edge);
  assert.ok(u < U && u >= s);
  const body = 2 * LEADER_FIGURE.half * cellOf(u), room = edge - (1.2 + B.CHARACTER_STAND.rear) * s;
  assert.ok(body <= room + 1e-9 && body >= room * 0.9, 'its body fills the room behind the rear rank');
  // no room at all: a figure's own unit, not less
  assert.equal(B.characterStandUnit(40, 1.6, 60), 40);
  // a wide stage: nothing is taken off
  assert.equal(B.characterStandUnit(100 / zoom, 1.6, 500 / zoom), U);
});

test('a fight on a village\'s tile is staged before the village, never over its houses', () => {
  const none = B.battleStage(B.battlePlan(liveClash()).tiles[0], 1.15);
  const own = clash(liveClash().tiles[0].attackers, liveClash().tiles[0].defenders, { village: { tier: 1, own: true } });
  const other = clash(liveClash().tiles[0].attackers, liveClash().tiles[0].defenders, { village: { tier: 1, own: false } });
  for (const [scene, scale, cy] of [[own, HERO.scale, HERO.at.y], [other, VILLAGE_SCALE, -RADIUS * 0.04]]) {
    const T = B.battlePlan(scene).tiles[0], st = B.battleStage(T, 1.15);
    const foot = cy + RADIUS * VILLAGE.ring[1] * scale * FLATTEN * 0.8;
    assert.deepEqual(T.village, scene.tiles[0].village);
    // the top of the numbers over the scene (its highest point) is below the village's foot
    assert.ok(st.cy - RADIUS * 0.12 - st.s * (B.BATTLE_ABOVE + 0.2) >= T.c.y + foot, `the scene's numbers stand under the palisade's foot (${(st.cy - T.c.y).toFixed(0)} below the tile's middle)`);
    assert.equal(st.cx, none.cx, 'straight before the village');
    assert.ok(st.s < none.s, 'in passing it is a little smaller, so the whole of it fits between the village and the foot of the picture');
    // a battle the camera is sent to keeps its stage's size, and stands before the village too
    const layout = B.battleLayout({ width: 1000, height: 700 }, { title: 128 });
    const focus = B.battleStage(T, 2.1, 1, layout);
    assert.ok(Math.abs(focus.s - layout.px / 2.1) < 1e-9); assert.ok(focus.cy > T.c.y + foot);
  }
  assert.equal(B.villageDrop(null, 50), 0);
  // the page marks the tiles from the Province's own sites, and which of them are the viewer's
  const before = { sites: [3, 7], siteMirror: [{ state: 0 }, { state: 1, faction: 0, tier: 1, garrison: 1080000n }], entries: [] };
  const sc = B.battleScene({ p: 2, q: 0, bell: 41, inputs: { arrivals: [{ present: 1, tile: 7, hostId: 9n, faction: 2, unit: 0, stance: 1, troops: 900000n, troopsAfter: 0n, fate: 5 }] }, before, after: null, ownTiles: new Set([7]) });
  assert.deepEqual(sc.tiles[0].village, { tier: 1, own: true });
});

// ------------------------------------------------------------------ the host art has one painter (the owner will hand over army art later)
test('one function draws a host\'s figure on the board, in the set pieces and in the battle: people/minis.mjs paintMini', () => {
  const src = f => readFileSync(new URL(f, WEB), 'utf8');
  // the three callers
  assert.match(src('people/units.mjs'), /if \(!paintMini\(ctx, x, y, s, kind, \{ faction, face, step, walking, alpha, lunge: tok\.lunge \?\? 0, own, pulse \}\)\)/, 'the board\'s token');
  assert.match(src('fx/pieces.mjs'), /const figureFlat = \(ctx, x, y, s, kind, o\) => \{ if \(!paintMini\(ctx, x, y, s, kind, \{ shade: FILE_SHADE, \.\.\.o \}\)\)/, 'a column, a muster');
  assert.match(src('people/battle.mjs'), /if \(!paintMini\(ctx, 0, 0, f\.s, f\.kind, o\)\)/, 'a battle\'s figure');
  // nobody else reads the unit sheets: the sheet's layout is the painter's own
  const files = [];
  const walk = dir => { for (const e of readdirSync(new URL(dir, WEB), { withFileTypes: true })) { if (e.isDirectory()) { if (!['council', 'art', 'wasm'].includes(e.name)) walk(`${dir}${e.name}/`); } else if (e.name.endsWith('.mjs')) files.push(`${dir}${e.name}`); } };
  walk('');
  const readers = files.filter(f => /\bminiSheet\(|\bminiCell\(|art\/units\/@/.test(src(f)));
  assert.deepEqual(readers, ['people/minis.mjs'], 'the sheets and their cells are read in one file');
  // and the notes say how new art is plugged in
  const readme = readFileSync(new URL('people/README.md', WEB), 'utf8');
  assert.match(readme, /## Host art/); assert.match(readme, /paintMini/); assert.match(readme, /MINI_ANCHOR/);
});

test('the card of the turn\'s own results is headed by the viewer\'s own face; the bell where the nation is not known', async () => {
  const feed = await import('../../permutation-server/web/frontier/hud/feed.mjs');
  setLang('ja');
  const strip = { turn: 43, items: [{ id: 'a', kind: 'arrival', p: 2, q: 0, tile: 7, text: 'x' }] };
  const mine = flat(feed.renderTurnStrip(strip, { faction: 3 }));
  assert.match(mine, /<div class="toast turn-strip" role="status">\s*<span class="toast-face"><svg [^>]*width="34" height="34" class="leader leader-hex leader-own" data-leader="dunmar" data-own="1"/);
  assert.doesNotMatch(mine, /class="toast-icon"/);
  assert.match(flat(feed.renderTurnStrip(strip)), /<span class="toast-icon"><svg[^>]*><use href="art\/ui\/icons\.svg#bell"\/><\/svg><\/span>/);
});

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
import { LEADER_MOTIONS, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE, LEADER_SPRITE_ANCHOR } from '../../permutation-server/web/frontier/leader-motion-data.mjs';
import { HERO, VILLAGE_SCALE } from '../../permutation-server/web/frontier/map/plates.mjs';
import { VILLAGE } from '../../permutation-server/web/frontier/map/village.mjs';
import { provinceTokens } from '../../permutation-server/web/frontier/people/units.mjs';

let life = 0;
// A page's Image for the rest of this file (the board module and the map painter share one sheet cache, whichever
// test first asks for a sheet), and every picture asked for so far.
const requests = [];
const loadAll = () => { for (const img of requests) { const m = LEADER_MOTIONS.find(x => img.src?.endsWith(`_${x.key}.webp`)); if (m && !img.width) img.load(256 * m.frames, 256); } };
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

test('where a character stands: outside the palisade at the village\'s right-hand foot, by the village\'s tier and size; clear of the hosts', async t => {
  const { O } = await board(t);
  for (const own of [true, false]) for (let tier = 0; tier < 4; tier++) {
    const [[x, y], [lx], [fx, fy]] = O.characterSpots(own, tier);
    const rx = VILLAGE.ring[tier] * (own ? HERO.scale : VILLAGE_SCALE);
    assert.ok(x - 0.25 >= rx, `tier ${tier}${own ? ' (own)' : ''}: the figure's left edge is outside the palisade (${x.toFixed(2)} against ${rx.toFixed(2)})`);
    assert.ok(lx < -rx && Math.abs(fx) < 0.1 && fy > y, 'then the left-hand foot, then the ground before the gate');
  }
  // the viewer's own town: below the foot of the standard's pole, outside the right-hand host
  const [sx, sy] = O.characterSpots(true, 1)[0];
  assert.ok(sy * RADIUS > HERO.standard.y + RADIUS * 0.9, 'the head stays under the pole\'s foot');
  assert.ok(sx - HERO.hosts[0][0][0] >= O.CHARACTER_CLEAR + 0.2, 'outside the host that stands before the gate');
  // a spot that hosts stand on is left for the next one
  const c = { x: 0, y: 0 }, first = O.characterSpot(c, true, [], 1);
  assert.deepEqual([first.x, first.y], [sx * RADIUS, sy * RADIUS]);
  const second = O.characterSpot(c, true, [{ x: first.x + 4, y: first.y }], 1);
  assert.ok(second.x < 0, 'hosts at the right-hand foot: the character takes the left');
});

test('the tokens: the viewer\'s character by the active village, another player\'s by a selected village; none where no village is drawn or a battle plays', async t => {
  const { O } = await board(t);
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 0, own: true, tier: 1 }, { p: 2, q: 0, tile: 26, faction: 2, own: false, tier: 1 }, { p: 3, q: 1, tile: 4, faction: 5, own: false }, { p: 2, q: 0, tile: 9, faction: 9 }, null]);
  assert.equal(O.boardCharacters().length, 3, 'only what names a village and a nation');
  const toks = O.characterTokens({ p: 2, q: 0, villages: new Set([7, 26]), heroTiles: new Set([7]) });
  assert.equal(toks.length, 2);
  const [mine, other] = toks;
  const h = tileHex(2, 0, 7), c = project(h.q, h.r), [sx, sy] = O.characterSpots(true, 1)[0];
  assert.deepEqual([mine.x, mine.y], [c.x + sx * RADIUS, c.y + sy * RADIUS]);
  assert.deepEqual([mine.kind, mine.faction, mine.tile, mine.character.key, mine.character.own, mine.hosts], ['character', 0, 7, 'aster', true, []]);
  assert.deepEqual([other.character.key, other.character.own], ['cinder', false]);
  assert.equal(mine.own, false, 'the ring is the character\'s own: the map never takes it for a host of the viewer');
  // a village the viewer has not surveyed is not drawn: nobody stands there
  assert.equal(O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]) }).length, 1);
  // a battle scene has the tile: the scene shows the characters
  assert.equal(O.characterTokens({ p: 2, q: 0, villages: new Set([7, 26]), heroTiles: new Set([7]), skipTiles: new Set([7]) }).length, 1);
  assert.equal(O.characterTokens({ p: 9, q: 9, villages: new Set([7]) }).length, 0);
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

test('painting: nothing until the sheet is here (no stand-in, no pop), then the shadow and the ring on the ground and the figure upright at the package\'s size', async t => {
  const { O, ctx, calls, draws, requests, loadAll } = await board(t);
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 4, own: true, tier: 1 }, { p: 2, q: 0, tile: 26, faction: 1, own: false }]);
  assert.ok(requests.some(r => r.src.endsWith('/ember_idle.webp')) && requests.some(r => r.src.endsWith('/borealis_idle.webp')), 'the idle sheets are asked for as soon as the page says who stands');
  assert.ok(!requests.some(r => /_walk|_attack|_hit/.test(r.src)), 'and nothing else');
  const [mine, other] = O.characterTokens({ p: 2, q: 0, villages: new Set([7, 26]), heroTiles: new Set([7]) });
  const s = 30;
  assert.equal(O.paintCharacter(ctx, mine, { s, t: 0, now: 10, level: 'full' }), false);
  assert.equal(calls.length, 0, 'before its sheet: nothing at all');
  loadAll();
  assert.equal(O.paintCharacter(ctx, mine, { s, t: 0, now: 10, level: 'full' }), true);
  assert.equal(draws().length, 0, 'the first frame the sheet is here the figure is still clear: it comes in, it does not pop');
  calls.length = 0;
  let stood = null;
  assert.equal(O.paintCharacter(ctx, mine, { s, t: 0.6, now: 10 + O.FADE_IN, level: 'full', up: (x, y) => { stood = [x, y]; return { sh: 0.1, vs: 1.2 }; } }), true);
  assert.deepEqual(stood, [mine.x, mine.y], 'upright about its feet on the tilted board');
  const d = draws();
  assert.equal(d.length, 1);
  const width = s * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  assert.deepEqual(d[0].slice(2), [256, 0, 256, 256, -width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width], 'the second idle frame at 0.6 s, at 1.30 of a host\'s figure');
  const order = calls.map(c => c[0]);
  assert.ok(order.indexOf('ellipse') < order.indexOf('transform') && order.indexOf('transform') < order.indexOf('drawImage'), 'the shadow and the ring lie on the ground, the figure stands on them');
  const strokes = calls.filter(c => c[0] === 'set' && c[1] === 'strokeStyle').map(c => c[2]);
  assert.deepEqual(strokes, [YOURS.key, YOURS.gold, YOURS.core], 'the viewer\'s own: the gold ring, an ivory core, a dark keyline');
  // another player's character: an ivory ring (never gold)
  calls.length = 0;
  O.paintCharacter(ctx, other, { s, t: 0, now: 20, level: 'full' }); calls.length = 0;
  O.paintCharacter(ctx, other, { s, t: 0, now: 21, level: 'full' });
  assert.deepEqual(calls.filter(c => c[0] === 'set' && c[1] === 'strokeStyle').map(c => c[2]), [YOURS.key, '#f4efe0']);
  // reduced motion: a still, there at once
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 4, own: true, tier: 1 }, { p: 2, q: 0, tile: 30, faction: 1, own: false }]);
  const [, fresh] = O.characterTokens({ p: 2, q: 0, villages: new Set([7, 30]), heroTiles: new Set([7]) });
  calls.length = 0;
  assert.equal(O.paintCharacter(ctx, fresh, { s, t: 1.7, now: 30, level: 'reduced' }), true);
  assert.deepEqual(draws().map(x => x[2]), [0], 'the first frame of the idle sheet');
});

test('the landing: the character waits for the land to flood, walks in on the walk sheet from its left, and stands', async t => {
  const { O, ctx, calls, draws, requests, loadAll } = await board(t);
  O.setBoardCharacters([{ p: 2, q: 0, tile: 7, faction: 0, own: true, tier: 0, pending: true }]);
  assert.ok(requests.some(r => r.src.endsWith('/aster_walk.webp')), 'the walk sheet is asked for while the landing is on its way');
  loadAll();
  const [tok] = O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: new Set([7]) });
  assert.equal(O.paintCharacter(ctx, tok, { s: 30, t: 0, now: 100, level: 'full' }), false, 'the landing is reported and has not begun: nobody stands on land that is not in its colour yet');
  assert.equal(calls.length, 0);
  O.noteLanding('2,0,7', 101);
  assert.equal(O.landingAge('2,0,7', 102), 1); assert.equal(O.landingAge('9,9,9', 102), null);
  const W = O.LANDING_WALK;
  O.paintCharacter(ctx, tok, { s: 30, t: 0, now: 101 + W.delay + 0.5, level: 'full' });
  calls.length = 0;
  O.paintCharacter(ctx, tok, { s: 30, t: 0, now: 101 + W.delay + 1.0, level: 'full' });
  const d = draws();
  assert.equal(d.length, 1); assert.match(d[0][1].src, /aster_walk\.webp$/);
  const moved = calls.find(c => c[0] === 'translate');
  assert.ok(moved[1] < tok.x && moved[2] > tok.y, 'on its way: left of its place and a little nearer');
  calls.length = 0;
  O.paintCharacter(ctx, tok, { s: 30, t: 0.2, now: 101 + W.delay + W.secs + 0.1, level: 'full' });
  assert.match(draws()[0][1].src, /aster_idle\.webp$/);
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
    assert.ok(Math.hypot(chr.x - host.x, (chr.y - host.y) / FLATTEN) >= O.CHARACTER_CLEAR * RADIUS);
    assert.equal(chr.status, null); assert.equal(chr.troops, null);
    // skipped where a battle scene has the tile
    assert.deepEqual(provinceTokens({ p: 2, q: 0, hosts, holdingTiles: new Set([7]), heroTiles: new Set([7]), heroSpots: HERO.hosts, skipTiles: new Set([7]) }), []);
  } finally { O.setBoardCharacters([]); }
});

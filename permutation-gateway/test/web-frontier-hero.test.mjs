// The village is the hero (UX brief §11.6; permutation-server/web/frontier/map/plates.mjs, labelpass.mjs,
// glyphs.mjs and the places that use them). What every test here leans on:
//   · a village has ONE label: its own name, its tier, and its garrison and hosts as two badges; the owner's name
//     is not on the map;
//   · what a plate says follows the survey: no garrison and no hosts for a village that is not in sight;
//   · the viewer's own village is drawn larger and its hosts stand in front of it, on its own tile;
//   · labels keep clear of the HUD's rectangles (nudged, or left out) and a tile's pile can be put away;
//   · the map's icons are the HUD sprite's own pictures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PLATES from '../../permutation-server/web/frontier/map/plates.mjs';
import { GLYPHS, paintGlyph } from '../../permutation-server/web/frontier/map/glyphs.mjs';
import { LABEL_PASS, OPEN_PASS, createLabelPass, rectOf, tileKeyOf } from '../../permutation-server/web/frontier/map/labelpass.mjs';
import { STANDARD_AT } from '../../permutation-server/web/frontier/map/ownland.mjs';
import { FrontierMap, NOGO_SELECTORS, paintGuide } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { provinceTokens } from '../../permutation-server/web/frontier/people/units.mjs';
import { placeName } from '../../permutation-server/web/frontier/people/identity.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { FLATTEN, RADIUS, project } from '../../permutation-server/web/map.mjs';

/** A context that records what is called on it. */
function recorder() {
  const calls = [];
  return new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : k === 'measureText' ? t => ({ width: String(t).length * 7 }) : k === 'canvas' ? null : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: (_, k, v) => { calls.push(['=', k, v]); return true; } });
}
const texts = g => g.calls.filter(c => c[0] === 'fillText').map(c => c[1]);

test('the map\'s icons are the HUD sprite\'s own paths, name by name', () => {
  const svg = readFileSync(new URL('../../permutation-server/web/frontier/art/ui/icons.svg', import.meta.url), 'utf8');
  for (const [name, G] of Object.entries(GLYPHS)) {
    const m = new RegExp(`<symbol id="${name}"[^>]*>([\\s\\S]*?)</symbol>`).exec(svg);
    assert.ok(m, `${name} is in the sprite`);
    const paths = [...m[1].matchAll(/<path d="([^"]+)"/g)].map(x => x[1]);
    assert.deepEqual(G.paths.map(p => p[0]), paths, `${name}: the same strokes`);
    const circles = [...m[1].matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(x => x.slice(1, 4).map(Number));
    assert.deepEqual(G.circles ?? [], circles, `${name}: the same circles`);
  }
  for (const n of ['home', 'swords', 'eye', 'shield', 'banner', 'hammer', 'bell', 'hourglass']) assert.ok(GLYPHS[n], n);
  // no Path2D here: nothing is drawn and nothing throws
  assert.equal(paintGlyph(recorder(), 'home', 0, 0, 14), typeof Path2D !== 'undefined');
  assert.equal(paintGlyph(null, 'home', 0, 0, 14), false);
});

test('one plate per village: its own name (never the owner\'s), the tier as a chip, garrison and hosts as two badges; 仮 while it is provisional', () => {
  setLang('ja');
  const v = { p: 2, pq: 0, site: 0, tier: 1, garrison: 300, hosts: 700 };
  const m = PLATES.plateModel(v);
  assert.equal(m.name, placeName(2, 0, 0).ja, 'the place\'s own name, without the tier and without a person\'s name');
  assert.deepEqual(m.chips, [{ text: '町', tone: 'tier' }]);
  assert.deepEqual(m.badges, [{ glyph: 'shield', text: '300', tone: 'plain' }, { glyph: 'banner', text: '700', tone: 'plain' }]);
  // out of sight: the model is given no garrison and no hosts, and says none
  assert.deepEqual(PLATES.plateModel({ ...v, garrison: null, hosts: 0 }).badges, []);
  assert.deepEqual(PLATES.plateModel(v, { badges: false }).badges, [], 'from afar: the name alone');
  assert.deepEqual(PLATES.plateModel({ ...v, provisional: true }).chips.map(c => c.text), ['町', '仮']);
  assert.equal(PLATES.plateModel({ ...v, garrison: 0, hosts: 0 }).badges[0].text, '0', 'an empty garrison is said, not left out');
  assert.equal(PLATES.plateModel({ ...v, shield: true }).badges[0].tone, 'shield');
  setLang('en');
  const e = PLATES.plateModel(v);
  assert.equal(e.name, placeName(2, 0, 0).en);
  assert.equal(e.chips[0].text, 'Town');
  setLang('ja');
  // painted: the name and the numbers are written, nothing else; type no smaller than 12 px
  const g = recorder(), S = PLATES.plateSize(g, m, 1, { own: true });
  PLATES.paintPlate(g, 0, 0, m, S, { k: 1, faction: 0, own: true });
  assert.deepEqual(texts(g), [m.name, '町', '300', '700']);
  const fonts = g.calls.filter(c => c[0] === '=' && c[1] === 'font').map(c => Number(/(\d+(?:\.\d+)?)px/.exec(c[2])[1]));
  assert.ok(fonts.length > 0 && fonts.every(px => px >= 12), `canvas type of at least 12 px: ${[...new Set(fonts)]}`);
  assert.ok(g.calls.some(c => c[0] === '=' && c[1] === 'font' && /Mincho|serif/.test(c[2])), 'the name in the serif');
  assert.ok(S.w < 190 && S.h <= 46, `a plate, not a billboard: ${Math.round(S.w)} x ${Math.round(S.h)}`);
});

test('the viewer\'s own village: 1.6 to 2 times larger, its plate above the sprite, the standard beside it, its hosts in front and on its own tile', () => {
  const H = PLATES.HERO;
  assert.ok(H.scale >= 1.6 && H.scale <= 2, `scale ${H.scale}`);
  assert.deepEqual(STANDARD_AT, H.standard, 'one place for the standard');
  assert.ok(H.standard.x > RADIUS * 0.9, 'beside the houses, not among them');
  assert.ok(H.top > PLATES.VILLAGE_TOP * 1.6, 'the plate hangs above the larger sprite');
  // the plate keeps left of the standard's pole and never covers the sprite: its lower edge is above the anchor
  const u = { x: 100, y: 200, hero: true }, S = { w: 150, h: 45 };
  const a = PLATES.plateAnchor(u, S, 1);
  assert.ok(a.ax + a.lean + S.w / 2 <= u.x + H.standard.x, 'left of the pole');
  assert.ok(a.ay === u.y - H.top && a.leader >= 10);
  assert.equal(PLATES.plateAnchor({ x: 0, y: 0 }, S, 1).lean, 0, 'another village: centred');
  assert.ok(PLATES.plateRise({ hero: true }, 1.3) > PLATES.plateRise({}, 1.3));
  // hosts: every spot in front of the houses (below the centre), outside the palisade either side of the gate road:
  // within the village's own footprint (fix pass 2: the town is drawn 1.65 times a tile, and hosts kept inside a
  // hexagon of 1.3 times the tile stood on its lower houses), never as far as the middle of the tile in front
  const inHex = (x, y) => { const ax = Math.abs(x) / (RADIUS * Math.sqrt(3) / 2), ay = Math.abs(y) / (RADIUS * FLATTEN); return ax <= 1.04 && ay + ax * 0.5 <= H.scale; };
  for (const spots of H.hosts) for (const [dx, dy] of spots) {
    const x = dx * RADIUS, y = dy * RADIUS * FLATTEN * 1.6;
    assert.ok(y > RADIUS * FLATTEN * 0.6, 'in front of the village');
    assert.ok(inHex(x, y), `on its own tile's edge (${x.toFixed(0)}, ${y.toFixed(0)})`);
    assert.ok(y < RADIUS * FLATTEN * 1.5 * 0.85, 'well short of the next row\'s centres');
  }
  // the token layer uses those spots on the viewer's village and its usual ones elsewhere
  const hosts = [{ id: 1n, faction: 0, unit: 0, tile: 7, state: 1, troops: 600 }];
  const c = (h => project(h.q, h.r))(tileHex(2, 0, 7));
  const plain = provinceTokens({ p: 2, q: 0, hosts, holdingTiles: new Set([7]) })[0];
  const hero = provinceTokens({ p: 2, q: 0, hosts, holdingTiles: new Set([7]), heroTiles: new Set([7]), heroSpots: H.hosts })[0];
  assert.ok(hero.y - c.y > plain.y - c.y, 'further to the front than on another village');
  assert.deepEqual([hero.x - c.x, hero.y - c.y].map(Math.round), [Math.round(H.hosts[0][0][0] * RADIUS), Math.round(H.hosts[0][0][1] * RADIUS * FLATTEN * 1.6)]);
});

const tile = (o = {}) => { const h = tileHex(2, 0, o.idx ?? 7), c = project(h.q, h.r); return { p: 2, pq: 0, idx: 7, x: c.x, y: c.y, state: 1, owner: 0, site: 0, tier: 1, lv: 3, garrison: 300, ...o }; };
test('the labels of a frame: the plate carries the hosts on a village (no pill of their own); a host in the field keeps its pill; out of sight no numbers', () => {
  setLang('ja');
  const home = tile({ hero: true }), other = tile({ idx: 20, site: 1, owner: 4, garrison: 50, x: tile().x + 400 }), far = tile({ idx: 45, site: 2, owner: 2, lv: 2, garrison: null, x: tile().x - 400 });
  const pills = [{ tok: { x: home.x + 20, y: home.y + 30, p: 2, q: 0, tile: 7, faction: 0, troops: 700, n: 2, own: true }, s: 29 },
    { tok: { x: home.x - 20, y: home.y + 30, p: 2, q: 0, tile: 7, faction: 0, troops: 400, status: 'sealed' }, s: 29 },
    { tok: { x: home.x + 900, y: home.y, p: 2, q: 0, tile: 30, faction: 0, troops: 250, own: true }, s: 29 }];
  const g = recorder();
  const n = PLATES.paintPlates(g, { tiles: [home, other, far], pills, constructions: [{ p: 2, q: 0, site: 0, share: 0.4 }], hostsOn: new Map([['2,0,7', 700]]), zoom: 1.3 });
  assert.equal(n, 3);
  const said = texts(g);
  assert.deepEqual(said.filter(t => /^\d/.test(t)).sort(), ['250', '300', '50', '700'], 'garrisons, the hosts on the hero village once, the pill of the host in the field; nothing for the village out of sight');
  assert.equal(said.filter(t => t === placeName(2, 0, 0).ja).length, 1, 'one plate for the village');
  assert.ok(!said.some(t => /×/.test(t)), 'no "700 ×2" on the village');
  // from afar another nation's hamlet has no plate; the viewer's own always has
  const g2 = recorder();
  assert.equal(PLATES.paintPlates(g2, { tiles: [home, tile({ idx: 20, site: 1, owner: 4, tier: 0, x: home.x + 400 })], zoom: 0.62 }), 1);
  // a tile whose pile is put away shows nothing: no plate, no ring, no pill
  const g3 = recorder();
  const pass = createLabelPass({ zoom: 1.3, hidden: new Set(['2,0,7']) });
  assert.equal(PLATES.paintPlates(g3, { tiles: [home], pills: pills.slice(0, 2), constructions: [{ p: 2, q: 0, site: 0, share: 0.4 }], hostsOn: new Map([['2,0,7', 700]]), zoom: 1.3, pass }), 0);
  assert.deepEqual(texts(g3), []);
  assert.ok(!g3.calls.some(c => c[0] === 'arc'), 'no ring either');
});

test('the label pass: a label under the HUD slides out the short way; with no room it is left out, unless it must stay; later labels keep clear of earlier ones', () => {
  const dial = { x: 300, y: 0, w: 100, h: 100 };
  const pass = createLabelPass({ nogo: [dial], zoom: 1, bounds: { w: 800, h: 600 } });
  // clear of everything: where it is
  assert.deepEqual(pass.place(100, 300, { x: 60, y: 280, w: 80, h: 24 }), { dx: 0, dy: 0 });
  // under the dial's lower edge: it moves down, just clear
  const a = pass.place(350, 110, { x: 310, y: 84, w: 80, h: 24 });
  assert.deepEqual([a.dx, a.dy], [0, 100 + LABEL_PASS.gap - 84]);
  // the next label that wants the same place moves off the first
  const b = pass.place(350, 110, { x: 310, y: 100 + LABEL_PASS.gap, w: 80, h: 24 });
  assert.ok(b && (b.dx !== 0 || b.dy !== 0), 'not on top of the one before');
  // boxed in on every side within its reach: left out; `keep`: it stays
  const tight = createLabelPass({ nogo: [{ x: 0, y: 0, w: 800, h: 600 }], zoom: 1, bounds: { w: 800, h: 600 } });
  assert.equal(tight.place(400, 300, { x: 360, y: 288, w: 80, h: 24 }), null);
  assert.deepEqual(tight.place(400, 300, { x: 360, y: 288, w: 80, h: 24 }, { keep: true }), { dx: 0, dy: 0 });
  // world px in, world px out: at zoom 2 a nudge of 10 screen px is 5 world px; `screen` says where the anchor is seen
  const z2 = createLabelPass({ nogo: [{ x: 0, y: 0, w: 400, h: 50 }], zoom: 2, screen: (x, y) => ({ x: x * 2 + 100, y: y * 2 }) });
  const m = z2.place(50, 30, { x: 40, y: 20, w: 20, h: 10 });   // seen at (180, 40) .. (220, 60): under the strip by 10 px
  assert.deepEqual([m.dx, m.dy], [0, (50 + LABEL_PASS.gap - 40) / 2]);
  // helpers
  assert.deepEqual(rectOf({ left: 1, top: 2, right: 11, bottom: 22 }), { x: 1, y: 2, w: 10, h: 20 });
  assert.deepEqual(rectOf({ x: 1, y: 2, width: 10, height: 20 }), { x: 1, y: 2, w: 10, h: 20 });
  assert.equal(rectOf({ x: 1, y: 2, width: 0, height: 20 }), null);
  assert.equal(tileKeyOf({ p: 2, q: 0, tile: 7 }), '2,0,7');
  assert.equal(tileKeyOf('2,0,7'), '2,0,7');
  assert.equal(tileKeyOf({ p: 2 }), null);
  assert.deepEqual(OPEN_PASS.place(0, 0, { x: 0, y: 0, w: 1, h: 1 }), { dx: 0, dy: 0 });
});

test('the map\'s hooks for the page: setNoGo, hideLabelsAt (counted), setPiece (counted), and the selectors it measures until it is fed', () => {
  const P = FrontierMap.prototype;
  const m = { tick() { this.ticks = (this.ticks ?? 0) + 1; } };
  P.hideLabelsAt.call(m, '2,0,7', true);
  P.hideLabelsAt.call(m, { p: 2, q: 0, tile: 7 }, true);
  assert.equal(m.hiddenLabels.get('2,0,7'), 2);
  P.hideLabelsAt.call(m, '2,0,7', false);
  assert.ok(m.hiddenLabels.has('2,0,7'), 'two effects on one tile: still hidden after the first ends');
  P.hideLabelsAt.call(m, '2,0,7', false);
  assert.equal(m.hiddenLabels.has('2,0,7'), false);
  P.hideLabelsAt.call(m, null, true);
  assert.equal(m.hiddenLabels.size, 0);
  P.setPiece.call(m, true); P.setPiece.call(m, true); P.setPiece.call(m, false);
  assert.equal(m.pieces, 1);
  P.setPiece.call(m, false); P.setPiece.call(m, false);
  assert.equal(m.pieces, 0, 'never below zero');
  P.setNoGo.call(m, [{ left: 10, top: 20, right: 110, bottom: 60 }, { x: 0, y: 0, width: 0, height: 5 }]);
  assert.deepEqual(m.nogoFed, [{ x: 10, y: 20, w: 100, h: 40 }]);
  P.setNoGo.call(m, null);
  assert.equal(m.nogoFed, null, 'null: the map measures the page again');
  assert.ok(m.ticks >= 8, 'each call asks for a frame');
  for (const sel of ['#bell-pill', '#rail', '#minimap', '.map-tools', '#tabs', '#panel']) assert.ok(NOGO_SELECTORS.includes(sel), `${sel} is measured`);
});

test('the guide\'s words stand above a village\'s plate (rise), in type of 12 px, and its ring is a quiet dashed mark', () => {
  const g = recorder();
  paintGuide(g, { p: 2, q: 0, tile: 7 }, 1, 'ガイド：ここから探索', 'label', { rise: 130 });
  assert.deepEqual(texts(g), ['ガイド：ここから探索']);
  const c = (h => project(h.q, h.r))(tileHex(2, 0, 7));
  const ys = g.calls.filter(x => x[0] === 'lineTo' || x[0] === 'moveTo').map(x => x[2]);
  assert.ok(Math.max(...ys) <= c.y - 130 + 1e-6, 'everything above the plate\'s top');
  assert.ok(g.calls.some(x => x[0] === '=' && x[1] === 'font' && /12/.test(x[2])));
  const r = recorder();
  paintGuide(r, { p: 2, q: 0, tile: 7 }, 1.3, '', 'ring');
  assert.ok(r.calls.some(x => x[0] === 'setLineDash' && x[1].length === 2), 'dashed');
  assert.deepEqual(texts(r), []);
});

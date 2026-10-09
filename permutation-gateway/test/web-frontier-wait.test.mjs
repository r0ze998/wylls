// The wait for the village on the map (UX brief §11.10; permutation-server/web/frontier/map/waitview.mjs and the
// places that use it). What every test here leans on:
//   · a candidate site is named as the drawer's list names it, with its number in that list;
//   · the countdown's time comes from the page (chain seconds), and its words never say the village is there;
//   · a list row can ask the map to fly to its place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as WAIT from '../../permutation-server/web/frontier/map/waitview.mjs';
import { FrontierMap, FLY_TO_ZOOM } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { placeName } from '../../permutation-server/web/frontier/people/identity.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { provincePixel } from '../../permutation-server/web/frontier/map/layers.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { RADIUS, project } from '../../permutation-server/web/map.mjs';

function recorder() {
  const calls = [];
  return new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : k === 'measureText' ? t => ({ width: String(t).length * 7 }) : k === 'canvas' ? null : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: (_, k, v) => { calls.push(['=', k, v]); return true; } });
}
const texts = g => g.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
const SITES = [{ p: 2, q: 0, site: 0, tile: 7 }, { p: 1, q: 1, site: 2, tile: 30 }, { p: 1, q: 1, site: 4, tile: null }];

test('a candidate is named as the list names it: its number and the name a village there would carry', () => {
  setLang('ja');
  assert.equal(WAIT.candidateLabel(SITES[0], 0), `1 ${placeName(2, 0, 0).ja}`);
  assert.equal(WAIT.candidateLabel(SITES[1], 1), `2 ${placeName(1, 1, 2).ja}`);
  setLang('en');
  assert.equal(WAIT.candidateLabel(SITES[0], 0), `1 ${placeName(2, 0, 0).en}`);
  setLang('ja');
  // where it is: its tile, or its province's middle while the terrain is on its way
  assert.deepEqual(WAIT.candidatePoint(SITES[0]), (h => project(h.q, h.r))(tileHex(2, 0, 7)));
  assert.deepEqual(WAIT.candidatePoint(SITES[2]), provincePixel(1, 1));
  // the box around all of them has room for a ring and a label on every side
  const b = WAIT.candidatesBox(SITES), pts = SITES.map(WAIT.candidatePoint);
  for (const p of pts) assert.ok(p.x - b.x0 >= RADIUS * 1.5 && b.x1 - p.x >= RADIUS * 1.5 && p.y - b.y0 >= RADIUS * 2 && b.y1 - p.y >= RADIUS);
  assert.equal(WAIT.candidatesBox([]), null);
  assert.equal(WAIT.candidatesBox(null), null);
});

test('the countdown: with a request out, the time until its result is due, on the candidate tried first; without one, the time to the next turn at the standard', () => {
  setLang('ja');
  assert.equal(WAIT.clockText(560), '9:20');
  assert.equal(WAIT.clockText(5), '0:05');
  assert.equal(WAIT.clockText(3850), '1:04:10');
  assert.equal(WAIT.clockText(-3), '0:00');
  // (rewritten with the fix pass on the second review: the map's line counts to the bell that decides the village,
  // `tollAt`, as the drawer and the dial do; it counted to the result, a minute later, and read 10:19 under a dial at 9:20)
  assert.deepEqual(WAIT.waitLine({ now: 1000, nextTurnAt: 1560, resultAt: 1619, tollAt: 1560, share: 0.4, first: 1 }), { at: 'candidate', index: 1, glyph: 'bell', share: 0.4, text: '村が決まる鐘まで 9:20' });
  assert.equal(WAIT.waitLine({ now: 1000, nextTurnAt: 1560, resultAt: 1619, first: 1 }).text, '村が決まる鐘まで 10:19', 'a page that gives no toll: the result\'s own time');
  assert.equal(WAIT.waitLine({ now: 1570, nextTurnAt: 2160, resultAt: 1619, tollAt: 1560, first: 0 }).text, 'まもなく村が決まります', 'after the toll');
  assert.equal(WAIT.waitLine({ now: 2000, nextTurnAt: 2100, resultAt: 1619, first: 0 }).text, 'まもなく村が決まります', 'past the time: no negative clock, no claim that it is decided');
  assert.deepEqual(WAIT.waitLine({ now: 1000, nextTurnAt: 1560, resultAt: null, first: null }), { at: 'home', index: null, glyph: 'bell', text: '次のターンまで 9:20' });
  assert.equal(WAIT.waitLine(null), null);
  assert.equal(WAIT.waitLine({ now: NaN }), null);
  setLang('en');
  assert.equal(WAIT.waitLine({ now: 1000, nextTurnAt: 1560, resultAt: 1619, tollAt: 1560, first: 0 }).text, 'Deciding bell in 9:20');
  assert.equal(WAIT.waitLine({ now: 1000, nextTurnAt: 1560 }).text, 'Next turn in 9:20');
  setLang('ja');
});

test('painted: the nation\'s name and 「あなたの国の土地」 under the standard; each candidate\'s number and name; the countdown once; type of 12 px and more', () => {
  setLang('ja');
  const g = recorder(), at = { x: 100, y: 200 };
  WAIT.paintWaitStandard(g, at, { zoom: 0.5, faction: 0, still: true });
  assert.ok(WAIT.waitUnit(0.5) * 0.5 >= WAIT.WAIT_STANDARD.screen, 'the standard is never small on screen');
  const line = WAIT.waitLine({ now: 1000, nextTurnAt: 1560, resultAt: null });
  WAIT.paintHomeTag(g, at, { zoom: 1, faction: 0, line });
  assert.deepEqual(texts(g), ['アステル', 'あなたの国の土地', '次のターンまで 9:20']);
  const c = recorder();
  const first = WAIT.waitLine({ now: 1000, nextTurnAt: 1560, resultAt: 1619, first: 0 });
  assert.equal(WAIT.paintCandidateLabels(c, SITES, { zoom: 1, line: first }), 3);
  assert.deepEqual(texts(c), ['1', placeName(2, 0, 0).ja, '2', placeName(1, 1, 2).ja, '3', placeName(1, 1, 4).ja, '村が決まる鐘まで 10:19'], 'the names first, then the one countdown');
  // with a request out the standard's tag carries no countdown of its own (one countdown on the map)
  const h = recorder();
  WAIT.paintHomeTag(h, at, { zoom: 1, faction: 0, line: first });
  assert.deepEqual(texts(h), ['アステル', 'あなたの国の土地']);
  for (const r of [g, c, h]) {
    const fonts = r.calls.filter(x => x[0] === '=' && x[1] === 'font').map(x => Number(/(\d+(?:\.\d+)?)px/.exec(x[2])[1]));
    assert.ok(fonts.every(px => px >= 12), `type of at least 12 px: ${[...new Set(fonts)]}`);
  }
  assert.doesNotThrow(() => { WAIT.paintHomeTag(null, at); WAIT.paintCandidateLabels(null, SITES); WAIT.paintWaitStandard(null, at); });
});

test('a list row flies the map to its place: {p, q, tile}, or {p, q, site} through the terrain, or the province', () => {
  const P = FrontierMap.prototype;
  const flown = [];
  const m = { cam: { view: { x: 0, y: 0, zoom: 0.4 } }, source: () => ({ terrainOf: (p, q) => (p === 1 && q === 1 ? { sites: [5, 9, 30] } : null) }), flyTo(t) { flown.push(t); } };
  assert.equal(P.flyToPlace.call(m, { p: 2, q: 0, tile: 7 }), true);
  assert.deepEqual(flown.pop(), { p: 2, q: 0, tile: 7, zoom: FLY_TO_ZOOM });
  P.flyToPlace.call(m, { p: 1, q: 1, site: 2 });
  assert.deepEqual(flown.pop(), { p: 1, q: 1, tile: 30, zoom: FLY_TO_ZOOM }, 'a site: its tile');
  P.flyToPlace.call(m, { p: 2, q: 0, site: 2 });
  assert.deepEqual(flown.pop(), { p: 2, q: 0, tile: undefined, zoom: FLY_TO_ZOOM }, 'no terrain yet: the province');
  m.cam.view.zoom = 1.6;
  P.flyToPlace.call(m, { p: 2, q: 0, tile: 7 });
  assert.equal(flown.pop().zoom, 1.6, 'a closer view is kept');
  assert.equal(P.flyToPlace.call(m, { p: 2 }), false);
  assert.equal(P.flyToPlace.call(m, null), false);
  assert.equal(flown.length, 0);
});

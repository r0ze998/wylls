// B14 (loop-play3, fix-b14-b16): rings 0–1 of a season WITH the centre (conquest byte 81 `centre` 0, ⑭ R2 off) are
// seeded but have no Province in a local world. The page said 「第1輪（生まれるところです）」 for good, lit the ring-1
// tiles as 「村を置ける場所」, and sealed a march there that the program can never reveal (its Reveal needs the
// Province): the host was lost. Now such a place is `centre`: named so, never a village, never a march's destination
// or road. With ⑭ R2 on (`centre` 1) the rings read as every other ring.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { destOpenOf } from '../../permutation-server/web/frontier/screens/march.mjs';
import { palisadeHexesOf } from '../../permutation-server/web/frontier/s1walk.mjs';
import { clientText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const rings = n => Array.from({ length: n }, (_, d) => ({ d, seed: '00' }));
// the local natural world: rings 0–3 seeded, Provinces only in rings 2–3 (natural_play opens the home provinces)
const LOCAL = { rings: rings(4), ringsOpened: 4, rMax: 9, ringProvinces: [0, 0, 12, 18] };
const withCentre = { conquestParams: { centre: 0 } }, centreFree = { conquestParams: { centre: 1 } };
const fsOf = (season, rec = LOCAL) => ({ season, record: rec, world: W.worldOf(rec), worldRings: new Map([[0, new Set()], [1, new Set()]]) });

test('a centre ring without its Province is the centre, not "being made"; a season whose centre is land reads it as any ring', () => {
  const w = W.worldOf(LOCAL);
  assert.equal(W.placeOf(w, 0, 0, () => null, { centre: true }), 'centre', 'a count of 0 says it before any list');
  assert.equal(W.placeOf(w, 1, -1, () => new Set(), { centre: true }), 'centre');
  // a centre ring PARTLY on chain is being opened by a keeper: its missing places stay pending (web-frontier-map-contract)
  const partly = W.worldOf({ ...LOCAL, ringProvinces: [0, 3, 12, 18] });
  assert.equal(W.placeOf(partly, 1, -1, () => new Set(['1,0']), { centre: true }), 'pending');
  assert.equal(W.placeOf(w, 2, 0, () => null, { centre: true }), 'open', 'ring 2 is whole');
  // the old reading without the option, unchanged
  assert.equal(W.placeOf(w, 1, -1, () => new Set()), 'pending');
  assert.equal(W.placeOf(w, 1, -1, () => null), 'open');
  // the page's state: the season says which
  assert.equal(W.placeNow(fsOf(withCentre), 1, -1), 'centre');
  assert.equal(W.placeNow(fsOf(undefined), 0, 0), 'centre', 'a season without the byte has the centre');
  assert.equal(W.placeNow(fsOf(centreFree), 1, -1), 'pending', '⑭ R2: ordinary land whose Province is still to come');
  // a centre Province that IS on chain (a season whose keeper opened the Seats) is open land
  const seats = { ...LOCAL, ringProvinces: [0, 6, 12, 18] };
  assert.equal(W.placeNow(fsOf(withCentre, seats), 1, -1), 'open');
  assert.equal(W.placeNow(fsOf(withCentre, seats), 0, 0), 'centre');
});

test('the words: the ring and the note say the centre has no province, in both languages', () => {
  assert.equal(W.ringText('centre', 1), '第1輪（中央・州なし）');
  assert.equal(W.PLACE_NOTE.centre(), 'ここは中央です。この世界では州がないので、村も置けず、進軍の行き先にもできません');
  assert.doesNotMatch(W.ringText('centre', 0), /生まれる/);
  setLang('en');
  assert.equal(W.ringText('centre', 1), 'Ring 1 (centre, no province)');
  assert.equal(W.PLACE_NOTE.centre(), 'This is the centre. This world has no province here, so no village can be placed here and no march can go here');
  assert.equal(clientText('DestinationNotOpen'), 'There is no province there, so a march cannot go there');
  setLang('ja');
  assert.equal(clientText('DestinationNotOpen'), 'そこには州がないので、進軍の行き先にできません');
});

test('no road through the centre: its 7 × 61 hexes are blocked for the planner, none in a centre-free season', () => {
  const closed = W.closedCentreHexes(fsOf(withCentre));
  assert.equal(closed.length, 7 * 61);
  assert.equal(new Set(closed.map(h => `${h.q},${h.r}`)).size, 7 * 61);
  assert.deepEqual(W.closedCentreHexes(fsOf(centreFree)), []);
  assert.deepEqual(W.closedCentreHexes({}), [], 'no season record: nothing is known, nothing is blocked');
  assert.equal(ringProvinces(0).length + ringProvinces(1).length, 7);
  // the march planner's `blocked` (fmarch planRoute, keep reach) carries them
  assert.equal(palisadeHexesOf(fsOf(withCentre)).length, 7 * 61);
  assert.deepEqual(palisadeHexesOf(fsOf(centreFree)), []);
});

test('the composer: a destination that is not open land is refused before anything is sealed', () => {
  assert.equal(destOpenOf(fsOf(withCentre), { p: 1, q: -1, tile: 30 }), false);
  assert.equal(destOpenOf(fsOf(withCentre), { p: 2, q: 0, tile: 30 }), true);
  assert.equal(destOpenOf({}, { p: 1, q: -1, tile: 30 }), undefined, 'without a season record the page cannot tell');
  assert.equal(destOpenOf(fsOf(withCentre), null), undefined);
  // (checkMarch's DestinationNotOpen itself: web-frontier-march.test.mjs 'checkMarch names every refusal')
});

test('the inspector: a centre tile names the centre, offers no site and no "march here"', () => {
  const FS = { ...fsOf(withCentre), selected: { p: 1, q: -1, idx: 30 }, mode: 'play', compose: { host: { id: '1' } } };
  const terrainOf = () => ({ sites: [30], terrain: new Uint8Array(61), names: ['plains'] });
  const m = inspect.inspectModel(FS, terrainOf);
  assert.equal(m.place, 'centre');
  assert.equal(m.opened, false);
  assert.equal(m.tile?.site ?? null, null, 'no 「村を置ける場所」 on the centre');
  const html = String(inspect.render(FS, terrainOf));
  assert.match(html, /第1輪（中央・州なし）/);
  assert.doesNotMatch(html, /生まれるところです/);
  assert.doesNotMatch(html, /村を置ける場所/);
  assert.doesNotMatch(html, /dest-from-map/, 'no 「ここを進軍の行き先にする」 on the centre');
  // the same tile in a ring that is open land still offers it
  const open = { ...FS, selected: { p: 2, q: 0, idx: 30 } };
  assert.match(String(inspect.render(open, terrainOf)), /dest-from-map/);
});

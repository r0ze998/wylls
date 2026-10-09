// Wave 4, the integration of the BOARD and the PLAYERS tracks (UX design 13): what the two left to be wired.
//   the gold of "yours" is one table for the board's rail and the people's rings (palette.mjs YOURS_MARK)
//   the viewer's own character stands in the spot the wait view keeps beside the nation's standard
//   the words under the standard name no speaker anywhere (the map's tag and the page's card read one function)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { YOURS_MARK, NATION_FILL, contrast } from '../../permutation-server/web/frontier/palette.mjs';
import { YOURS as RAIL } from '../../permutation-server/web/frontier/map/chart.mjs';
import { YOURS as RING } from '../../permutation-server/web/frontier/people/leader-art.mjs';
import * as WAIT from '../../permutation-server/web/frontier/map/waitview.mjs';
import { LEADER_MOTIONS, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE, LEADER_SPRITE_ANCHOR } from '../../permutation-server/web/frontier/leader-motion-data.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');

test('"yours" is one gold: the board\'s rail and the people\'s rings read the same three tones', () => {
  for (const k of ['gold', 'core', 'key']) {
    assert.equal(RAIL[k], YOURS_MARK[k], `the board's ${k}`);
    assert.equal(RING[k], YOURS_MARK[k], `the people's ${k}`);
  }
  // neither module keeps a tone of its own
  assert.match(src('map/chart.mjs'), /export const YOURS = Object\.freeze\(\{ \.\.\.YOURS_MARK, rail:/);
  assert.match(src('people/leader-art.mjs'), /export const YOURS = Object\.freeze\(\{ \.\.\.YOURS_MARK, inset:/);
  // the mark is told by how it is built: gold on its keyline, the core lighter than the gold, the key darker than any nation's cloth
  assert.ok(contrast(YOURS_MARK.gold, YOURS_MARK.key) >= 7);
  assert.ok(contrast(YOURS_MARK.core, YOURS_MARK.key) > contrast(YOURS_MARK.gold, YOURS_MARK.key));
  for (let f = 0; f < 6; f++) assert.ok(contrast(NATION_FILL[f], YOURS_MARK.key) >= 2.5, `nation ${f}: its cloth beside the keyline`);
});

// A page's Image for this file: every picture asked for, loaded when the test says so.
const requests = [];
globalThis.Image = class { constructor() { requests.push(this); } load(w, h) { this.width = w; this.height = h; this.onload?.(); } };
const loadAll = () => { for (const img of requests) { const m = LEADER_MOTIONS.find(x => img.src?.endsWith(`_${x.key}.webp`)); if (m && !img.width) img.load(256 * m.frames, 256); } };
function recorder() {
  const calls = [], state = { globalAlpha: 1, stack: [] };
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'globalAlpha') return state.globalAlpha;
      if (k === 'save') return () => state.stack.push(state.globalAlpha);
      if (k === 'restore') return () => { state.globalAlpha = state.stack.pop(); };
      return (...a) => { calls.push([k, ...a, state.globalAlpha]); };
    },
    set(_, k, v) { if (k === 'globalAlpha') state.globalAlpha = v; else calls.push(['set', k, v]); return true; },
  });
  return { ctx, calls };
}

test('the wait for the village: the viewer\'s own character stands in the spot kept beside the standard, the ring on the ground, the figure upright; nothing before its sheet', async () => {
  const O = await import('../../permutation-server/web/frontier/people/onboard.mjs');
  const at = { x: 400, y: -120 }, zoom = 0.668, spot = WAIT.waitSpotAt(at, zoom);
  assert.ok(spot.x < at.x && spot.box.w > 0 && spot.box.h > 0, 'the room is to the left of the pole');
  const { ctx, calls } = recorder();
  // no nation, no spot: nothing
  assert.equal(O.paintWaitCharacter(ctx, spot, { faction: 6 }), false);
  assert.equal(O.paintWaitCharacter(ctx, null, { faction: 0 }), false);
  // before the sheet: the sheet is asked for (the idle one alone) and the spot stays empty
  assert.equal(O.paintWaitCharacter(ctx, spot, { faction: 3, now: 5, level: 'full' }), false);
  assert.equal(calls.length, 0);
  assert.ok(requests.some(r => r.src.endsWith('/dunmar_idle.webp')) && !requests.some(r => /_walk|_attack|_hit/.test(r.src)));
  loadAll();
  // the first frame the sheet is here it is still clear (it comes in over FADE_IN, it does not pop)
  assert.equal(O.paintWaitCharacter(ctx, spot, { faction: 3, now: 5, level: 'full' }), true);
  const first = calls.find(c => c[0] === 'drawImage');
  assert.equal(first[first.length - 1], 0, 'drawn with no opacity yet');
  calls.length = 0;
  let stood = null;
  assert.equal(O.paintWaitCharacter(ctx, spot, { faction: 3, now: 5 + O.FADE_IN + 0.6, level: 'full', up: (x, y) => { stood = [x, y]; return { sh: 0.1, vs: 1.2 }; } }), true);
  // the figure: WAIT_FILL of the room kept, its feet a little up the room, upright about its feet
  const s = spot.box.h * O.WAIT_FILL / O.characterHeight(1), feet = spot.y - s * O.WAIT_LIFT;
  assert.deepEqual(stood, [spot.x, feet]);
  const d = calls.filter(c => c[0] === 'drawImage');
  assert.equal(d.length, 1);
  const width = s * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  assert.deepEqual(d[0].slice(3, 10), [0, 256, 256, -width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width]);
  assert.ok(Math.abs(O.characterHeight(s) - spot.box.h * O.WAIT_FILL) < 1e-9, 'as tall as the room asks');
  assert.ok(d[0][d[0].length - 1] === 1, 'whole once it has come in');
  // the ring on the ground at its feet says "yours": key, gold, ivory core; it lies on the board (before the upright transform)
  const order = calls.map(c => c[0]);
  assert.ok(order.indexOf('ellipse') < order.indexOf('transform') && order.indexOf('transform') < order.indexOf('drawImage'));
  assert.deepEqual(calls.filter(c => c[0] === 'set' && c[1] === 'strokeStyle').map(c => c[2]), [YOURS_MARK.key, YOURS_MARK.gold, YOURS_MARK.core]);
  // the ring keeps inside the room: its lowest point is not below the room's foot (the tag under the standard begins there)
  const ring = calls.filter(c => c[0] === 'ellipse').pop();
  assert.ok(ring[2] + ring[4] <= spot.y + 1e-9, 'the ring\'s lowest point is at the room\'s foot at most');
  // reduced motion: the sheet's first frame, there at once (another nation, never seen before)
  loadAll(); O.paintWaitCharacter(recorder().ctx, spot, { faction: 1, now: 9, level: 'reduced' }); loadAll();
  const r = recorder();
  assert.equal(O.paintWaitCharacter(r.ctx, spot, { faction: 1, now: 9, level: 'reduced' }), true);
  const still = r.calls.find(c => c[0] === 'drawImage');
  assert.equal(still[2], 0); assert.equal(still[still.length - 1], 1);
});

test('the map paints the wait\'s character where it paints the standard, through the people\'s painter, and not on the world chart', () => {
  const fmap = src('map/fmap.mjs');
  assert.match(fmap, /import \{ paintWaitCharacter \} from '\.\.\/people\/onboard\.mjs';/);
  const calls = fmap.match(/paintWaitCharacter\(/g) ?? [];
  assert.equal(calls.length, 1, 'one call');
  assert.match(fmap, /if \(homeAt && lod !== 'world'\) paintWaitCharacter\(ctx, waitSpotAt\(homeAt, z\), \{ faction: survey\.faction, up \}\);/);
  // the spot the labels keep clear of is the spot the figure is painted in
  assert.match(fmap, /pass\.block\(homeAt\.x, homeAt\.y, waitSpotAt\(homeAt, z\)\.box\)/);
  // truth: the painter knows a nation and a spot; it reads no village, march, route or destination
  const fn = src('people/onboard.mjs').split('export function paintWaitCharacter')[1].split('\n}\n')[0];
  assert.doesNotMatch(fn, /march|route|dest|holding|village\b/i);
});

test('the words under the standard name no speaker anywhere: the map\'s tag and the page\'s card read one function', () => {
  assert.equal(WAIT.leaderWords, WAIT.nationWords);
  for (let f = 0; f < 6; f++) for (const st of [null, 'ticket']) assert.deepEqual(Object.keys(WAIT.nationWords(f, st)), ['text']);
  assert.equal(WAIT.nationWords(6), null);
  assert.doesNotMatch(src('map/waitview.mjs'), /LEADERS|\.who\b/);
  assert.doesNotMatch(src('frontier.css'), /\.map-wait\b/, 'the stage the map no longer makes has no rule left');
});

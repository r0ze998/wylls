// Exact pure minimap rendering paths and canvas command counters. No browser,
// network, terrain generation, keys or signing; public coordinates only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paintMinimap } from '../../permutation-server/web/frontier/hud/minimap.mjs';
import { FACTION_FILL } from '../../permutation-server/web/frontier/people/avatar.mjs';

function canvas({ cache = true } = {}) {
  const layers = [], metrics = { calls: new Map(), fills: new Map(), nonfinite: 0, images: [] };
  let ctx;
  const cv = { width: 188, height: 188, getContext: () => ctx };
  if (cache) cv.ownerDocument = { createElement() {
    const layer = canvas({ cache: false }); layers.push(layer); return layer.cv;
  } };
  const state = {};
  ctx = new Proxy(state, {
    get(target, name) {
      if (name === 'canvas') return cv;
      if (Object.hasOwn(target, name)) return target[name];
      return (...args) => {
        metrics.calls.set(name, (metrics.calls.get(name) ?? 0) + 1);
        metrics.nonfinite += args.filter(x => typeof x === 'number' && !Number.isFinite(x)).length;
        if (name === 'fill') metrics.fills.set(target.fillStyle, (metrics.fills.get(target.fillStyle) ?? 0) + 1);
        if (name === 'drawImage') metrics.images.push(args[0]);
        if (name === 'createRadialGradient') return { addColorStop() {} };
      };
    },
    set(target, name, value) { target[name] = value; return true; },
  });
  return { cv, ctx, layers, metrics };
}
class Records extends Map {
  reads = 0;
  get(key) { this.reads++; return super.get(key); }
}
const record = faction => ({ owners: [faction], sites: [1], clash: false });
const paint = (c, args) => paintMinimap(c.ctx, { recs: new Map(), rings: 6, ...args });

test('minimap ring128 has finite cloud rim and never reads unopened or out-of-disk land', () => {
  const c = canvas({ cache: false }), recs = new Records([['128,0', record(1)], ['129,0', record(2)]]);
  paint(c, { rings: 129, recs });
  assert.equal(recs.reads, 1 + 3 * 128 * 129);
  assert.equal(c.metrics.nonfinite, 0);
  assert.equal(c.metrics.fills.get(FACTION_FILL[1]), 1);
  assert.equal(c.metrics.fills.get(FACTION_FILL[2]) ?? 0, 0);
  const small = canvas({ cache: false }), closed = new Records([['5,0', record(1)], ['6,0', record(2)]]);
  paint(small, { rings: 6, recs: closed });
  assert.equal(closed.reads, 91); // open rings0..5, with neutral cloud rim6
  assert.equal(small.metrics.fills.get(FACTION_FILL[1]), 1);
  assert.equal(small.metrics.fills.get(FACTION_FILL[2]) ?? 0, 0);
});

test('minimap camera frames reuse the exact static layer without scanning a large world again', () => {
  const c = canvas(), revision = {}, recs = new Records([['128,0', record(1)]]);
  paint(c, { rings: 129, revision, recs });
  const reads = recs.reads, base = c.layers[0].cv;
  assert.equal(c.layers.length, 1);
  for (let i = 0; i < 8; i++) {
    const wrapper = { get() { throw new Error('static world rescanned during camera motion'); } };
    paint(c, { rings: 129, revision, recs: wrapper, view: { x: i * 10, y: i * 5, zoom: 1 }, size: { width: 800, height: 600 }, pins: [{ p: i, q: 0 }], now: i * 120 });
  }
  assert.equal(recs.reads, reads);
  assert.equal(c.layers.length, 1);
  assert.equal(c.metrics.images.length, 9);
  assert.ok(c.metrics.images.every(image => image === base));
  assert.equal(c.metrics.calls.get('strokeRect'), 8);
  assert.equal(c.metrics.nonfinite + c.layers[0].metrics.nonfinite, 0);
});

test('minimap revisions and visual inputs invalidate cached land without losing ownership or survey', () => {
  const c = canvas(), recs = new Records([['1,0', record(1)]]), args = { recs, revision: {} };
  paint(c, args);
  assert.equal(c.layers[0].metrics.fills.get(FACTION_FILL[1]), 1);
  recs.set('1,0', record(2)); args.revision = {}; paint(c, args);
  assert.equal(c.layers.length, 2);
  assert.equal(c.layers.at(-1).metrics.fills.get(FACTION_FILL[2]), 1);
  for (const change of [{ lens: 'land' }, { rings: 7 }, { dpr: 2 }, { px: 100 }, { own: [{ p: 1, q: 0 }] }, { survey: { showAll: true } }]) {
    const n = c.layers.length; Object.assign(args, change); paint(c, args);
    assert.equal(c.layers.length, n + 1);
  }
  const survey = { showAll: false, tiles: new Map([['9,-4', 3]]), villages: [], faction: 1, home: { p: 1, q: 0, tile: 30 }, province: () => ({ max: 3 }), levelOf: () => 3 };
  paint(c, { recs, revision: args.revision, survey });
  assert.ok(c.layers.at(-1).metrics.calls.get('fillRect') > 0, 'surveyed tiles are preserved in static layer');
  const n = c.layers.length;
  paint(c, { recs, revision: args.revision, survey, now: 900 });
  assert.equal(c.layers.length, n, 'breathing home pip is dynamic');
});

test('minimap direct fallback observes mutable records and clamps legacy extent', () => {
  const c = canvas({ cache: false }), recs = new Records([['1,0', record(1)]]);
  paint(c, { recs }); recs.set('1,0', record(2)); paint(c, { recs });
  assert.equal(c.metrics.fills.get(FACTION_FILL[1]), 1);
  assert.equal(c.metrics.fills.get(FACTION_FILL[2]), 1);
  assert.equal(recs.reads, 182);
  paint(c, { recs, revision: {}, rings: Number.MAX_SAFE_INTEGER });
  assert.equal(recs.reads, 182 + 49537);
  assert.equal(c.metrics.nonfinite, 0);
});

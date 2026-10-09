// The map painter for a leader figure, on the board (people/leader-motion.mjs paintLeaderMotion, ported with its
// own test web-frontier-leader-motion.test.mjs) as the effects demo uses it: `?fx=leaders` (people/leader-demo.mjs).
// The painter draws into a proxy context here: feet anchor, the token unit's height at 1.30, facing, the motion
// and its time share, the viewer's own ring, upright through the caller's `stand`. And the truth rule: the six
// walk the map in the demo alone; normal play never loads the painter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { project, RADIUS } from '../../permutation-server/web/map.mjs';
import { MOTION_LEADERS, LEADER_MOTIONS, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE, LEADER_SPRITE_ANCHOR, motionSpriteFrame } from '../../permutation-server/web/frontier/leader-motion-data.mjs';
import { zoomBoost } from '../../permutation-server/web/frontier/people/crowds.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
let lifecycle = 0;
/** A page's Image and a context that records what it was asked to draw (every method exists; none does anything else). */
async function fixture(t) {
  const previous = globalThis.Image, requests = [];
  globalThis.Image = class { constructor() { requests.push(this); } load(w, h) { this.width = w; this.height = h; this.onload?.(); } };
  t.after(() => { if (previous === undefined) delete globalThis.Image; else globalThis.Image = previous; });
  // (the demo and the painter share one sheet cache: a fresh copy of both per test)
  const tag = `?demo=${++lifecycle}`;
  const D = await import(`../../permutation-server/web/frontier/people/leader-demo.mjs${tag}`);
  const calls = [];
  const state = { globalAlpha: 1, stack: [] };
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'globalAlpha') return state.globalAlpha;
      if (k === 'save') return () => state.stack.push(state.globalAlpha);
      if (k === 'restore') return () => { state.globalAlpha = state.stack.pop(); };
      return (...a) => { calls.push([k, ...a]); };
    },
    set(_, k, v) { if (k === 'globalAlpha') state.globalAlpha = v; else calls.push(['set', k, v]); return true; },
  });
  const loadAll = () => { for (const img of requests) { const m = LEADER_MOTIONS.find(x => img.src.endsWith(`_${x.key}.webp`)); if (m && !img.width) img.load(256 * m.frames, 256); } };
  return { D, ctx, calls, requests, loadAll, draws: () => calls.filter(c => c[0] === 'drawImage') };
}

test('the demo\'s beats: each leader walks one tile, stands, strikes once, takes a hit; a pure function of the clock', async t => {
  const { D } = await fixture(t);
  assert.equal(D.LEADER_DEMO_TILES.length, 6);
  assert.equal(new Set(D.LEADER_DEMO_TILES.map(String)).size, 6, 'six tiles, one each');
  assert.ok(D.LEADER_DEMO_TILES.every(([dq, dr]) => (dq !== 0 || dr !== 0) && Math.abs(dq) <= 4 && Math.abs(dr) <= 2), 'near the demo tile, never on it');
  const p = (tt, i = 0) => D.leaderDemoPose(tt, i);
  assert.deepEqual(p(0), { motion: 'walk', share: 0, looping: true, walk: 1 });
  assert.equal(p(1.3).motion, 'walk'); assert.ok(Math.abs(p(1.3).walk - 0.5) < 1e-9, 'half way along the tile'); assert.ok(Math.abs(p(1.3).share - 1.3) < 1e-9, 'the walk clip loops once a second');
  assert.deepEqual([p(2.7).motion, p(2.7).walk], ['idle', 0], 'arrived: it stands');
  assert.deepEqual([p(3.2).motion, p(3.2).share, p(3.2).looping], ['attack', 0, false]);
  assert.ok(Math.abs(p(3.6).share - 0.5) < 1e-9);
  assert.equal(p(4.1).motion, 'idle', 'back to the stance');
  assert.deepEqual([p(4.6).motion, p(4.6).share], ['hit', 0]);
  assert.equal(p(5.3).motion, 'idle');
  assert.equal(p(3.2, 5).motion, 'idle', 'the six strike a moment apart'); assert.equal(p(3.2 + 5 * D.LEADER_DEMO.stagger, 5).motion, 'attack');
  assert.ok(D.LEADER_DEMO.hit[1] < D.LEADER_DEMO.secs && D.LEADER_DEMO.attack[1] < D.LEADER_DEMO.hit[0]);
  // reduced motion: nobody travels; a still on the tile
  assert.deepEqual(D.leaderDemoPose(1.3, 2, { full: false }), { motion: 'idle', share: 0, looping: true, walk: 0 });
  // the figures: the six nations' leaders in order of depth, a tile's width walked from the west
  const at = { q: 15, r: -7 }, a = D.leaderDemoFigures(at, 0), b = D.leaderDemoFigures(at, 3);
  assert.deepEqual(a.map(f => f.leader).sort(), MOTION_LEADERS.map(l => l.key).sort());
  for (let i = 1; i < a.length; i++) assert.ok(a[i].y >= a[i - 1].y, 'the far ones first');
  const tile = project(1, 0).x - project(0, 0).x;
  for (const f of b) { const s = a.find(x => x.leader === f.leader); assert.ok(Math.abs(f.x - s.x - tile) < 1e-6 && Math.abs(f.y - s.y) < 1e-6, `${f.leader} walked one tile east`); }
  const aster = b.find(f => f.leader === 'aster'), home = project(at.q + D.LEADER_DEMO_TILES[0][0], at.r + D.LEADER_DEMO_TILES[0][1]);
  assert.ok(Math.abs(aster.x - home.x) < 1e-6 && aster.y > home.y && aster.y < home.y + RADIUS * 0.4, 'the feet stand a little below the tile\'s middle');
});

test('the painter draws the six into a proxy context: feet at the tile, a host\'s height at 1.30, the frame of the time, the own ring, upright through `stand`', async t => {
  const { D, ctx, calls, requests, loadAll, draws } = await fixture(t);
  const at = { q: 15, r: -7 }, zoom = 1.15;
  assert.equal(D.paintLeaderDemo(null, { at }), 0, 'nothing without a context');
  assert.equal(D.paintLeaderDemo(ctx, { t: 1, zoom, at }), 0, 'no sheet yet: nothing is drawn but the shadows, and the loads begin');
  assert.equal(draws().length, 0);
  assert.equal(calls.filter(c => c[0] === 'ellipse').length, 6, 'six shadows on the ground');
  assert.ok(requests.length >= 6 && requests.every(r => /\/art\/leaders3d\/motion-v1\/sprite\/[a-z]+_(walk|idle)\.webp$/.test(r.src)));
  assert.equal(D.preloadLeaderDemo() > 0, true); assert.equal(requests.length, 24, 'every sheet of the demo is asked for once');
  // (the engine is asked for a frame whenever a sheet arrives: playLeaderDemo wires it)
  let kicks = 0;
  D.playLeaderDemo({ add: () => ({ id: 0 }), kick: () => { kicks++; } }, { at });
  loadAll(); assert.equal(D.preloadLeaderDemo(), 0); assert.equal(kicks, 24, 'a sheet that arrives asks for a frame');
  const size = RADIUS * 0.66 * zoomBoost(RADIUS * zoom), width = size * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  assert.equal(LEADER_DRAW_SCALE, 1.3);
  for (const [tt, key] of [[1.0, 'walk'], [3.7, 'attack'], [5.05, 'hit'], [5.9, 'idle']]) {
    calls.length = 0;
    const stood = [];
    const n = D.paintLeaderDemo(ctx, { t: tt, zoom, at, own: 0, stand: (g, x, y, draw) => { stood.push([x, y]); calls.push(['stand:in']); draw(); calls.push(['stand:out']); } });
    assert.equal(n, 6, `${key}: all six`);
    const figs = D.leaderDemoFigures(at, tt), d = draws();
    assert.equal(d.length, 6);
    figs.forEach((f, i) => {
      const pose = D.leaderDemoPose(tt, MOTION_LEADERS.findIndex(l => l.key === f.leader)), m = LEADER_MOTIONS.find(x => x.key === pose.motion);
      assert.equal(pose.motion, key);
      assert.ok(d[i][1].src.endsWith(`/${f.leader}_${key}.webp`), `${f.leader}: the ${key} sheet`);
      assert.deepEqual(d[i].slice(2, 6), [motionSpriteFrame(m, pose.share, pose.looping) * 256, 0, 256, 256], 'the frame of the time');
      assert.deepEqual(d[i].slice(6), [-width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width], 'a host\'s height at 1.30, anchored at the feet');
      assert.deepEqual(stood[i], [f.x, f.y], 'stood upright about its feet');
    });
    // every figure is drawn inside `stand`, its shadow outside it (the shadow lies on the ground)
    let inside = false;
    for (const c of calls) { if (c[0] === 'stand:in') inside = true; else if (c[0] === 'stand:out') inside = false; else if (c[0] === 'drawImage') assert.ok(inside); else if (c[0] === 'fill') assert.ok(!inside); }
    assert.deepEqual(calls.filter(c => c[0] === 'translate').map(c => c.slice(1)), figs.map(f => [f.x, f.y]), 'the feet at the tile');
    assert.equal(calls.filter(c => c[0] === 'scale').length, 0, 'facing east: no mirror');
    assert.equal(calls.filter(c => c[0] === 'stroke').length, 1, 'one gold ring: the viewer\'s own nation\'s leader');
    assert.deepEqual(calls.find(c => c[0] === 'set' && c[1] === 'strokeStyle').slice(2), ['#f3d58a']);
  }
  assert.equal(ctx.globalAlpha, 1, 'the context is left as it was');
  // reduced motion: the six stand on their tiles as stills
  calls.length = 0;
  assert.equal(D.paintLeaderDemo(ctx, { t: 1.0, zoom, at, full: false }), 6);
  for (const d of draws()) { assert.match(d[1].src, /_idle\.webp$/); assert.equal(d[2], 0); }
  assert.deepEqual(calls.filter(c => c[0] === 'translate').map(c => c[1]).sort((a, b) => a - b), D.LEADER_DEMO_TILES.map(([dq, dr]) => project(at.q + dq, at.r + dr).x).sort((a, b) => a - b), 'nobody travels');
});

test('playLeaderDemo adds one effect on the top canvas that paints the six by the effect\'s own time; the own ring follows the viewer\'s nation', async t => {
  const { D, ctx, loadAll, draws, calls } = await fixture(t);
  const added = [];
  const fx = { add: spec => { added.push(spec); return { id: 1 }; }, kick: () => {}, map: { source: () => ({ survey: { faction: 4 } }) } };
  D.playLeaderDemo(fx, { at: { q: 3, r: 1 } }, { stand: (g, x, y, draw) => draw() });
  assert.equal(added.length, 1);
  const e = added[0];
  assert.deepEqual([e.name, e.layer, e.dur, e.info], ['leaders', 'top', D.LEADER_DEMO.secs, true]);
  loadAll();   // (the painter's sheet cache is the page's: sheets an earlier test loaded are simply there)
  e.draw(ctx, { t: 3.7, zoom: 1, mode: 'full' });
  assert.equal(draws().length, 6); assert.ok(draws().every(d => /_attack\.webp$/.test(d[1].src)));
  assert.equal(calls.filter(c => c[0] === 'stroke').length, 1, 'Ember\'s viewer: one ring');
  calls.length = 0; e.draw(ctx, { t: 3.7, zoom: 1, mode: 'reduced' });
  assert.ok(draws().every(d => /_idle\.webp$/.test(d[1].src)), 'reduced motion: stills');
});

test('the truth rule: no leader walks the map in normal play: the painter and the demo are reached from the demo switch alone', () => {
  const files = [];
  const walk = (dir, rel = '') => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory()) { if (!['art', 'wasm', 'council'].includes(e.name)) walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`); } else if (/\.(mjs|html)$/.test(e.name)) files.push(`${rel}${e.name}`); } };
  walk(WEB);
  const importers = name => files.filter(f => new RegExp(`from '[^']*${name}'|import\\('[^']*${name}'\\)`).test(readFileSync(new URL(f, WEB), 'utf8')));
  assert.deepEqual(importers('leader-demo\\.mjs'), ['fx/demo.mjs'], 'the demo of the six is the demo switch\'s alone');
  assert.deepEqual(importers('leader-motion\\.mjs'), ['people/leader-demo.mjs'], 'the map painter is used by that demo alone');
  // and fx/demo.mjs itself is loaded only when the address carries ?fx=
  assert.deepEqual(importers('/demo\\.mjs').sort(), ['fx/index.mjs']);
  assert.match(readFileSync(new URL('fx/index.mjs', WEB), 'utf8'), /if \(q\.has\('fx'\)\) import\('\.\/demo\.mjs'\)/);
  const demo = readFileSync(new URL('fx/demo.mjs', WEB), 'utf8');
  assert.match(demo, /leaders: \{ secs: LEADER_DEMO\.secs, run: \(c, fx\) => playLeaderDemo\(fx, c, \{ stand: stood \}\) \}/);
  assert.match(demo, /tag\.className = 'fx-demo-tag'/, 'the corner tag stands while any sample plays');
  // the map sprites are named by the demo's painter only: no screen, no map module asks for them
  const users = files.filter(f => /motionSpriteUrl|leaderMotionSheet|paintLeaderMotion/.test(readFileSync(new URL(f, WEB), 'utf8')));
  assert.deepEqual(users.sort(), ['leader-motion-data.mjs', 'people/leader-demo.mjs', 'people/leader-motion.mjs']);
});

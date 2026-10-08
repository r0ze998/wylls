// The effects layer (permutation-server/web/frontier/fx/, UX-DESIGN §8):
// the clock every effect reads (rate, freeze, seek, step, hit-stop), the
// easing functions, the seeded particle pool (the same event id paints the
// same burst), the bus, the motion level (the system's setting and the
// player's, the calmer of the two), the engine (ground and top passes into a
// context whose methods do nothing, the shake's limits, the named effects in
// every motion level) and the sound's rules without a browser (silent before
// a gesture, mute remembered). Canvas pixels are judged from the demo
// switch's screenshots (?fx=), not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, fxNow, clock as pageClock } from '../../permutation-server/web/frontier/fx/clock.mjs';
import * as ease from '../../permutation-server/web/frontier/fx/ease.mjs';
import { hashSeed, rng, hash01, noise1 } from '../../permutation-server/web/frontier/fx/rand.mjs';
import { createParticles, KINDS, KIND_NAMES, GROUND_FLATTEN } from '../../permutation-server/web/frontier/fx/particles.mjs';
import { createBus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { motion, resolveMotion, setMotionSource, forceMotion, MOTION_LEVELS, REDUCED_FADE } from '../../permutation-server/web/frontier/fx/motion.mjs';
import { createEngine, worldTransform, toScreen, paintGround, fx, SHAKE_PX, SHAKE_MS } from '../../permutation-server/web/frontier/fx/engine.mjs';
import { EFFECTS, installEffects, pointOf, hexDisc, rgba } from '../../permutation-server/web/frontier/fx/effects.mjs';
import { createAudio, SOUND_NAMES, SOUND_SECS, BELL_PARTIALS, BELL_HZ, MUTE_KEY } from '../../permutation-server/web/frontier/fx/audio.mjs';
import { startFx } from '../../permutation-server/web/frontier/fx/index.mjs';
import { SAMPLES } from '../../permutation-server/web/frontier/fx/demo.mjs';
import * as fmap from '../../permutation-server/web/frontier/map/fmap.mjs';
import * as fui from '../../permutation-server/web/frontier/fui.mjs';
import { FLATTEN, RADIUS, project } from '../../permutation-server/web/map.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

/** A context whose every method does nothing (the map tests draw into the same kind); it counts the calls. */
function proxyCtx() {
  const calls = new Map();
  const noop = () => {};
  const ctx = new Proxy({}, {
    get: (o, k) => {
      if (k in o) return o[k];
      if (k === 'calls') return calls;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop });
      return (...a) => { calls.set(k, (calls.get(k) ?? 0) + 1); return undefined; };
    },
    set: (o, k, v) => { o[k] = v; return true; },
  });
  return ctx;
}
/** A clock over a hand-moved time in ms. */
function handClock() {
  let ms = 1000;
  const c = createClock({ now: () => ms });
  c.now();
  return { c, tick: d => { ms += d; } };
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('fx clock: runs from 0, rate, freeze and play, seek, step, hit-stop; the page clock is published as __fxNow', () => {
  const { c, tick } = handClock();
  assert.equal(c.now(), 0);
  tick(500); assert.ok(near(c.now(), 0.5));
  c.setRate(0.25); tick(1000); assert.ok(near(c.now(), 0.75), 'a quarter speed from the change on, no jump');
  c.setRate(2); tick(250); assert.ok(near(c.now(), 1.25));
  c.freeze(); tick(5000); assert.ok(near(c.now(), 1.25), 'frozen');
  assert.equal(c.frozen, true);
  c.play(); tick(100); assert.ok(near(c.now(), 1.45), 'resumes where it stopped, at the rate it had');
  assert.equal(c.seek(3), 3); tick(900); assert.equal(c.now(), 3, 'a seek leaves the clock frozen there');
  assert.ok(near(c.step(), 3 + 1 / 60)); assert.ok(near(c.step(0.5), 3.5 + 1 / 60));
  assert.equal(c.seek(-4), 0, 'never before 0');
  c.play(1); tick(200); assert.ok(near(c.now(), 0.2));
  // a hit-stop holds every effect for some real milliseconds, then time goes on from where it was
  c.hitStop(70);
  tick(40); assert.ok(near(c.now(), 0.2), 'held');
  tick(30); assert.ok(near(c.now(), 0.2), 'held to the end of the stop');
  tick(100); assert.ok(near(c.now(), 0.3), 'then on, with the stop not counted');
  c.hitStop(9999); tick(250); tick(50); assert.ok(near(c.now(), 0.35), 'a stop is at most 250 ms');
  assert.deepEqual(Object.keys(c.state()).sort(), ['frozen', 'rate', 't']);
  assert.equal(c.setRate(-1), 1, 'a bad rate reads as 1');
  // the page's clock: a function on the global, seconds
  assert.equal(globalThis.__fxNow, fxNow);
  const a = fxNow(); assert.ok(Number.isFinite(a) && a >= 0 && fxNow() >= a);
  assert.equal(typeof pageClock.wall(), 'number');
});

test('fx ease: every easing starts at 0 and ends at 1; the overshooting ones pass 1; phase names the beat', () => {
  for (const [name, f] of Object.entries(ease.EASES)) {
    assert.ok(near(f(0), 0, 1e-9), `${name}(0)`);
    assert.ok(near(f(1), 1, 1e-9), `${name}(1)`);
    assert.ok(near(f(-3), 0, 1e-9) && near(f(7), 1, 1e-9), `${name} clamps`);
    for (let k = 0; k <= 1; k += 0.05) assert.ok(Number.isFinite(f(k)), `${name}(${k})`);
  }
  const over = f => Math.max(...Array.from({ length: 101 }, (_, i) => f(i / 100)));
  assert.ok(over(ease.outBack) > 1.05 && over(ease.outElastic) > 1.05 && over(ease.spring) > 1.05, 'overshoot');
  assert.ok(Math.min(...Array.from({ length: 101 }, (_, i) => ease.inBack(i / 100))) < -0.05, 'inBack winds up below 0');
  assert.ok(over(k => ease.spring(k, { damping: 1 })) <= 1.0001, 'a critically damped spring does not overshoot');
  for (const f of [ease.outQuad, ease.outCubic, ease.outQuart, ease.outExpo, ease.inOutQuad]) for (let i = 1; i <= 100; i++) assert.ok(f(i / 100) >= f((i - 1) / 100), 'monotone');
  assert.ok(ease.outCubic(0.3) > 0.3 && ease.inCubic(0.3) < 0.3, 'out is fast first, in is slow first');
  assert.equal(ease.span(5, 2, 4), 1); assert.equal(ease.span(1, 2, 4), 0); assert.equal(ease.span(3, 2, 4), 0.5);
  assert.equal(ease.lerp(10, 20, 0.25), 12.5);
  assert.equal(ease.pulse(0), 0); assert.equal(ease.pulse(0.2), 1); assert.equal(ease.pulse(1), 0);
  assert.equal(ease.envelope(-1, 2), 0); assert.equal(ease.envelope(1, 2), 1); assert.equal(ease.envelope(2, 2), 0);
  assert.ok(ease.envelope(0.04, 2) > 0 && ease.envelope(0.04, 2) < 1 && ease.envelope(1.9, 2) < 1);
  const beats = [['wind', 0.1], ['hit', 0.05], ['decay', 0.5]];
  assert.deepEqual(ease.phase(0.05, beats), { name: 'wind', i: 0, k: 0.5, done: false });
  assert.equal(ease.phase(0.12, beats).name, 'hit');
  assert.equal(ease.phase(0.4, beats).name, 'decay');
  assert.deepEqual(ease.phase(9, beats), { name: 'decay', i: 2, k: 1, done: true });
});

test('fx rand: a seed fixes the sequence; hashes are stable numbers', () => {
  assert.equal(hashSeed('2,0@39'), hashSeed('2,0@39'));
  assert.notEqual(hashSeed('2,0@39'), hashSeed('2,0@40'));
  assert.equal(hashSeed('a'), 0xe40c292c, 'FNV-1a');
  const a = rng('clash'), b = rng('clash'), c = rng('other');
  const A = Array.from({ length: 50 }, () => a()), B = Array.from({ length: 50 }, () => b()), C = Array.from({ length: 50 }, () => c());
  assert.deepEqual(A, B);
  assert.notDeepEqual(A, C);
  assert.ok(A.every(v => v >= 0 && v < 1));
  const mean = A.reduce((s, v) => s + v, 0) / A.length;
  assert.ok(mean > 0.3 && mean < 0.7);
  const r = rng(7);
  for (let i = 0; i < 100; i++) { const v = r.range(2, 5); assert.ok(v >= 2 && v < 5); const n = r.int(4); assert.ok(Number.isInteger(n) && n >= 0 && n < 4); assert.ok([-1, 1].includes(r.sign())); assert.ok(['x', 'y'].includes(r.pick(['x', 'y']))); }
  assert.equal(hash01(3, 4), hash01(3, 4)); assert.ok(hash01(3, 4) >= 0 && hash01(3, 4) < 1);
  assert.ok(Math.abs(noise1(2.5, 9)) <= 1);
  assert.ok(Math.abs(noise1(2.5, 9) - noise1(2.5001, 9)) < 0.01, 'continuous');
});

test('fx particles: nine kinds; seeded by the event id, the same seed gives the same burst at every time; a pool that never grows', () => {
  assert.deepEqual(KIND_NAMES, ['dust', 'spark', 'ember', 'smoke', 'shard', 'leaf', 'coin', 'mist', 'ink']);
  assert.equal(GROUND_FLATTEN, FLATTEN, 'the ground plane of the map');
  assert.ok(KINDS.spark.add && KINDS.ember.add && !KINDS.dust.add && !KINDS.ink.add, 'additive and normal blending');
  const opts = { x: 100, y: 50, z: 10, n: 24, seed: '2,0@39', t: 1 };
  const P1 = createParticles(), P2 = createParticles(), P3 = createParticles();
  for (const k of KIND_NAMES) { assert.equal(P1.emit(k, opts), 24); P2.emit(k, opts); P3.emit(k, { ...opts, seed: '2,0@40' }); }
  // an unrelated burst before it does not change it: the seed alone decides, not the pool's position
  const P4 = createParticles(); P4.emit('dust', { n: 5, seed: 'x', t: -50 }); for (const k of KIND_NAMES) P4.emit(k, opts);
  for (const t of [1.01, 1.2, 1.6, 2.4]) {
    const a = P1.snapshot(t), b = P2.snapshot(t), c = P3.snapshot(t), d = P4.snapshot(t);
    assert.ok(a.length > 0, `alive at ${t}`);
    assert.deepEqual(a, b, `same seed, same picture at ${t}`);
    assert.deepEqual(a, d, `whatever came before, at ${t}`);
    assert.notDeepEqual(a, c, `another seed, another picture at ${t}`);
    assert.ok(a.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && p.alpha >= 0 && p.alpha <= 1 && p.size > 0));
  }
  // time is a pure input: asking in any order gives the same answer (a frozen or rewound clock)
  const later = P1.snapshot(1.6); P1.snapshot(1.1); assert.deepEqual(P1.snapshot(1.6), later);
  assert.equal(P1.snapshot(0.99).length, 0, 'nothing before the launch');
  assert.equal(P1.snapshot(9).length, 0, 'nothing after the longest life');
  assert.equal(P1.liveAt(9), 0); assert.ok(P1.liveAt(1.2) > 100); assert.equal(P1.liveAt(1.2, 'ground'), 0);
  assert.ok(P1.until > 2 && P1.until < 5);
  // ballistic kinds come back to the ground and stay on it; buoyant kinds rise
  const S = createParticles(); S.emit('spark', { n: 40, seed: 's', t: 0, z: 20, up: 0.3 });
  assert.ok(S.snapshot(0.05).some(p => p.z > 20), 'sparks fly up first');
  for (const t of [0.2, 0.4, 0.6, 0.75]) assert.ok(S.snapshot(t).every(p => p.z >= 0), 'never under the ground');
  assert.ok(S.snapshot(0.5).some(p => p.z > 0.5) && S.snapshot(0.5).every(p => p.z < 12), 'a low spark has landed by half a second and is on a small bounce or at rest');
  const E = createParticles(); E.emit('smoke', { n: 10, seed: 's', t: 0 });
  const e0 = E.snapshot(0.1), e1 = E.snapshot(1.2);
  assert.ok(e1.every((p, i) => p.z > e0[i].z), 'smoke rises');
  assert.ok(e1.every((p, i) => p.size > e0[i].size), 'and spreads');
  // dust spreads as an ellipse on the ground: wider than deep by the map's squash
  const D = createParticles(); D.emit('dust', { n: 400, seed: 'd', t: 0 });
  const d1 = D.snapshot(0.4);
  const sx = Math.sqrt(d1.reduce((s, p) => s + p.x * p.x, 0) / d1.length), sy = Math.sqrt(d1.reduce((s, p) => s + p.y * p.y, 0) / d1.length);
  assert.ok(Math.abs(sy / sx - FLATTEN) < 0.08, `ground ellipse ${sy / sx}`);
  // the pool: a fixed size, the oldest overwritten; unknown kinds and empty bursts launch nothing
  const small = createParticles({ capacity: 16 });
  assert.equal(small.emit('coin', { n: 10, seed: 1, t: 0 }), 10);
  assert.equal(small.emit('leaf', { n: 10, seed: 2, t: 0 }), 10);
  assert.equal(small.count, 16); assert.equal(small.capacity, 16);
  assert.equal(small.emit('nothing', { n: 4 }), 0); assert.equal(small.emit('dust', { n: 0 }), 0);
  small.clear(); assert.equal(small.count, 0); assert.equal(small.liveAt(0.1), 0);
  // drawing: two passes (normal, then additive), tolerant of a context that does nothing
  const ctx = proxyCtx();
  assert.equal(P1.draw(ctx, 1.2), P1.liveAt(1.2));
  assert.equal(ctx.globalCompositeOperation, 'source-over', 'the blend mode is put back');
  assert.equal(ctx.globalAlpha, 1);
  assert.equal(P1.draw(ctx, 1.2, { layer: 'ground' }), 0);
  const G = createParticles(); G.emit('ink', { n: 6, seed: 'g', t: 0, layer: 'ground' });
  assert.equal(G.draw(ctx, 0.3, { layer: 'ground' }), 6); assert.equal(G.draw(ctx, 0.3, { layer: 'top' }), 0);
  // options: a colour of the caller's, a staggered launch
  const C = createParticles(); C.emit('dust', { n: 12, seed: 'c', t: 0, color: '#123456', stagger: 0.5 });
  assert.ok(C.snapshot(0.6).every(p => p.color === '#123456'));
  assert.ok(C.snapshot(0.05).length < 12, 'births spread over the stagger');
});

test('fx bus: emit reaches the type and the wildcard; off, once; a listener that throws stops nothing', () => {
  const bus = createBus();
  const seen = [];
  const off = bus.on('bell', (p, t) => seen.push([t, p.turn]));
  bus.on('*', (p, t) => seen.push(['*', t]));
  bus.once('seal', () => seen.push(['once']));
  assert.equal(bus.emit('bell', { turn: 43 }), 2);
  assert.equal(bus.emit('seal'), 2); assert.equal(bus.emit('seal'), 1);
  off(); assert.equal(bus.emit('bell', { turn: 44 }), 1);
  assert.deepEqual(seen, [['bell', 43], ['*', 'bell'], ['once'], ['*', 'seal'], ['*', 'seal'], ['*', 'bell']]);
  assert.equal(bus.count('bell'), 0); assert.equal(bus.count('*'), 1);
  const warn = console.warn; console.warn = () => {};
  try {
    bus.on('x', () => { throw new Error('boom'); });
    let after = 0; bus.on('x', () => { after++; });
    assert.equal(bus.emit('x'), 2, 'the thrower is not counted; the next listener and the wildcard still run');
    assert.equal(after, 1);
  } finally { console.warn = warn; }
  bus.clear(); assert.equal(bus.emit('x'), 0);
});

test('fx motion(): the calmer of the system setting and the player\'s; the preference is stored with the UI preferences', () => {
  assert.deepEqual(MOTION_LEVELS, ['full', 'reduced', 'off']);
  assert.equal(REDUCED_FADE, 0.2, 'reduced mode: a 200 ms opacity change (UX-DESIGN 8.5)');
  assert.equal(resolveMotion('full', false), 'full');
  assert.equal(resolveMotion('full', true), 'reduced', 'the system asks for less motion');
  assert.equal(resolveMotion('reduced', false), 'reduced'); assert.equal(resolveMotion('reduced', true), 'reduced');
  assert.equal(resolveMotion('off', false), 'off'); assert.equal(resolveMotion('off', true), 'off');
  assert.equal(resolveMotion(undefined, false), 'full'); assert.equal(resolveMotion('loud', true), 'reduced', 'an unknown setting reads as full');
  const mm = globalThis.matchMedia;
  try {
    let pref = 'full', reduce = false, asked = '';
    globalThis.matchMedia = q => { asked = q; return { matches: reduce }; };
    setMotionSource(() => pref);
    assert.equal(motion(), 'full'); assert.equal(asked, '(prefers-reduced-motion: reduce)');
    reduce = true; assert.equal(motion(), 'reduced', 'read live: no reload needed');
    pref = 'off'; assert.equal(motion(), 'off');
    pref = 'reduced'; reduce = false; assert.equal(motion(), 'reduced');
    forceMotion('full'); assert.equal(motion(), 'full', 'the demo switch can show a level'); forceMotion(null); assert.equal(motion(), 'reduced');
    forceMotion('nonsense'); assert.equal(motion(), 'reduced');
    setMotionSource(() => { throw new Error('not ready'); }); assert.equal(motion(), 'full', 'a source that fails reads as full');
    globalThis.matchMedia = () => { throw new Error('no media'); }; assert.equal(motion(), 'full');
    delete globalThis.matchMedia; setMotionSource(() => null); assert.equal(motion(), 'full', 'no matchMedia at all (node)');
  } finally { if (mm) globalThis.matchMedia = mm; else delete globalThis.matchMedia; setMotionSource(() => null); forceMotion(null); }
  assert.equal(fui.DEFAULTS.effects, 'full');
});

test('fx engine: the world transform is the map\'s; effects live for their time on their layer; ground and top passes draw into a proxy', () => {
  const view = { x: 120, y: -40, zoom: 1.3 }, size = { width: 800, height: 600 };
  // the same formula as FrontierMap.draw: a world point lands where the map's worldToScreen puts it, times dpr
  for (const dpr of [1, 2]) {
    const [a, b, c, d, e, f] = worldTransform(view, size, dpr);
    assert.deepEqual([b, c], [0, 0]); assert.equal(a, d);
    for (const [x, y] of [[0, 0], [333, -91], [-50, 720]]) {
      const s = fmap.worldToScreen(view, size, x, y);
      assert.ok(near(a * x + e, s.x * dpr, 1e-6) && near(d * y + f, s.y * dpr, 1e-6));
      assert.deepEqual(toScreen(view, size, x, y), s);
    }
  }
  const { c: clock, tick } = handClock();
  const eng = createEngine({ clock, motion: () => 'full', bus: createBus() });
  const drawn = [];
  const mk = (layer, extra = {}) => eng.add({ layer, dur: 0.5, name: layer, draw: (ctx, s) => { drawn.push([layer, s.t, s.k, s.zoom, s.px, s.mode]); ctx.fillRect(0, 0, 1, 1); }, ...extra });
  const g = mk('ground'), t = mk('top'), sc = mk('screen', { delay: 0.2 });
  assert.ok(g.id && t.id && sc.id);
  assert.equal(eng.add({ layer: 'top', dur: 0 }), null, 'an effect needs a duration');
  assert.deepEqual(eng.live(), { live: 2, pending: 1, ground: 1 });
  tick(100);
  const ctx = proxyCtx();
  assert.equal(eng.paintGround(ctx, { zoom: 2 }), 1);
  assert.deepEqual(drawn.at(-1).slice(0, 1), ['ground']);
  assert.ok(near(drawn.at(-1)[1], 0.1) && near(drawn.at(-1)[2], 0.2) && drawn.at(-1)[3] === 2 && drawn.at(-1)[4] === 0.5 && drawn.at(-1)[5] === 'full');
  drawn.length = 0;
  assert.equal(eng.drawTop(ctx, { t: clock.now(), view, size, dpr: 2 }), 1, 'the top pass: the top layer only while the painter does the ground');
  assert.deepEqual(drawn.map(d => d[0]), ['top']);
  drawn.length = 0;
  assert.equal(eng.drawTop(ctx, { t: 0.3, view, size, dpr: 1, ground: true }), 3, 'with no tile painter the ground layer is drawn on top too, under the rest');
  assert.deepEqual(drawn.map(d => d[0]), ['ground', 'top', 'screen']);
  assert.ok(ctx.calls.get('setTransform') >= 4 && ctx.calls.get('save') >= 4 && ctx.calls.get('save') === ctx.calls.get('restore'));
  assert.equal(eng.drawTop(ctx, { t: 0.6, view, size }), 1, 'only the delayed one is left at 0.6 s');
  assert.equal(eng.drawTop(ctx, { t: 0.71, view, size }), 0);
  // without a page a frame only prunes what is over
  tick(700);
  assert.deepEqual(eng.frame(), { live: 0, pending: 0, ground: 0 });
  assert.equal(eng.paintGround(ctx, { zoom: 1 }), 0);
  // an effect that throws is dropped quietly, the others still draw
  const warn = console.warn; console.warn = () => {};
  try {
    eng.add({ layer: 'top', dur: 1, draw: () => { throw new Error('bad effect'); } });
    let ok = 0; eng.add({ layer: 'top', dur: 1, draw: () => { ok++; } });
    eng.drawTop(ctx, { t: clock.now() + 0.1, view, size }); eng.drawTop(ctx, { t: clock.now() + 0.2, view, size });
    assert.equal(ok, 2);
  } finally { console.warn = warn; }
  // cancel, clear
  const h = eng.add({ layer: 'top', dur: 5, draw: () => {} }); h.cancel(); eng.clear();
  assert.deepEqual(eng.live(), { live: 0, pending: 0, ground: 0 });
  // particles through the engine count as live, on their layer
  assert.equal(eng.emit('dust', { n: 10, seed: 'e', layer: 'ground' }), 10);
  tick(100); assert.deepEqual(eng.live(), { live: 10, pending: 0, ground: 10 });
  assert.equal(eng.paintGround(ctx, { zoom: 1 }), 10);
  // the page's engine and its ground pass exist without a page, and paint nothing when nothing is live
  assert.equal(paintGround(ctx, { zoom: 1 }), 0);
  assert.equal(fx.mounted, false);
});

test('fx engine: the shake stays in 2 to 8 px and 120 to 250 ms, decays, and only moves in full motion', () => {
  assert.deepEqual([...SHAKE_PX, ...SHAKE_MS], [2, 8, 120, 250]);
  const { c: clock, tick } = handClock();
  let level = 'full';
  const eng = createEngine({ clock, motion: () => level, bus: createBus() });
  assert.equal(eng.shake(50, 9000, { seed: 'a' }), true);
  let peak = 0, late = 0;
  for (let ms = 0; ms <= 260; ms += 4) {
    const s = eng.shakeAt(ms / 1000), mag = Math.hypot(s.x, s.y);
    assert.ok(mag <= 8 + 1e-9, `at most 8 px (${mag})`);
    if (ms < 60) peak = Math.max(peak, mag);
    if (ms > 200 && ms < 250) late = Math.max(late, mag);
    if (ms >= 250) assert.equal(mag, 0, 'over after 250 ms');
  }
  assert.ok(peak > 1.5, `it moves (${peak})`);
  assert.ok(late < peak * 0.35, 'and dies away');
  assert.deepEqual(eng.shakeAt(0.1), eng.shakeAt(0.1), 'a function of time and seed');
  assert.equal(eng.live().live, 1);
  // several at once still stay inside 8 px
  eng.shake(8, 250, { seed: 'b' }); eng.shake(8, 250, { seed: 'c' });
  for (let ms = 0; ms < 250; ms += 3) { const s = eng.shakeAt(ms / 1000); assert.ok(Math.hypot(s.x, s.y) <= 8 + 1e-9); }
  tick(300); eng.frame(); assert.equal(eng.live().live, 0);
  // a small request is raised to the floor: 2 px for 120 ms
  eng.shake(0.1, 5, { seed: 'd' });
  assert.ok(Math.hypot(eng.shakeAt(clock.now() + 0.119).x, eng.shakeAt(clock.now() + 0.119).y) >= 0);
  assert.deepEqual(eng.shakeAt(clock.now() + 0.121), { x: 0, y: 0 });
  for (const m of ['reduced', 'off']) { level = m; assert.equal(eng.shake(8, 200), false, `no shake when ${m}`); assert.equal(eng.emit('spark', { n: 20 }), 0, `no particles when ${m}`); }
});

test('fx vocabulary: eleven named effects; each draws through its whole life in every motion level without a real canvas', () => {
  assert.deepEqual(Object.keys(EFFECTS), ['flash', 'ripple', 'dust', 'spark', 'label', 'glow', 'banner', 'toll', 'number', 'chip', 'burst']);
  const args = { flash: { q: 3, r: -2 }, ripple: { q: 3, r: -2 }, dust: { q: 3, r: -2 }, spark: { q: 3, r: -2, shake: 5 }, label: { q: 3, r: -2, text: '-120' }, glow: { q: 3, r: -2, radius: 2 },
    banner: { title: 'Victory', sub: 'sample' }, toll: { x: 0, y: 0 }, number: { text: '+5', vx: 10, vy: 10 }, chip: { vx: 10, vy: 10 }, burst: { q: 3, r: -2, kind: 'leaf', n: 24 } };
  const view = { x: 200, y: -100, zoom: 1.3 }, size = { width: 800, height: 600 };
  const info = new Set(['label', 'banner', 'number']);
  for (const level of MOTION_LEVELS) {
    for (const name of Object.keys(EFFECTS)) {
      const { c: clock, tick } = handClock();
      const eng = installEffects(createEngine({ clock, motion: () => level, bus: createBus() }));
      assert.ok(eng.has(name) && eng.names().includes(name));
      const handles = eng.play(name, { ...args[name], seed: 'unit' });
      const where = `${name} / ${level}`;
      if (level === 'off') assert.equal(handles.length > 0, info.has(name), `${where}: with effects off only what is information is shown`);
      else if (name === 'dust' || name === 'burst') assert.equal(handles.length > 0, level === 'full', `${where}: particles are decoration, nothing of them in reduced motion`);
      else assert.ok(handles.length > 0, where);
      const start = eng.live();
      if (level !== 'full') assert.equal(eng.particles.count, 0, `${where}: no particles outside full motion`);
      if (level === 'full' && ['dust', 'spark', 'burst'].includes(name)) assert.ok(eng.particles.count >= 20, `${where}: 20 or more particles`);
      const ctx = proxyCtx();
      let frames = 0, ended = false;
      for (let ms = 0; ms <= 4000 && !ended; ms += 16) {
        frames += eng.drawTop(ctx, { t: clock.now(), view, size, dpr: 2, ground: true });
        tick(16); eng.frame();
        const c = eng.live(); ended = c.live === 0 && c.pending === 0;
      }
      assert.ok(ended, `${where}: it ends`);
      const canvasEffect = !['banner', 'number', 'chip', 'burst'].includes(name);
      if (canvasEffect && handles.length) assert.ok(frames > 10, `${where}: it drew (${frames})`);
      if (start.live + start.pending === 0) assert.equal(frames, 0);
    }
  }
  // an unknown name plays nothing; the bus plays by name
  const bus = createBus();
  const eng = installEffects(createEngine({ clock: handClock().c, motion: () => 'full', bus }));
  assert.deepEqual(eng.play('nothing'), []);
  assert.equal(bus.emit('fx', { name: 'flash', q: 0, r: 0 }), 1); assert.equal(eng.live().live, 1);
  eng.destroy(); assert.equal(bus.emit('fx', { name: 'flash', q: 0, r: 0 }), 0);
  // positions: world px, an axial hex, or a province and a tile
  assert.deepEqual(pointOf({ x: 5, y: 6 }), { x: 5, y: 6, q: null, r: null });
  assert.deepEqual(pointOf({ q: 3, r: -2 }), { ...project(3, -2), q: 3, r: -2 });
  const home = pointOf({ p: 2, q: 0, tile: 7 }); assert.ok(Number.isInteger(home.q) && Number.isFinite(home.x));
  assert.equal(hexDisc(0, 0, 2).length, 19); assert.deepEqual(hexDisc(4, 4, 2)[0], { q: 4, r: 4 });
  assert.equal(rgba('#f0d48a', 0.5), 'rgba(240,212,138,0.500)'); assert.equal(rgba('#fff', 2), 'rgba(255,255,255,1.000)');
  assert.ok(RADIUS > 0);
});

test('fx vocabulary: anticipation, impact and decay are separate beats (not one linear fade)', () => {
  // record what the flash paints: fill alpha over time must rise late (after a wind-up), peak, then fall fast and tail off
  const { c: clock, tick } = handClock();
  const eng = installEffects(createEngine({ clock, motion: () => 'full', bus: createBus() }));
  eng.play('flash', { q: 0, r: 0, color: '#f0d48a', seed: 'beats' });
  const alphaOf = style => Number(/rgba\([^)]*,([0-9.]+)\)$/.exec(String(style))?.[1] ?? 0);
  const samples = [];
  for (let ms = 0; ms < 680; ms += 10) {
    let white = 0;
    const ctx = proxyCtx();
    const fills = [];
    const real = new Proxy(ctx, { get: (o, k) => (k === 'fill' ? () => { fills.push(o.fillStyle); } : o[k]), set: (o, k, v) => { o[k] = v; return true; } });
    eng.drawTop(real, { t: clock.now(), view: { x: 0, y: 0, zoom: 1 }, size: { width: 400, height: 300 }, ground: true });
    for (const f of fills) if (/^rgba\(255,255,255/.test(String(f))) white = Math.max(white, alphaOf(f));
    samples.push(white);
    tick(10);
  }
  const at = ms => samples[Math.round(ms / 10)];
  assert.equal(at(30), 0, 'no white during the wind-up');
  assert.ok(at(80) > 0.85, 'the impact burns white');
  assert.ok(at(200) < at(80) * 0.6, 'and is mostly gone 120 ms later');
  assert.equal(at(600), 0, 'the tail carries colour only');
  const peakAt = samples.indexOf(Math.max(...samples)) * 10;
  assert.ok(peakAt >= 60 && peakAt <= 110, `the peak sits at the impact, 60 to 100 ms in (${peakAt})`);
});

test('fx demo samples: every sample plays effects that exist, with sample data only (no record of the game)', () => {
  const eng = installEffects(createEngine({ clock: handClock().c, motion: () => 'full', bus: createBus() }));
  const c = { at: { q: 15, r: -7 }, origin: { x: 0, y: 0 } };
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    for (const [name, s] of Object.entries(SAMPLES)) {
      assert.ok(s.secs > 0.5 && s.secs < 8, name);
      // a set piece is a composition run on a page (test/web-frontier-setpieces.test.mjs plays every one)
      if (s.run) { assert.equal(typeof s.run, 'function', name); assert.equal(s.cues, undefined, name); continue; }
      const cues = s.cues(c);
      assert.ok(cues.length >= 1, name);
      for (const [effect, a] of cues) {
        assert.ok(eng.has(effect), `${name} → ${effect}`);
        for (const v of Object.values(a)) if (typeof v === 'string' && lang === 'en') assert.ok(!/[぀-ヿ一-鿿]/.test(v), `${name}: English sample text (${v})`);
      }
      for (const [sound, delay] of s.sounds ?? []) { assert.ok(SOUND_NAMES.includes(sound)); assert.ok(delay >= 0); }
    }
  }
  setLang('ja');
  for (const n of ['flash', 'ripple', 'dust', 'spark', 'label', 'glow', 'banner', 'toll']) assert.ok(SAMPLES[n], `the first vocabulary has a sample: ${n}`);
  // the entry point registers the vocabulary and needs no page
  assert.equal(startFx({}), fx); assert.ok(fx.has('toll') && !fx.mounted);
});

test('fx audio: eight synthesised sounds; silent before the first gesture and without WebAudio; mute is remembered', () => {
  assert.deepEqual(SOUND_NAMES, ['bell', 'seal', 'clash', 'tick', 'shimmer', 'drum', 'confirm', 'refuse']);
  for (const n of SOUND_NAMES) assert.ok(SOUND_SECS[n] > 0);
  // the bell: inharmonic partials of a cast bell, the low ones ringing longest
  const ratios = BELL_PARTIALS.map(p => p[0]);
  for (const r of [0.5, 1, 1.2, 1.5, 2]) assert.ok(ratios.includes(r), `the ${r} partial`);
  assert.ok(ratios.some(r => Math.abs(r - Math.round(r)) > 0.05 && r > 2), 'upper partials are not harmonics');
  const decays = BELL_PARTIALS.map(p => p[2]);
  assert.ok(decays[0] >= 8 && decays.at(-1) < 0.5 && decays[0] === Math.max(...decays), 'the hum rings longest, the highest partial is gone at once');
  assert.ok(BELL_PARTIALS.filter(p => p[3] > 0).length >= 3, 'paired partials beat');
  assert.ok(BELL_HZ > 120 && BELL_HZ < 300);
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } };
  const a = createAudio({ storage });
  assert.equal(a.muted, false); assert.equal(a.ready, false);
  assert.equal(a.play('bell'), false, 'nothing sounds before a gesture');
  assert.equal(a.unlock(), false, 'no AudioContext here');
  assert.equal(a.play('tick'), false);
  const heard = [];
  const off = a.onChange(m => heard.push(m));
  assert.equal(a.toggle(), true); assert.equal(a.muted, true);
  assert.deepEqual(JSON.parse(mem.get(MUTE_KEY)), { v: 1, muted: true });
  assert.equal(createAudio({ storage }).muted, true, 'remembered');
  assert.equal(a.toggle(), false); off(); a.toggle();
  assert.deepEqual(heard, [true, false]);
  mem.set(MUTE_KEY, '{broken'); assert.equal(createAudio({ storage }).muted, false, 'a damaged record reads as not muted');
  assert.equal(createAudio({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } }).toggle(), true, 'a storage that refuses only costs the preference');
  assert.equal(typeof a.install({}), 'function', 'installing on something that is not a document does nothing');
  // with a (fake) context: the first gesture unlocks, mute silences, a sound cannot stack on itself
  const AC = globalThis.AudioContext;
  try {
    const made = { osc: 0, started: 0 };
    const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
    const nodeOf = extra => ({ connect() {}, start() { made.started++; }, stop() {}, gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), ...extra });
    globalThis.AudioContext = class {
      constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 8000; this.destination = {}; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      createGain() { return nodeOf(); } createOscillator() { made.osc++; return nodeOf({ type: 'sine' }); }
      createBiquadFilter() { return nodeOf({ type: '' }); } createDynamicsCompressor() { return nodeOf(); } createConvolver() { return nodeOf({ buffer: null }); }
      createBufferSource() { return nodeOf({ buffer: null }); }
      createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    };
    let ms = 0;
    const b = createAudio({ storage: { getItem: () => null, setItem() {} }, now: () => ms });
    assert.equal(b.play('bell'), false);
    assert.equal(b.unlock(), true); assert.equal(b.ready, true);
    assert.equal(b.play('bell'), true);
    assert.ok(made.osc >= BELL_PARTIALS.length, 'one oscillator or two for each partial');
    assert.equal(b.play('bell'), false, 'the bell cannot be struck twice in the same breath');
    ms += 2000; assert.equal(b.play('bell'), true);
    for (const n of SOUND_NAMES) { ms += 2000; assert.equal(b.play(n, { seed: n }), true, n); }
    assert.equal(b.play('whistle'), false);
    b.setMuted(true); ms += 2000; assert.equal(b.play('tick'), false, 'muted');
    b.setMuted(false); assert.equal(b.play('tick'), true);
    ms += 10; assert.equal(b.play('tick'), false, 'presses closer than 45 ms share one tick');
  } finally { if (AC) globalThis.AudioContext = AC; else delete globalThis.AudioContext; }
});

/** A page just large enough for the engine: elements with a style, a dataset, children and a 2D context that does nothing. */
function fakePage() {
  const made = [];
  const el = (tag) => {
    const vars = new Map(), attrs = new Map();
    const e = {
      tag, id: '', className: '', hidden: false, dataset: {}, children: [], parent: null, textContent: '',
      style: { setProperty: (k, v) => vars.set(k, v), getPropertyValue: k => vars.get(k) ?? '' }, vars, attrs,
      setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: k => attrs.get(k) ?? null,
      append(...kids) { for (const k of kids) { k.parent = e; e.children.push(k); } },
      after(k) { k.parent = e.parent; const list = e.parent?.children ?? []; list.splice(list.indexOf(e) + 1, 0, k); },
      remove() { const list = e.parent?.children ?? []; const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); e.parent = null; },
      getBoundingClientRect: () => ({ left: 280, top: 52, width: 800, height: 848 }),
      offsetLeft: 280, offsetTop: 52, clientWidth: 800, clientHeight: 848, width: 0, height: 0,
      getContext: () => (e.ctx ??= proxyCtx()),
      querySelector: () => null,
    };
    made.push(e);
    return e;
  };
  const doc = { createElement: el, head: el('head'), body: el('body'), getElementById: id => made.find(e => e.id === id && e.parent) ?? null, querySelector: () => null, defaultView: null };
  const main = el('main'); doc.body.append(main);
  const canvas = el('canvas'); canvas.id = 'frontier-map'; canvas.ownerDocument = doc; main.append(canvas);
  for (const e of made) e.ownerDocument = doc;
  const mk = doc.createElement; doc.createElement = t => { const e = mk(t); e.ownerDocument = doc; return e; };
  return { doc, main, canvas };
}

test('fx engine on a page: the top canvas and #fx-hud are made by script, aria-hidden; the loop runs only while something is live; the shake moves the two canvases only', () => {
  const { doc, main, canvas } = fakePage();
  const raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame;
  const queue = [];
  globalThis.requestAnimationFrame = fn => { queue.push(fn); return queue.length; };
  globalThis.cancelAnimationFrame = () => {};
  const frames = n => { for (let i = 0; i < n && queue.length; i++) queue.shift()(0); };
  try {
    const { c: clock, tick } = handClock();
    const eng = installEffects(createEngine({ clock, motion: () => 'full', bus: createBus() }));
    let invalidated = 0;
    const map = { view: { x: 100, y: 50, zoom: 1.3 }, lod: 'tile', art: {}, size: () => ({ width: 800, height: 848 }), invalidate: () => { invalidated++; } };
    eng.mount({ map, canvas });
    assert.equal(eng.mounted, true);
    const top = eng.top, hud = eng.hud;
    assert.equal(main.children.indexOf(top), main.children.indexOf(canvas) + 1, 'the top canvas sits right after the map canvas');
    assert.equal(top.id, 'fx-top'); assert.equal(top.getAttribute('aria-hidden'), 'true');
    assert.equal(hud.id, 'fx-hud'); assert.equal(hud.getAttribute('aria-hidden'), 'true'); assert.equal(hud.parent, doc.body, 'the HUD layer hangs from the body: no transform of the map reaches it');
    assert.deepEqual(['--fx-l', '--fx-t', '--fx-w', '--fx-h'].map(k => top.vars.get(k)), ['280px', '52px', '800px', '848px'], 'laid over the map canvas by its measured box');
    assert.equal(hud.vars.get('--fx-free'), '848px');
    frames(3);
    assert.equal(queue.length, 0, 'nothing live: no frame loop');
    assert.equal(canvas.dataset.fx, '0');
    // a ground effect and a top effect: the map is asked to repaint, the top canvas is sized at the device pixel ratio and drawn
    eng.play('flash', { q: 0, r: 0, seed: 't' }); eng.play('spark', { q: 0, r: 0, seed: 't', shake: 6 });
    assert.equal(queue.length, 1, 'one loop, however many effects');
    tick(80); frames(1);
    assert.ok(invalidated >= 1, 'ground effects repaint through the tile painter');
    assert.equal(top.width, 800); assert.equal(top.height, 848);
    assert.ok(top.ctx.calls.get('clearRect') >= 1 && top.ctx.calls.get('setTransform') >= 2);
    assert.ok(Number(canvas.dataset.fx) > 20, 'data-fx carries the live count');
    // the shake: the same offset on both canvases, nothing on the HUD layer
    tick(20); frames(1);
    const sx = canvas.vars.get('--fx-sx'), sy = canvas.vars.get('--fx-sy');
    assert.match(sx, /^-?\d+\.\d\dpx$/); assert.notEqual(`${sx}${sy}`, '0.00px0.00px');
    assert.equal(top.vars.get('--fx-sx'), sx); assert.equal(top.vars.get('--fx-sy'), sy);
    assert.ok(Number(canvas.vars.get('--fx-ss')) > 1 && Number(canvas.vars.get('--fx-ss')) < 1.05, 'the layer swells a little so no edge shows');
    assert.equal(hud.vars.has('--fx-sx'), false, 'the HUD never moves');
    // a HUD effect: a node appears in #fx-hud for its life and is driven by custom properties
    eng.play('banner', { title: 'Victory', sub: 'sample' });
    tick(300); frames(1);
    const banner = hud.children.find(k => k.className === 'fx-banner');
    assert.ok(banner && !banner.hidden);
    assert.deepEqual(banner.children.map(k => k.className.split(' ')[0]), ['fx-banner-band', 'fx-banner-rule', 'fx-banner-glint', 'fx-banner-title', 'fx-banner-sub', 'fx-banner-rule']);
    assert.equal(banner.children[3].textContent, 'Victory');
    assert.ok(Number(banner.vars.get('--fx-to')) > 0.9 && Number(banner.vars.get('--fx-band')) > 0.9);
    assert.ok(parseFloat(banner.vars.get('--fx-fs')) >= 20 && parseFloat(banner.vars.get('--fx-fs')) <= 60);
    // while the tile painter is not running (far view) the ground layer is drawn on the top canvas instead
    map.lod = 'world'; const before = invalidated;
    eng.play('glow', { q: 0, r: 0, radius: 1, seed: 'far' });
    tick(100); frames(1);
    assert.equal(invalidated, before, 'no repaint asked of a painter that is not painting tiles');
    // everything ends: the loop stops, the shake is back at rest, the banner is gone, the count is 0
    for (let i = 0; i < 40; i++) { tick(200); frames(1); }
    assert.equal(queue.length, 0, 'the loop stopped');
    assert.equal(canvas.dataset.fx, '0');
    assert.equal(canvas.vars.get('--fx-sx'), '0.00px'); assert.equal(canvas.vars.get('--fx-ss'), '1');
    assert.equal(hud.children.length, 0);
    eng.unmount(); assert.equal(eng.mounted, false); assert.equal(main.children.includes(top), false);
  } finally { globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = caf; }
});

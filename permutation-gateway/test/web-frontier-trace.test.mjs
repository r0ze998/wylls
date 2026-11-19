// ftrace.mjs: the opt-in diagnostic that names the work the main thread is in (the tab's title), so a page that
// stands still says where. Nothing imports it; off unless installed. No browser, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/ftrace.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));
/** A stand-in page: its own schedulers (run by hand), and classes with the map's method names. */
function page() {
  const said = [], queue = { raf: [], timer: [], micro: [], interval: [] };
  const global = { document: { title: 'WYLLS' },
    requestAnimationFrame(f) { queue.raf.push(f); return queue.raf.length; }, setTimeout(f) { queue.timer.push(f); return queue.timer.length; },
    setInterval(f) { queue.interval.push(f); return queue.interval.length; }, clearInterval() {}, queueMicrotask(f) { queue.micro.push(f); } };
  const calls = [];
  class FrontierMap { draw(x) { calls.push('draw'); this.paintScene(); return x * 2; } paintScene() { calls.push('scene'); this.art.paintFar(); } other() { return 'untouched'; } }
  class SpriteArt { paintFar() { calls.push('far'); said.push(`inside: ${global.document.title}`); if (this.fail) throw new Error('boom'); } }
  class CloudSea { paint() { calls.push('sea'); } }
  class KeepBoard { frame() { return 7; } }
  return { said, queue, global, calls, classes: { FrontierMap, SpriteArt, CloudSea, KeepBoard } };
}

test('off unless installed: nothing is wrapped, nothing is written; installing names the work in the title and uninstalling puts everything back', async () => {
  const p = page(), { FrontierMap, SpriteArt } = p.classes, raf = p.global.requestAnimationFrame, draw = FrontierMap.prototype.draw;
  let clock = 5000; p.global.performance = { now: () => clock };
  assert.equal(T.traceState().on, false);
  const m = new FrontierMap(); m.art = new SpriteArt();
  assert.equal(m.draw(2), 4); assert.equal(p.global.document.title, 'WYLLS');
  // (a sink that shows every crumb, as the worker hears them; the title's own, sparser writing is tested below)
  const off = await T.install({ global: p.global, classes: p.classes, sink: t => { p.global.document.title = t; } });
  assert.equal(await T.install({ global: p.global, classes: p.classes }), off, 'installing twice is one install');
  assert.equal(T.traceState().on, true); assert.equal(p.global.document.title, 'idle 0');
  // a frame: the title inside the innermost step is the whole way down, and idle again afterwards
  p.global.requestAnimationFrame(function tick() { return m.draw(3); });
  p.said.length = 0; p.queue.raf.shift()();
  assert.match(p.said[0], /^inside: \[\d+\] raf:tick > map\.draw > map\.paintScene > art\.paintFar$/);
  assert.equal(p.global.document.title, 'idle 0'); assert.deepEqual(T.traceState().stack, []);
  assert.equal(m.draw(5), 10, 'the wrapped method answers as before'); assert.equal(m.other(), 'untouched');
  // timers, intervals and microtasks are named by their callback; an anonymous one says so
  p.global.setTimeout(function renderHudTick() { p.said.push(p.global.document.title); }); p.queue.timer.shift()();
  p.global.queueMicrotask(function flush() { p.said.push(p.global.document.title); }); p.queue.micro.shift()();
  p.global.setInterval(() => { p.said.push(p.global.document.title); }); p.queue.interval.at(-1)();
  assert.match(p.said.at(-3), /^\[\d+\] timer:renderHudTick$/); assert.match(p.said.at(-2), /^\[\d+\] microtask:flush$/); assert.match(p.said.at(-1), /^\[\d+\] interval:anonymous$/);
  // a step that throws: the error goes on as before, and the stack is not left standing
  m.art.fail = true; assert.throws(() => m.draw(1), /boom/); assert.deepEqual(T.traceState().stack, []); assert.equal(p.global.document.title, 'idle 0');
  // the heartbeat counts while nothing runs (the first interval taken is the module's own, unnamed); it says idle once the page has rested a beat
  p.queue.interval[0](); assert.equal(p.global.document.title, 'idle 0', 'work was a moment ago: not yet');
  clock += 1000; p.queue.interval[0](); assert.equal(p.global.document.title, 'idle 2');
  // a hang: the callback never returns; what the title holds is where
  let title = null; m.art.fail = false;
  SpriteArt.prototype.paintFar = T.traced('art.paintFar', function hung() { title = p.global.document.title; });   // (read at the point a hang would be)
  p.global.requestAnimationFrame(function tick() { m.draw(1); }); p.queue.raf.shift()();
  assert.match(title, /raf:tick > map\.draw > map\.paintScene > art\.paintFar$/);
  off();
  assert.equal(T.traceState().on, false); assert.equal(FrontierMap.prototype.draw, draw); assert.equal(p.global.requestAnimationFrame, raf);
  const before = p.global.document.title; new FrontierMap().other(); assert.equal(p.global.document.title, before);
});

test('with its own sink nothing touches the title; the real classes\' listed methods exist, and nothing of the game imports the module', async () => {
  const p = page(), said = [];
  const off = await T.install({ global: p.global, classes: p.classes, sink: t => said.push(t) });
  new p.classes.CloudSea().paint();
  assert.equal(p.global.document.title, 'WYLLS'); assert.match(said.at(-2), /^\[\d+\] sea\.paint$/); assert.match(said.at(-1), /^idle \d+$/);
  off();
  // the names in TRACED are methods of the real classes (a renamed step would silently stop being named)
  const { FrontierMap } = await import('../../permutation-server/web/frontier/map/fmap.mjs');
  const { SpriteArt } = await import('../../permutation-server/web/frontier/map/sprites.mjs');
  const { CloudSea } = await import('../../permutation-server/web/frontier/map/cloudsea.mjs');
  const { KeepBoard } = await import('../../permutation-server/web/frontier/map/keeps.mjs');
  for (const [cls, names] of [[FrontierMap, T.TRACED.map], [SpriteArt, T.TRACED.art], [CloudSea, T.TRACED.sea], [KeepBoard, T.TRACED.keeps]]) for (const n of names) assert.equal(typeof cls.prototype[n], 'function', `${cls.name}.${n}`);
  // off by default: no file of the client imports it, and it has no storage, network or key use of its own
  const dir = new URL('../../permutation-server/web/frontier/', import.meta.url);
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : e.name.endsWith('.mjs') || e.name.endsWith('.html') ? [new URL(e.name, d)] : []));
  // the one place that names it: the page's start in app.mjs, by a dynamic import; no page and no other module does
  for (const f of walk(dir)) if (!f.pathname.endsWith('/ftrace.mjs') && !f.pathname.endsWith('/frontier/app.mjs')) assert.ok(!readFileSync(f, 'utf8').includes('ftrace'), f.pathname);
  const app = readFileSync(new URL('app.mjs', dir), 'utf8');
  assert.doesNotMatch(app, /^import[^\n]*ftrace/m, 'never a static import: a page that does not ask never loads it');
  assert.match(app, /load = \(\) => import\('\.\/ftrace\.mjs'\)/);
  assert.match(app, /if \(globalThis\.document && !globalThis\.process\?\.versions\?\.node\) startPage\(\)\.catch\(e => console\.error\('frontier boot:', e\)\);\s*$/, 'the page has one start');
  // and the module's own check: the address asks, on a loopback page
  for (const [loc, want] of [[{ hostname: '127.0.0.1', search: '?localPlay=1&devWallet=off&trace=title' }, true], [{ hostname: 'localhost', search: '?trace=title' }, true], [{ hostname: 'play.localhost', search: '?a=1&trace=title&b=2' }, true], [{ hostname: '[::1]', search: '?trace=title' }, true],
    [{ hostname: '127.0.0.1', search: '?localPlay=1' }, false], [{ hostname: '127.0.0.1', search: '?trace=titles' }, false], [{ hostname: '127.0.0.1', search: '?xtrace=title' }, false], [{ hostname: '127.0.0.1', search: '' }, false],
    [{ hostname: 'wylls.example', search: '?trace=title' }, false], [{ hostname: '192.168.1.5', search: '?trace=title' }, false], [{ hostname: '127.0.0.1.example', search: '?trace=title' }, false], [undefined, false], [{}, false]]) {
    assert.equal(T.traceRequested(loc), want, JSON.stringify(loc));
  }
  assert.equal(T.traceState().on, false, 'importing the module here (no address) turned nothing on');
  const src = readFileSync(new URL('ftrace.mjs', dir), 'utf8');
  for (const banned of ['localStorage', 'sessionStorage', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'crypto', 'cookie']) assert.ok(!src.includes(banned), banned);
  await pause(1);
});

test('the page\'s one start: the game does not begin before the diagnostic is wholly installed; a page that does not ask never loads it', async () => {
  const { startPage } = await import('../../permutation-server/web/frontier/app.mjs');
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  // not asked for: boot at once, the module is not loaded
  let loads = 0, boots = 0;
  const plain = startPage({ loc: { hostname: '127.0.0.1', search: '?localPlay=1&devWallet=off' }, load: async () => { loads++; return T; }, start: () => { boots++; return 'booted'; } });
  assert.equal(boots, 1, 'in the same turn: nothing is awaited'); assert.equal(await plain, 'booted'); assert.equal(loads, 0);
  // asked for: the module loads (held), then its install runs (held), and only then the game starts
  const order = []; let releaseLoad, releaseInstall;
  const fake = { traceRequested: loc => { order.push('asked'); return T.traceRequested(loc); }, install: () => { order.push('install begins'); return new Promise(r => { releaseInstall = () => { order.push('install done'); r(); }; }); } };
  const run = startPage({ loc: { hostname: '127.0.0.1', search: '?localPlay=1&trace=title' }, load: () => new Promise(r => { releaseLoad = () => r(fake); }), start: () => { order.push('boot'); return 'booted'; } });
  await tick(); assert.deepEqual(order, [], 'the module is still loading: nothing has begun');
  releaseLoad(); await tick(); assert.deepEqual(order, ['asked', 'install begins'], 'installing: the game has not begun');
  await pause(20); assert.deepEqual(order, ['asked', 'install begins'], 'however long the install takes');
  releaseInstall(); assert.equal(await run, 'booted'); assert.deepEqual(order, ['asked', 'install begins', 'install done', 'boot']);
  // the real module, with its four imports: every step of the map is already named when the game starts
  const p = page(); let stack = null;
  const real = startPage({ loc: { hostname: 'localhost', search: '?trace=title' }, load: async () => ({ traceRequested: T.traceRequested, install: () => T.install({ global: p.global, sink: () => {} }) }),
    start: () => { stack = T.traceState(); return 'booted'; } });
  assert.equal(stack, null, 'not in the same turn'); assert.equal(await real, 'booted'); assert.equal(stack.on, true, 'installed before the game started');
  const { FrontierMap } = await import('../../permutation-server/web/frontier/map/fmap.mjs');
  assert.equal(FrontierMap.prototype.draw.name, 'tracedCall', 'the real map\'s frame is named'); T.uninstall(); assert.notEqual(FrontierMap.prototype.draw.name, 'tracedCall');
  // the flag on a page that is not loopback: the module is loaded, says no, nothing is installed, the game starts
  let installs = 0;
  assert.equal(await startPage({ loc: { hostname: 'wylls.example', search: '?trace=title' }, load: async () => ({ traceRequested: T.traceRequested, install: async () => { installs++; } }), start: () => 'booted' }), 'booted'); assert.equal(installs, 0);
  // a diagnostic that cannot be loaded, or whose install fails, is said and the game starts all the same
  const errors = [], error = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  try {
    assert.equal(await startPage({ loc: { hostname: '127.0.0.1', search: '?trace=title' }, load: async () => { throw new Error('404'); }, start: () => 'booted' }), 'booted');
    assert.equal(await startPage({ loc: { hostname: '127.0.0.1', search: '?trace=title' }, load: async () => ({ traceRequested: () => true, install: async () => { throw new Error('no worker'); } }), start: () => 'booted' }), 'booted');
  } finally { console.error = error; }
  assert.equal(errors.length, 2); assert.match(errors[0], /frontier trace: Error: 404/); assert.match(errors[1], /frontier trace: Error: no worker/);
});

test('a step that has returned is never left in the title; canvas work that can hold the browser is noted just before it runs, with its size', async () => {
  const p = page(), said = [];
  // a stand-in 2D context and canvas, with the browser's own shapes (methods and accessors on the prototypes)
  const done = [];
  class Ctx { constructor(canvas) { this.canvas = canvas; this._f = 'none'; }
    beginPath() { done.push('beginPath'); } moveTo() {} lineTo() {} closePath() {} rect() {} arc() {}
    fill() { done.push(`fill after: ${said.at(-1)}`); } stroke() { done.push('stroke'); } clip() { done.push('clip'); }
    drawImage() { done.push(`drawImage after: ${said.at(-1)}`); } getImageData() { return {}; } createImageData() { return {}; } putImageData() {}
    get filter() { return this._f; } set filter(v) { this._f = v; } }
  class Canvas { constructor(w, h) { this._w = w; this._h = h; done.push(`made ${w}x${h} after: ${said.at(-1)}`); } get width() { return this._w; } set width(v) { this._w = v; } get height() { return this._h; } set height(v) { this._h = v; } getContext() { return new Ctx(this); } }
  p.global.OffscreenCanvas = Canvas; p.global.OffscreenCanvasRenderingContext2D = Ctx;
  class Art { paint() { this.model(); this.after(); } model() {} after() { p.afterTitle = said.at(-1); new p.global.OffscreenCanvas(21000, 18000); } }
  const off = await T.install({ global: p.global, classes: { ...p.classes, SpriteArt: Art }, sink: t => said.push(t) });
  // art.paint > art.model, then work in art.paint after model has returned: the title says art.paint, not art.model
  const art = new Art(); art.paint();
  assert.match(p.afterTitle, /^\[\d+\] art\.paint$/, 'model has returned: it is not left standing');
  assert.match(done.at(-1), /^made 21000x18000 after: \[\d+\] art\.paint \| new canvas 21000x18000$/, 'noted before the canvas is made');
  assert.match(said.at(-1), /^idle \d+$/);
  // small work is not noted
  const before = said.length, small = new p.global.OffscreenCanvas(512, 512), g = small.getContext();
  g.beginPath(); for (let i = 0; i < 100; i++) g.lineTo(i, i); g.fill(); g.drawImage(small, 0, 0); g.getImageData(0, 0, 10, 10);
  assert.equal(said.length, before, 'nothing said for small work');
  // each kind of large work, noted before it runs
  const wide = new p.global.OffscreenCanvas(9000, 100); assert.match(said.at(-1), /\| new canvas 9000x100$/, 'a side past the limit');
  small.width = 20000; assert.match(said.at(-1), /\| canvas width = 20000 \(20000x512\)$/); small.width = 512;
  g.beginPath(); for (let i = 0; i < T.PATH_STEPS; i++) g.lineTo(i, i); g.fill();
  assert.match(done.at(-1), /^fill after: \[\d+\] idle \| ctx\.fill path of 20000 steps on 512x512$/);
  g.beginPath(); g.lineTo(1, 1); const n = said.length; g.stroke(); assert.equal(said.length, n, 'beginPath starts the count again');
  g.clip({}); assert.match(said.at(-1), /\| ctx\.clip\(Path2D\) on 512x512$/, 'a Path2D\'s length is not known: always noted');
  g.drawImage(wide, 0, 0); assert.match(done.at(-1), /^drawImage after: \[\d+\] idle \| ctx\.drawImage 9000x100 → 9000x100 on 512x512$/);
  g.drawImage(small, 0, 0, 512, 512, 0, 0, 4000, 4000); assert.match(said.at(-1), /\| ctx\.drawImage 512x512 → 4000x4000 on 512x512$/);
  g.getImageData(0, 0, 4000, 3000); assert.match(said.at(-1), /\| ctx\.getImageData 4000x3000$/);
  g.putImageData({ width: 5000, height: 5000 }, 0, 0); assert.match(said.at(-1), /\| ctx\.putImageData 5000x5000$/);
  g.filter = 'blur(7.00px) saturate(1.08)'; assert.match(said.at(-1), /\| ctx\.filter = blur\(7\.00px\) saturate\(1\.08\) on 512x512$/); assert.equal(g.filter, 'blur(7.00px) saturate(1.08)');
  const m = said.length; g.filter = 'none'; assert.equal(said.length, m);
  new p.global.OffscreenCanvas(NaN, 10); assert.match(said.at(-1), /\| new canvas NaN x?10|\| new canvas NaNx10$/);
  off();
  // put back: the page's own canvas and context are untouched
  assert.equal(p.global.OffscreenCanvas, Canvas); const k = said.length; new Canvas(30000, 30000).getContext().filter = 'blur(1px)'; assert.equal(said.length, k);
});

test('the title is written seldom and says the outer two levels; every level and every step of the scene goes to the worker', async () => {
  const p = page(); let clock = 1000; p.global.performance = { now: () => clock };
  const heard = [];
  // the worker: a stand-in that keeps what it is sent
  p.global.Worker = class { constructor() {} postMessage(t) { heard.push(t); } terminate() {} };
  p.global.Blob = class {}; p.global.URL = { createObjectURL: () => 'blob:x' };
  const titles = []; let title = 'WYLLS';
  Object.defineProperty(p.global.document, 'title', { get: () => title, set: v => { title = v; titles.push(v); } });
  const off = await T.install({ global: p.global, classes: p.classes });
  assert.equal(typeof p.global.__frontierTrace, 'function', 'the page\'s own steps have their hook');
  const m = new p.classes.FrontierMap(); m.art = { paintFar() { p.global.__frontierTrace('scene: edge 2304 segments at zoom 0.575'); } };
  const frame = () => { p.global.requestAnimationFrame(function tick() { m.draw(1); }); p.queue.raf.shift()(); };
  titles.length = 0; heard.length = 0; frame();
  // the worker heard every level and the step; the title was written once, for the outer level
  assert.ok(heard.some(t => /^\[\d+\] raf:tick > map\.draw > map\.paintScene \| scene: edge 2304 segments at zoom 0\.575$/.test(t)), heard.join(' / '));
  assert.ok(heard.some(t => /^\[\d+\] raf:tick > map\.draw > map\.paintScene$/.test(t)));
  assert.deepEqual(titles.map(t => t.replace(/^\[\d+\] /, '')), ['raf:tick', 'raf:tick > map.draw'], 'the outer two levels as they begin; nothing on the way back');
  // sixty frames in a second: a handful of title writes, not thousands; the worker still hears all of it
  titles.length = 0; heard.length = 0;
  for (let i = 0; i < 60; i++) { clock += 16; frame(); }
  assert.equal(titles.length, 0, `${titles.length} title writes in a second of the same frames`); assert.ok(heard.length >= 60 * 6, `${heard.length} crumbs to the worker`);
  // a hang in a frame after a quiet spell: the title says that frame, whatever was written before
  clock += 5000; p.queue.interval[0](); assert.match(title, /^idle \d+$/);
  let atHang = null; m.art = { paintFar() { atHang = title; } }; clock += 16; frame();
  assert.match(atHang, /^\[\d+\] raf:tick( > map\.draw)?$/, 'the outer levels of the frame under way');
  // a large canvas is said in the title too (rare, and the likeliest thing to hold the browser)
  p.global.requestAnimationFrame(function tick() { T.mark('new canvas 21000x18000'); }); p.queue.raf.shift()();
  assert.ok(titles.some(t => /\| new canvas 21000x18000$/.test(t)));
  off();
  assert.equal(p.global.__frontierTrace, undefined, 'the hook is gone with the trace');
});

test('the map\'s scene says its steps only when the trace is on: every mark is an optional call, and names a step of paintScene', () => {
  const fmap = readFileSync(new URL('../../permutation-server/web/frontier/map/fmap.mjs', import.meta.url), 'utf8');
  const marks = [...fmap.matchAll(/globalThis\.__frontierTrace\?\.\((['`])scene: ([a-z ]+)/g)].map(x => x[2].trim());
  assert.deepEqual(marks, ['painter', 'provinces', 'provinces listed', 'chart cells', 'edge', 'ceiling edge', 'keeps', 'tiles', 'layered', 'wide land', 'wedge', 'site marks', 'focused wedge', 'keeps top', 'guide', 'threats', 'wait standard']);
  assert.equal(fmap.split('__frontierTrace').length - 1, marks.length, 'no other use: never read, never assigned, never called without ?.');
  // and with no trace installed the hook is not there at all
  assert.equal(globalThis.__frontierTrace, undefined);
  for (const n of ['paintLayered', 'farPass', 'topPass', 'overPass', 'labelPass']) assert.ok(T.TRACED.map.includes(n), n);
});

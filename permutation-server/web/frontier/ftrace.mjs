// A diagnostic for a page that stands still: WHAT was the main thread in when it stopped answering?
//
// Off unless asked for; it changes nothing of the game's rules, state or network. Loading this file does nothing by
// itself. The page's one start (app.mjs startPage) loads it only when the address asks, awaits `install()`, and
// boots the game after that:
//   - open the page on this machine with `?trace=title` in its address (a loopback page only: traceRequested)
//   - from then on the tab's TITLE is the work under way, its outer two levels:
//         [412] raf:tick > map.draw
//     and `idle <n>` (n counts up four times a second) once the page rests. The title is written when the outer work
//     changes, not on every frame of the same animation.
//   - the EXACT place — every level, and the steps inside the map's scene — goes to a small worker, which says it
//     once in its own console when the main thread has been silent for STALL_MS inside a piece of work:
//         [stall] main thread silent 3.4 s in: [23206] raf:tick > map.draw > map.paintScene | scene: edge
//   - when the page hangs, the title stays at the work it hung in. The title is read without the page's help: the tab
//     strip, a native screenshot, or the browser's own target list (CDP Target.getTargets), none of which needs the
//     hung main thread.
//   - canvas work that can hold the browser itself is noted just before it is done, with its size:
//         [2750] raf:tick > map.draw > map.paintScene > art.paint | new canvas 21000x18000
//     (a very large canvas, a very large draw, a very long path filled, stroked or clipped, a blur: see CANVAS_AREA)
//   - a small worker hears the same crumbs; when the main thread has been silent for STALL_MS inside a piece of work
//     it says so once in the console: `[stall] main thread silent 3.0 s in: raf:tick > map.draw > art.paintFar`.
//
// What is named: the tasks the page starts (animation frames, timers, microtasks, by the callback's own name) and
// the map's own large steps (the methods of FrontierMap, SpriteArt, CloudSea and KeepBoard listed below). It names
// where the time goes; it does not time anything and keeps no history.
export const STALL_MS = 3000, IDLE_MS = 250, TITLE_MS = 200;
/** The methods wrapped, by class: the map's frame and its large steps. A name that is not there is skipped. */
export const TRACED = Object.freeze({
  map: ['draw', 'open', 'paintScene', 'paintWait', 'paintBare', 'backdrop', 'quickSheet', 'groundApron', 'groundPass', 'dressPage', 'updatePointer',
    'paintLayered', 'farPass', 'topPass', 'overPass', 'labelPass', 'youFrame', 'wedgeHome', 'pileRise', 'keepsOn'],
  art: ['paint', 'paintFar', 'farBitmap', 'model', 'warm'],
  sea: ['paint', 'bake', 'rough'],
  keeps: ['frame', 'read', 'ground', 'top', 'over', 'far'],
});

const state = { on: false, stack: [], n: 0, idle: 0, sink: null, undo: [], workAt: -Infinity, clock: () => Date.now() };
const label = () => state.stack.join(' > ');
/** `fine`: a crumb below the outer two levels, or a note of a small step: it goes to the worker, not to the title. */
function say(text, fine = false) { try { state.sink?.(text, fine); } catch { /* a sink that fails is not the page's trouble */ } }
/** Work begins: `name` goes on the stack and is said. Returns the function that ends it. */
export function enter(name) {
  if (!state.on) return () => {};
  state.stack.push(name);
  state.workAt = state.clock();
  say(`[${++state.n}] ${label()}`, state.stack.length > 2);
  let done = false;
  return () => {
    if (done) return; done = true;
    const at = state.stack.lastIndexOf(name);
    if (at >= 0) state.stack.length = at;
    // (said on every way back up: a step that has returned is never left standing in the title. A hang inside
    // `art.paint` after `art.model` came back reads `… > art.paint`, not `… > art.model`)
    // (to the worker: the title is not written on the way back up; it says idle from the heartbeat, once the page rests)
    say(state.stack.length ? `[${++state.n}] ${label()}` : `idle ${state.idle}`, true);
  };
}
/** `fn` with its work named: sync, or until its promise settles is NOT waited for (a task is what runs now). */
export function traced(name, fn) {
  if (typeof fn !== 'function') return fn;
  return function tracedCall(...args) {
    const end = enter(name);
    try { return fn.apply(this, args); } finally { end(); }
  };
}
/**
 * A note inside the work under way, said at once: `[n] raf:tick > map.draw > art.paint | new canvas 21000x18000`.
 * It stays until the next step begins or ends. Used for the canvas work that can hold the browser itself (below).
 */
export function mark(text, fine = false) { if (state.on) say(`[${++state.n}] ${label() || 'idle'} | ${text}`, fine); }
/** A step of the page's own code says where it is (map/fmap.mjs paintScene, through `globalThis.__frontierTrace`): to the worker only. */
const step = text => mark(String(text), true);
const nameOf = (kind, fn) => `${kind}:${(typeof fn === 'function' && fn.name) || 'anonymous'}`;

function wrapMethods(proto, tag, names) {
  for (const m of names) {
    const own = Object.getOwnPropertyDescriptor(proto, m);
    if (!own || typeof own.value !== 'function') continue;
    const was = own.value;
    Object.defineProperty(proto, m, { ...own, value: traced(`${tag}.${m}`, was) });
    state.undo.push(() => Object.defineProperty(proto, m, own));
  }
}
function wrapScheduler(g, key, kind, at = 0) {
  const was = g[key];
  if (typeof was !== 'function') return;
  g[key] = function scheduled(...args) { if (typeof args[at] === 'function') args[at] = traced(nameOf(kind, args[at]), args[at]); return was.apply(this, args); };
  state.undo.push(() => { g[key] = was; });
}

/**
 * The canvas work that can hold the browser's own code (where no script can be paused): each is NOTED just before it
 * is done, so a tab that stops inside one says which, with its size.
 *   a canvas made or resized to CANVAS_AREA px or more, or to a side of CANVAS_SIDE or more
 *   drawImage, getImageData, putImageData, createImageData over CANVAS_AREA px or more
 *   fill, stroke or clip of a path of PATH_STEPS steps or more (counted from beginPath)
 *   a blur or other filter set on a context
 * Small work is not noted (a title for every call would be the slow thing).
 */
export const CANVAS_AREA = 8_000_000, CANVAS_SIDE = 8192, PATH_STEPS = 20_000;
const big = (w, h) => !(w >= 0 && h >= 0) || w * h >= CANVAS_AREA || w >= CANVAS_SIDE || h >= CANVAS_SIDE;
const dim = x => (Number.isFinite(x) ? Math.round(x) : String(x));
function wrapContext(proto) {
  if (!proto) return;
  const steps = new WeakMap();
  const swap = (name, make) => {
    const own = Object.getOwnPropertyDescriptor(proto, name);
    if (!own || typeof own.value !== 'function') return;
    Object.defineProperty(proto, name, { ...own, value: make(own.value) });
    state.undo.push(() => Object.defineProperty(proto, name, own));
  };
  swap('beginPath', was => function beginPath(...a) { steps.set(this, 0); return was.apply(this, a); });
  for (const m of ['moveTo', 'lineTo', 'arc', 'arcTo', 'rect', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'closePath', 'roundRect']) {
    swap(m, was => function pathStep(...a) { steps.set(this, (steps.get(this) ?? 0) + 1); return was.apply(this, a); });
  }
  for (const m of ['fill', 'stroke', 'clip']) {
    swap(m, was => function pathUse(...a) { const n = a[0] && typeof a[0] === 'object' ? null : steps.get(this) ?? 0; if (n === null) mark(`ctx.${m}(Path2D) on ${dim(this.canvas?.width)}x${dim(this.canvas?.height)}`); else if (n >= PATH_STEPS) mark(`ctx.${m} path of ${n} steps on ${dim(this.canvas?.width)}x${dim(this.canvas?.height)}`); return was.apply(this, a); });
  }
  swap('drawImage', was => function drawImage(img, ...a) {
    const sw = img?.width ?? img?.videoWidth ?? 0, sh = img?.height ?? img?.videoHeight ?? 0;
    const dw = a.length >= 8 ? a[6] : a.length >= 4 ? a[2] : sw, dh = a.length >= 8 ? a[7] : a.length >= 4 ? a[3] : sh;
    if (big(sw, sh) || big(Math.abs(dw), Math.abs(dh))) mark(`ctx.drawImage ${dim(sw)}x${dim(sh)} → ${dim(dw)}x${dim(dh)} on ${dim(this.canvas?.width)}x${dim(this.canvas?.height)}`);
    return was.call(this, img, ...a);
  });
  for (const m of ['getImageData', 'createImageData']) swap(m, was => function imageData(...a) { const w = typeof a[0] === 'number' ? (m === 'getImageData' ? a[2] : a[0]) : a[0]?.width, h = typeof a[0] === 'number' ? (m === 'getImageData' ? a[3] : a[1]) : a[0]?.height; if (big(Math.abs(w), Math.abs(h))) mark(`ctx.${m} ${dim(w)}x${dim(h)}`); return was.apply(this, a); });
  swap('putImageData', was => function putImageData(d, ...a) { if (big(d?.width, d?.height)) mark(`ctx.putImageData ${dim(d?.width)}x${dim(d?.height)}`); return was.call(this, d, ...a); });
  const filter = Object.getOwnPropertyDescriptor(proto, 'filter');
  if (filter?.set) {
    Object.defineProperty(proto, 'filter', { ...filter, set(v) { if (v && v !== 'none') mark(`ctx.filter = ${String(v).slice(0, 60)} on ${dim(this.canvas?.width)}x${dim(this.canvas?.height)}`); return filter.set.call(this, v); } });
    state.undo.push(() => Object.defineProperty(proto, 'filter', filter));
  }
}
function wrapCanvases(global) {
  const Native = global.OffscreenCanvas;
  if (typeof Native === 'function') {
    global.OffscreenCanvas = class OffscreenCanvas extends Native { constructor(w, h) { if (big(w, h)) mark(`new canvas ${dim(w)}x${dim(h)}`); super(w, h); } };
    state.undo.push(() => { global.OffscreenCanvas = Native; });
  }
  for (const proto of [global.HTMLCanvasElement?.prototype, typeof Native === 'function' ? Native.prototype : null]) for (const side of ['width', 'height']) {
    const own = proto ? Object.getOwnPropertyDescriptor(proto, side) : null;
    if (!own?.set) continue;
    Object.defineProperty(proto, side, { ...own, set(v) { const w = side === 'width' ? v : this.width, h = side === 'height' ? v : this.height; if (big(w, h)) mark(`canvas ${side} = ${dim(v)} (${dim(w)}x${dim(h)})`); return own.set.call(this, v); } });
    state.undo.push(() => Object.defineProperty(proto, side, own));
  }
  wrapContext(global.CanvasRenderingContext2D?.prototype);
  wrapContext(global.OffscreenCanvasRenderingContext2D?.prototype);
}

/** The worker's source: it keeps the last crumb and says once when the main thread goes silent inside work. */
const WORKER = `let last = 'idle', at = Date.now(), told = false;
onmessage = e => { last = String(e.data); at = Date.now(); told = false; };
setInterval(() => { const quiet = Date.now() - at; if (!told && quiet > ${STALL_MS} && !/^idle/.test(last)) { told = true; console.warn('[stall] main thread silent ' + (quiet / 1000).toFixed(1) + ' s in: ' + last); } }, 500);`;

/**
 * Turn the trace on. `sink(text)` receives every crumb (default: the document's title, and the stall worker);
 * `classes` `{FrontierMap, SpriteArt, CloudSea, KeepBoard}` (default: the page's own modules, imported here);
 * `global` the object whose requestAnimationFrame / setTimeout / setInterval / queueMicrotask are named.
 * Returns `uninstall()`. Installing twice is one install.
 */
export async function install({ sink = null, classes = null, global = globalThis, worker = true } = {}) {
  if (state.on) return uninstall;
  let post = null;
  if (!sink) {
    const doc = global.document;
    if (worker && typeof global.Worker === 'function' && typeof global.Blob === 'function' && global.URL?.createObjectURL) {
      try { const w = new global.Worker(global.URL.createObjectURL(new global.Blob([WORKER], { type: 'text/javascript' }))); post = t => w.postMessage(t); state.undo.push(() => w.terminate()); } catch { post = null; }
    }
    // every crumb goes to the worker (a message costs the page next to nothing; its `[stall]` line is the exact
    // place). The TITLE is written far less often: a title is a message to the browser's own window, and some sixty
    // of them a frame was work of its own. It gets the outer two levels and the large-canvas notes only, and is not
    // written again for the work it already shows (or the outer level of it): the frames of one animation, which all
    // begin alike, write nothing. This is NOT a limit on how often a CHANGED title is written: other work is always
    // written at once. TITLE_MS only spaces the heartbeat's repeated `idle n`.
    let shown = '', shownAt = -Infinity;
    const clock = () => state.clock();
    sink = (text, fine) => {
      post?.(text);
      if (fine || !doc) return;
      const what = text.replace(/^\[\d+\] /, '').replace(/^idle \d+$/, 'idle'), t = clock();
      // (the same work as is shown, or the outer level of it — every frame of an animation begins the same way — is
      // not written again; idle is written again only as its count moves)
      if (what !== 'idle' && (what === shown || shown.startsWith(`${what} > `))) return;
      if (what === 'idle' && shown === 'idle' && t - shownAt < TITLE_MS) return;
      shown = what; shownAt = t; doc.title = text;
    };
  }
  state.clock = () => global.performance?.now?.() ?? Date.now();
  state.sink = sink;
  const c = classes ?? await (async () => {
    const [f, s, sea, k] = await Promise.all([import('./map/fmap.mjs'), import('./map/sprites.mjs'), import('./map/cloudsea.mjs'), import('./map/keeps.mjs')]);
    return { FrontierMap: f.FrontierMap, SpriteArt: s.SpriteArt, CloudSea: sea.CloudSea, KeepBoard: k.KeepBoard };
  })();
  if (c.FrontierMap) wrapMethods(c.FrontierMap.prototype, 'map', TRACED.map);
  if (c.SpriteArt) wrapMethods(c.SpriteArt.prototype, 'art', TRACED.art);
  if (c.CloudSea) wrapMethods(c.CloudSea.prototype, 'sea', TRACED.sea);
  if (c.KeepBoard) wrapMethods(c.KeepBoard.prototype, 'keeps', TRACED.keeps);
  wrapCanvases(global);
  // (the page's own steps: `globalThis.__frontierTrace?.('scene: edge')` in the map's code is this, or nothing)
  const hadStep = global.__frontierTrace;
  global.__frontierTrace = step;
  state.undo.push(() => { if (hadStep === undefined) delete global.__frontierTrace; else global.__frontierTrace = hadStep; });
  // (the heartbeat's own timer is taken before the timers are named: it is not a piece of the page's work, and its
  // count shows the page is alive)
  const nativeInterval = typeof global.setInterval === 'function' ? global.setInterval.bind(global) : null;
  wrapScheduler(global, 'requestAnimationFrame', 'raf');
  wrapScheduler(global, 'setTimeout', 'timer');
  wrapScheduler(global, 'setInterval', 'interval');
  wrapScheduler(global, 'queueMicrotask', 'microtask');
  state.on = true;
  // (idle is said once the page has rested for a beat: between the frames of an animation the title keeps the frame)
  const id = nativeInterval?.(() => { state.idle++; if (!state.stack.length && state.clock() - state.workAt >= IDLE_MS) say(`idle ${state.idle}`); }, IDLE_MS);
  state.undo.push(() => global.clearInterval?.(id));
  say(`idle ${state.idle}`);
  return uninstall;
}
/** Turn the trace off: every wrapped method and scheduler is put back as it was. */
export function uninstall() {
  if (!state.on) return;
  for (const f of state.undo.splice(0).reverse()) { try { f(); } catch { /* best effort */ } }
  state.on = false; state.stack.length = 0; state.sink = null;
}
/** (tests) The crumb stack as it stands. */
export const traceState = () => ({ on: state.on, stack: [...state.stack], n: state.n });

/**
 * Whether the page's address asks for the trace: `?trace=title`, on a loopback page only (localhost, *.localhost,
 * 127.x.x.x, ::1). A page served from anywhere else never turns it on by its address.
 */
export function traceRequested(loc = globalThis.location) {
  const host = String(loc?.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '::1';
  return loopback && /[?&]trace=title(?:&|$)/.test(String(loc?.search ?? ''));
}

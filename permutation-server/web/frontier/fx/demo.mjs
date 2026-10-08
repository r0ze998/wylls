// The effects demo switch (UX-DESIGN §8.6). It is the one labelled exception
// to "effects are driven by real records only": with `?fx=` in the address
// the page plays named effects from the built-in sample data below, and a
// corner tag says so for as long as it is active. Without `?fx=` this file
// is never loaded and `window.__fx` does not exist.
//
//   ?fx=<name>[,<name>…]   the samples to play (`?fx=` alone: none, the handle only)
//   &fxt=<seconds>          freeze the effects clock at that time after the start
//   &fxrate=<n>             play at that rate instead (0.25 = slow motion); loops
//   &fxat=<p>,<q>,<tile>    where on the map, or &fxat=<q>,<r> (a tile's axial hex); default: the viewer's village, else the tile at the view's centre
//   &fxmotion=<full|reduced|off>   show that motion level whatever the system says
//
//   window.__fx.list()           the sample names
//   window.__fx.play('spark')    play these samples from the start (a name, a list, or nothing = resume)
//   window.__fx.seek(1.2)        freeze at 1.2 s        .step(1/60)  one frame on
//   window.__fx.rate(0.25)       slow motion             .state()     {t, frozen, rate, names, live}
//   window.__fx.sound('bell')    hear a sound (after a click: browsers ask for a gesture)
//
// Frame-by-frame capture: seek, wait for a frame, shoot; every effect and
// every particle is a function of the clock and its seed, so a frame is the
// same on every run.
import { L, onLangChange } from '../../lang.mjs';
import { inverseHex, project } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { clock } from './clock.mjs';
import { forceMotion, motion, MOTION_LEVELS } from './motion.mjs';
import { audio } from './audio.mjs';
import { TONE } from './effects.mjs';

/**
 * The samples: name → {secs (how long one run lasts), cues(c) → [[effect, args, delay?]], sounds?: [[name, delay]]}.
 * `c` = {at: {q, r} (the demo tile), origin: {x, y} (the Engine when it is in view, else the demo tile)}.
 */
export const SAMPLES = Object.freeze({
  flash: { secs: 0.9, cues: c => [['flash', { ...c.at, color: TONE.you }]] },
  ripple: { secs: 1.2, cues: c => [['ripple', { ...c.at, color: TONE.brassHi }]] },
  dust: { secs: 1.3, cues: c => [['dust', { ...c.at }]] },
  spark: { secs: 1.6, cues: c => [['spark', { ...c.at, shake: 4 }]], sounds: [['clash', 0.06]] },
  label: { secs: 1.5, cues: c => [['label', { ...c.at, text: '−120', color: '#ff9d86', size: 28 }]] },
  glow: { secs: 1.9, cues: c => [['glow', { ...c.at, radius: 2, color: TONE.reach }]] },
  banner: { secs: 3.0, cues: () => [['banner', { title: L`勝利`, sub: L`演出の見本です。実際の記録ではありません。`, tone: 'win' }]] },
  toll: { secs: 3.2, cues: c => [['toll', { ...c.origin }]], sounds: [['bell', 0.2]] },
  number: { secs: 1.3, cues: () => [['number', { el: '#bell-chip', text: '+120', below: true, size: 20 }]] },
  chip: { secs: 1.0, cues: () => [['chip', { el: '#bell-chip' }]] },
  // every particle kind side by side, on the six tiles around the demo tile and on it (dust, spark and shard are in the samples above)
  kinds: { secs: 2.6, cues: c => [['leaf', 1, 0, { n: 16, height: 0.5, power: 1.2 }], ['coin', 1, -1, { n: 14, height: 0.2 }], ['smoke', 0, -1, { n: 10, stagger: 0.5 }], ['mist', -1, 0, { n: 9, radius: 0.5, stagger: 0.4 }],
    ['ink', -1, 1, { n: 12, radius: 0.5, stagger: 0.3 }], ['ember', 0, 1, { n: 16, radius: 0.3, stagger: 0.5 }], ['shard', 0, 0, { n: 12 }]].map(([kind, dq, dr, o]) => ['burst', { q: c.at.q + dq, r: c.at.r + dr, kind, ...o }]) },
  // two compositions, to show how the pieces stack: the bell's turn, and one blow landing
  bell: { secs: 3.6, cues: c => [['toll', { ...c.origin }], ['chip', { el: '#bell-chip' }, 0.2], ['banner', { title: L`鐘が鳴りました — ターン ${43}`, dur: 2.9 }, 0.3]], sounds: [['bell', 0.2]] },
  strike: { secs: 1.8, cues: c => [['flash', { ...c.at, color: '#ffb347' }], ['spark', { ...c.at, shake: 6 }, 0.07], ['dust', { ...c.at, power: 0.8 }, 0.09], ['ripple', { ...c.at, color: '#ffd27a', radius: 1.8 }, 0.07], ['label', { ...c.at, text: '−120', color: '#ff9d86', size: 30 }, 0.16]], sounds: [['clash', 0.13]] },
});

const ints = s => String(s ?? '').split(',').map(Number);

/** Start the demo on a page (called by fx/index.mjs when the address has `?fx=`). */
export function startDemo({ fx, map = null, params, doc = globalThis.document }) {
  const win = doc?.defaultView ?? globalThis;
  let names = String(params.get('fx') ?? '').split(',').map(s => s.trim()).filter(n => SAMPLES[n]);
  const fxt = params.has('fxt') ? Math.max(0, Number(params.get('fxt')) || 0) : null;
  const rate0 = params.has('fxrate') ? Math.max(0, Number(params.get('fxrate')) || 0) : 1;
  const fxat = ints(params.get('fxat'));
  if (MOTION_LEVELS.includes(params.get('fxmotion'))) forceMotion(params.get('fxmotion'));
  fx.keep = true;

  // ---- where: a tile and the bell's origin
  const anchor = () => {
    if (fxat.length >= 3 && fxat.every(Number.isInteger)) return tileHex(fxat[0], fxat[1], fxat[2]);
    if (fxat.length === 2 && fxat.every(Number.isInteger)) return { q: fxat[0], r: fxat[1] };
    const own = (() => { try { return (map?.source?.()?.own ?? []).find(o => Number.isInteger(o.tile)); } catch { return null; } })();
    if (own) return tileHex(own.p, own.q, own.tile);
    const v = fx.view();
    const [q, r] = inverseHex(v.x, v.y).split(',').map(Number);
    return { q, r };
  };
  const context = () => {
    const at = anchor();
    const here = project(at.q, at.r);
    const e = fx.toScreen(0, 0), sz = fx.size();
    const engineInView = e.x >= 0 && e.y >= 0 && e.x <= sz.width && e.y <= sz.height;
    return { at: { q: at.q, r: at.r }, origin: engineInView ? { x: 0, y: 0 } : { x: here.x, y: here.y }, key: `${at.q},${at.r},${engineInView ? 1 : 0}` };
  };

  // ---- the corner tag
  const tag = doc.createElement('span');
  tag.className = 'fx-demo-tag';
  const label = () => { tag.textContent = L`演出の見本`; };
  label();
  onLangChange(label);
  fx.hud?.append(tag);

  // ---- one run: everything starts at clock 0
  let key = '', length = 1;
  function spawn() {
    const c = context();
    key = c.key;
    fx.clear();
    length = 0.5;
    for (const n of names) {
      const s = SAMPLES[n];
      length = Math.max(length, s.secs);
      s.cues(c).forEach(([effect, args, delay = 0], i) => fx.play(effect, { ...args, delay, seed: `demo|${n}|${i}|${effect}` }));
    }
  }
  function sounds() {
    for (const n of names) for (const [name, delay] of SAMPLES[n].sounds ?? []) audio().play(name, { delay: delay / Math.max(0.05, clock.rate || 1), seed: n });
  }
  /** Start the run again from 0: frozen at `at` when given, else running. */
  function restart(at = null) {
    clock.seek(0);
    spawn();
    if (at !== null) clock.seek(at); else { clock.play(); sounds(); }
    fx.kick();
  }
  /** Rebuild the run at the clock's present time (the demo tile moved: the village arrived, the view was dragged). */
  function rebuild() {
    const { t, frozen } = clock.state();
    clock.seek(0);
    spawn();
    clock.seek(t);
    if (!frozen) clock.play();
    fx.kick();
  }

  clock.setRate(rate0 || 1);
  restart(fxt !== null ? fxt : rate0 === 0 ? 0 : null);

  // the demo tile follows what the map knows; a running demo loops with a short rest between runs
  win.setInterval?.(() => {
    if (!names.length) return;
    if (context().key !== key) { rebuild(); return; }
    if (!clock.frozen && clock.now() > length + 0.8) restart();
  }, 200);

  const state = () => ({ ...clock.state(), names: [...names], live: fx.live(), motion: motion(), at: key });
  const handle = {
    list: () => Object.keys(SAMPLES),
    play(what, { rate } = {}) {
      if (rate !== undefined) clock.setRate(rate);
      if (what === undefined) { clock.play(); fx.kick(); return state(); }
      names = (Array.isArray(what) ? what : String(what).split(',')).map(s => String(s).trim()).filter(n => SAMPLES[n]);
      restart();
      return state();
    },
    seek(t) { clock.seek(t); fx.kick(); return state(); },
    step(dt = 1 / 60) { clock.step(dt); fx.kick(); return state(); },
    rate(n) { clock.setRate(n); return state(); },
    motion(level) { forceMotion(level ?? null); rebuild(); return state(); },
    sound: (name, opts) => audio().play(name, opts),
    state,
  };
  try { win.__fx = handle; } catch { /* a frozen window */ }
  return handle;
}

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
//   &fxcam=<zoom>           centre the camera on the demo tile at that zoom (with &fxat=)
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
import { tileHex, locate, DIRECTIONS } from '../fgeo.mjs';
import { startBattle } from '../people/battle.mjs';
import { clock } from './clock.mjs';
import { bus } from './bus.mjs';
import { forceMotion, motion, MOTION_LEVELS } from './motion.mjs';
import { audio } from './audio.mjs';
import { TONE } from './effects.mjs';
import { stageBattle, BATTLE_ZOOM } from './battle.mjs';
import { playToll, playResult, playBusy, playSent, playLanded, playRefused, playSealed, playMoment, playLanding, playReveal, TOLL_CLEAR, RESULT_GAP } from './stage.mjs';
import { hexKey } from '../map/survey.mjs';
import { hexDisc } from './effects.mjs';
import { renderStatus } from '../hud/status.mjs';

// ---- sample data for the set pieces: labelled as a demo on screen, never mixed with the page's records
const T = n => n;   // whole troops, as people/battle.mjs scenes carry them
/** Sample clashes on the demo tile (the viewer is nation 0). */
export const DEMO_SCENES = Object.freeze({
  // the viewer's assault with archers behind takes a garrisoned village
  win: at => ({ attackers: [{ id: 'd1', faction: 0, unit: 0, stance: 1, before: T(900), after: T(760), fate: 'Stays', kind: 'arrival' }, { id: 'd2', faction: 0, unit: 1, stance: 1, before: T(320), after: T(290), fate: 'Stays', kind: 'arrival' }],
    defenders: [{ id: 'd3', faction: 2, unit: 3, stance: 0, before: T(520), after: 0, fate: 'Destroyed', kind: 'resident' }, { id: 'g0', faction: 2, stance: 3, before: T(260), after: 0, fate: 'Destroyed', kind: 'garrison' }], at }),
  // riders on the flank clear a camp, which burns
  camp: at => ({ attackers: [{ id: 'd1', faction: 0, unit: 2, stance: 2, before: T(600), after: T(510), fate: 'Stays', kind: 'arrival' }],
    defenders: [{ id: 'camp', faction: 6, stance: 0, before: T(420), after: 0, fate: 'Destroyed', kind: 'camp' }], at }),
  // another nation's assault breaks on the viewer's braced line
  held: at => ({ attackers: [{ id: 'd1', faction: 4, unit: 0, stance: 1, before: T(1400), after: 0, fate: 'Destroyed', kind: 'arrival' }, { id: 'd2', faction: 4, unit: 4, stance: 1, before: T(300), after: T(300), fate: 'Retreated', kind: 'arrival' }],
    defenders: [{ id: 'g0', faction: 0, stance: 3, before: T(800), after: T(590), fate: 'Stays', kind: 'garrison' }, { id: 'd3', faction: 0, unit: 3, stance: 0, before: T(450), after: T(360), fate: 'Stays', kind: 'resident' }], at }),
  // two other nations, watched from outside
  others: at => ({ attackers: [{ id: 'd1', faction: 3, unit: 5, stance: 2, before: T(700), after: T(420), fate: 'Stays', kind: 'arrival' }],
    defenders: [{ id: 'd3', faction: 1, unit: 0, stance: 0, before: T(650), after: 0, fate: 'Destroyed', kind: 'resident' }], at }),
});
const demoScene = (name, c) => { const l = locate(c.at.q, c.at.r), d = DEMO_SCENES[name](c.at); return { p: l.p, q: l.q, bell: 43, tiles: [{ idx: l.idx, hex: d.at, attackers: d.attackers, defenders: d.defenders }] }; };
const battle = (name, opts = {}) => ({ secs: 7.6, run: (c, fx) => { stageBattle(fx, startBattle(demoScene(name, c), 0, opts.speed ?? 1), { focus: c.cam, zoom: c.cam ? BATTLE_ZOOM : null, viewerFaction: 0, seed: `demo|battle|${name}`, ...opts }); } });
const tileOf = (c, dq = 0, dr = 0) => { const l = locate(c.at.q + dq, c.at.r + dr); return { p: l.p, q: l.q, tile: l.idx }; };
/** A sample route of four steps from the demo tile (east, north-east, east, east). */
const demoRoute = c => ({ ...tileOf(c), dirs: [0, 1, 0, 0] });
const demoDest = c => { let { q, r } = c.at; for (const d of demoRoute(c).dirs) { q += DIRECTIONS[d][0]; r += DIRECTIONS[d][1]; } const l = locate(q, r); return { p: l.p, q: l.q, tile: l.idx }; };
const act = (c, name = 'Build') => ({ id: `demo-${name}`, name, faction: 0, tile: tileOf(c) });
const march = c => ({ ...act(c, 'Depart'), unit: 0, route: demoRoute(c), dest: demoDest(c) });
const moment = (kind, extra = {}) => ({ secs: 3.0, run: (c, fx) => playMoment(fx, { kind, ...tileOf(c), faction: 0, own: true, id: 'demo', ...extra }) });
/** The turn the page's dial shows (the sample toll announces that one, so the banner and the dial agree); 43 without a dial. */
const turnOf = c => c.turn ?? 43;
/**
 * The HUD's own status chip for a sample (hud/status.mjs renderStatus: the ring while an action is tracked, the
 * toast with "try again" when it was refused), shown in a notice stack of the demo's own beside the page's:
 * the sample never writes the page's state. `at`: seconds on the demo clock from which it shows.
 */
const statusSample = (c, st, at = 0) => { c.status?.(st, at); };
/** A sample survey: the tiles around the demo tile come out of the chart ring by ring, on the map's own reveal (map/survey.mjs). */
function revealSample(c, fx) {
  const tiles = hexDisc(c.at.q, c.at.r, 2).map(h => ({ q: h.q, r: h.r, at: 0.15 + 0.08 * Math.max(Math.abs(h.q - c.at.q), Math.abs(h.r - c.at.r), Math.abs(h.q + h.r - c.at.q - c.at.r)) }));
  try {
    const reveals = fx.map?.source?.()?.survey?.reveals;
    if (reveals?.set) { for (const t of tiles) reveals.set(hexKey(t.q, t.r), t.at * 1000); fx.map.tick?.(); }
  } catch { /* a page without a survey: the engine's part alone */ }
  playReveal(fx, { tiles, seed: 'demo|reveal' });
}

/**
 * The samples: name → {secs (how long one run lasts), cues(c) → [[effect, args, delay?]], sounds?: [[name, delay]]},
 * or {secs, run(c, fx, later)} for a set piece (the same composition the page plays, fed with the sample data above;
 * `later(seconds)` gives an engine whose every cue starts that much later).
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
  bell: { secs: 3.6, run: (c, fx) => playToll(fx, { turn: turnOf(c), home: tileOf(c) }) },
  strike: { secs: 1.8, cues: c => [['flash', { ...c.at, color: '#ffb347' }], ['spark', { ...c.at, shake: 6 }, 0.07], ['dust', { ...c.at, power: 0.8 }, 0.09], ['ripple', { ...c.at, color: '#ffd27a', radius: 1.8 }, 0.07], ['label', { ...c.at, text: '−120', color: '#ff9d86', size: 30 }, 0.16]], sounds: [['clash', 0.13]] },

  // ---- the set pieces (UX-DESIGN §8.3), each the page's own composition on sample data
  battle: battle('win'),
  'battle-camp': battle('camp'),
  'battle-held': battle('held'),
  'battle-others': battle('others', { viewerFaction: null }),
  'battle-fast': { ...battle('win', { speed: 2.5 }), secs: 3.4 },
  // the turn: the toll, then this turn's own results one after another
  turn: { secs: 6.6, run: (c, fx, later) => {
    const turn = turnOf(c);
    playToll(fx, { turn, home: tileOf(c) });
    const items = [['arrival', 2, -1, L`進軍が開封されました`], ['battle', -1, 1, L`衝突が決着しました`], ['incoming', 0, 0, L`来襲の恐れ`]].map(([result, dq, dr, text]) => ({ id: `demo-${result}`, result, kind: result, text, ...tileOf(c, dq, dr), faction: 0 }));
    // (as on the page: the results and their card wait until the toll's banner has gone, fx/stage.mjs TOLL_CLEAR)
    items.forEach((x, i) => playResult(later(TOLL_CLEAR + i * RESULT_GAP), x));
    // the HUD's strip of this turn's results (app.mjs listens): the same sample items, under the demo's tag
    bus.emit('turn:results', { turn, demo: true, items, fresh: items, startsIn: TOLL_CLEAR, gap: RESULT_GAP });
  } },
  results: { secs: 3.4, run: (c, fx, later) => [['arrival', 2, -1], ['battle', -1, 1], ['incoming', 0, 0]].forEach(([result, dq, dr], i) => playResult(later(i * 0.7), { id: `demo-${result}`, result, ...tileOf(c, dq, dr), faction: 0 })) },
  // an own action: tracked, sent, landed; and refused
  action: { secs: 3.6, run: (c, fx, later) => { const a = act(c); playBusy(fx, a); statusSample(c, { state: 'busy', text: L`送信中…`, share: null }); playSent(later(0.7), a); playLanded(later(1.5), a); statusSample(c, { state: 'done', text: L`完了しました`, share: 1 }, 1.5); }, settle: 1.5 },
  landed: { secs: 1.8, run: (c, fx) => playLanded(fx, act(c)) },
  // (with the HUD's own status chip beside them: the ring while it is tracked, the toast with "try again" when it is refused)
  refused: { secs: 3.2, run: (c, fx, later) => { const a = act(c, 'Train'); playBusy(fx, a); statusSample(c, { state: 'busy', text: L`送信中…`, share: null }); playRefused(later(0.9), a); statusSample(c, { state: 'refused', text: L`演出の見本です。実際の記録ではありません。`, retry: true }, 0.9); }, settle: 0.9 },
  pending: { secs: 3, run: (c, fx) => { playBusy(fx, act(c)); statusSample(c, { state: 'busy', text: L`送信中…`, share: null }); } },
  // seal and depart: the route draws on, the seal stamps, the column sets off, the ribbon rests
  seal: { secs: 5.2, run: (c, fx, later) => { const a = march(c); playBusy(fx, a); playSealed(later(1.1), a); }, settle: 1.1 },
  // the landing of the viewer's village, played again on the map's own timeline (map/fmap.mjs playLanding)
  // (a viewer without a village: the engine's part alone, on the demo tile)
  landing: { secs: 4.2, run: (c, fx) => { const m = fx.map; if (m?.playLanding) { m.keepLanding = true; if (m.playLanding(null, { fly: false })) return; } playLanding(fx, { ...tileOf(c), faction: 0, maxD: 2, flood: 0.12, impact: 1.21 }); } },
  // land comes out of the chart (an explore's reveal)
  reveal: { secs: 3.4, run: (c, fx) => revealSample(c, fx) },
  // moments of the map
  built: moment('built', { label: L`伐採場` }),
  harvest: moment('harvest', { site: 0 }),
  'harvest-other': moment('harvest', { own: false, faction: 3 }),
  muster: moment('muster', { unit: 0, troops: 400 }),
  arrive: moment('arrive', { faction: 2, own: false }),
  camp: moment('camp', { own: false }),
  village: moment('village', { from: 2, to: 0 }),
  'village-lost': moment('village', { from: 0, to: null }),
  depart: moment('depart', { faction: 3, own: false }),
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
  // &fxcam=<zoom>: put the camera on the demo tile at that zoom (what the page does when it flies to a battle)
  const fxcam = Number(params.get('fxcam'));
  let camReady = false;
  if (fxcam > 0 && fxat.every(Number.isInteger) && fxat.length >= 2 && map?.setView) {
    const h = fxat.length >= 3 ? tileHex(fxat[0], fxat[1], fxat[2]) : { q: fxat[0], r: fxat[1] }, c = project(h.q, h.r);
    // (as the page does for a battle: in the part of the map nothing covers, map/fmap.mjs flyTo; else the canvas centre)
    // (a sample that places the camera itself, a battle, is staged again once the camera is there)
    win.setTimeout?.(() => { if (map.flyTo) map.flyTo({ x: c.x, y: c.y, zoom: Math.min(2.5, fxcam) }, 1); else map.setView({ x: c.x, y: c.y, zoom: Math.min(2.5, fxcam) }); camReady = true; rebuild(); }, 600);
  }

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
    // (the resource strip appears when the page has the village's stores: a sample that flies to it is rebuilt then)
    const strip = doc.getElementById?.('res-strip');
    const turn = Number(String(doc.querySelector?.('#bell-pill .dial-num')?.textContent ?? '').replace(/[^0-9]/g, '')) || null;
    return { at: { q: at.q, r: at.r }, cam: fxcam > 0 && camReady, turn, status: (st, from) => statuses.push({ st, from }), origin: engineInView ? { x: 0, y: 0 } : { x: here.x, y: here.y }, key: `${at.q},${at.r},${engineInView ? 1 : 0}${strip && !strip.hidden ? 's' : ''}` };
  };

  // ---- the corner tag
  const tag = doc.createElement('span');
  tag.className = 'fx-demo-tag';
  const label = () => { tag.textContent = L`演出の見本`; };
  label();
  onLangChange(label);
  fx.hud?.append(tag);

  // ---- the demo's own notice stack: the HUD's status chip for a sample (never the page's state), by the demo clock
  const statuses = [];
  let stack = null, shown = null;
  function showStatus() {
    const t = clock.now();
    let cur = null;
    for (const x of statuses) if (t >= x.from) cur = x;
    if (cur === shown) return;
    shown = cur;
    if (!cur) { stack?.remove(); stack = null; return; }
    if (!stack) { stack = doc.createElement('div'); stack.className = 'feed fx-demo-feed'; stack.id = 'fx-demo-feed'; (doc.getElementById('feed')?.parentElement ?? doc.body)?.append(stack); }
    stack.innerHTML = String(renderStatus(cur.st));
  }

  // ---- one run: everything starts at clock 0
  /** The engine with every cue pushed `d` seconds later (a set piece's second act). */
  const later = d => fx.later(d);
  /** A waiting state of a sample (a ring turning, a ribbon being drawn) ends at `at` seconds: under the demo finished effects are kept, so its length is cut instead. */
  const settleAt = at => { if (!(at > 0)) return; fx.trim?.(['pending', 'route'], at); };
  let key = '', length = 1;
  function spawn() {
    const c = context();
    key = c.key;
    statuses.length = 0;
    fx.clear();
    length = 0.5;
    for (const n of names) {
      const s = SAMPLES[n];
      length = Math.max(length, s.secs);
      if (s.run) { s.run(c, fx, later); settleAt(s.settle); continue; }
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
    showStatus();
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
    seek(t) { clock.seek(t); fx.kick(); showStatus(); return state(); },
    step(dt = 1 / 60) { clock.step(dt); fx.kick(); return state(); },
    rate(n) { clock.setRate(n); return state(); },
    motion(level) { forceMotion(level ?? null); rebuild(); return state(); },
    sound: (name, opts) => audio().play(name, opts),
    state,
  };
  try { win.__fx = handle; } catch { /* a frozen window */ }
  return handle;
}

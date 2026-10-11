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
import { playToll, playResult, playBusy, playSent, playLanded, playRefused, playSealed, playMoment, playLanding, playReveal, playRecruits, TOLL_CLEAR, RESULT_GAP } from './stage.mjs';
import { hexKey } from '../map/survey.mjs';
import { hexDisc } from './effects.mjs';
import { renderStatus } from '../hud/status.mjs';
import { playLeaderDemo, LEADER_DEMO } from '../people/leader-demo.mjs';
import { stood } from './draw.mjs';
import { FS } from '../fstate.mjs';
import { hostId } from '../faddr.mjs';
import { protoApply, protoRefusal, protoSpot, protoStart, protoTail } from './proto-demo.mjs';
import { keepApply, keepStart } from './keep-demo.mjs';

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
// (`c.village`: the demo tile is the viewer's own village, as it is by default: the sample fight is staged before it, as the page's is)
const demoScene = (name, c) => { const l = locate(c.at.q, c.at.r), d = DEMO_SCENES[name](c.at); return { p: l.p, q: l.q, bell: 43, tiles: [{ idx: l.idx, hex: d.at, attackers: d.attackers, defenders: d.defenders, ...(c.village ? { village: c.village } : {}) }] }; };
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

// ---- the board after landing (UX design 14.2 to 14.4): sample RECORDS laid over the page's own (map/fmap.mjs
// setSample), so the board draws them through the same functions as real ones; the corner tag says it is a sample
const ENTRY = { faction: 0, unit: 0, state: 1, troops: 400_000, staminaValue: 120, staminaBell: 0, dealtBps: 10_000, readyBell: 0, fromBell: 0, pendBell: 0, pendOp: 0, opA: 0, opB: 0, opTroops: 0, opRef: 0 };
/** Offsets from the village (axial) the samples stand their hosts on, in order of preference. */
const SPOTS_EAST = [[3, -1], [2, 0], [3, 0], [2, -1], [1, 1], [2, 1]], SPOTS_WEST = [[1, -3], [0, -3], [2, -3], [-1, 3], [0, 3], [1, 2], [-2, 0]], SPOTS_SOUTH = [[0, 2], [1, 1], [-1, 2], [1, 2], [0, 1]];
/**
 * A sample of the viewer's own records at demo second `t`: `make(k)` → `{hosts: [{seq, unit, troops, at: [dq, dr] |
 * null (the village), state, stamina, fromBell}], marches: [{seq, dirs, depart (turns ago), arrive (turns from
 * now), open}], explore: [[dq, dr], …] | null, queue, production, tier}`. Returns the page state with those records
 * in the page's own shapes, or null while the page has no village yet. `k` = {t, home, here(dq, dr), pick(list)}.
 */
function boardState(make, t) {
  const home = (FS.holdings ?? []).find(h => Number.isInteger(h?.tile));
  const env = home ? FS.provinces.get(`${home.p},${home.q}`) : null, pv = env?.province;
  const hex = home ? tileHex(home.p, home.q, home.tile) : null;
  if (!home || !pv?.entries || !hex) return null;
  const bell = FS.nowBell ?? 42;
  const passable = idx => { try { return ((BigInt(pv.passableMask ?? 0) >> BigInt(idx)) & 1n) === 1n; } catch { return true; } };
  const taken = new Set([home.tile, ...(Array.from(pv.sites ?? [])), pv.camp?.state === 1 ? pv.camp.tile : -1]);
  const here = (dq, dr) => { const l = locate(hex.q + dq, hex.r + dr); return l.p === home.p && l.q === home.q ? l.idx : null; };
  const pick = list => { for (const [dq, dr] of list) { const i = here(dq, dr); if (i !== null && passable(i) && !taken.has(i)) return [dq, dr]; } return list[0]; };
  const d = make({ t, home, here, pick, bell });
  const idOf = seq => hostId({ p: home.p, q: home.q, site: home.site, gen: home.gen ?? 0, seq });
  // the home province with the sample's hosts in place of the viewer's own
  const mine = e => { try { return ((BigInt(e.id) >> 40n) & 0xfn) === BigInt(home.site) && Number(BigInt(e.id) >> 44n) === Number(idOf(0) >> 44n); } catch { return false; } };
  const entries = pv.entries.filter(e => !e.state || !mine(e));
  for (const h of d.hosts ?? []) {
    const idx = h.at ? here(h.at[0], h.at[1]) : home.tile;
    if (idx === null) continue;
    entries.push({ ...ENTRY, id: idOf(h.seq), unit: h.unit ?? 0, tile: idx, state: h.state ?? 1, troops: (h.troops ?? 400) * 1000, staminaValue: h.stamina ?? 120, staminaBell: bell, fromBell: h.fromBell !== undefined ? bell + h.fromBell : 0 });
  }
  const provinces = new Map(FS.provinces);
  // (a sample tier is the province's own word of the site too: the public record the board draws a village from)
  const siteMirror = d.tier !== undefined && Array.isArray(pv.siteMirror) ? pv.siteMirror.map((m, j) => (j === home.site ? { ...m, tier: d.tier } : m)) : pv.siteMirror;
  provinces.set(`${home.p},${home.q}`, { ...env, province: { ...pv, entries, siteMirror } });
  const marches = (d.marches ?? []).map(m => {
    let { q, r } = hex; for (const k of m.dirs) { q += DIRECTIONS[k][0]; r += DIRECTIONS[k][1]; }
    const l = locate(q, r), id = String(idOf(m.seq));
    return { entry: { host: id, state: m.open ? 'revealed' : 'landed', departBell: bell - (m.depart ?? 1), arriveBell: bell + (m.arrive ?? 1), route: { p: home.p, q: home.q, tile: home.tile, dirs: [...m.dirs] } }, transit: null,
      facts: { nowBell: bell, pipeline: null, slotPresent: !!m.open, settleReady: false }, dest: { p: l.p, q: l.q, tile: l.idx } };
  });
  const explore = d.explore ? { bell, p: home.p, q: home.q, tiles: d.explore.map(([dq, dr]) => here(dq, dr)).filter(i => i !== null), host: idOf(d.scout ?? 9), state: 1 } : { ...(home.explore ?? {}), state: 0 };
  const now = FS.chain?.now?.() ?? 0;
  const holding = { ...home, explore, ...(d.tier !== undefined ? { tier: d.tier } : {}), ...(d.production ? { production: d.production(home) } : {}), ...(d.queue ? { queue: d.queue(now) } : {}), ...(d.stores ? { stores: d.stores(home, now) } : {}) };
  return { ...FS, holdings: (FS.holdings ?? []).map(h => (h === home ? holding : h)), provinces, marches, nowBell: bell, own: d.tier !== undefined ? [{ p: home.p, q: home.q, tile: home.tile, tier: d.tier, state: home.state ?? null, name: null }] : undefined, key: d.key ?? '' };
}
/** A sample for the board: its records at each moment of the run (`make`), given to the map for as long as the run lasts. */
const board = (secs, make, extra = {}) => ({ secs, board: true, ...extra, run: (c, fx, later) => {
  const m = fx.map;
  if (!m?.setSample) return;
  let last = null;
  m.setSample(() => {
    const t = clock.now(), probe = boardState(make, t);
    if (!probe) return FS;
    // (the same object while nothing of the sample changes: the map reads it again only when it does)
    const sig = `${probe.key}|${FS.holdings?.length}|${FS.provinces.size}|${FS.nowBell}`;
    if (last?.sig !== sig) last = { sig, fs: probe };
    return last.fs;
  }, make);
  extra.also?.(c, fx, later);
} });
/**
 * A sample of the banner rule's prototype: `scene(k)` → the records at demo second `k.t` (fx/proto-demo.mjs
 * protoSampleModel), with the viewer's sample hosts standing where it says (`hosts: [{seq, at}]`).
 */
const proto = (secs, scene) => board(secs, k => { const S = scene(k) ?? {}; return { key: `proto-${S.key}`, hosts: [...(S.hosts ?? []).map(h => ({ seq: h.seq, troops: 600, stamina: 46, at: h.at })), { seq: 8, troops: 600, stamina: 110 }] }; },
  { proto: true, also: (c, fx) => protoStart(fx.map, t => scene({ t })) });
/** The sample march of `arrival`: out of the village to the south-west, into land that is still chart (directions: fgeo.mjs DIRECTIONS). */
const ARRIVAL_WAY = [5, 4, 4, 3, 4, 3, 4];
/** A Holding's production with `n[i]` of building i built over its tier's base (fland.mjs BUILD_ITEMS; store order Food, Wood, Stone, Ore, Horses, Gold, Science, Influence). */
const built = n => home => { const base = [40, 30, 20, 15, 0, 15, 5, 0].map(b => Math.floor((b * (100 + [0, 50, 100, 175][home.tier ?? 0])) / 100) * 1000); const add = [12, 10, 8, 6, 0, 6, 3, 0], item = [0, 1, 2, 3, -1, 4, 5, -1]; return base.map((b, i) => String(b + (item[i] >= 0 ? (n[item[i]] ?? 0) * add[i] * 1000 : 0))); };
/** A Holding's stores as they stand `secs` after their last settling. */
const grown = secs => (home, now) => (home.stores ?? []).map(a => ({ ...a, t0: String(Math.floor(now - secs)) }));
/** How long a sample that only stands is shown before the run begins again (s). */
const STANDS = 7.9;
const HOSTS_HOME = [{ seq: 7, troops: 400, stamina: 120 }, { seq: 8, troops: 600, stamina: 110 }, { seq: 9, unit: 6, troops: 100, stamina: 120 }];
/** The passable tiles of the viewer's home province (a muster may stand on any of them): `[{p, q, tile}]`. */
function homeTiles() {
  const home = (FS.holdings ?? []).find(h => Number.isInteger(h?.tile)), pv = home ? FS.provinces.get(`${home.p},${home.q}`)?.province : null;
  if (!pv) return [];
  const out = [];
  for (let i = 0; i < 61; i++) { let ok = true; try { ok = ((BigInt(pv.passableMask ?? 0) >> BigInt(i)) & 1n) === 1n; } catch { ok = true; } if (ok) out.push({ p: home.p, q: home.q, tile: i }); }
  return out;
}
const homeOf = () => { const h = (FS.holdings ?? []).find(x => Number.isInteger(x?.tile)); return h ? { p: h.p, q: h.q, tile: h.tile } : null; };

/**
 * The samples: name → {secs (how long one run lasts), cues(c) → [[effect, args, delay?]], sounds?: [[name, delay]]},
 * or {secs, run(c, fx, later)} for a set piece (the same composition the page plays, fed with the sample data above;
 * `later(seconds)` gives an engine whose every cue starts that much later).
 * `c` = {at: {q, r} (the demo tile), origin: {x, y} (the Engine when it is in view, else the demo tile)}.
 */
/**
 * A sample of the keeps (fx/keep-demo.mjs): sample RECORDS for the map's keep board, in the herald's own shapes, laid
 * at a real keep near the viewer's village. A board sample: the hosts' sample records of the run before are taken away.
 */
const keep = kind => ({ secs: STANDS, board: true, keep: true, run: (c, fx) => { fx.map?.setSample?.(null); keepStart(fx.map, kind); } });

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
  // the six leaders on six tiles by the demo tile, for the owner to judge the figures on the real board: they walk a tile, strike,
  // take a hit (people/leader-demo.mjs; the game has no leader on the map: this is the demo's alone)
  leaders: { secs: LEADER_DEMO.secs, run: (c, fx) => playLeaderDemo(fx, c, { stand: stood }) },

  // ---- after landing: the board (UX design 14.2 to 14.4), on sample records
  // hosts away from home: the first host stands three tiles out with the character at its head (it has marched: its
  // stamina ring says how many turns until the next), a Scout stands the other way (it can act: the pip); each
  // carries its pennon, and the land each watches is rimmed with a dashed line
  afield: board(STANDS, k => ({ key: 'afield', hosts: [{ seq: 7, troops: 400, stamina: 52, at: k.pick(SPOTS_EAST) }, { seq: 8, troops: 600, stamina: 110 }, { seq: 9, unit: 6, troops: 100, stamina: 120, at: k.pick(SPOTS_WEST) }] })),
  // every host at home: the character stands by its standard
  athome: board(STANDS, () => ({ key: 'athome', hosts: HOSTS_HOME })),
  // the viewer's own sealed march: the ribbon at rest, and the character's hexagon face as the marker that advances by the clock
  sealed: board(STANDS, () => ({ key: 'sealed', hosts: [{ seq: 7, troops: 400, stamina: 46, state: 3 }, { seq: 8, troops: 600, stamina: 110 }, { seq: 9, unit: 6, troops: 100 }], marches: [{ seq: 7, dirs: [0, 1, 0, 0], depart: 1, arrive: 1 }] })),
  // a second host's march beside it (not the one the character leads: a plain marker)
  'sealed-two': board(STANDS, () => ({ key: 'sealed2', hosts: [{ seq: 7, troops: 400, stamina: 46, state: 3 }, { seq: 8, troops: 600, stamina: 36, state: 3 }, { seq: 9, unit: 6, troops: 100 }], marches: [{ seq: 7, dirs: [0, 1, 0, 0], depart: 1, arrive: 1 }, { seq: 8, dirs: [3, 4, 3], depart: 0, arrive: 2 }] })),
  // arrival is the reward: the sealed march, then (1.2 s) its seal is open: the host and the character stand on the
  // destination, the chart round it dissolves to paint, 「+N マス測量」 rises, the route's tiles are surveyed
  arrival: board(7.5, k => (k.t < 1.2
    ? { key: 'arr0', hosts: [{ seq: 7, troops: 400, stamina: 46, state: 3 }, { seq: 8, troops: 600, stamina: 110 }, { seq: 9, unit: 6, troops: 100 }], marches: [{ seq: 7, dirs: ARRIVAL_WAY, depart: 2, arrive: 0 }] }
    : { key: 'arr1', hosts: [{ seq: 7, troops: 400, stamina: 46, state: 3 }, { seq: 8, troops: 600, stamina: 110 }, { seq: 9, unit: 6, troops: 100 }], marches: [{ seq: 7, dirs: ARRIVAL_WAY, depart: 2, arrive: 0, open: true }] })),
  // a muster placed on a tile: a ghost host with 「次のターンで整列」, then (2.2 s) the turn has come and it stands
  ghost: board(6, k => ({ key: k.t < 2.2 ? 'ghost0' : 'ghost1', hosts: [...HOSTS_HOME, { seq: 10, troops: 300, stamina: 120, at: k.pick(SPOTS_SOUTH), ...(k.t < 2.2 ? { state: 2, fromBell: 1 } : {}) }] })),
  // an exploration under way: surveyors' flags on its tiles
  flags: board(STANDS, k => { const at = k.pick(SPOTS_WEST); return { key: 'flags', hosts: [{ seq: 7, troops: 400 }, { seq: 8, troops: 600 }, { seq: 9, unit: 6, troops: 100, at }], explore: [[at[0] + 1, at[1]], [at[0], at[1] + 1]] }; }),
  // the character walks out with its column: three steps, fading into the march (the seal comes down at 0.6 s)
  leave: board(6, k => (k.t < 0.6
    ? { key: 'leave0', hosts: HOSTS_HOME }
    : { key: 'leave1', hosts: [{ seq: 7, troops: 400, stamina: 46, state: 3 }, { seq: 8, troops: 600, stamina: 110 }, { seq: 9, unit: 6, troops: 100 }], marches: [{ seq: 7, dirs: [0, 1, 0, 0], depart: 0, arrive: 2 }] }),
  // (the seal's own set piece beside it, as the page plays it: the stamp, the column setting off)
  { also: (c, fx, later) => { const a = march(c); playSealed(later(0.6), a); } }),
  // the village at work: a scaffold with a ring timer for every item of the queue (the first is being built, the others wait)
  scaffolds: board(STANDS, () => ({ key: 'scaffolds', hosts: HOSTS_HOME, tier: 1, queue: now => [{ doneAt: now + 1500, kind: 1, arg: 0, delta: 0 }, { doneAt: now + 8700, kind: 1, arg: 3, delta: 0 }, { doneAt: now + 15900, kind: 1, arg: 1, delta: 0 }, { doneAt: 0, kind: 0, arg: 0, delta: 0 }] })),
  // what it has built, added to its picture: farm, woodcutter, quarry, mine, market, school (one addition a kind)
  annex: board(STANDS, () => ({ key: 'annex', hosts: HOSTS_HOME, queue: () => [], production: built([2, 1, 1, 1, 1, 1]) })),
  'annex-farm-mine': board(STANDS, () => ({ key: 'annex2', hosts: HOSTS_HOME, queue: () => [], production: built([1, 0, 0, 1, 0, 0]) })),
  // sheaves on its fields: an hour's growth since the last settling
  sheaves: board(STANDS, () => ({ key: 'sheaves', hosts: HOSTS_HOME, queue: () => [], production: built([1, 0, 0, 0, 0, 0]), stores: grown(3300) })),
  // a Harvest: the sheaves fly to the resource strip, the fields are bare again (the record's clock was set anew at 0.5 s)
  'harvest-fields': board(5.5, k => ({ key: k.t < 0.5 ? 'hf0' : 'hf1', hosts: HOSTS_HOME, queue: () => [], production: built([1, 0, 0, 0, 0, 0]), stores: grown(k.t < 0.5 ? 3300 : 0) }),
    { also: (c, fx, later) => playMoment(later(0.45), { kind: 'harvest', ...tileOf(c), faction: 0, own: true, id: 'demo', site: 0 }) }),
  // a Train landed: recruits walk up the gate road into the village
  recruits: { secs: 4.6, run: (c, fx) => playRecruits(fx, { id: 'demo', tile: tileOf(c), faction: 0, unit: 0, n: 300 }) },
  // a promotion: the hamlet becomes a town (1.0 s): its land floods one ring further and its picture is the town's
  promotion: board(7, k => ({ key: k.t < 1 ? 'promo0' : 'promo1', hosts: HOSTS_HOME, queue: () => [], tier: k.t < 1 ? 0 : 1 })),
  // ---- the banner rule's PROTOTYPE (a design, not in the program): sample records in the shapes the sample world
  // serves (fx/proto-demo.mjs), drawn by the board through its own model and painters. Each is under the demo's tag
  // AND the prototype's own label.
  // land standing: the viewer's village land and a firm banner as one shape in the gold line, a nation-mate's banner,
  // another nation's banner, the nation's commons hatched
  'proto-land': proto(STANDS, () => { const E = protoSpot('east'), Sx = protoSpot('south', [E]), Wx = protoSpot('west', [E, Sx]); return { key: 'land', since: 0, hosts: [{ seq: 7, at: E }],
    banners: [{ slot: 0, at: E, tail: protoTail(E), mine: true, firm: true }, { slot: 1, at: Sx, firm: true }, { slot: 2, at: Wx, nation: 2, firm: false }] }; }),
  // a trail: the host arrived (0.8 s): its last steps are inked behind it, a pole rises, the dial counts
  'proto-trail': proto(7.5, k => { const E = protoSpot('east'), tail = protoTail(E, 3); return k.t < 0.8 ? { key: 'trail0', since: 0, hosts: [{ seq: 7, at: E }] }
    : { key: 'trail1', since: 0.8, hosts: [{ seq: 7, at: E }], trails: [{ host: 7, tiles: tail }], rising: [{ host: 7, at: E, since: 0, canAt: 1, n: 7 + tail.length, flower: true, tail }] }; }),
  // the raise: the count is done; then (1.2 s) the RAISE record: the pole drops with dust, the colour floods from the
  // tail's far end through the pole and outward, the gold line closes, the chip rises
  'proto-raise': proto(7.9, k => { const E = protoSpot('east'), tail = protoTail(E, 3); return k.t < 1.2
    ? { key: 'raise0', since: 0, hosts: [{ seq: 7, at: E }], trails: [{ host: 7, tiles: tail }], rising: [{ host: 7, at: E, since: -1, canAt: 0, n: 7 + tail.length, flower: true, tail }] }
    : { key: 'raise1', since: 1.2, hosts: [{ seq: 7, at: E }], banners: [{ slot: 0, at: E, tail, mine: true, firm: true }], events: [{ op: 'RAISE', slot: 0 }] }; }),
  // a threat: another nation's host stands on the viewer's border banner; the ember ring fills turn by turn
  'proto-threat': proto(7.9, k => { const E = protoSpot('east'), n = Math.min(7, Math.floor(k.t)); return { key: `threat${n}`, since: n, turn: n,
    banners: [{ slot: 0, at: E, tail: protoTail(E), mine: true, firm: false, border: [2], contested: { nation: 2, host: 'sample-cinder', since: -9 - n, at: 27 - n } }] }; }),
  // taken: the count ran out; (1.2 s) the banner is another nation's: the cloth is changed, the colour turns from the pole outward
  'proto-taken': proto(7.9, k => { const E = protoSpot('east'); return k.t < 1.2
    ? { key: 'taken0', since: 0, banners: [{ slot: 0, at: E, tail: protoTail(E), mine: true, firm: false, border: [2], contested: { nation: 2, host: 'sample-cinder', since: -36, at: 0 } }] }
    : { key: 'taken1', since: 1.2, banners: [{ slot: 0, at: E, tail: protoTail(E), nation: 2, firm: false }], events: [{ op: 'TAKE', slot: 0, nation: 2 }] }; }),
  // pulled down: (1.2 s) the banner is gone: the pole topples, the colour drains to the commons' hatch
  'proto-pulled': proto(7.9, k => { const E = protoSpot('east'); return k.t < 1.2
    ? { key: 'pulled0', since: 0, banners: [{ slot: 0, at: E, tail: protoTail(E), mine: true, firm: false, contested: { nation: 2, host: 'sample-cinder', since: -36, at: 0 } }] }
    : { key: 'pulled1', since: 1.2, banners: [], events: [{ op: 'PULL', slot: 0 }] }; }),
  // frayed: one banner of the viewer's is frayed (hatched, not counting), another's walk is due soon (its cloth frays)
  'proto-frayed': proto(STANDS, () => { const E = protoSpot('east'), Sx = protoSpot('south', [E]); return { key: 'frayed', since: 0,
    banners: [{ slot: 0, at: E, tail: protoTail(E), mine: true, firm: false, frayed: true, walkIn: -30, strikeIn: 42 }, { slot: 1, at: Sx, mine: true, firm: true, walkIn: 12 }] }; }),
  // choosing a place: what a banner there would bring (the preview route's answer), then (4 s) a tile where none can rise
  'proto-choose': proto(7.9, k => { const E = protoSpot('east'), N = protoSpot('north', [E]); return k.t < 4
    ? { key: 'choose0', since: 0, preview: { at: E, flower: true, tail: protoTail(E, 3), answer: { ok: true, size: 7 + protoTail(E, 3).length, price: 0, waitTurns: 1 } } }
    : { key: 'choose1', since: 4, preview: { at: N, answer: protoRefusal('NotSurveyed') } }; }),
  // another nation's claim rising on the viewer's nation's ground: a ghost banner with its dial
  'proto-ghost': proto(STANDS, () => { const Wx = protoSpot('west'); return { key: 'ghost', since: 0, rising: [{ host: 'sample-cinder', nation: 2, at: Wx, since: -3, canAt: 9, n: 7 }] }; }),
  // the viewer's own count on another nation's banner: the same ring, in gold
  'proto-take': proto(STANDS, () => { const Wx = protoSpot('west'); return { key: 'take', since: 0, hosts: [{ seq: 7, at: Wx }], banners: [{ slot: 2, at: Wx, nation: 2, firm: false, contested: { nation: 0, host: 7, since: -24, at: 12 } }] }; }),
  // picking a tile for a muster: every passable tile of the home province lit in gold-teal, the tag says what a tap does
  'pick-muster': { secs: STANDS, board: true, run: (c, fx) => { fx.map?.setSample?.(null); fx.map?.pickTile?.({ kind: 'muster', tiles: homeTiles(), origin: homeOf(), label: L`ここに集める` }); } },
  // picking a Scout's tiles: the six round it in sky blue, up to two
  // ---- the keeps of a conquest season (map/keeps.mjs): each sample lays records in the herald's own shapes at a real keep
  // near the viewer's village (fx/keep-demo.mjs), read and drawn by the board as the chain's records are. Under the demo's tag.
  // a fighting host in hand: the keeps it can reach are lit with their arrival turn, the others stay dim
  'keep-reach': keep('reach'),
  // the viewer's nation holds a keep's tile: the dial fills turn by turn, then the record says the hold was broken
  'keep-contest': keep('contest'),
  // the capture's record: the standard struck and the new one raised, the province flooding from the keep, "+1 province"
  'keep-captured': keep('captured'),
  // a province of the viewer's nation taken by another: the colour drains and turns, "−1 province"
  'keep-lost': keep('lost'),
  'pick-explore': { secs: STANDS, board: true, run: (c, fx) => { fx.map?.setSample?.(null); const h = homeOf(), hx = h ? tileHex(h.p, h.q, h.tile) : null; if (!hx) return; fx.map?.pickTile?.({ kind: 'explore', tiles: DIRECTIONS.map(([dq, dr]) => ({ q: hx.q + dq, r: hx.r + dr })), origin: h, max: 2, label: L`探索するマスを選ぶ（2つまで）` }); } },
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
    const engineInView = fx.onStage(0, 0);
    // (the resource strip appears when the page has the village's stores: a sample that flies to it is rebuilt then)
    const strip = doc.getElementById?.('res-strip');
    const turn = Number(String(doc.querySelector?.('#bell-pill .dial-num')?.textContent ?? '').replace(/[^0-9]/g, '')) || null;
    // (the demo tile is the viewer's village unless the address names another: a battle there stands before the village)
    const home = (() => { try { const l = locate(at.q, at.r); const o = (map?.source?.()?.own ?? []).find(h => h.p === l.p && h.q === l.q && h.tile === l.idx); return o ? { tier: Math.max(0, Math.min(3, Number(o.tier ?? 0))), own: true } : null; } catch { return null; } })();
    return { at: { q: at.q, r: at.r }, village: home, cam: fxcam > 0 && camReady, turn, status: (st, from) => statuses.push({ st, from }), origin: engineInView ? { x: 0, y: 0 } : { x: here.x, y: here.y }, key: `${at.q},${at.r},${engineInView ? 1 : 0}${strip && !strip.hidden ? 's' : ''}` };
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
  const settleAt = at => { if (!(at > 0)) return; fx.trim?.(['pending', 'route', 'waiting'], at); };
  let key = '', length = 1;
  function spawn() {
    const c = context();
    key = c.key;
    statuses.length = 0;
    fx.clear();
    // (the board's sample records and a pick of the run before are taken away: each run lays its own)
    try { map?.pickCancel?.(); if (!names.some(n => SAMPLES[n]?.board)) map?.setSample?.(null); } catch { /* a map without them */ }
    try { if (!names.some(n => SAMPLES[n]?.proto)) protoStart(map, null); } catch { /* a map without the prototype */ }
    try { if (!names.some(n => SAMPLES[n]?.keep)) keepStart(map, null); } catch { /* a map without keeps */ }
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
    protoApply(); keepApply();
    fx.kick();
  }
  /** Rebuild the run at the clock's present time (the demo tile moved: the village arrived, the view was dragged). */
  function rebuild() {
    const { t, frozen } = clock.state();
    clock.seek(0);
    spawn();
    clock.seek(t);
    if (!frozen) clock.play();
    protoApply(); keepApply();
    fx.kick();
  }

  clock.setRate(rate0 || 1);
  restart(fxt !== null ? fxt : rate0 === 0 ? 0 : null);

  // the demo tile follows what the map knows; a running demo loops with a short rest between runs
  win.setInterval?.(() => {
    if (!names.length) return;
    showStatus();
    protoApply(); keepApply();
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
    seek(t) { clock.seek(t); protoApply(); keepApply(); fx.kick(); showStatus(); return state(); },
    step(dt = 1 / 60) { clock.step(dt); protoApply(); keepApply(); fx.kick(); return state(); },
    rate(n) { clock.setRate(n); return state(); },
    motion(level) { forceMotion(level ?? null); rebuild(); return state(); },
    sound: (name, opts) => audio().play(name, opts),
    state,
  };
  try { win.__fx = handle; } catch { /* a frozen window */ }
  return handle;
}

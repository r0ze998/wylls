// The set pieces (UX-DESIGN §8.3): what the page shows when something real
// happens. The page only reports the event on the bus (fx/bus.mjs); this
// file decides how it looks and sounds. Nothing here invents an event: every
// function below is called with a record the page holds (or, under the demo
// switch and its corner tag, with labelled sample data).
//
//   event (who emits it)                       → what plays
//   bell {turn, home}        app ringToll       the toll: brass ripple, the banner in #bell-toll, the bell
//   feed {fresh, turn}       app tickFeed       this turn's own results in order → `turn:results`
//   turn:urgent {turn}       app ringToll       the bell chip beats once (the last 30 s)
//   battle {play, …}         app playBattle     the battle (fx/battle.mjs)
//   moment {kind, …}         app checkMoments   built, harvest, muster, arrive, camp, village, depart
//   action:busy | sent | landed | refused      controller act / sendTheMarch
//   march:sealed {…}         controller         the seal and the departure
//
// Emitted here for the HUD: `turn:results {turn, items, fresh, startsIn}`,
// `res:gain {p, q, site}` (when harvest tokens land in the resource strip).
import { L, fmtNum } from '../../lang.mjs';
import { project } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { factionName } from '../fi18n.mjs';
import { FACTION_FILL, FACTION_DARK, FACTION_LIGHT } from '../people/avatar.mjs';
import { UNIT_KINDS, routePoints } from '../people/units.mjs';
import { bus as defaultBus } from './bus.mjs';
import { TONE } from './effects.mjs';
import { installPieces, FLY_LANDS, SEAL_PX } from './pieces.mjs';
import { stageBattle } from './battle.mjs';
import { installIdle } from './idle.mjs';

const fill = f => FACTION_FILL[f] ?? TONE.brassHi;
const light = f => FACTION_LIGHT[f] ?? TONE.ivory;
const dark = f => FACTION_DARK[f] ?? TONE.brassLo;
/** A position argument for effects from an event's `{p, q, tile}` (null when it names no tile). */
const spot = a => (a && [a.p, a.q, a.tile].every(Number.isInteger) ? { p: a.p, q: a.q, tile: a.tile } : a && Number.isInteger(a.q) && Number.isInteger(a.r) && !Number.isInteger(a.p) ? { q: a.q, r: a.r } : null);
const worldOf = at => { if (!at) return null; const h = Number.isInteger(at.tile) ? tileHex(at.p, at.q, at.tile) : at; return h ? project(h.q, h.r) : null; };

/** How long the toll's banner stays (s), and the gap between two results played one after another. */
export const TOLL_BANNER_SECS = 2.9;
export const RESULT_GAP = 0.7;
/** The order this turn's own results are shown in. */
export const RESULT_ORDER = Object.freeze(['arrival', 'battle', 'incoming']);

/** What kind of own result a notification of hud/feed.mjs is (null: not one of the three shown at the turn). */
export function resultKind(x) {
  const id = String(x?.id ?? '');
  if (id.startsWith('rv:')) return 'arrival';
  if (x?.kind === 'battle') return 'battle';
  if (x?.kind === 'incoming') return 'incoming';
  return null;
}
/** Own results in the order they are shown: arrivals, then battles, then warnings; otherwise as they came. */
export function orderResults(list) {
  return list.map((x, i) => ({ x, i, k: RESULT_ORDER.indexOf(x.result) })).sort((a, b) => a.k - b.k || a.i - b.i).map(o => o.x);
}

// ------------------------------------------------------------------ the compositions
/** The bell tolls: `{turn, home: {p, q, tile} | null}`. */
export function playToll(fx, { turn, home = null } = {}) {
  const e = fx.toScreen(0, 0), sz = fx.size();
  const engineInView = e.x >= 0 && e.y >= 0 && e.x <= sz.width && e.y <= sz.height;
  const h = worldOf(home), v = fx.view();
  // from the Engine when it is in view; else from the viewer's own village; else from the middle of what is looked at
  const o = engineInView ? { x: 0, y: 0 } : h ?? { x: v.x, y: v.y };
  const seed = `bell|${turn}`;
  fx.play('toll', { ...o, seed });
  fx.play('chip', { el: '#bell-chip', delay: 0.2, seed });
  fx.play('banner', { title: L`鐘が鳴りました — ターン ${fmtNum(turn)}`, into: fx.doc?.getElementById?.('bell-toll') ?? '#bell-toll', y: 0.2, dur: TOLL_BANNER_SECS, delay: 0.3, seed });
  fx.sound('bell', { delay: 0.2, seed });
}

/** One own result on the map: `{result: 'arrival' | 'battle' | 'incoming', p, q, tile, faction}`. */
export function playResult(fx, x, delay = 0) {
  const at = spot(x) ?? (Number.isInteger(x.p) && Number.isInteger(x.q) ? { p: x.p, q: x.q, tile: 0 } : null);
  if (!at) return;
  const seed = `result|${x.id ?? `${x.p},${x.q}`}`;
  if (x.result === 'arrival') {
    fx.play('unseal', { ...at, color: fill(x.faction), delay, seed });
    fx.play('ripple', { ...at, color: light(x.faction), radius: 2, delay: delay + 0.3, seed });
    fx.play('label', { ...at, text: L`開封されました`, color: TONE.ivory, size: 21, lift: 1.25, delay: delay + 0.34, seed });
    fx.sound('shimmer', { delay: delay + 0.3, seed });
  } else if (x.result === 'battle') {
    fx.play('swords', { ...at, delay, seed });
    fx.play('ripple', { ...at, color: '#ffb09a', radius: 1.8, delay: delay + 0.14, seed });
    fx.sound('clash', { delay: delay + 0.14, seed });
  } else if (x.result === 'incoming') {
    fx.play('alarm', { ...at, delay, seed });
    fx.play('label', { ...at, text: L`来襲の恐れ`, color: '#ffb09a', size: 22, lift: 0.95, delay: delay + 0.3, seed });
    fx.sound('drum', { delay, seed });
  }
}

/** An own action is on its way: a ring turns on its tile (and, for a march, the route draws on). Returns what to cancel. */
export function playBusy(fx, a) {
  const at = spot(a.tile), handles = [];
  const seed = `act|${a.id}`;
  if (a.name === 'Depart' && (a.route || a.dest)) {
    const from = worldOf(at), to = worldOf(a.dest);
    const points = routePoints(a.route, from && to ? { from, to } : null);
    if (points.length > 1) { handles.push(...fx.play('route', { points, color: fill(a.faction), seed })); a.points = points; }
  }
  if (at) handles.push(...fx.play('pending', { ...at, color: light(a.faction), seed }));
  return handles;
}
/** It left this browser. */
export function playSent(fx, a) {
  const at = spot(a.tile);
  if (at) fx.play('ripple', { ...at, color: TONE.brassHi, radius: 1.3, layer: 'top', seed: `sent|${a.id}` });
}
/** It is on the chain: a burst in the nation's colour on its tile, and a sound. */
export function playLanded(fx, a) {
  const at = spot(a.tile), seed = `landed|${a.id}`;
  fx.sound('confirm', { seed });
  if (!at) return;
  fx.play('flash', { ...at, color: fill(a.faction), seed });
  fx.play('ripple', { ...at, color: light(a.faction), radius: 2.1, delay: 0.07, seed });
  fx.play('burst', { ...at, kind: 'spark', n: 20, height: 0.3, power: 0.85, delay: 0.08, seed, colors: [light(a.faction), fill(a.faction), '#fff6dc'] });
  fx.play('mark', { ...at, kind: 'ok', color: fill(a.faction), delay: 0.1, seed });
  fx.play('pip', { ...at, color: fill(a.faction), seed });
}
/** It was refused: the tile beats red. */
export function playRefused(fx, a) {
  const at = spot(a.tile), seed = `refused|${a.id}`;
  fx.sound('refuse', { seed });
  if (!at) return;
  fx.play('pulse', { ...at, color: TONE.ember, seed });
  fx.play('mark', { ...at, kind: 'no', color: TONE.ember, delay: 0.05, seed });
  fx.play('pip', { ...at, color: TONE.ember, seed });
  fx.shake(2.5, 130, { seed });
}

/**
 * An own march was sealed and has left: `{id, tile (origin), dest, route,
 * points?, faction, unit}`. The seal stamps on the far end of its ribbon,
 * dust rises at the origin, the column sets off; the ribbon stays, sealed,
 * for this viewer only. Returns the handle of the resting ribbon.
 */
export function playSealed(fx, a) {
  const at = spot(a.tile), seed = `sealed|${a.id}`;
  const from = worldOf(at), to = worldOf(a.dest);
  const points = a.points ?? routePoints(a.route, from && to ? { from, to } : null);
  if (!points || points.length < 2) { if (at) { fx.play('stamp', { ...at, lift: 0.5, seed }); fx.sound('seal', { delay: 0.16, seed }); } return []; }
  const end = points[points.length - 1], color = fill(a.faction);
  const caption = L`封印済み · あなたにだけ見えます`;
  // the ribbon is already there (drawn while the order was sealed); it flashes as the seal comes down on its end
  const rest = fx.play('sealed', { points, color, caption, captionAfter: 2.5, seed });
  fx.play('route', { points, color, dur: 0.6, drawn: true, seed: `${seed}|flash` });
  fx.play('stamp', { x: end.x, y: end.y, size: SEAL_PX, caption, hold: 2.2, rest: 0.5, seed });
  fx.sound('seal', { delay: 0.16, seed });
  fx.play('walker', { points, kind: UNIT_KINDS[a.unit ?? 0] ?? 'spearman', faction: a.faction ?? 0, delay: 0.42, seed });
  fx.play('pip', { x: points[0].x, y: points[0].y, color, seed });
  return rest;
}

const MOMENT_LABEL = {
  built: m => (m.label ? L`${m.label}が完成` : L`建物が完成`),
  muster: () => L`軍勢を編成`,
  arrive: () => L`到着`,
  camp: () => L`野営地がなくなった`,
  depart: () => L`出発`,
  village: m => (Number.isInteger(m.to) && m.to < 6 ? (m.from === null || m.from === undefined ? L`${factionName(m.to)}の新しい村` : L`${factionName(m.to)}の村になった`) : L`村がなくなった`),
};

/**
 * A moment of the map (people/moments.mjs): `{kind, p, q, tile, …}` with
 * `own` true for the viewer's own village or host. Each has a form readable
 * at the default zoom and a pip for the far view.
 */
export function playMoment(fx, m, { bus = defaultBus } = {}) {
  const at = spot(m);
  if (!at) return;
  const seed = `moment|${m.kind}|${m.p},${m.q},${m.tile}|${m.id ?? ''}`;
  const label = (text, color, extra = {}) => fx.play('label', { ...at, text, color, size: 21, lift: 1.3, dur: 1.9, delay: 0.25, seed, ...extra });
  switch (m.kind) {
    case 'built':
      fx.play('flash', { ...at, color: TONE.brassHi, seed });
      fx.play('pillar', { ...at, delay: 0.07, seed });
      fx.play('dust', { ...at, power: 1.15, delay: 0.08, seed });
      fx.play('burst', { ...at, kind: 'coin', n: 18, height: 1.0, radius: 0.25, power: 0.9, delay: 0.12, seed });
      fx.play('burst', { ...at, kind: 'spark', n: 10, height: 0.9, power: 0.6, delay: 0.1, seed: `${seed}|s`, colors: ['#fff6dc', TONE.brassHi, TONE.brass] });
      label(MOMENT_LABEL.built(m), TONE.brassHi);
      fx.play('pip', { ...at, color: TONE.brassHi, seed });
      if (m.own) fx.sound('confirm', { delay: 0.08, seed });
      break;
    case 'harvest': {
      fx.play('flash', { ...at, color: '#e8c35a', seed });
      fx.play('burst', { ...at, kind: 'leaf', n: 26, height: 0.4, radius: 0.55, power: 1.5, size: 1.7, life: 0.9, delay: 0.07, seed });
      fx.play('burst', { ...at, kind: 'spark', n: 10, height: 0.4, power: 0.6, delay: 0.08, seed: `${seed}|s`, colors: ['#fff6dc', '#f0d48a', '#e8c35a'] });
      fx.play('ripple', { ...at, color: '#e8c35a', radius: 1.7, delay: 0.07, seed });
      fx.play('pip', { ...at, color: '#e0bd52', seed });
      if (!m.own) break;
      const gain = () => bus.emit('res:gain', { p: m.p, q: m.q, site: m.site ?? null, tile: m.tile });
      const flown = fx.play('fly', { ...at, to: m.to ?? '#res-strip', n: 6, delay: 0.16, seed });
      if (flown.length) {
        fx.play('chip', { el: m.to ?? '#res-strip', color: TONE.brassHi, fill: 0.3, delay: 0.16 + FLY_LANDS, seed });
        // the strip counts up as the first token lands (a zero-size effect is the timer: it follows the effects clock)
        fx.add({ name: 'res-gain', layer: 'top', dur: 0.16 + FLY_LANDS, info: true, draw() {}, onEnd: gain });
        fx.sound('tick', { delay: 0.16 + FLY_LANDS, seed });
      } else gain();
      break;
    }
    case 'muster':
      fx.play('glow', { ...at, radius: 0, color: fill(m.faction), hold: 1.0, seed });
      fx.play('forming', { ...at, kind: UNIT_KINDS[m.unit ?? 0] ?? 'spearman', faction: m.faction ?? 0, n: m.n ?? 5, seed });
      label(MOMENT_LABEL.muster(m), light(m.faction), { delay: 0.5 });
      fx.play('pip', { ...at, color: fill(m.faction), seed });
      if (m.own) fx.sound('drum', { delay: 0.4, seed, level: 0.6 });
      break;
    case 'arrive':
      fx.play('burst', { ...at, kind: 'mist', n: 12, radius: 0.45, power: 1.4, life: 0.6, seed });
      fx.play('flash', { ...at, color: TONE.ivory, delay: 0.12, seed });
      fx.play('ripple', { ...at, color: light(m.faction), radius: 1.8, delay: 0.18, seed });
      label(MOMENT_LABEL.arrive(m), TONE.ivory, { delay: 0.3 });
      fx.play('pip', { ...at, color: TONE.ivory, seed });
      break;
    case 'camp':
      fx.play('dust', { ...at, power: 1.2, seed });
      fx.play('burst', { ...at, kind: 'smoke', n: 16, height: 0.3, radius: 0.35, stagger: 0.7, seed });
      label(MOMENT_LABEL.camp(m), TONE.ivory);
      fx.play('pip', { ...at, color: '#d8cfb8', seed });
      break;
    case 'village': {
      const to = Number.isInteger(m.to) && m.to < 6 ? m.to : null;
      if (to !== null) {
        fx.play('glow', { ...at, radius: 1, color: fill(to), hold: 1.5, seed });
        fx.play('flash', { ...at, color: light(to), seed });
        fx.play('raise', { ...at, fill: fill(to), dark: dark(to), delay: 0.1, seed });
      } else {
        fx.play('pulse', { ...at, color: '#d8cfb8', beats: 1, seed });
        fx.play('burst', { ...at, kind: 'smoke', n: 12, height: 0.3, radius: 0.3, stagger: 0.6, seed });
      }
      fx.play('dust', { ...at, power: 1, delay: 0.1, seed });
      label(MOMENT_LABEL.village(m), to !== null ? light(to) : TONE.ivory, { delay: 0.45, serif: true, size: 23 });
      fx.play('pip', { ...at, color: to !== null ? fill(to) : '#d8cfb8', seed });
      if (m.own) fx.sound('drum', { delay: 0.1, seed, level: 0.7 });
      break;
    }
    case 'depart':
      // another nation's host (or an own one seen leaving): that it left, and from where; never a heading
      fx.play('dust', { ...at, power: 0.9, seed });
      fx.play('stamp', { ...at, size: 40, lift: 0.5, hold: 1.1, rest: 0.6, shake: 0, delay: 0.1, seed });
      label(MOMENT_LABEL.depart(m), TONE.ivory, { delay: 0.4, lift: 1.5 });
      fx.play('pip', { ...at, color: '#d2533c', seed });
      break;
    default: break;
  }
}

// ------------------------------------------------------------------ wiring
/**
 * Install the set pieces on an engine and subscribe them to the bus.
 * Returns `{off()}`. Idempotent per engine.
 */
export function installStage(fx, { bus = defaultBus } = {}) {
  if (fx.staged) return fx.staged;
  installPieces(fx);
  installIdle(fx);
  const offs = [];
  const on = (type, fn) => offs.push(bus.on(type, p => { if (fx.mounted) fn(p ?? {}); }));

  // ---- the bell and the turn's own results
  let turn = null, results = [], tollEnds = -Infinity;
  const resting = new Set();   // sealed ribbons at rest: they go at the turn
  on('bell', p => {
    for (const h of resting) h.cancel?.();
    resting.clear();
    turn = p.turn ?? null; results = [];
    playToll(fx, p);
    tollEnds = fx.clock.now() + 0.3 + TOLL_BANNER_SECS - 0.9;
  });
  on('feed', p => {
    const fresh = (p.fresh ?? []).map(x => ({ ...x, result: resultKind(x) })).filter(x => x.result && !results.some(r => r.id === x.id));
    if (!fresh.length) return;
    if (p.turn !== undefined && p.turn !== turn) { turn = p.turn; results = []; }
    const ordered = orderResults(fresh);
    const wait = Math.max(0, tollEnds - fx.clock.now());
    ordered.forEach((x, i) => {
      playResult(fx, x, wait + i * RESULT_GAP);
      if (x.result === 'arrival' && Number.isInteger(x.tile)) recent.set(`arrive|${x.p},${x.q},${x.tile}`, fx.clock.now() + wait + i * RESULT_GAP);
    });
    results = orderResults([...results, ...ordered]);
    const pub = x => ({ id: x.id, kind: x.result, p: x.p, q: x.q, tile: x.tile ?? null, text: x.text ?? '', battle: x.battle ?? null });
    bus.emit('turn:results', { turn, items: results.map(pub), fresh: ordered.map(pub), startsIn: wait, gap: RESULT_GAP });
  });
  on('turn:urgent', () => {
    fx.play('chip', { el: '#bell-chip', color: TONE.ember, fill: 0.4, seed: `urgent|${turn}` });
    fx.sound('tick', { seed: 'urgent' });
  });

  // ---- battles
  on('battle', p => { if (p.play) stageBattle(fx, p.play, p); });

  // ---- moments (at most a handful at once: the viewer's own first)
  const recent = new Map();   // "kind|p,q,tile" → clock time: one thing is not announced twice
  on('moment', m => {
    const key = `${m.kind}|${m.p},${m.q},${m.tile}`, now = fx.clock.now();
    for (const [k, t] of recent) if (now - t > 30) recent.delete(k);
    if (recent.has(key) && now - recent.get(key) < 8) return;
    recent.set(key, now);
    playMoment(fx, m, { bus });
  });

  // ---- own actions
  const pendingActs = new Map();   // id → {handles, a}
  const settle = id => { const rec = pendingActs.get(id); pendingActs.delete(id); for (const h of rec?.handles ?? []) h.cancel?.(); return rec; };
  on('action:busy', a => { settle(a.id); pendingActs.set(a.id, { handles: playBusy(fx, a), a }); });
  on('action:sent', a => playSent(fx, a));
  on('action:landed', a => { const rec = settle(a.id); if (a.name !== 'Depart') playLanded(fx, { ...rec?.a, ...a }); });
  on('action:refused', a => { const rec = settle(a.id); playRefused(fx, { ...rec?.a, ...a }); });
  on('march:sealed', a => {
    const rec = settle(a.id);
    const at = spot(a.tile);
    if (at) recent.set(`depart|${at.p},${at.q},${at.tile}`, fx.clock.now());
    for (const h of playSealed(fx, { ...rec?.a, ...a })) resting.add(h);
  });

  fx.staged = { off() { offs.forEach(f => f()); fx.staged = null; } };
  return fx.staged;
}

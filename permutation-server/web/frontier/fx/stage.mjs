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
//   landing {p, q, tile, …}  map/fmap.mjs       a village lands: dust and sparks under the standard, its name
//   tiles:lit {origin, tiles} map/fmap.mjs      the engine's glow runs over the tiles a selected host can act on
//   reveal {n}               app surveyNow      land comes out of the chart: a shimmer
//
// Emitted here for the HUD: `turn:results {turn, items, fresh, startsIn}`,
// `res:gain {p, q, site}` (when harvest tokens land in the resource strip).
import { L, fmtNum, onLangChange } from '../../lang.mjs';
import { project } from '../../map.mjs';
import { tileHex, hexDistance, locate } from '../fgeo.mjs';
import { keyHex } from '../map/survey.mjs';
import { factionName } from '../fi18n.mjs';
import { FACTION_FILL, FACTION_DARK, FACTION_LIGHT } from '../people/avatar.mjs';
import { UNIT_KINDS, routePoints } from '../people/units.mjs';
import { bus as defaultBus } from './bus.mjs';
import { TONE, bannerGone } from './effects.mjs';
import { installPieces, FLY_LANDS, SEAL_PX, COLUMN_SECS, FORMING_SECS } from './pieces.mjs';
import { stageBattle } from './battle.mjs';
import { installIdle } from './idle.mjs';

const fill = f => FACTION_FILL[f] ?? TONE.brassHi;
const light = f => FACTION_LIGHT[f] ?? TONE.ivory;
const dark = f => FACTION_DARK[f] ?? TONE.brassLo;
/** A position argument for effects from an event's `{p, q, tile}` (null when it names no tile). */
const spot = a => (a && [a.p, a.q, a.tile].every(Number.isInteger) ? { p: a.p, q: a.q, tile: a.tile } : a && Number.isInteger(a.q) && Number.isInteger(a.r) && !Number.isInteger(a.p) ? { q: a.q, r: a.r } : null);
const worldOf = at => { if (!at) return null; const h = Number.isInteger(at.tile) ? tileHex(at.p, at.q, at.tile) : at; return h ? project(h.q, h.r) : null; };

/** When the toll's banner comes after the stroke and how long it stays (s), and the gap between two results played one after another. */
export const TOLL_BANNER_AT = 0.3;
export const TOLL_BANNER_SECS = 2.6;
export const RESULT_GAP = 0.7;
/** Seconds after the stroke at which the banner has faded under a tenth of its opacity: this turn's results and their card wait for it (UX-DESIGN §11.14). */
export const TOLL_CLEAR = TOLL_BANNER_AT + bannerGone(TOLL_BANNER_SECS);
/** How many moments of other people play in full within one beat (the viewer's own always do). */
export const MOMENTS_AT_ONCE = 8;
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
  const engineInView = fx.onStage(0, 0);
  const h = worldOf(home), v = fx.view();
  // from the Engine when it is in view; else from the viewer's own village; else from the middle of what is looked at
  const o = engineInView ? { x: 0, y: 0 } : h ?? { x: v.x, y: v.y };
  const seed = `bell|${turn}`;
  fx.play('toll', { ...o, seed });
  fx.play('chip', { el: '#bell-chip', delay: 0.2, seed });
  // under the dial, at the top of the stage the HUD leaves free (a phone: between its two columns of buttons, on two lines)
  fx.play('banner', { title: L`鐘が鳴りました — ターン ${fmtNum(turn)}`, into: fx.doc?.getElementById?.('bell-toll') ?? '#bell-toll', y: 0, dur: TOLL_BANNER_SECS, delay: TOLL_BANNER_AT, seed });
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
    fx.play('tag', { ...at, text: L`開封されました`, icon: 'seal', color: fill(x.faction), delay: delay + 0.34, dur: 1.9, seed });
    fx.hush(at, 2.3, delay);
    fx.sound('shimmer', { delay: delay + 0.3, seed });
  } else if (x.result === 'battle') {
    fx.play('swords', { ...at, delay, seed });
    fx.play('ripple', { ...at, color: '#ffb09a', radius: 1.8, delay: delay + 0.14, seed });
    fx.sound('clash', { delay: delay + 0.14, seed });
  } else if (x.result === 'incoming') {
    fx.play('alarm', { ...at, delay, seed });
    fx.play('tag', { ...at, text: L`来襲の恐れ`, icon: 'alert', tone: 'ember', delay: delay + 0.3, dur: 1.9, seed });
    fx.hush(at, 2.3, delay);
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
  if (at) {
    // a ring turns round the tile, and a small tag over it says what is happening, on the map (the HUD's chip stands
    // across the screen; the second review: "a small ring plus a chip 650 px away")
    handles.push(...fx.play('pending', { ...at, radius: a.radius ?? 1.45, seed }));
    handles.push(...fx.play('waiting', { ...at, text: L`送信中…`, icon: 'hourglass', tone: 'brass', lift: 3.05, dur: 75, seed }));
  }
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
  fx.hush(at, 1.6);
}
/** It was refused: the tile beats red. */
export function playRefused(fx, a) {
  const at = spot(a.tile), seed = `refused|${a.id}`;
  fx.sound('refuse', { seed });
  if (!at) return;
  fx.play('pulse', { ...at, color: TONE.ember, seed });
  // an ember ring with a bar on a chip of bell metal, beside the village (its plate stays: the mark is not in its
  // place), and the word for it on a tag
  fx.play('mark', { ...at, kind: 'no', color: TONE.ember, delay: 0.05, size: 19, lift: 0.5, side: 1.7, seed });
  fx.play('tag', { ...at, text: L`送られていません`, icon: 'alert', tone: 'ember', lift: 3.05, dur: 2.2, delay: 0.1, seed });
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
  if (!points || points.length < 2) { if (at) { fx.play('stamp', { ...at, lift: 0.5, seed }); fx.play('tag', { ...at, text: L`封印済み`, icon: 'seal', tone: 'ember', delay: 0.4, seed }); fx.sound('seal', { delay: 0.16, seed }); } return []; }
  const end = points[points.length - 1], color = fill(a.faction);
  const caption = L`封印済み · あなたにだけ見えます`;
  // the ribbon is already there (drawn while the order was sealed); a glint crosses it as the seal comes down on its end
  const rest = fx.play('sealed', { points, color, caption, captionAfter: 0.75, seed });
  fx.play('route', { points, color, dur: 0.6, drawn: true, seed: `${seed}|flash` });
  fx.play('stamp', { x: end.x, y: end.y, size: SEAL_PX, hold: 1.7, rest: 0.54, seed });
  fx.sound('seal', { delay: 0.16, seed });
  // the column sets off: out of the village, along the ribbon, for everyone at the table to see (every motion level)
  fx.play('walker', { points, kind: UNIT_KINDS[a.unit ?? 0] ?? 'spearman', faction: a.faction ?? 0, delay: 0.42, seed });
  fx.play('pip', { x: points[0].x, y: points[0].y, color, seed });
  if (at) fx.hush(at, 0.42 + COLUMN_SECS);
  return rest;
}

/**
 * A village lands (map/fmap.mjs tellLanding; UX-DESIGN §5.1): `{p, q, tile, faction, name, maxD, flood, impact
 * (seconds on the map's own timeline), standard: {x, y}}`. The map floods the land ring by ring and drops the
 * standard; here the flood's crest runs out as rings, and where the standard comes down the ground answers:
 * dust, gold sparks, a short shake, the thud, and the village's name.
 */
export function playLanding(fx, a) {
  const at = spot(a);
  if (!at) return;
  const seed = `landing|${a.p},${a.q},${a.tile}`, t = a.impact ?? 1.2, s = a.standard ?? worldOf(at);
  fx.sound('shimmer', { delay: a.flood ?? 0.12, seed });
  fx.play('ripple', { ...at, color: light(a.faction), radius: (a.maxD ?? 1) + 0.8, delay: a.flood ?? 0.12, seed });
  fx.play('dust', { x: s.x, y: s.y, power: 1.15, delay: t, seed });
  fx.play('burst', { x: s.x, y: s.y, kind: 'spark', n: 24, height: 0.35, power: 0.95, delay: t, seed, colors: ['#fff6dc', TONE.you, fill(a.faction)] });
  fx.play('ripple', { x: s.x, y: s.y, color: TONE.you, radius: 1.5, delay: t + 0.02, seed: `${seed}|foot` });
  fx.shake(3, 170, { delay: t, seed });
  fx.sound('seal', { delay: t, seed });
  fx.sound('drum', { delay: t + 0.03, seed, level: 0.55 });
  // the village's name, in the viewer's gold (it is theirs): the one word of the moment, shown in every motion level
  // (on a bell-metal tag, like every word of the map: bare translucent letters over the village read as a glitch)
  if (a.name) fx.play('tag', { ...at, text: a.name, icon: 'home', tone: 'gold', lift: 3.05, dur: 3.0, delay: fx.motionLevel() === 'full' ? t + 0.3 : 0, seed });
  fx.play('pip', { ...at, color: TONE.you, delay: t, seed });
  // the village's own labels make way until its name has been read
  fx.hush(at, t + 3.0);
}

/**
 * Tiles lit for a selected host (map/fmap.mjs; UX-DESIGN §5.2): `{origin: {q, r}, tiles: [{q, r, kind}],
 * colours: {kind: [r, g, b]}}`. The engine's glow runs over them from the host outward as they roll out, kind
 * by kind in its own colour, and lets go; the light that stays is the map's.
 */
export function playLit(fx, a) {
  const byKind = new Map();
  for (const t of a.tiles ?? []) { if (!byKind.has(t.kind)) byKind.set(t.kind, []); byKind.get(t.kind).push({ q: t.q, r: t.r }); }
  const hex = c => (Array.isArray(c) ? `#${c.map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}` : TONE.reach);
  for (const [kind, tiles] of byKind) fx.play('glow', { tiles, origin: a.origin, color: hex(a.colours?.[kind]), hold: 0.5, gain: 0.5, seed: `lit|${kind}|${a.origin?.q},${a.origin?.r}` });
  fx.sound('tick', { seed: 'lit' });
}

const MOMENT_LABEL = {
  built: m => (m.label ? L`${m.label}が完成` : L`建物が完成`),
  muster: () => L`軍勢を編成`,
  arrive: () => L`到着`,
  camp: () => L`野営地がなくなった`,
  depart: () => L`出発`,
  village: m => (Number.isInteger(m.to) && m.to < 6 ? (m.from === null || m.from === undefined ? L`${factionName(m.to)}の新しい村` : L`${factionName(m.to)}の村になった`) : L`村がなくなった`),
};
/** The icon of a moment's caption (the HUD's sprite, hud/icons.mjs). */
const MOMENT_ICON = Object.freeze({ built: 'hammer', muster: 'banner', arrive: 'flag', camp: 'tent', depart: 'seal', village: 'home' });

/**
 * A moment of the map (people/moments.mjs): `{kind, p, q, tile, …}` with
 * `own` true for the viewer's own village or host. Each is as large as the
 * tile and its neighbours (readable at the hero zoom), has its caption on a
 * tag above the tile (the tile's own labels make way while it plays: `fx.hush`)
 * and a pip for the far view.
 */
export function playMoment(fx, m, { bus = defaultBus } = {}) {
  const at = spot(m);
  if (!at) return;
  const seed = `moment|${m.kind}|${m.p},${m.q},${m.tile}|${m.id ?? ''}`;
  // the caption: over the tile, above whatever stands on it
  const caption = (text, extra = {}) => {
    const delay = extra.delay ?? 0.25, dur = extra.dur ?? 2.1;
    fx.play('tag', { ...at, text, icon: MOMENT_ICON[m.kind], lift: 1.5, seed, ...extra, delay, dur });
    fx.hush(at, delay + dur + 0.1);
  };
  switch (m.kind) {
    case 'built':
      // the tile and the land round it catch the light of the work finished: a shaft, a wide ring, a shower of brass
      fx.play('flash', { ...at, color: TONE.brassHi, seed });
      fx.play('glow', { ...at, radius: 1, color: TONE.brassHi, hold: 0.9, gain: 0.55, delay: 0.06, seed });
      fx.play('pillar', { ...at, delay: 0.07, seed });
      fx.play('ripple', { ...at, color: TONE.brassHi, radius: 2.3, delay: 0.08, seed });
      fx.play('dust', { ...at, power: 1.2, ring: m.own === false ? 0.6 : 1.0, delay: 0.08, seed });
      fx.play('burst', { ...at, kind: 'coin', n: 28, height: 1.2, radius: 0.4, power: 1.25, up: 1.15, delay: 0.12, seed });
      fx.play('burst', { ...at, kind: 'spark', n: 16, height: 1.1, power: 0.85, delay: 0.1, seed: `${seed}|s`, colors: ['#fff6dc', TONE.brassHi, TONE.brass] });
      caption(MOMENT_LABEL.built(m), { tone: 'gold' });
      fx.play('pip', { ...at, color: TONE.brassHi, seed });
      if (m.own) fx.sound('confirm', { delay: 0.08, seed });
      break;
    case 'harvest': {
      fx.play('flash', { ...at, color: '#e8c35a', seed });
      fx.play('burst', { ...at, kind: 'leaf', n: 34, height: 0.4, radius: 0.8, power: 1.7, size: 1.9, life: 0.95, delay: 0.07, seed });
      fx.play('burst', { ...at, kind: 'spark', n: 12, height: 0.4, power: 0.7, delay: 0.08, seed: `${seed}|s`, colors: ['#fff6dc', '#f0d48a', '#e8c35a'] });
      fx.play('ripple', { ...at, color: '#e8c35a', radius: 2.1, delay: 0.07, seed });
      fx.play('pip', { ...at, color: '#e0bd52', seed });
      if (!m.own) break;
      fx.hush(at, 1.4);
      // where nothing may fly (reduced motion, effects off) a word says it instead of the tokens
      if (fx.motionLevel() !== 'full') caption(L`収穫しました`, { icon: 'grain', tone: 'gold', delay: 0, dur: 1.8 });
      const gain = () => bus.emit('res:gain', { p: m.p, q: m.q, site: m.site ?? null, tile: m.tile });
      const flown = fx.play('fly', { ...at, to: m.to ?? '#res-strip', n: 8, delay: 0.16, seed });
      if (flown.length) {
        fx.play('chip', { el: m.to ?? '#res-strip', color: TONE.brassHi, fill: 0.3, delay: 0.16 + FLY_LANDS, seed });
        // the strip counts up as the first token lands (a zero-size effect is the timer: it follows the effects clock)
        fx.add({ name: 'res-gain', layer: 'top', dur: 0.16 + FLY_LANDS, info: true, draw() {}, onEnd: gain });
        fx.sound('tick', { delay: 0.16 + FLY_LANDS, seed });
      } else gain();
      break;
    }
    case 'muster':
      fx.play('glow', { ...at, radius: 0, color: fill(m.faction), hold: 1.2, seed });
      fx.play('ripple', { ...at, color: light(m.faction), radius: 1.8, delay: 0.5, seed });
      fx.play('forming', { ...at, kind: UNIT_KINDS[m.unit ?? 0] ?? 'spearman', faction: m.faction ?? 0, n: m.n ?? 7, seed });
      caption(MOMENT_LABEL.muster(m), { color: fill(m.faction), delay: 0.55, dur: FORMING_SECS - 0.55 });
      fx.play('pip', { ...at, color: fill(m.faction), seed });
      if (m.own) fx.sound('drum', { delay: 0.5, seed, level: 0.6 });
      break;
    case 'arrive':
      fx.play('burst', { ...at, kind: 'mist', n: 12, radius: 0.45, power: 1.4, life: 0.6, seed });
      fx.play('flash', { ...at, color: TONE.ivory, delay: 0.12, seed });
      fx.play('ripple', { ...at, color: light(m.faction), radius: 1.8, delay: 0.18, seed });
      caption(MOMENT_LABEL.arrive(m), { color: fill(m.faction), delay: 0.3, dur: 1.7 });
      fx.play('pip', { ...at, color: TONE.ivory, seed });
      break;
    case 'camp':
      // it is gone, not burnt (fire is only for a camp a clash destroyed): its dust settles, a little smoke, cloth and poles thrown clear
      fx.play('pulse', { ...at, color: '#d8cfb8', beats: 1, seed });
      fx.play('dust', { ...at, power: 1.5, seed });
      fx.play('burst', { ...at, kind: 'shard', n: 14, height: 0.2, radius: 0.3, power: 0.9, up: 0.9, seed: `${seed}|bits`, colors: ['#8a7a5c', '#4a3626', '#c9b98f'] });
      fx.play('burst', { ...at, kind: 'smoke', n: 18, height: 0.3, radius: 0.4, stagger: 0.8, seed });
      fx.play('ripple', { ...at, color: '#e9dfc6', radius: 1.9, delay: 0.1, seed });
      caption(MOMENT_LABEL.camp(m), { tone: 'ivory' });
      fx.play('pip', { ...at, color: '#d8cfb8', seed });
      break;
    case 'village': {
      const to = Number.isInteger(m.to) && m.to < 6 ? m.to : null;
      if (to !== null) {
        fx.play('glow', { ...at, radius: 1, color: fill(to), hold: 1.6, seed });
        fx.play('flash', { ...at, color: light(to), seed });
        fx.play('ripple', { ...at, color: light(to), radius: 2.6, delay: 0.12, seed });
        fx.play('raise', { ...at, fill: fill(to), dark: dark(to), delay: 0.1, seed });
      } else {
        fx.play('pulse', { ...at, color: '#d8cfb8', beats: 1, seed });
        fx.play('burst', { ...at, kind: 'smoke', n: 14, height: 0.3, radius: 0.35, stagger: 0.6, seed });
      }
      fx.play('dust', { ...at, power: 1.2, delay: 0.1, seed });
      caption(MOMENT_LABEL.village(m), { ...(to !== null ? { color: fill(to), icon: 'banner' } : { tone: 'ivory' }), delay: 0.45, dur: 2.3, lift: to !== null ? 2.95 : 1.5 });
      fx.play('pip', { ...at, color: to !== null ? fill(to) : '#d8cfb8', seed });
      if (m.own) fx.sound('drum', { delay: 0.1, seed, level: 0.7 });
      break;
    }
    case 'depart':
      // another nation's host (or an own one seen leaving): that it left, and from where; never a heading
      fx.play('dust', { ...at, power: 0.7, seed });
      fx.play('stamp', { ...at, size: 40, lift: 0.5, hold: 1.1, rest: 0.6, shake: 0, delay: 0.24, seed });
      caption(MOMENT_LABEL.depart(m), { tone: 'ember', delay: 0.55, dur: 1.5 });
      fx.play('pip', { ...at, color: '#d2533c', seed });
      break;
    default: break;
  }
}

/**
 * Land comes out of the chart (map/survey.mjs `reveals`: hexKey → the effects-clock ms its dissolve starts;
 * the map dissolves each tile from chart to paint, map/chart.mjs paintReveal). Here the survey is felt: the
 * chart's ink lifts off each tile as its paint comes, a pale line runs outward ahead of it, a few glints,
 * and one caption counts what was surveyed. `{tiles: [{q, r, at (seconds from now)}], caption}`.
 */
export function playReveal(fx, { tiles = [], seed = 'reveal', caption = true } = {}) {
  const list = tiles.filter(t => Number.isInteger(t.q) && Number.isInteger(t.r));
  fx.sound('shimmer', { seed });
  if (!list.length) return;
  const first = list.reduce((a, b) => (b.at < a.at ? b : a));
  const far = list.reduce((d, t) => Math.max(d, hexDistance(first.q, first.r, t.q, t.r)), 0);
  fx.play('ripple', { q: first.q, r: first.r, color: '#fff4d0', radius: far + 1.2, delay: Math.max(0, first.at), layer: 'top', seed });
  for (const t of list) {
    const d = Math.max(0, t.at), sd = `${seed}|${t.q},${t.r}`;
    fx.play('burst', { q: t.q, r: t.r, kind: 'ink', n: 3, radius: 0.45, power: 1.2, life: 0.7, size: 0.55, delay: d, seed: sd });
    fx.play('burst', { q: t.q, r: t.r, kind: 'spark', n: 2, height: 0.25, power: 0.35, up: 0.6, size: 0.8, delay: d + 0.35, seed: `${sd}|g`, colors: ['#fffaf0', '#f4e4b4'] });
  }
  // one caption for the whole survey, over the tile nearest its middle (`caption` false: land that only came into
  // the picture, such as the candidate sites of the wait, is not called a survey)
  if (caption && list.length >= 3) {
    const cq = list.reduce((a, t) => a + t.q, 0) / list.length, cr = list.reduce((a, t) => a + t.r, 0) / list.length;
    const mid = list.reduce((a, b) => (Math.hypot(b.q - cq, b.r - cr) < Math.hypot(a.q - cq, a.r - cr) ? b : a));
    const last = list.reduce((a, t) => Math.max(a, t.at), 0);
    const delay = Math.max(0.3, last * 0.5);
    fx.play('tag', { q: mid.q, r: mid.r, text: L`新しく ${fmtNum(list.length)} マスを測量しました`, icon: 'chart', tone: 'ivory', lift: 1.2, delay, dur: 2.4, seed });
    // (the caption's own tile: what the map says there makes way for as long as the caption stands)
    try { const at = locate(mid.q, mid.r); if (at) fx.hush({ p: at.p, q: at.q, tile: at.idx }, 2.4, delay); } catch { /* a tile outside the opened world */ }
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
    tollEnds = fx.clock.now() + TOLL_CLEAR;
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

  // ---- the land: a village lands, tiles light for a host, land comes out of the chart
  on('landing', a => playLanding(fx, a));
  on('tiles:lit', a => playLit(fx, a));
  // (the tiles and their start times are the map's own: map/survey.mjs `reveals`, read from the map's source)
  let revealSeen = -Infinity;
  on('reveal', a => {
    let tiles = a.tiles ?? null;
    if (!tiles) {
      tiles = [];
      try {
        const now = fx.clock.now();
        const reveals = fx.map?.source?.()?.survey?.reveals;
        for (const [k, t0] of reveals ?? []) { if (t0 <= revealSeen) continue; const h = keyHex(k); tiles.push({ q: h.q, r: h.r, at: t0 / 1000 - now }); }
        for (const t0 of reveals?.values?.() ?? []) revealSeen = Math.max(revealSeen, t0);
      } catch { tiles = []; }
    }
    playReveal(fx, { tiles, caption: a.words !== false, seed: `reveal|${a.n ?? tiles.length}|${Math.round(fx.clock.now() * 10)}` });
  });

  // ---- battles
  on('battle', p => { if (p.play) stageBattle(fx, p.play, p); });

  // ---- moments: one thing is not announced twice; many at once (a bell resolving a whole view) follow one
  // another a tenth of a second apart, and past MOMENTS_AT_ONCE only the viewer's own play in full (the rest
  // show their far-view pip, so nothing is dropped without a trace)
  const recent = new Map();   // "kind|p,q,tile" → clock time
  let run = { t: -Infinity, n: 0 };
  on('moment', m => {
    const key = `${m.kind}|${m.p},${m.q},${m.tile}`, now = fx.clock.now();
    for (const [k, t] of recent) if (now - t > 30) recent.delete(k);
    if (recent.has(key) && now - recent.get(key) < 8) return;
    recent.set(key, now);
    run = now - run.t < 0.6 ? { t: run.t, n: run.n + 1 } : { t: now, n: 0 };
    if (run.n >= MOMENTS_AT_ONCE && !m.own) { const at = spot(m); if (at) fx.play('pip', { ...at, color: TONE.brassHi, delay: run.n * 0.05, seed: key }); return; }
    playMoment(fx.later(m.own ? 0 : run.n * 0.1), m, { bus });
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

  // ---- the language changed: words written in the one before are taken down at once (they are nodes of the page now,
  // and a caption is never left standing in a language the page is no longer in)
  const offLang = onLangChange?.(() => { if (fx.mounted) fx.drop(['label', 'tag', 'banner']); });
  if (typeof offLang === 'function') offs.push(offLang);

  fx.staged = { off() { offs.forEach(f => f()); fx.staged = null; } };
  return fx.staged;
}

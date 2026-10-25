// The set pieces (UX-DESIGN §8.3): what the page shows when something real
// happens. The page only reports the event on the bus (fx/bus.mjs); this
// file decides how it looks and sounds. Nothing here invents an event: every
// function below is called with a record the page holds (or, under the demo
// switch and its corner tag, with labelled sample data).
//
//   event (who emits it)                       → what plays
//   bell {turn, home}        app ringToll       the toll: brass ripple, the banner in #bell-toll, the bell
//   feed {fresh, turn}       app tickFeed       this turn's own results in order → `turn:results` (a battle the page
//                                               will play by itself is its own result: its scene has its place in the order)
//   turn:urgent {turn}       app ringToll       the bell chip beats once (the last 30 s)
//   battle {play, …}         app playBattle     the battle (fx/battle.mjs)
//   moment {kind, …}         app checkMoments   built, harvest, muster, arrive, camp, village, depart
//   action:busy | sent | landed | refused      controller act / sendTheMarch
//   march:sealed {…}         controller         the seal and the departure
//   landing {p, q, tile, …}  map/fmap.mjs       a village lands: dust and sparks under the standard, its name
//   tiles:lit {origin, tiles} map/fmap.mjs      the engine's glow runs over the tiles a selected host can act on
//   reveal {n}               app surveyNow      land comes out of the chart: a shimmer
//
// Emitted here for the HUD: `turn:results {turn, items, fresh, startsIn}` (each item with the effects-clock second
// `at` its mark or scene starts, how long it plays, `secs`, and `plays` when its battle is its own result),
// `turn:scene {…item}` at that second (the page starts the battle then: app playBattle),
// `res:gain {p, q, site}` (when harvest tokens land in the resource strip).
import { L, fmtNum, onLangChange } from '../../lang.mjs';
import { project, RADIUS as R } from '../../map.mjs';
import { tileHex, hexDistance, locate } from '../fgeo.mjs';
import { keyHex } from '../map/survey.mjs';
import { factionName, TIERS } from '../fi18n.mjs';
import { FACTION_FILL, FACTION_DARK, FACTION_LIGHT } from '../people/avatar.mjs';
import { UNIT_KINDS, routePoints } from '../people/units.mjs';
import { bus as defaultBus } from './bus.mjs';
import { TONE, bannerGone } from './effects.mjs';
import { installPieces, FLY_LANDS, SEAL_PX, COLUMN_SECS, FORMING_SECS } from './pieces.mjs';
import { stageBattle } from './battle.mjs';
import { endBattle } from '../people/battle.mjs';
import { installIdle } from './idle.mjs';
import { NARROW } from './safe.mjs';

const fill = f => FACTION_FILL[f] ?? TONE.brassHi;
const light = f => FACTION_LIGHT[f] ?? TONE.ivory;
const dark = f => FACTION_DARK[f] ?? TONE.brassLo;
/** A position argument for effects from an event's `{p, q, tile}` (null when it names no tile). */
const spot = a => (a && [a.p, a.q, a.tile].every(Number.isInteger) ? { p: a.p, q: a.q, tile: a.tile } : a && Number.isInteger(a.q) && Number.isInteger(a.r) && !Number.isInteger(a.p) ? { q: a.q, r: a.r } : null);
const worldOf = at => { if (!at) return null; const h = Number.isInteger(at.tile) ? tileHex(at.p, at.q, at.tile) : at; return h ? project(h.q, h.r) : null; };

/** When the toll's banner comes after the stroke and how long it stays (s), and the gap between two results played one after another. */
export const TOLL_BANNER_AT = 0.3;
// (1.6 s: the dial carries the turn; the banner only names it, and this turn's results, which wait for it, come a
// second sooner. It was 2.6 s with 「新しいターン — ターン N」, which said ターン twice: the design review of 2026-10-24)
export const TOLL_BANNER_SECS = 1.6;
export const RESULT_GAP = 0.7;
/** How long one result's mark plays (the card's row is lit as long), and the pause after a battle that played as its own result. */
export const RESULT_SECS = 1.5;
export const SCENE_REST = 0.4;
/** On a phone a scene does not start before the turn's card has stood this long (s). */
export const CARD_READ = 2.2;
/** Seconds after the stroke at which the banner has faded under a tenth of its opacity: this turn's results and their card wait for it (UX-DESIGN §11.14). */
export const TOLL_CLEAR = TOLL_BANNER_AT + bannerGone(TOLL_BANNER_SECS);
/** The longest the toll's banner waits for a battle that is on stage when the bell tolls (s). */
export const TOLL_WAIT_MAX = 9;
/** How long a camp's leaving waits for the battle that may have cleared it to be told (s). */
export const CAMP_BEAT = 2.4;
/** How many moments of other people play in full within one beat (the viewer's own always do). */
export const MOMENTS_AT_ONCE = 8;
/** The order this turn's own results are shown in. */
export const RESULT_ORDER = Object.freeze(['arrival', 'battle', 'incoming']);

/** What kind of own result a notification of hud/feed.mjs is (null: not one of the three shown at the turn). */
export function resultKind(x) {
  const id = String(x?.id ?? '');
  if (id.startsWith('rv:')) return 'arrival';
  // (the viewer's own march resolved with nobody to fight, hud/feed.mjs: an arrival, marked on its tile)
  if (id.startsWith('rs:') && x?.kind === 'march') return 'arrival';
  if (x?.kind === 'battle') return 'battle';
  if (x?.kind === 'incoming') return 'incoming';
  return null;
}
/** A result as the bus carries it (`turn:results`, `turn:scene`). */
const pubResult = x => ({ id: x.id, kind: x.result, p: x.p, q: x.q, tile: x.tile ?? null, text: x.text ?? '', battle: x.battle ?? null, at: x.at, secs: x.secs, plays: x.plays, focus: !!x.focus });
/** Own results in the order they are shown: arrivals, then battles, then warnings; otherwise as they came. */
export function orderResults(list) {
  return list.map((x, i) => ({ x, i, k: RESULT_ORDER.indexOf(x.result) })).sort((a, b) => a.k - b.k || a.i - b.i).map(o => o.x);
}

// ------------------------------------------------------------------ the compositions
/** The bell tolls: `{turn, home: {p, q, tile} | null}`. */
export function playToll(fx, { turn, home = null, wait = 0 } = {}) {
  const engineInView = fx.onStage(0, 0);
  const h = worldOf(home), v = fx.view();
  // from the Engine when it is in view; else from the viewer's own village; else from the middle of what is looked at
  const o = engineInView ? { x: 0, y: 0 } : h ?? { x: v.x, y: v.y };
  const seed = `bell|${turn}`;
  fx.play('toll', { ...o, seed });
  fx.play('chip', { el: '#bell-chip', delay: 0.2, seed });
  // under the dial, at the top of the stage the HUD leaves free (a phone: between its two columns of buttons, on two lines)
  // (`wait`: a battle is on stage and its verdict stands where this banner would: the stroke and the bell are now, the
  // banner's words come when the scene has ended)
  fx.play('banner', { title: L`ターン ${fmtNum(turn)}`, sub: L`新しいターン`, into: fx.doc?.getElementById?.('bell-toll') ?? '#bell-toll', y: 0, dur: TOLL_BANNER_SECS, delay: TOLL_BANNER_AT + Math.max(0, wait), seed });
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
  // the tile and the land round it take the nation's colour for a breath (the real landing read thin: a pale ring and a few streaks)
  fx.play('glow', { ...at, radius: 1, color: fill(a.faction), hold: 0.5, gain: 0.6, delay: 0.03, seed });
  fx.play('ripple', { ...at, color: light(a.faction), radius: 2.1, delay: 0.07, seed });
  fx.play('ripple', { ...at, color: fill(a.faction), radius: 1.3, delay: 0.16, seed: `${seed}|in` });
  fx.play('burst', { ...at, kind: 'spark', n: 28, height: 0.3, power: 1.0, delay: 0.08, seed, colors: [light(a.faction), fill(a.faction), '#fff6dc'] });
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
  // (the map draws the viewer's sealed march from its record once the page holds it, map/fmap.mjs drawsMarchTo: the effect's ribbon then gives way)
  const rest = fx.play('sealed', { points, color, caption, captionAfter: 0.75, seed, yieldTo: () => !!fx.map?.drawsMarchTo?.(a.dest) });
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
      // (restaged: where the map shows sheaves on the village's fields, the goods fly from the fields; else from the village)
      let fields = [];
      try { fields = (fx.map?.fieldPoints?.(m.p, m.q, m.tile) ?? []).slice(0, 2); } catch { fields = []; }
      for (const f of fields) fx.play('burst', { x: f.x, y: f.y, kind: 'leaf', n: 10, height: 0.2, radius: 0.3, power: 1.1, size: 1.5, life: 0.8, delay: 0.1, seed: `${seed}|f${f.x | 0}` });
      const flown = fields.length
        ? fields.flatMap((f, i) => fx.play('fly', { x: f.x, y: f.y + R * 0.4, to: m.to ?? '#res-strip', n: i ? 3 : 5, delay: 0.16 + i * 0.12, seed: `${seed}|fly${i}` }))
        : fx.play('fly', { ...at, to: m.to ?? '#res-strip', n: 8, delay: 0.16, seed });
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
      // (lost or taken: the band below says it; the tile's own labels still make way while the flag changes)
      if (m.lost || m.taken) fx.hush(at, 3.6);
      else caption(MOMENT_LABEL.village(m), { ...(to !== null ? { color: fill(to), icon: 'banner' } : { tone: 'ivory' }), delay: 0.45, dur: 2.3, lift: to !== null ? 2.95 : 1.5 });
      fx.play('pip', { ...at, color: to !== null ? fill(to) : '#d8cfb8', seed });
      // the two largest things that happen to a player get the weight of a battle's verdict: a band over the map, a held
      // beat, the drum (the design review of 2026-10-24: losing a village played as small as a finished sawmill).
      // From the record only: `lost` / `taken` are the page's own reading of its holdings (app.mjs checkMoments)
      if (m.lost) {
        fx.play('banner', { title: L`村を失いました`, sub: to !== null ? L`${factionName(to)}の村になりました` : L`村は残っていません`, tone: 'loss', y: 0.05, dur: 3.2, delay: 0.5, seed: `${seed}|lost` });
        fx.shake(3, 180, { seed });
        fx.sound('drum', { delay: 0.1, seed, level: 1 });
        fx.sound('drum', { delay: 0.55, seed: `${seed}|2`, level: 0.8 });
      } else if (m.taken) {
        fx.play('banner', { title: L`村を奪いました`, sub: L`${factionName(m.from)}から`, tone: 'win', color: fill(to), y: 0.05, dur: 3.0, delay: 0.5, seed: `${seed}|taken` });
        fx.play('burst', { ...at, kind: 'spark', n: 26, height: 0.6, power: 1.1, delay: 0.15, seed: `${seed}|s`, colors: ['#fff6dc', TONE.you, fill(to)] });
        fx.sound('shimmer', { delay: 0.5, seed });
        fx.sound('drum', { delay: 0.1, seed, level: 0.9 });
      } else if (m.own) fx.sound('drum', { delay: 0.1, seed, level: 0.7 });
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

/**
 * The survey grew (map/fmap.mjs `survey:gain`, from the survey's own count: map/survey.mjs surveyGain): `{n, q, r,
 * faction, kind, claims}`. One chip rises from the piece that caused it: 「+N マス測量」 (UX design 14.4). It stands in for the
 * reveal's own caption, which counted only the tiles that came into sight.
 */
export function playGain(fx, a) {
  if (!(a.n > 0) || !Number.isInteger(a.q) || !Number.isInteger(a.r)) return;
  const seed = `gain|${a.seq ?? ''}|${a.q},${a.r}`;
  // (the banner rule's prototype is on and the cause is the destination of a march just sealed: the tiles round it
  // came out of the chart in colour beside land that can be owned, and the plate's count rose. Said once, as it is:
  // surveyed, not owned. It stands a little longer, for the camera may be on its way back from the order.)
  const sealed = !!a.claims && a.kind === 'destination';
  fx.play('tag', { q: a.q, r: a.r, text: sealed ? L`+${fmtNum(a.n)} マス測量（土地ではありません）` : L`+${fmtNum(a.n)} マス測量`, icon: 'chart', tone: 'gold', lift: 2.5, rise: 26, delay: 0.55, dur: sealed ? 4.2 : 2.8, seed });
  fx.play('ripple', { q: a.q, r: a.r, color: '#fff4d0', radius: 2.2, delay: 0.5, layer: 'top', seed });
  fx.sound('tick', { delay: 0.55, seed });
}
/**
 * A Train landed (the bus's `action:landed` of a Train: `{tile: {p, q, tile}, faction, unit?, n?}`): recruits walk
 * up the gate road into the village (UX design 14.2). Training is an instant purchase into the village's reserve, so
 * nothing waits and nothing is timed: a short file of figures, and they are in. Reduced motion: they stand before
 * the gate for a moment.
 */
export function playRecruits(fx, a) {
  const at = spot(a.tile ?? a), w = worldOf(at);
  if (!w) return;
  const seed = `recruits|${a.id ?? ''}|${at.p},${at.q},${at.tile}`;
  // from open ground in front of the village, up the road, to the gate
  const points = [{ x: w.x + R * 0.9, y: w.y + R * 1.5 }, { x: w.x + R * 0.3, y: w.y + R * 1.02 }, { x: w.x + R * 0.04, y: w.y + R * 0.5 }];
  fx.play('walker', { points, kind: UNIT_KINDS[a.unit ?? 0] ?? 'spearman', faction: a.faction ?? 0, n: Math.max(3, Math.min(6, Math.round((a.n ?? 300) / 100) + 2)), reach: 1.4, delay: 0.25, seed });
  fx.play('tag', { ...at, text: L`新兵が村に入りました`, icon: 'banner', color: fill(a.faction), lift: 1.5, delay: 0.5, dur: 2.2, seed });
  fx.sound('drum', { delay: 0.3, seed, level: 0.4 });
}
/**
 * A village of the viewer's was promoted (map/fmap.mjs `promotion`: `{p, q, tile, faction, tier, from, to, grew}`):
 * the map floods the new ring of its land; here the flood's crest runs out, and one line says what grew. The words
 * are the land's true name: the village's worked land, never territory.
 */
export function playPromotion(fx, a) {
  const at = spot(a);
  if (!at) return;
  const seed = `promotion|${a.p},${a.q},${a.tile}|${a.tier}`;
  fx.sound('shimmer', { delay: 0.12, seed });
  fx.play('flash', { ...at, color: light(a.faction), seed });
  fx.play('ripple', { ...at, color: light(a.faction), radius: (a.to ?? 2) + 0.8, delay: 0.12, seed });
  fx.play('ripple', { ...at, color: TONE.you, radius: (a.to ?? 2) + 0.3, delay: 0.5, seed: `${seed}|rim` });
  fx.play('burst', { ...at, kind: 'spark', n: 22, height: 0.5, power: 1.0, delay: 0.12, seed, colors: ['#fff6dc', TONE.you, fill(a.faction)] });
  // (a rank is one of the few things a player works hours for: it is named on a band, as a battle's verdict is, and
  // what it changed is its small line: the design review of 2026-10-24. It was a caption 「村のまわりが広がりました」)
  const rank = Number.isInteger(a.tier) && TIERS[a.tier] ? TIERS[a.tier] : null;
  if (rank) fx.play('banner', { title: L`${rank}になりました`, sub: a.grew ? L`村のまわりが広がりました` : L`村が大きくなりました`, tone: 'win', color: light(a.faction), y: 0.05, dur: 3.0, delay: 0.45, seed: `${seed}|band` });
  else fx.play('tag', { ...at, text: a.grew ? L`村のまわりが広がりました` : L`村が大きくなりました`, icon: 'home', tone: 'gold', lift: 3.05, delay: 0.6, dur: 3.0, seed });
  fx.hush(at, 3.7);
  fx.play('pip', { ...at, color: TONE.you, seed });
}
/** A host that was forming up stands now (map/fmap.mjs `board:formed`): it forms up with dust at the toll. */
export function playFormed(fx, a) {
  const at = spot(a);
  if (!at) return;
  const seed = `formed|${a.host ?? ''}|${a.p},${a.q},${a.tile}`;
  fx.play('dust', { ...at, power: 1.0, ring: 0.5, seed });
  fx.play('glow', { ...at, radius: 0, color: fill(a.faction), hold: 0.7, gain: 0.6, seed });
  fx.play('ripple', { ...at, color: light(a.faction), radius: 1.5, delay: 0.08, seed });
  fx.play('pip', { ...at, color: fill(a.faction), seed });
  fx.sound('drum', { delay: 0.05, seed, level: 0.5 });
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
  let turn = null, results = [], tollEnds = -Infinity, seqEnds = -Infinity;
  const resting = new Set();   // sealed ribbons at rest: they go at the turn
  // tiles a battle has for itself: "p,q,tile" → the effects-clock second it ends (what else would play there waits)
  const held = new Map();
  const hold = (key, until) => { held.set(key, Math.max(held.get(key) ?? -Infinity, until)); };
  // the effects-clock second the battle that is on stage (or has its place in this turn's order) ends
  let sceneUntil = -Infinity;
  /** A province in which a battle is on stage or about to be: "p,q" → the second it ends (a camp that the battle clears is told by the battle). */
  const fought = new Map();
  on('bell', p => {
    for (const h of resting) h.cancel?.();
    resting.clear();
    turn = p.turn ?? null; results = [];
    // (a battle that is playing when the bell tolls keeps the top of the stage until its verdict has been read: the toll's
    // banner was drawn over it — 「The bell Victory Turn 44」, the English recording of 2026-10-11 — and comes after it now)
    const now = fx.clock.now(), busy = Math.max(0, sceneUntil - now);
    const wait = busy > 0 ? Math.min(busy + 0.25, TOLL_WAIT_MAX) : 0;
    playToll(fx, { ...p, wait });
    tollEnds = now + wait + TOLL_CLEAR;
  });
  /**
   * How long the battle of a result plays as its own result (0: it is only marked). The page says with `scene`
   * (the scene's seconds at its playback speed) that it plays battles by itself, and with `focus` that it sends
   * the camera; without the camera the scene plays only where the viewer is looking.
   */
  const sceneSecs = x => {
    if (x.result !== 'battle' || !(x.scene > 0)) return 0;
    const w = worldOf(spot(x));
    if (!x.focus && !(w && fx.onStage(w.x, w.y))) return 0;
    const level = fx.motionLevel?.() ?? 'full';
    return level === 'off' ? 3 : level === 'reduced' ? Math.min(4.2, Math.max(2.4, x.scene)) : x.scene;
  };
  on('feed', p => {
    const fresh = (p.fresh ?? []).map(x => ({ ...x, result: resultKind(x) })).filter(x => x.result && !results.some(r => r.id === x.id));
    if (!fresh.length) return;
    if (p.turn !== undefined && p.turn !== turn) { turn = p.turn; results = []; }
    const ordered = orderResults(fresh);
    const now = fx.clock.now();
    // after the toll's banner, and after what an earlier poll is still playing
    const wait = Math.max(0, tollEnds - now, seqEnds - now);
    let t = wait;
    // (on a phone the turn's card steps back for a scene, fx.css: it is given the time to be read first, or it would
    // show for the length of one gap and be gone)
    const narrow = (fx.doc?.defaultView?.innerWidth ?? Infinity) < NARROW;
    for (const x of ordered) {
      const scene = sceneSecs(x);
      if (scene > 0 && narrow) t = Math.max(t, wait + CARD_READ);
      Object.assign(x, { at: now + t, secs: scene || RESULT_SECS, plays: scene > 0 });
      // (a battle that plays is not also marked with crossed swords: the page starts its scene at `at`, and the
      // tile is the battle's until it ends. The first real turn showed the scene, the mark and the toll's banner at once)
      if (scene > 0) {
        if (spot(x)) hold(`${x.p},${x.q},${x.tile}`, x.at + scene);
        if (Number.isInteger(x.p) && Number.isInteger(x.q)) fought.set(`${x.p},${x.q}`, Math.max(fought.get(`${x.p},${x.q}`) ?? -Infinity, x.at + scene));
        // (a zero-size effect is the timer: the cue follows the effects clock, as everything else of the sequence does)
        const cue = pubResult(x);
        fx.add({ name: 'scene-cue', layer: 'top', dur: Math.max(0.02, t), info: true, draw() {}, onEnd: () => bus.emit('turn:scene', cue) });
      // (an arrival whose seal the board's own record has just opened there, `board:arrival`, is not opened twice)
      } else if (!(x.result === 'arrival' && Number.isInteger(x.tile) && now - (recent.get(`arrive|${x.p},${x.q},${x.tile}`) ?? -Infinity) < 8)) playResult(fx, x, t);
      if (x.result === 'arrival' && Number.isInteger(x.tile)) recent.set(`arrive|${x.p},${x.q},${x.tile}`, x.at);
      t += scene > 0 ? scene + SCENE_REST : RESULT_GAP;
    }
    seqEnds = now + t;
    results = orderResults([...results, ...ordered]);
    bus.emit('turn:results', { turn, items: results.map(pubResult), fresh: ordered.map(pubResult), startsIn: wait, gap: RESULT_GAP });
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
    // (where the map tells the survey's own count, `survey:gain`, that chip is the caption: 「+N マス測量」)
    let counted = false;
    try { counted = !!fx.map?.source?.()?.survey?.gain; } catch { counted = false; }
    playReveal(fx, { tiles, caption: a.words !== false && !counted, seed: `reveal|${a.n ?? tiles.length}|${Math.round(fx.clock.now() * 10)}` });
  });
  // ---- the viewer's hosts on the board (map/fmap.mjs boardChanged; UX design 14.4)
  on('survey:gain', a => playGain(fx, a));
  on('promotion', a => playPromotion(fx, a));
  on('board:formed', a => playFormed(fx, a));
  on('board:arrival', a => {
    // the seal opens with a flash on the destination, once: this turn's own result (`feed`) may have opened it already
    const key = `arrive|${a.p},${a.q},${a.tile}`, now = fx.clock.now();
    if (now - (recent.get(key) ?? -Infinity) < 8) return;
    recent.set(key, now);
    playResult(fx, { result: 'arrival', id: `board|${a.host}`, p: a.p, q: a.q, tile: a.tile, faction: a.faction });
  });

  // ---- battles (the tiles of a scene are its own for as long as it plays: a moment there waits, see below)
  on('battle', p => {
    if (!p.play) return;
    // (a scene that has its place in the turn's order is started by its cue alone. Who gives it that place is asked
    // first — map/ownclash.mjs: the viewer's own host fighting where it stands —, and a start it calls off is over at
    // once and never staged: the page also starts, without the camera, the clash of any province it has loaded, and
    // the scene would play twice)
    const ask = { play: p.play, focus: !!p.focus, hold: false };
    bus.emit('battle:ask', ask);
    if (ask.hold) { endBattle(p.play); return; }
    const h = stageBattle(fx, p.play, p), sc = p.play.scene;
    if (h && sc) for (const T of sc.tiles ?? []) hold(`${sc.p},${sc.q},${T.idx}`, fx.clock.now() + (h.dur ?? 3));
    if (h && sc) { const until = fx.clock.now() + (h.dur ?? 3); sceneUntil = Math.max(sceneUntil, until); fought.set(`${sc.p},${sc.q}`, Math.max(fought.get(`${sc.p},${sc.q}`) ?? -Infinity, until)); }
  });

  // ---- moments: one thing is not announced twice; many at once (a bell resolving a whole view) follow one
  // another a tenth of a second apart, and past MOMENTS_AT_ONCE only the viewer's own play in full (the rest
  // show their far-view pip, so nothing is dropped without a trace)
  const recent = new Map();   // "kind|p,q,tile" → clock time
  let run = { t: -Infinity, n: 0 };
  // ---- a keep's capture (map/keeps.mjs says it once, from the capture's own record). The host that held the keep's
  // tile goes into the keep with the capture, and the roster then reads as a host that left: a "departure" was
  // stamped over the keep in the very second its province changed hands (seen on the local test chain, 2026-10-11).
  // A departure from a keep's own tile waits a moment for that word, and is not played when the capture comes.
  const captured = new Map();   // "p,q" → clock time
  on('keep:captured', k => { captured.set(`${k.p},${k.q}`, fx.clock.now()); });
  const keepTile = m => { try { const row = fx.map?.keeps?.on ? fx.map.keeps.rows.get(`${m.p},${m.q}`) : null; return !!row && row.tile === m.tile; } catch { return false; } };
  const taken = m => { const t = captured.get(`${m.p},${m.q}`); return t !== undefined && Math.abs(fx.clock.now() - t) < 4; };
  on('moment', m => {
    if (m.kind === 'depart' && keepTile(m)) {
      if (!taken(m)) globalThis.setTimeout?.(() => { if (fx.mounted && !taken(m)) moment(m); }, 450);
      return;
    }
    moment(m);
  });
  const moment = m => {
    const key = `${m.kind}|${m.p},${m.q},${m.tile}`, now = fx.clock.now();
    for (const [k, t] of recent) if (now - t > 30) recent.delete(k);
    if (recent.has(key) && now - recent.get(key) < 8) return;
    recent.set(key, now);
    run = now - run.t < 0.6 ? { t: run.t, n: run.n + 1 } : { t: now, n: 0 };
    if (run.n >= MOMENTS_AT_ONCE && !m.own) { const at = spot(m); if (at) fx.play('pip', { ...at, color: TONE.brassHi, delay: run.n * 0.05, seed: key }); return; }
    // a battle playing on that tile has it: the moment (its light, its caption) comes when the field is clear
    for (const [k, until] of held) if (until <= now) held.delete(k);
    const busyAt = () => { const t = fx.clock.now(); return Math.max(0, (held.get(`${m.p},${m.q},${m.tile}`) ?? -Infinity) - t); };
    // (a camp that is gone: the record that takes it away comes with the turn's resolution, and when a battle cleared it
    // that battle is told a moment later and staged after the toll's banner. The caption 「野営地がなくなった」 stood beside
    // the camp while the scene of its fight was only starting — the English recording of 2026-10-11. The camp's moment
    // waits a beat for the battle to be told, and then until that battle, on its tile or anywhere in its province, is over)
    if (m.kind === 'camp') {
      const pk = `${m.p},${m.q}`;
      const go = () => { const t = fx.clock.now(), left = Math.max(busyAt(), (fought.get(pk) ?? -Infinity) - t); if (left > 0.02) fx.add({ name: 'moment-wait', layer: 'top', dur: left + 0.3, info: true, draw() {}, onEnd: go }); else playMoment(fx, m, { bus }); };
      fx.add({ name: 'moment-wait', layer: 'top', dur: CAMP_BEAT, info: true, draw() {}, onEnd: go });
      return;
    }
    playMoment(fx.later((m.own ? 0 : run.n * 0.1) + busyAt()), m, { bus });
  };

  // ---- own actions
  const pendingActs = new Map();   // id → {handles, a}
  const settle = id => { const rec = pendingActs.get(id); pendingActs.delete(id); for (const h of rec?.handles ?? []) h.cancel?.(); return rec; };
  on('action:busy', a => { settle(a.id); pendingActs.set(a.id, { handles: playBusy(fx, a), a }); });
  on('action:sent', a => playSent(fx, a));
  on('action:landed', a => {
    const rec = settle(a.id);
    if (a.name !== 'Depart') playLanded(fx, { ...rec?.a, ...a });
    // a Train on the chain: the recruits walk into the village (the reserve rose at once: nothing is timed)
    if (a.name === 'Train') playRecruits(fx.later(0.35), { ...rec?.a, ...a });
  });
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

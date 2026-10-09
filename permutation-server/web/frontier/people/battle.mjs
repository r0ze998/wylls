// The battle scene (design session: "make battles move"; staged again for
// UX-DESIGN §8.3): a clash of one province and bell, played as seven seconds
// on the map when the bell resolves it (or on demand: the inspector, the
// report, the replay page).
//
//   1  0.0–1.2 s  the revealed arrivals come out of the mist on the tile
//                 they arrived at — never from a direction: a sealed march
//                 shows no route, only where it was revealed. The two
//                 strength bars slide in.
//   2  1.2–2.2 s  each side takes its stance: Assault a wedge with its point
//                 forward, Flank two wings, Brace one tight line, Hold a
//                 block. A side is as many figures as its troops call for
//                 (a log scale, `figuresFor`).
//   3  2.2–4.0 s  the melee: three exchanges. Each has its anticipation
//                 (150 ms, the lines draw back), a charge, a contact frame
//                 held for 70 ms (the struck figures lit for two frames, a
//                 star where the lines meet), a knockback, and the losses so
//                 far struck over each side while its bar drains. Archers
//                 loose a volley before each contact.
//   4  4.0–5.6 s  the blow that decides it, then the fates (ClashInputs):
//                 Stays plants the standard, Retreated walks off unhurt,
//                 Bounced is thrown back, Withdrew steps aside, Destroyed
//                 falls. The record's own losses stand over each side.
//   5  5.6–7.0 s  the field as it was left; the numbers let go.
//
// The players (UX design 13.2: the six are the players): each side that is
// a nation has its player's character standing behind its formation, facing
// the enemy. It strikes (the attack sheet) on an exchange its side wins,
// takes the blow (the hit sheet) on one it loses, and stands between. A camp
// has none. Which side wins an exchange follows the record's own losses
// (`exchangeWinners`): nothing is invented, the staging only says who had
// the better of it.
//
// A fight on a tile that holds a village is staged on the ground before the
// village (`villageDrop`), never over its houses.
//
// `paintBattle` is a pure function of the scene and a time: it draws the
// figures, the arrows, the contact flashes, the bars and the numbers. What
// needs the page (the dimmed map, particles, the shake, sound, the title
// across the map, the far view's mark) is added by fx/battle.mjs, which
// plays this painter on the effects canvas.
//
// Everything comes from bytes the page decodes itself: the ClashInputs
// (arrivals: tile, stance, troops before and after, fate, owner tag), the
// Province before the bell (the report's province_before_b64: residents,
// garrisons, camp) and the Province after (the current envelope).
import { RADIUS, FLATTEN, project } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { troopsOf } from '../fmarch.mjs';
import { FACTION_FILL, FACTION_DARK, FACTION_LIGHT, FACTION_MARK, sigilPath } from './avatar.mjs';
import { baseDisc, unitFigure, UNIT_KINDS } from './units.mjs';
import { paintMini, preloadMinis } from './minis.mjs';
import { clamp01, lerp, span, inQuad, inCubic, outQuad, outCubic, outExpo, outBack, inOutQuad } from '../fx/ease.mjs';
import { standing } from '../map/tilt.mjs';
import { sideOutcome } from './outcome.mjs';
import { paintLeaderMotion, leaderMotionSheet } from './leader-motion.mjs';
import { MOTION_LEADERS, LEADER_MOTIONS } from '../leader-motion-data.mjs';
import { VILLAGE } from '../map/village.mjs';
import { HERO, VILLAGE_SCALE, VILLAGE_AT } from '../map/plates.mjs';

export const FATES = Object.freeze(['Stays', 'Withdrew', 'Bounced', 'Retreated', 'Destroyed']);
export const STANCE_POSE = Object.freeze(['hold', 'assault', 'flank', 'brace']);
/** The phases' start times (s) and the scene's length. */
export const PHASE = Object.freeze({ emerge: 0, deploy: 1.2, melee: 2.2, fates: 4.0, losses: 5.6, end: 7.0 });

const NEUTRAL = 6;

/**
 * The scene of a clash: `{p, q, bell, tiles: [{idx, attackers, defenders}]}`
 * with sides `[{id, faction, stance, before, after, fate, tag?, kind}]` in
 * whole troops. Tiles where arrivals fought; with no arrivals (hosts already
 * in the province fighting each other, a garrison or a camp — most clashes
 * of a long season), the tiles where sides met and someone lost troops
 * between the province before and after (`residentScene`); null if none.
 */
export function battleScene({ p, q, bell, inputs, before = null, after = null, ownTiles = null }) {
  const arrivals = (inputs?.arrivals ?? []).filter(a => a.present === 1 || a.present === true);
  if (!arrivals.length) return withVillages(residentScene({ p, q, bell, before, after }), before ?? after, ownTiles);
  return withVillages(arrivalScene({ p, q, bell, arrivals, before, after }), before ?? after, ownTiles);
}

/**
 * Mark the tiles of a scene that hold a village (the Province's own sites): `tile.village = {tier, own}`; `own`:
 * the tile is one of `ownTiles` (the viewer's villages, which the map draws larger). The scene on such a tile is
 * staged before the village, not on its houses (`villageDrop`).
 */
function withVillages(scene, province, ownTiles = null) {
  if (!scene || !province) return scene;
  const sites = Array.from(province.sites ?? []);
  (province.siteMirror ?? []).forEach((m, j) => {
    if (!m || m.state !== 1) return;
    const tile = scene.tiles.find(t => t.idx === sites[j]);
    if (tile) tile.village = { tier: Math.max(0, Math.min(3, Number(m.tier ?? 0))), own: !!ownTiles?.has?.(sites[j]) };
  });
  return scene;
}

function arrivalScene({ p, q, bell, arrivals, before, after }) {
  const byTile = new Map();
  const tileOf = idx => { if (!byTile.has(idx)) byTile.set(idx, { idx, attackers: [], defenders: [] }); return byTile.get(idx); };
  for (const a of arrivals) {
    tileOf(a.tile).attackers.push({ id: String(a.hostId), faction: a.faction, unit: a.unit ?? 0, stance: a.stance ?? 0, before: troopsOf(a.troops), after: a.fate ? troopsOf(a.troopsAfter) : null,
      fate: FATES[a.fate - 1] ?? null, tag: a.citizenTag ?? null, kind: 'arrival' });
  }
  const alive = new Map((after?.entries ?? []).filter(e => e.state === 1).map(e => [String(e.id), e]));
  // without the province before the bell (an older report), the defenders are the ones there now: who
  // stood is known, their losses are not
  const standIn = !before && after;
  if (standIn) {
    for (const e of after.entries ?? []) {
      if (e.state !== 1 || !byTile.has(e.tile) || arrivals.some(a => String(a.hostId) === String(e.id))) continue;
      byTile.get(e.tile).defenders.push({ id: String(e.id), faction: e.faction, unit: e.unit ?? 0, stance: 0, before: troopsOf(e.troops), after: null, fate: 'Stays', kind: 'resident' });
    }
    const sitesNow = Array.from(after.sites ?? []);
    (after.siteMirror ?? []).forEach((m, j) => {
      if (!m || m.state !== 1 || !byTile.has(sitesNow[j]) || troopsOf(m.garrison) <= 0) return;
      byTile.get(sitesNow[j]).defenders.push({ id: `g${j}`, faction: m.faction, stance: 3, before: troopsOf(m.garrison), after: null, fate: 'Stays', kind: 'garrison' });
    });
  }
  for (const e of before?.entries ?? []) {
    if (e.state !== 1 || !byTile.has(e.tile)) continue;
    const now = alive.get(String(e.id));
    byTile.get(e.tile).defenders.push({ id: String(e.id), faction: e.faction, unit: e.unit ?? 0, stance: 0, before: troopsOf(e.troops), after: now ? troopsOf(now.troops) : (after ? 0 : null),
      fate: now ? 'Stays' : after ? 'Destroyed' : null, kind: 'resident' });
  }
  const sites = Array.from(before?.sites ?? []);
  (before?.siteMirror ?? []).forEach((m, j) => {
    if (!m || m.state !== 1 || !byTile.has(sites[j]) || troopsOf(m.garrison) <= 0) return;
    const a = after?.siteMirror?.[j];
    const left = a ? troopsOf(a.garrison) : null;
    byTile.get(sites[j]).defenders.push({ id: `g${j}`, faction: m.faction, stance: 3, before: troopsOf(m.garrison), after: left, fate: left === 0 ? 'Destroyed' : left === null ? null : 'Stays', kind: 'garrison' });
  });
  if (before?.camp?.state === 1 && byTile.has(before.camp.tile)) {
    const left = after ? (after.camp?.state === 1 ? Number(after.camp.troops) : 0) : null;
    byTile.get(before.camp.tile).defenders.push({ id: 'camp', faction: NEUTRAL, stance: 0, before: Number(before.camp.troops), after: left, fate: left === 0 ? 'Destroyed' : left === null ? null : 'Stays', kind: 'camp' });
  }
  return { p, q, bell, tiles: [...byTile.values()] };
}

/**
 * A clash of residents (no arrivals): needs both provinces. On each tile the
 * hosts, the garrison and the camp before the bell are the sides; a tile is
 * a battle when two sides met and troops were lost. The defenders are the
 * garrison's (or the camp's) side, else the faction holding the tile's
 * site, else the side that lost least; the rest attack.
 */
export function residentScene({ p, q, bell, before, after }) {
  if (!before || !after) return null;
  const alive = new Map((after.entries ?? []).filter(e => e.state === 1).map(e => [String(e.id), e]));
  const byTile = new Map();
  const at = idx => { if (!byTile.has(idx)) byTile.set(idx, []); return byTile.get(idx); };
  for (const e of before.entries ?? []) {
    if (e.state !== 1) continue;
    const now = alive.get(String(e.id));
    at(e.tile).push({ id: String(e.id), faction: e.faction, unit: e.unit ?? 0, stance: 0, before: troopsOf(e.troops), after: now ? troopsOf(now.troops) : 0, fate: now ? 'Stays' : 'Destroyed', kind: 'resident' });
  }
  const sites = Array.from(before.sites ?? []);
  const holderOf = new Map();
  (before.siteMirror ?? []).forEach((m, j) => {
    if (!m || m.state !== 1) return;
    holderOf.set(sites[j], m.faction);
    if (troopsOf(m.garrison) <= 0) return;
    const left = troopsOf(after.siteMirror?.[j]?.garrison ?? 0);
    at(sites[j]).push({ id: `g${j}`, faction: m.faction, stance: 3, before: troopsOf(m.garrison), after: left, fate: left === 0 ? 'Destroyed' : 'Stays', kind: 'garrison' });
  });
  if (before.camp?.state === 1) {
    const left = after.camp?.state === 1 ? Number(after.camp.troops) : 0;
    at(before.camp.tile).push({ id: 'camp', faction: NEUTRAL, stance: 0, before: Number(before.camp.troops), after: left, fate: left === 0 ? 'Destroyed' : 'Stays', kind: 'camp' });
  }
  const tiles = [];
  for (const [idx, list] of byTile) {
    const sides = new Set(list.map(x => x.faction));
    if (sides.size < 2 || !list.some(x => x.after < x.before)) continue;
    const held = list.find(x => x.kind === 'garrison' || x.kind === 'camp');
    let def = held ? held.faction : holderOf.has(idx) && sides.has(holderOf.get(idx)) ? holderOf.get(idx) : null;
    if (def === null) {
      const lost = new Map();
      for (const x of list) lost.set(x.faction, (lost.get(x.faction) ?? 0) + (x.before - x.after));
      def = [...lost.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0];
    }
    tiles.push({ idx, attackers: list.filter(x => x.faction !== def), defenders: list.filter(x => x.faction === def) });
  }
  return tiles.length ? { p, q, bell, tiles, residents: true } : null;
}

/** The total losses of a side on a tile (whole troops; null when unknown). */
export const losses = list => (list.some(x => x.after === null) ? null : list.reduce((s, x) => s + Math.max(0, x.before - x.after), 0));

// ------------------------------------------------------------------ playing
const hash = (a, b) => { let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1); h ^= h >>> 15; return (h >>> 0) / 4294967296; };
const smooth = k => { k = clamp01(k); return k * k * (3 - 2 * k); };
const wallNow = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000;

/** Playback speeds (UI plan D4, Civ's quick combat): the setting's values and their rates. */
export const BATTLE_SPEEDS = Object.freeze({ normal: 1, fast: 2.5, off: 0 });

/**
 * A playing scene: `{scene, t0, speed}`; `paintBattle(ctx, play, {zoom, now, lossText})`
 * draws it at time `now` (s) and returns false once it is over. `speed` > 1 plays it faster.
 */
export function startBattle(scene, now = wallNow(), speed = 1) {
  return scene ? { scene, t0: now, speed: speed > 0 ? speed : 1 } : null;
}

/** The scene's own time (s) at `now`. */
export const battleTime = (play, now) => (now - play.t0) * (play.speed ?? 1) + (play.scene?.residents ? PHASE.deploy : 0);   // residents were there all along: no emerging from the mist
/** Whether a scene is still playing at `now`. */
export const battleLive = (play, now) => !!play && battleTime(play, now) <= PHASE.end;
/** "P,Q,tile" of every tile a playing scene covers (the map hides the host sprites there). */
export function battleTiles(plays, now) {
  const out = new Set();
  for (const b of plays ?? []) if (battleLive(b, now)) for (const t of b.scene.tiles) out.add(`${b.scene.p},${b.scene.q},${t.idx}`);
  return out;
}

// ------------------------------------------------------------------ the choreography (UX-DESIGN §8.3)
/**
 * The contact frames in scene seconds: three exchanges of the melee, then the
 * blow that decides it, exactly when the fates begin. Everything that reacts
 * to a blow (the hit-stop, the white flash, the knockback, the shake, the
 * sparks, the sound) hangs on these four times.
 */
export const BATTLE_HITS = Object.freeze([PHASE.melee + 0.22, PHASE.melee + 0.78, PHASE.melee + 1.32, PHASE.fates]);
/** A contact holds the figures for this long (a hit-stop of 70 ms), then they catch up: the scene still ends at 7.0 s. */
export const HIT_STOP = 0.07;
const CATCH_UP = 0.14;
/** The share of a side's losses that has been dealt after each contact. The numbers shown are this running total; the last is the record's own. */
export const LOSS_BY_HIT = Object.freeze([0.25, 0.5, 0.75, 1]);
/** How hard each contact lands (the size of its flash, its sparks and its shake). */
export const HIT_POWER = Object.freeze([0.8, 0.9, 1, 1.4]);

/** The time the figures are posed at: scene time with each contact held for HIT_STOP and caught up after. */
export function poseTime(t) {
  for (let i = BATTLE_HITS.length - 1; i >= 0; i--) {
    const h = BATTLE_HITS[i];
    if (t < h) continue;
    if (t < h + HIT_STOP) return h;
    if (t < h + HIT_STOP + CATCH_UP) return h + (t - h - HIT_STOP) * ((HIT_STOP + CATCH_UP) / CATCH_UP);
    return t;
  }
  return t;
}

/** How many figures stand for `troops` (a log scale): 1 for a few dozen, 4 for about a thousand, 9 at most. */
export const figuresFor = troops => Math.max(1, Math.min(9, Math.round(2.4 * Math.log10(Math.max(1, Number(troops) || 0) / 30))));
/** The most figures one side shows. */
export const SIDE_FIGURES_MAX = 12;

/**
 * The places of `n` figures in a stance, in figure heights: `fx` toward the
 * enemy, `fy` across the line. Assault is a wedge with its point forward,
 * Flank two wings ahead of an empty middle, Brace one tight line shoulder
 * to shoulder, Hold a block.
 */
export function formation(pose, n) {
  const out = [];
  if (pose === 'assault') {
    for (let row = 0, placed = 0; placed < n; row++) {
      const k = Math.min(row + 1, n - placed);
      for (let i = 0; i < k; i++) out.push({ fx: 0.4 - row * 0.5, fy: (i - (k - 1) / 2) * 0.6 });
      placed += k;
    }
  } else if (pose === 'flank') {
    for (let i = 0; i < n; i++) { const wing = i % 2 ? 1 : -1, j = Math.floor(i / 2); out.push({ fx: 0.34 - j * 0.42, fy: wing * (0.66 + j * 0.2) }); }
  } else if (pose === 'brace') {
    const per = Math.min(n, 5);
    for (let i = 0; i < n; i++) { const rk = Math.floor(i / per), inRank = Math.min(per, n - rk * per); out.push({ fx: 0.2 - rk * 0.46, fy: ((i % per) - (inRank - 1) / 2) * 0.4 }); }
  } else {
    const per = n <= 4 ? 2 : 3;
    for (let i = 0; i < n; i++) { const rk = Math.floor(i / per), inRank = Math.min(per, n - rk * per); out.push({ fx: 0.1 - rk * 0.54, fy: ((i % per) - (inRank - 1) / 2) * 0.58 }); }
  }
  return out;
}

/** A figure's height in world px at a zoom: about 80 px on screen where the camera flies in (zoom 2.1), 62 px at the default view, never under 40 px while figures are drawn. */
export const battleScale = (zoom, fit = 1) => Math.max(40, Math.min(88, 34 + 22 * zoom) * fit) / Math.max(0.05, zoom);
/** How much of its full size the scene takes on a map `width` CSS px wide (a phone shows it smaller, never under 40 px a figure). */
export const battleFit = width => (width > 0 ? Math.max(0.5, Math.min(1, width / 720)) : 1);
/** Where a side's formation is centred before the charge, and how near the two centres come at a contact (figure heights). */
const REST = 1.6, MEET = 0.74;
/** The tallest a figure is drawn (screen px): the miniatures' sheets hold about 130 px a figure. */
export const FIGURE_PX_MAX = 120;
/** A fight fills the stage (UX-DESIGN §11.14): what the scene needs around its tile, in figure heights and screen px. */
const NEED = Object.freeze({ back: 1.85, above: 1.72, below: 1.05, foot: 78, head: 36 });
/** How far over its tile's centre a scene's loss numbers stand (figure heights): just over the heads of the rear rank. */
export const BATTLE_ABOVE = NEED.above;
/**
 * The scene sized to a stage of `width` × `height` screen px (what the HUD leaves free): `{px (a figure's
 * height), rest (how far apart the two sides stand, figure heights), bar (a strength bar's length, px),
 * above, below (how far the scene reaches over and under its tile's centre, px)}`. `title`: the height kept
 * for the verdict over the scene. A narrow stage (a phone) stands the sides closer so the figures can be larger.
 */
export function battleLayout({ width = 0, height = 0 } = {}, { title = 0 } = {}) {
  if (!(width > 0) || !(height > 0)) return null;
  const rest = width < 520 ? 1.2 : REST;
  const px = Math.max(40, Math.min(FIGURE_PX_MAX, width / (2 * (rest + NEED.back)), (height - NEED.foot - NEED.head - title) / (NEED.above + NEED.below)));
  return { px, rest, half: width / 2, bar: Math.max(84, Math.min(196, (width - 150) / 2, px * 2.1)), above: NEED.above * px + NEED.head, below: NEED.below * px + NEED.foot };
}
/** A figure's height in world px at a zoom for a layout (or by the zoom alone, `battleScale`, without one). */
const figureSize = (zoom, fit, layout) => (layout?.px > 0 ? layout.px / Math.max(0.05, zoom) : battleScale(zoom, fit));
/** A line across the field runs up and to the right on screen (the map's oblique view): how far a step across shifts a figure sideways, and how deep it reads. */
const SKEW = 0.34, DEPTH = 0.8;

const NEUTRAL_FILL = '#8a7a5c', NEUTRAL_DARK = '#4a3626', NEUTRAL_LIGHT = '#e9dfc6';
/** A side's colours: the nation's, or leather for the neutral camp. */
export const sideColors = f => (f >= 0 && f < 6 ? { fill: FACTION_FILL[f], dark: FACTION_DARK[f], light: FACTION_LIGHT[f] } : { fill: NEUTRAL_FILL, dark: NEUTRAL_DARK, light: NEUTRAL_LIGHT });

function sideOf(list, sgn, idx) {
  const by = new Map();
  for (const w of list) {
    // a nation's archers and crossbowmen stand as their own group behind its line
    const shoots = w.kind !== 'garrison' && w.kind !== 'camp' && ['archer', 'crossbowman'].includes(UNIT_KINDS[w.unit ?? 0]);
    const key = `${w.kind === 'garrison' ? 'g' : w.kind === 'camp' ? 'c' : shoots ? 'r' : 'h'}${w.faction}`;
    const g = by.get(key) ?? { key, faction: w.faction, kind: w.kind, members: [] };
    g.members.push(w); by.set(key, g);
  }
  // the line in front of the archers: melee groups first
  const groups = [...by.values()].sort((a, b) => (a.key[0] === 'r') - (b.key[0] === 'r'));
  for (const g of groups) {
    const main = [...g.members].sort((a, b) => b.before - a.before)[0];
    g.unit = g.kind === 'camp' ? 'spearman' : g.kind === 'garrison' ? 'pikeman' : UNIT_KINDS[main.unit ?? 0] ?? 'spearman';
    g.ranged = g.unit === 'archer' || g.unit === 'crossbowman';
    g.pose = g.kind === 'garrison' ? 'brace' : g.kind === 'camp' ? 'hold' : STANCE_POSE[main.stance ?? 0] ?? 'hold';
    g.before = g.members.reduce((a, m) => a + m.before, 0);
    g.after = g.members.some(m => m.after === null) ? null : g.members.reduce((a, m) => a + m.after, 0);
    g.fate = g.members.find(m => m.fate && m.fate !== 'Stays')?.fate ?? (g.members.every(m => m.fate === 'Stays') ? 'Stays' : null);
    g.n = figuresFor(g.before);
  }
  for (let total = groups.reduce((a, g) => a + g.n, 0); total > SIDE_FIGURES_MAX; total--) [...groups].sort((a, b) => b.n - a.n)[0].n--;
  const melee = groups.filter(g => !g.ranged), G = Math.max(1, melee.length);
  // how far back the line reaches: the archers stand behind its last rank
  let back = 0;
  groups.forEach((g, gi) => {
    const off = g.ranged && melee.length ? 0 : (g.ranged ? gi : melee.indexOf(g)) - (G - 1) / 2;
    const slots = formation(g.pose, g.n);
    const lossFrac = g.after === null || g.before <= 0 ? 0 : clamp01((g.before - g.after) / g.before);
    const gone = g.fate === 'Destroyed' || g.after === 0;
    const order = slots.map((_, i) => i).sort((a, b) => hash(a + 3, idx * 7 + gi * 31 + sgn) - hash(b + 3, idx * 7 + gi * 31 + sgn));
    g.off = off * (G > 2 ? 1.05 : 1.3);
    if (!g.ranged) back = Math.min(back, ...slots.map(sl => sl.fx));
    g.figs = slots.map((sl, i) => {
      const rank = order.indexOf(i);
      let fall = -1;
      for (let j = 0; j < BATTLE_HITS.length && fall < 0; j++) {
        const down = j === BATTLE_HITS.length - 1 && gone ? g.n : Math.floor(g.n * lossFrac * LOSS_BY_HIT[j] + 1e-6);
        if (rank < down) fall = j;
      }
      return { fx: (g.ranged && melee.length ? sl.fx - slots[0].fx + back - 0.55 : sl.fx - (g.ranged ? 0.4 : 0)) - Math.abs(off) * 0.06, fy: sl.fy + g.off, fall, j: hash(i + 1, gi * 13 + idx + (sgn > 0 ? 77 : 0)), front: sl.fx >= -0.12 && !g.ranged };
    });
  });
  const known = groups.length > 0 && !groups.some(g => g.after === null);
  const before = groups.reduce((a, g) => a + g.before, 0), after = known ? groups.reduce((a, g) => a + g.after, 0) : null;
  const lead = [...groups].sort((a, b) => b.before - a.before)[0] ?? null;
  const rel = known && before > 0 ? clamp01((before - after) / before) : 0.3;
  return { sgn, groups, before, after, loss: known ? Math.max(0, before - after) : null, faction: lead?.faction ?? null,
    // what became of the side: the one function the title and the report ask too (people/outcome.mjs)
    fate: sideOutcome(list),
    // the side's player: a nation's side has its character behind its line (a camp has none)
    character: lead && lead.kind !== 'camp' && lead.faction >= 0 && lead.faction < NEUTRAL ? MOTION_LEADERS[lead.faction].key : null,
    // how far each contact throws this side back (figure heights): more the more it lost; the last blow is the hardest for the side that broke
    kb: HIT_POWER.map((p, j) => (0.1 + 0.2 * rel) * (j === HIT_POWER.length - 1 ? 1.5 : 1) * p) };
}

const plans = new WeakMap();
/**
 * The staging of a scene, worked out once: per tile its centre, whether two
 * sides met there (`fight`), and for each side its groups, their formation
 * and which figure falls at which contact.
 */
export function battlePlan(scene) {
  let plan = plans.get(scene);
  if (plan) return plan;
  plan = { residents: !!scene.residents, tiles: scene.tiles.map(tile => {
    const h = tile.hex ?? tileHex(scene.p, scene.q, tile.idx);
    const sides = [sideOf(tile.attackers ?? [], -1, tile.idx), sideOf(tile.defenders ?? [], 1, tile.idx)];
    const fight = sides.every(s => s.groups.length > 0);
    return { idx: tile.idx, q: h.q, r: h.r, c: project(h.q, h.r), sides, fight, village: tile.village ?? null, wins: fight ? exchangeWinners(sides[0], sides[1]) : [] };
  }) };
  plans.set(scene, plan);
  return plan;
}

/** Where a tile's scene stands at a zoom: its centre, the figure height `s`, the point of contact and each side's middle (world px). */
export function battleStage(tile, zoom, fit = 1, layout = null) {
  // (a fight in passing before a village: a little smaller, so that the whole of it, numbers to strength bars, stands
  // between the village's foot and the foot of the picture where the camera already is)
  const s = figureSize(zoom, fit, layout) * (tile.village && !layout ? PASSING_AT_VILLAGE : 1), cx = tile.c.x, cy = tile.c.y + RADIUS * 0.12 + villageDrop(tile.village, s), rest = layout?.rest ?? REST;
  return { s, cx, cy, rest, contact: { x: cx, y: cy - s * 0.48 }, feet: { x: cx, y: cy + s * 0.05 },
    left: { x: cx - MEET * s, y: cy }, right: { x: cx + MEET * s, y: cy } };
}

/**
 * How far below its tile's centre a scene stands when the tile holds a village (world px; `s` a figure's height):
 * past the village's foot (its palisade, by tier and by the scale it is drawn at: map/village.mjs, map/plates.mjs),
 * then the height of the scene's own rear rank and of the numbers over it. The fight is on the ground before the
 * village, and nothing of it is drawn over the houses (UX design 13.6). 0 for a tile without one.
 */
export const PASSING_AT_VILLAGE = 0.82;
export function villageDrop(village, s) {
  if (!village) return 0;
  const t = Math.max(0, Math.min(3, Number.isInteger(village.tier) ? village.tier : 1)), scale = village.own ? HERO.scale : VILLAGE_SCALE;
  const foot = (village.own ? HERO.at.y : VILLAGE_AT.y) + RADIUS * VILLAGE.ring[t] * scale * FLATTEN * 0.8;
  return foot + RADIUS * 0.1 + s * (NEED.above + 0.2);
}

/**
 * Who has the better of each contact, from the record's own losses: `[sgn]`, one for each of BATTLE_HITS, −1 the
 * attackers, +1 the defenders, 0 neither (the losses are not known, or nobody lost anything). The last blow goes to
 * the side that holds the field (else to the one that lost the smaller share); of the others, each side wins as
 * many as the other's share of the losses calls for. The players' characters strike and take blows by it.
 */
export function exchangeWinners(A, D) {
  const n = BATTLE_HITS.length, rel = s => (s.loss !== null && s.before > 0 ? clamp01(s.loss / s.before) : null);
  const a = rel(A), d = rel(D);
  if (a === null || d === null || (a === 0 && d === 0)) return Array(n).fill(0);
  const holds = (D.fate === 'Stays') !== (A.fate === 'Stays') ? (D.fate === 'Stays' ? 1 : -1) : a === d ? 0 : a > d ? 1 : -1;
  if (holds === 0) return Array.from({ length: n }, (_, j) => (j % 2 ? 1 : -1));
  // (the holder's count: the other side's share of all that was lost, one at the least: the last blow is its own)
  const mine = Math.max(1, Math.min(n, Math.round(n * (holds > 0 ? a : d) / (a + d))));
  const out = Array(n).fill(holds);
  [1, 0, 2].slice(0, n - mine).forEach(j => { out[j] = -holds; });
  return out;
}

/** A character's clips in a scene (seconds): the strike begins `lead` before its contact and is over in `secs`; a blow is taken from the contact on. */
export const CHARACTER_CLIP = Object.freeze({ attack: Object.freeze({ lead: 0.24, secs: 0.56 }), hit: Object.freeze({ lead: 0, secs: 0.5 }) });
/** Where a side's character stands: this far behind its formation's middle and this far upstage (figure heights), and how large (of a figure's height unit: the size it has on the board beside a host). */
export const CHARACTER_STAND = Object.freeze({ back: 1.3, up: 0.35, scale: 1 });
const IDLE_SECS = LEADER_MOTIONS.find(m => m.key === 'idle').duration;
/**
 * What the character of the side with sign `sgn` does at posed time `tau` (scene seconds `t` for the idle loop):
 * `{motion: 'idle' | 'attack' | 'hit', share, looping}`. The latest exchange whose clip has begun decides.
 */
export function characterAct(wins, sgn, tau, t = tau) {
  for (let j = BATTLE_HITS.length - 1; j >= 0; j--) {
    const w = wins?.[j];
    if (!w) continue;
    const strike = w === sgn, c = strike ? CHARACTER_CLIP.attack : CHARACTER_CLIP.hit, t0 = BATTLE_HITS[j] - c.lead;
    if (tau < t0) continue;
    if (tau < t0 + c.secs) return { motion: strike ? 'attack' : 'hit', share: (tau - t0) / c.secs, looping: false };
    break;
  }
  return { motion: 'idle', share: t / IDLE_SECS, looping: true };
}

/**
 * How a clash ended, from its fates (never guessed): `{kind, winner, side,
 * camp, tile}`. `kind`: 'taken' the attackers hold the tile and the
 * defenders are gone; 'cleared' the same against a camp; 'held' the
 * defenders stand and the attackers are gone; 'standoff' both remain;
 * 'ruin' neither; 'arrived' nobody stood against the arrivals; 'none' an
 * outcome the page does not know yet. `winner` is the nation that holds
 * the tile (null for none or the neutral camp).
 */
export function battleVerdict(scene) {
  const tile = [...(scene?.tiles ?? [])].sort((a, b) => [...b.attackers, ...b.defenders].reduce((n, x) => n + x.before, 0) - [...a.attackers, ...a.defenders].reduce((n, x) => n + x.before, 0))[0];
  if (!tile) return { kind: 'none', winner: null, side: null, camp: false, tile: null };
  const A = tile.attackers ?? [], D = tile.defenders ?? [];
  const camp = D.some(x => x.kind === 'camp');
  const out = (kind, side = null) => {
    const list = side === 'attackers' ? A : side === 'defenders' ? D : [];
    const w = [...list].filter(x => x.fate === 'Stays' && x.faction < NEUTRAL).sort((a, b) => (b.after ?? b.before) - (a.after ?? a.before))[0];
    return { kind, winner: w ? w.faction : null, side, camp, tile: tile.idx };
  };
  if (!D.length) return out(A.some(x => x.fate === 'Stays') ? 'arrived' : 'none', 'attackers');
  if ([...A, ...D].some(x => !x.fate)) return out('none');
  const stays = list => list.some(x => x.fate === 'Stays' && x.after !== 0);
  const a = stays(A), d = stays(D);
  if (a && d) return out('standoff');
  if (a) return out(camp ? 'cleared' : 'taken', 'attackers');
  if (d) return out('held', 'defenders');
  return out('ruin');
}

// ------------------------------------------------------------------ drawing
const INK = '#0c1614', IVORY = '#f4efe0', BRASS = '#c9a24a', BRASS_HI = '#f0d48a', EMBER = '#e2553d';
const SANS = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp01(a).toFixed(3)})`; };

/** Text with a dark outline, readable on any ground. `px` is its size in world units. */
/**
 * What stands on the tilted board stands upright (map/tilt.mjs standing): the figures, the holder's standard and
 * the scene's own numbers. `paintBattle` sets it for one painting (`up(x, y)` of the map, or null on a flat board).
 */
let UP = null;
const upright = (ctx, x, y, draw) => standing(ctx, UP ? UP(x, y) : null, x, y, draw);

/** The serif of names, titles and captions (UX-DESIGN §6; the same stack as fx/effects.mjs SERIF). */
const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", Georgia, "Times New Roman", serif';
/** The size of an outcome caption's letters on screen (px), and its plate's height. */
export const FATE_PX = 13;
export const FATE_PLATE_PX = 23;
/**
 * A caption on a small bell-metal tag, upright, its middle at (x, y): the outcome under a side's losses
 * (戦場に残った, 壊滅した …). Bell metal, a brass hairline, the accent down its left edge, ivory letters in the
 * serif: the same tag as every caption of the map (fx/effects.mjs `tag`), drawn here because the scene is one
 * painting. `k` is one screen pixel in the context's units. Returns the plate's half width in those units.
 */
function plateText(ctx, text, x, y, k, { accent = BRASS, alpha = 1 } = {}) {
  if (alpha <= 0.01 || !text) return 0;
  let hw = 0;
  upright(ctx, x, y, () => {
    ctx.save();
    ctx.translate(x, y); ctx.scale(k, k);
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${FATE_PX}px ${SERIF}`;
    const w = (ctx.measureText?.(text)?.width ?? String(text).length * FATE_PX) / 2 + 10, h = FATE_PLATE_PX / 2;
    hw = w * k;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(-w, -h, w * 2, h * 2, 3); else ctx.rect?.(-w, -h, w * 2, h * 2);
    const g = ctx.createLinearGradient?.(0, -h, 0, h);
    if (g?.addColorStop) { g.addColorStop(0, '#1d3a33'); g.addColorStop(0.72, '#10221f'); ctx.fillStyle = g; } else ctx.fillStyle = '#10221f';
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = rgba(BRASS, 0.92); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = accent; ctx.fillRect?.(-w + 1, -h + 2, 2.5, h * 2 - 4);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = IVORY; ctx.fillText?.(text, 1.5, 0.5);
    ctx.restore();
  });
  return hw;
}
function inkText(ctx, text, x, y, px, color, opts = {}) { if (opts.alpha !== undefined && opts.alpha <= 0.01) return; upright(ctx, x, y, () => inkTextFlat(ctx, text, x, y, px, color, opts)); }
function inkTextFlat(ctx, text, x, y, px, color, { align = 'center', weight = 800, alpha = 1, scale = 1 } = {}) {
  if (alpha <= 0.01 || !text) return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(scale * px / 32, scale * px / 32);
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} 32px ${SANS}`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.strokeStyle = rgba(INK, 0.94); ctx.lineWidth = 6.5; ctx.strokeText?.(text, 0, 0);
  ctx.fillStyle = color; ctx.fillText?.(text, 0, 0);
  ctx.restore();
}

/** How much of a miniature's baked cast shadow a battle keeps (people/minis.mjs `shade`): the lines stand close, and the full shadows piled into one dark mass under them. */
export const FIGURE_SHADE = 0.42;
/** How much light a blow adds to a struck figure, and for how long (s): two frames at full, gone before the hit-stop ends (UX-DESIGN §11.14). */
export const HIT_TINT = 0.6;
export const HIT_TINT_SECS = Object.freeze([0.034, 0.07]);
/** The tint of a blow at `since` seconds after its contact frame (0..1 of HIT_TINT). */
export const hitTint = since => (since < 0 ? 0 : since < HIT_TINT_SECS[0] ? 1 : 1 - span(since, HIT_TINT_SECS[0], HIT_TINT_SECS[1]));
/** Start loading the sheets a scene will need (so its first frames already have their figures). */
export function preloadBattle(scene) {
  for (const tile of scene?.tiles ?? []) for (const x of [...(tile.attackers ?? []), ...(tile.defenders ?? [])]) {
    const nation = x.faction >= 0 && x.faction < 6;
    preloadMinis(nation ? x.faction : null);
    // the side's player (a nation's side): the three sheets its character plays in a scene
    if (nation && x.kind !== 'camp') for (const m of ['idle', 'attack', 'hit']) leaderMotionSheet(MOTION_LEADERS[x.faction].key, m);
  }
}

function paintFigure(ctx, f) { if (f.alpha > 0.02) { if (f.character) paintCharacterFigure(ctx, f); else upright(ctx, f.x, f.y, () => paintFigureFlat(ctx, f)); } }
/** A side's character: a soft shadow on the ground, the figure upright on it (people/leader-motion.mjs; nothing until its sheet is here). */
function paintCharacterFigure(ctx, f) {
  ctx.save();
  ctx.globalAlpha *= 0.3 * f.alpha; ctx.fillStyle = '#0a120f';
  ctx.beginPath(); ctx.ellipse?.(f.x + f.s * 0.05, f.y + f.s * 0.02, f.s * 0.32, f.s * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  upright(ctx, f.x, f.y, () => paintLeaderMotion(ctx, f.x, f.y, f.s, { leader: f.character, motion: f.motion, share: f.share, looping: f.looping, face: f.face, alpha: f.alpha, own: false }));
}
function paintFigureFlat(ctx, f) {
  if (f.alpha <= 0.02) return;
  ctx.save();
  ctx.translate(f.x, f.y - f.hop);
  if (f.rot) ctx.rotate(f.rot);
  if (f.sx !== 1 || f.sy !== 1) ctx.scale(f.sx, f.sy);
  // a host's figure: the one painter of the host art (people/minis.mjs paintMini: a nation's miniature, or the
  // camp's; the blow's light on it for a frame or two)
  const nation = f.faction >= 0 && f.faction < 6;
  const o = { faction: f.faction, face: f.face, step: f.step, walking: f.walking, alpha: f.alpha, shade: FIGURE_SHADE, camp: !nation, flash: f.flash > 0.02 ? f.flash * HIT_TINT : 0 };
  // until its sheet has loaded a figure is only the shadow it will stand on (a page with no sheets at all draws the plain canvas figure)
  if (!paintMini(ctx, 0, 0, f.s, f.kind, o)) {
    if (typeof globalThis.Image === 'undefined') { baseDisc(ctx, 0, 0, f.s, f.faction, { alpha: f.alpha }); unitFigure(ctx, 0, -f.s * 0.02, f.s, f.kind, o); }
    else { ctx.fillStyle = `rgba(12,22,20,${(0.28 * f.alpha).toFixed(3)})`; ctx.beginPath(); ctx.ellipse?.(0, 0, f.s * 0.3, f.s * 0.12, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

/** How a group stands at scene time `t` (posed at `tau`): its advance toward the enemy, its lean, whether it walks, its alpha and facing. */
function groupState(T, side, g, t, tau, residents, ENGAGE = REST - MEET) {
  const sgn = side.sgn;
  let adv = 0, lean = 0, alpha = 1, walking = false, face = -sgn, hop = 0, hit = -1;
  // out of the mist on the tile it arrived at (never from a direction)
  if (sgn < 0 && !residents) alpha = span(t, 0.15, 0.95);
  if (t >= PHASE.deploy && t < PHASE.deploy + 0.85) walking = true;
  if (T.fight) {
    const h0 = BATTLE_HITS[0];
    if (tau >= h0) {
      hit = 0;
      while (hit + 1 < BATTLE_HITS.length && BATTLE_HITS[hit + 1] <= tau) hit++;
    }
    if (!g.ranged && tau >= h0 - 0.3) {
      if (tau < h0 - 0.15) { const u = outQuad((tau - (h0 - 0.3)) / 0.15); adv = -0.1 * u; lean = -0.12 * u; }                 // anticipation, 150 ms: they draw back
      else if (tau < h0) { const u = (tau - (h0 - 0.15)) / 0.15; adv = lerp(-0.1, ENGAGE + 0.08, inCubic(u)); lean = lerp(-0.12, 0.18, u); walking = true; hop = Math.sin(u * Math.PI) * 0.07; }
      else {
        const u = tau - BATTLE_HITS[hit], kb = side.kb[hit];
        const thrown = u < 0.06 ? outCubic(u / 0.06) : 1 - inOutQuad(span(u, 0.06, 0.2));
        adv = ENGAGE + 0.08 * (1 - span(u, 0, 0.1)) - kb * thrown;
        lean = 0.18 * (1 - span(u, 0, 0.08)) - 0.24 * Math.min(1.4, kb / 0.2) * thrown;
        const nx = BATTLE_HITS[hit + 1];
        if (nx !== undefined && tau >= nx - 0.26) {
          if (tau < nx - 0.15) { const v = outQuad((tau - (nx - 0.26)) / 0.11); adv = ENGAGE - 0.12 * v; lean = -0.12 * v; }
          else { const v = (tau - (nx - 0.15)) / 0.15; adv = lerp(ENGAGE - 0.12, ENGAGE + 0.08, inCubic(v)); lean = lerp(-0.12, 0.18, v); hop = Math.sin(v * Math.PI) * 0.07; }
        }
      }
    }
    if (g.ranged && tau >= h0 - 0.42) {
      // the loose: a small recoil each time the volley leaves
      for (const h of BATTLE_HITS) { const u = tau - (h - 0.4); if (u >= 0 && u < 0.2) lean = -0.1 * Math.sin((u / 0.2) * Math.PI); }
    }
  }
  // the fates
  const fk = span(t, PHASE.fates + 0.14, PHASE.fates + 1.4);
  if (fk > 0 && g.fate) {
    if (g.fate === 'Stays') { adv = lerp(adv, T.fight ? 0.26 : 0, smooth(span(fk, 0, 0.5))); const c = t - (PHASE.fates + 0.7); if (c > 0 && c < 1.1) hop = Math.abs(Math.sin(c * Math.PI * 2.4)) * 0.09 * (1 - c / 1.1); }
    else if (g.fate === 'Retreated' || g.fate === 'Withdrew') { adv -= 1.0 * smooth(fk); alpha *= 1 - 0.92 * smooth(fk); walking = true; face = sgn; lean = 0; }
    else if (g.fate === 'Bounced') { adv -= 0.85 * outExpo(fk); alpha *= 1 - 0.88 * smooth(span(fk, 0.35, 1)); }
  }
  return { adv, lean, alpha, walking, face, hop, hit };
}

/** The sides' share of their losses dealt by scene time `t` (0..1), stepping at each contact; `lag` delays it (the pale ghost of the bar). */
function lossShare(t, lag = 0) {
  let k = 0, prev = 0;
  for (let j = 0; j < BATTLE_HITS.length; j++) { k += (LOSS_BY_HIT[j] - prev) * outCubic(span(t, BATTLE_HITS[j] + lag, BATTLE_HITS[j] + lag + (lag ? 0.4 : 0.14))); prev = LOSS_BY_HIT[j]; }
  return k;
}

function paintMist(ctx, x, y, s, t, amount) {
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + t * 0.35, px = x + Math.cos(a) * s * (0.5 + 0.25 * (i % 2)), py = y - s * 0.15 + Math.sin(a) * s * 0.3;
    const r = s * (0.55 + 0.12 * (i % 3));
    const g = ctx.createRadialGradient?.(px, py, 0, px, py, r);
    if (g?.addColorStop) { g.addColorStop(0, `rgba(240,243,246,${(0.3 * amount).toFixed(3)})`); g.addColorStop(0.5, `rgba(240,243,246,${(0.16 * amount).toFixed(3)})`); g.addColorStop(1, 'rgba(240,243,246,0)'); ctx.fillStyle = g; }
    else ctx.fillStyle = `rgba(240,243,246,${(0.2 * amount).toFixed(3)})`;
    ctx.beginPath(); ctx.ellipse?.(px, py, r, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  }
}

/** One arrow of a volley at flight share `u`: a pale trail along its arc, a dark shaft with a light edge, a head. */
function paintArrow(ctx, a, b, u, s, k, alpha) {
  const H = s * 0.95;
  const at = v => ({ x: lerp(a.x, b.x, v), y: lerp(a.y, b.y, v) - Math.sin(v * Math.PI) * H });
  ctx.save();
  ctx.lineCap = 'round';
  const N = 6;
  for (let i = 0; i < N; i++) {
    const v0 = Math.max(0, u - 0.3 * (1 - i / N)), v1 = Math.max(0, u - 0.3 * (1 - (i + 1) / N));
    const p0 = at(v0), p1 = at(v1);
    ctx.strokeStyle = `rgba(255,246,220,${(alpha * 0.9 * ((i + 1) / N) ** 1.6).toFixed(3)})`; ctx.lineWidth = (1.2 + 2.4 * (i + 1) / N) * k;
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
  }
  const p = at(u), q = at(Math.max(0, u - 0.07));
  const dx = p.x - q.x, dy = p.y - q.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, L = s * 0.3;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#2a1c10'; ctx.lineWidth = 3.2 * k; ctx.beginPath(); ctx.moveTo(p.x - ux * L, p.y - uy * L); ctx.lineTo(p.x, p.y); ctx.stroke();
  ctx.strokeStyle = '#f1e2bd'; ctx.lineWidth = 1 * k; ctx.beginPath(); ctx.moveTo(p.x - ux * L, p.y - uy * L - 0.6 * k); ctx.lineTo(p.x - ux * L * 0.2, p.y - uy * L * 0.2 - 0.6 * k); ctx.stroke();
  ctx.fillStyle = '#d7dde0'; ctx.beginPath(); ctx.moveTo(p.x + ux * 3 * k, p.y + uy * 3 * k); ctx.lineTo(p.x - ux * 3 * k - uy * 2.6 * k, p.y - uy * 3 * k + ux * 2.6 * k); ctx.lineTo(p.x - ux * 3 * k + uy * 2.6 * k, p.y - uy * 3 * k - ux * 2.6 * k); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/**
 * The mark of a contact: a small star where the lines meet, a tight core of light in the two sides' colours, a
 * low shock on the ground. `colA`, `colB`: the light of the side that lands this blow and of the other (the
 * core); `ringL`, `ringR`: the nation's own colour of the side standing on the left and on the right (the shock);
 * `starA`, `starB`: the nations' own colours of the side that lands the blow and of the other (the star: its four
 * long points in the first, the four short ones between them in the second, on a dark keyline, a small ivory heart:
 * UX design 13.6, it was plain ivory).
 */
function paintContact(ctx, st, u, power, colA, colB, k, ringL = colA, ringR = colB, starA = ringL, starB = ringR) {
  const { contact: c, feet, s } = st;
  if (u < 0 || u >= 0.4) return;
  ctx.save();
  // the shock running out along the ground: each half in the colour of the nation that stands on it, at full
  // strength (it was the two pale tints through ivory at 0.62, and read as one ivory ring)
  const kr = u / 0.4, rr = lerp(s * 0.3, s * 1.5 * Math.sqrt(power), outExpo(kr));
  const ring = ctx.createLinearGradient?.(feet.x - rr, 0, feet.x + rr, 0), ra = 0.92 * (1 - kr) * (1 - kr * 0.6);
  const stroke = w => { ctx.lineWidth = w; ctx.beginPath(); ctx.ellipse?.(feet.x, feet.y, rr, rr * FLATTEN * 0.62, 0, 0, Math.PI * 2); ctx.stroke(); };
  // (a dark seat under it, so the colours hold on pale ground and on dark)
  ctx.strokeStyle = rgba(INK, 0.3 * (1 - kr)); stroke(lerp(10, 4, outCubic(kr)) * k);
  if (ring?.addColorStop) { ring.addColorStop(0, rgba(ringL, ra)); ring.addColorStop(0.44, rgba(ringL, ra)); ring.addColorStop(0.56, rgba(ringR, ra)); ring.addColorStop(1, rgba(ringR, ra)); ctx.strokeStyle = ring; }
  else ctx.strokeStyle = rgba(ringL, ra);
  stroke(lerp(7.5, 2.6, outCubic(kr)) * k);
  ctx.globalCompositeOperation = 'lighter';
  const kb = span(u, 0, 0.16);
  if (kb < 1) {
    const r = lerp(s * 0.16, s * 0.46 * Math.sqrt(power), outCubic(kb));
    const g = ctx.createRadialGradient?.(c.x, c.y, 0, c.x, c.y, r);
    if (g?.addColorStop) {
      g.addColorStop(0, `rgba(255,250,236,${(0.9 * (1 - kb)).toFixed(3)})`); g.addColorStop(0.4, rgba(colA, 0.55 * (1 - kb)));
      g.addColorStop(0.75, rgba(colB, 0.3 * (1 - kb))); g.addColorStop(1, rgba(colB, 0));
      ctx.fillStyle = g;
    } else ctx.fillStyle = `rgba(255,255,255,${(0.4 * (1 - kb)).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
  }
  // the star: four points and four short ones between them, stabbing out and dying back within a quarter second
  const ks = span(u, 0, 0.24);
  if (ks < 1) {
    const len = s * 0.56 * Math.sqrt(power) * outBack(Math.min(1, ks * 2.6), 2.2) * (1 - inQuad(ks));
    const wd = Math.max(1.6 * k, s * 0.07 * (1 - ks)), fade = 1 - ks * ks;
    // (painted, not added as light: on a bright ground light in two colours burns out to white)
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineJoin = 'round';
    const points = (odd, fill) => {
      ctx.beginPath();
      for (let i = odd; i < 8; i += 2) {
        const ang = (i / 8) * Math.PI * 2 + 0.2, L1 = len * (i % 2 ? 0.5 : 1) * (i % 4 === 0 ? 1.15 : 1);
        const ax = Math.cos(ang), ay = Math.sin(ang);
        ctx.moveTo(c.x - ay * wd, c.y + ax * wd); ctx.lineTo(c.x + ax * L1, c.y + ay * L1); ctx.lineTo(c.x + ay * wd, c.y - ax * wd); ctx.closePath();
      }
      ctx.strokeStyle = rgba(INK, 0.7 * fade); ctx.lineWidth = 2.2 * k; ctx.stroke();
      ctx.fillStyle = rgba(fill, 0.97 * fade); ctx.fill();
    };
    points(1, starB); points(0, starA);
    ctx.fillStyle = `rgba(255,248,226,${(0.95 * fade).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(1.5 * k, wd * 1.25), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** The holder's standard, planted when the fates are known: a pole, a swallow-tail pennon in the nation's colour, a gold finial. */
function paintStandard(ctx, x, y, s, faction, t, k) { upright(ctx, x, y, () => paintStandardFlat(ctx, x, y, s, faction, t, k)); }
function paintStandardFlat(ctx, x, y, s, faction, t, k) {
  const up = outBack(span(t, PHASE.fates + 0.55, PHASE.fates + 1.0), 1.6);
  if (up <= 0) return;
  const col = sideColors(faction), top = y - s * 1.75 * up, wv = Math.sin(t * 5.2) * s * 0.05, wv2 = Math.sin(t * 5.2 + 1.1) * s * 0.07;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(12,22,20,.55)'; ctx.lineWidth = s * 0.085; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
  ctx.strokeStyle = '#6b4a2e'; ctx.lineWidth = s * 0.05; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
  const w = s * 0.82 * up, h = s * 0.44 * up;
  ctx.beginPath();
  ctx.moveTo(x, top + s * 0.04); ctx.quadraticCurveTo(x + w * 0.5, top + s * 0.04 + wv, x + w, top + s * 0.02 + wv2);
  ctx.lineTo(x + w * 0.74, top + s * 0.04 + h * 0.5 + wv2); ctx.lineTo(x + w, top + s * 0.04 + h + wv2);
  ctx.quadraticCurveTo(x + w * 0.5, top + s * 0.04 + h + wv, x, top + s * 0.04 + h); ctx.closePath();
  ctx.fillStyle = col.fill; ctx.fill(); ctx.strokeStyle = col.dark; ctx.lineWidth = Math.max(1.2 * k, s * 0.03); ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.fillRect(x + s * 0.03, top + s * 0.07, w * 0.5, h * 0.2);
  ctx.fillStyle = BRASS_HI; ctx.strokeStyle = '#7d6428'; ctx.lineWidth = 1 * k; ctx.beginPath(); ctx.arc(x, top, s * 0.065, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function sigilOn(ctx, x, y, r, faction, alpha) {
  const col = sideColors(faction);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = IVORY; ctx.strokeStyle = col.dark; ctx.lineWidth = r * 0.16;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = FACTION_MARK[faction] ?? col.fill;   // (on ivory: three of the fills are too light to carry a mark)
  let drawn = false;
  try {
    if (typeof globalThis.Path2D === 'function') { ctx.translate(x, y); ctx.fill(new globalThis.Path2D(sigilPath(faction < 6 ? faction : -1, r * 0.55))); drawn = true; }
  } catch { drawn = false; }
  if (!drawn) { ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

/** Two crossed swords, centred at (x, y), `r` their half length. */
export function crossedSwords(ctx, x, y, r, { color = BRASS_HI, ink = INK, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha; ctx.lineCap = 'round';
  for (const pass of [0, 1]) for (const d of [-1, 1]) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(d * Math.PI / 4);
    ctx.strokeStyle = pass ? color : ink;
    ctx.lineWidth = r * (pass ? 0.16 : 0.34); ctx.beginPath(); ctx.moveTo(0, r * 0.62); ctx.lineTo(0, -r); ctx.stroke();                 // blade
    ctx.lineWidth = r * (pass ? 0.14 : 0.3); ctx.beginPath(); ctx.moveTo(-r * 0.3, r * 0.5); ctx.lineTo(r * 0.3, r * 0.5); ctx.stroke();    // guard
    ctx.lineWidth = r * (pass ? 0.2 : 0.36); ctx.beginPath(); ctx.moveTo(0, r * 0.62); ctx.lineTo(0, r * 0.95); ctx.stroke();              // grip
    ctx.restore();
  }
  ctx.restore();
}

/** The two strength bars over the scene: each side's sigil, its troops counting down, a fill that drains at each contact with a pale ghost behind it. */
function paintBars(ctx, T, st, t, k, numText, nameText, show, fit = 1, layout = null) {
  if (show <= 0.01) return;
  const bf = Math.max(0.62, Math.min(1, fit * 1.2));
  const BW = (layout?.bar ?? 176 * bf) * k, BH = 14 * k, GAP = (layout ? Math.max(34, Math.min(56, layout.bar * 0.3)) : 52 * bf) * k, y = st.cy + st.s * NEED.below + 34 * k;
  const share = lossShare(t), ghost = lossShare(t, 0.32);
  let hit = 0;
  for (const h of BATTLE_HITS) { const u = t - h; if (u >= 0 && u < 0.16) hit = 1 - u / 0.16; }
  ctx.save();
  // one plate of bell metal under both bars, their numbers and their names (the second review: the names and the
  // counts were bare letters on the land)
  {
    const half = GAP / 2 + BW + 12 * k, top = y - 9 * k, h = BH + 36 * k;
    ctx.globalAlpha = show;
    ctx.beginPath(); ctx.roundRect?.(st.cx - half, top, half * 2, h, 9 * k);
    const metal = ctx.createLinearGradient?.(0, top, 0, top + h);
    if (metal?.addColorStop) { metal.addColorStop(0, 'rgba(24,46,41,.9)'); metal.addColorStop(1, 'rgba(10,22,20,.9)'); ctx.fillStyle = metal; } else ctx.fillStyle = 'rgba(12,22,20,.88)';
    ctx.fill(); ctx.strokeStyle = rgba(BRASS, 0.7); ctx.lineWidth = 1 * k; ctx.stroke();
  }
  for (const side of T.sides) {
    const d = side.sgn, col = sideColors(side.faction);
    const inner = st.cx + d * (GAP / 2), outer = inner + d * BW, x0 = Math.min(inner, outer);
    const slide = (1 - show) * 18 * k * d, jolt = hit * 2.5 * k * Math.sin(t * 90);
    ctx.globalAlpha = show;
    // the plate: bell metal with a brass line
    ctx.beginPath(); ctx.roundRect?.(x0 - 3 * k + slide, y - 3 * k + jolt, BW + 6 * k, BH + 6 * k, 5 * k);
    ctx.fillStyle = 'rgba(12,22,20,.92)'; ctx.fill(); ctx.strokeStyle = rgba(BRASS, 0.95); ctx.lineWidth = 1.2 * k; ctx.stroke();
    const known = side.loss !== null && side.before > 0;
    const now = known ? 1 - (side.loss / side.before) * share : 1, was = known ? 1 - (side.loss / side.before) * ghost : 1;
    // filled from the sigil's end; what a blow has just taken shows pale for a moment
    ctx.fillStyle = 'rgba(255,244,222,.9)'; ctx.fillRect((d < 0 ? outer : outer - BW * was) + slide, y + jolt, BW * was, BH);
    const g = ctx.createLinearGradient?.(0, y, 0, y + BH);
    if (g?.addColorStop) { g.addColorStop(0, col.light); g.addColorStop(0.3, col.fill); g.addColorStop(1, col.dark); ctx.fillStyle = g; } else ctx.fillStyle = col.fill;
    ctx.fillRect((d < 0 ? outer : outer - BW * now) + slide, y + jolt, BW * now, BH);
    ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fillRect((d < 0 ? outer : outer - BW * now) + slide, y + jolt + 1.5 * k, BW * now, 2 * k);
    // quarter marks
    ctx.fillStyle = 'rgba(12,22,20,.5)';
    for (let q = 1; q < 4; q++) ctx.fillRect(x0 + (BW * q) / 4 - 0.5 * k + slide, y + jolt, 1 * k, BH);
    sigilOn(ctx, outer + d * 19 * k + slide, y + BH / 2 + jolt, 15 * k, side.faction, show);
    const cur = known ? Math.round(side.before - side.loss * share) : side.before;
    inkText(ctx, numText(cur), outer - d * 1 * k + slide, y + BH + 17 * k, 19 * k, IVORY, { align: d < 0 ? 'left' : 'right', alpha: show });
    const name = nameText ? nameText(side) : '';
    if (name) inkText(ctx, name, inner + slide, y + BH + 17 * k, 13 * k, col.light, { align: d < 0 ? 'right' : 'left', alpha: show * 0.95, weight: 700 });
  }
  ctx.globalAlpha = 1;
  crossedSwords(ctx, st.cx, y + BH / 2, 14 * k * (1 + 0.25 * hit), { alpha: show });
  ctx.restore();
}

/** The size of a loss number on screen (px): the running total after each contact, and the record's own total at the end. */
export const LOSS_PX = 28;
export const LOSS_PX_FINAL = 32;
/** A number is there at full opacity on its first frame, 1.3 times its size, and settles to 1.0 in 120 ms (UX-DESIGN §11.14). */
export const LOSS_POP = Object.freeze({ from: 1.3, secs: 0.12 });

/**
 * The numbers over a side: the running total of its losses, struck again at each contact; the record's own total
 * and the fate at the end. Ivory with an ink outline, readable from the first exchange. `e.place(x, y, halfW,
 * halfH)` (the effects layer's) keeps a number inside what the HUD leaves free.
 */
function paintLosses(ctx, side, st, t, k, e) {
  const { lossText, fateText, numText, layout } = e;
  let hit = -1;
  for (let j = 0; j < BATTLE_HITS.length; j++) if (t >= BATTLE_HITS[j]) hit = j;
  if (hit < 0) return;
  const last = hit === BATTLE_HITS.length - 1;
  const narrow = layout ? layout.rest < REST : e.fit < 0.8;
  const size = (last ? (narrow ? LOSS_PX : LOSS_PX_FINAL) : LOSS_PX) * k;
  const final = side.loss ? lossText(side.loss) : '';
  const n = side.loss !== null && side.loss > 0 ? (last ? side.loss : Math.round(side.loss * LOSS_BY_HIT[hit])) : 0;
  const text = n > 0 ? (last ? final : `−${numText(n)}`) : '';
  // over its side; two long numbers never run into each other (each keeps to its half)
  let half = 0;
  if (text) { ctx.save(); ctx.font = `800 32px ${SANS}`; half = ((ctx.measureText?.(text)?.width ?? 0) * size) / 32 / 2; ctx.restore(); }
  const u = t - BATTLE_HITS[hit];
  const out = last ? 1 - inQuad(span(t, PHASE.end - 0.6, PHASE.end - 0.1)) : 1;
  const pop = lerp(LOSS_POP.from, 1, outCubic(span(u, 0, LOSS_POP.secs))), rise = 8 * k * outCubic(span(u, 0, 0.4));
  let x = st.cx + side.sgn * Math.max((st.rest + 0.2) * st.s, half + 8 * k), y = st.cy - st.s * NEED.above;
  if (e.place && text) { const at = e.place(x, y, half + 4 * k, size * 0.6 + (last ? (FATE_PLATE_PX + 6) * k : 0)); x = at.x; y = at.y; }
  if (text) inkText(ctx, text, x, y - rise, size, IVORY, { alpha: out, scale: pop });
  if (last && fateText) {
    // the outcome, on a tag of its own under the number: ember down its edge when nothing is left, else the side's colour
    const ft = side.fate ? fateText(side.fate) : null;
    if (ft) plateText(ctx, ft, x, y + size * 0.5 + (FATE_PLATE_PX / 2 + 5) * k - rise, k, { accent: side.after === 0 ? EMBER : sideColors(side.faction).fill, alpha: span(t, PHASE.fates + 0.45, PHASE.fates + 0.8) * out });
  }
}

function paintTile(ctx, T, e) {
  const { t, tau, k, residents } = e;
  const st = battleStage(T, e.zoom, e.fit, e.layout), s = st.s, cx = st.cx, cy = st.cy, REST = st.rest, ENGAGE = REST - MEET;
  // half the stage's width in world px (a layout made for a stage knows it): figures are kept inside it
  const edge = e.layout?.half > 0 ? e.layout.half / Math.max(0.05, e.zoom) : 0;
  const mist = residents ? 0 : 1 - span(t, 0.55, 1.5);
  if (mist > 0.01 && T.sides[0].groups.length) paintMist(ctx, cx - REST * s, cy - s * 0.3, s * 1.3, t, mist);
  // the figures, back to front
  const figs = [], volleys = [];
  let hit = -1;
  for (let j = 0; j < BATTLE_HITS.length; j++) if (t >= BATTLE_HITS[j]) hit = j;
  const sinceHit = hit >= 0 ? t - BATTLE_HITS[hit] : Infinity;
  for (const side of T.sides) for (const g of side.groups) {
    const gs = groupState(T, side, g, t, tau, residents, ENGAGE);
    for (const f of g.figs) {
      // from a loose crowd into the stance's formation
      const dk = outBack(span(t, PHASE.deploy + f.j * 0.22, PHASE.deploy + 0.6 + f.j * 0.22), 1.25);
      const px = lerp(f.fx * 0.5 - 0.22 + (f.j - 0.5) * 0.34, f.fx, dk), py = lerp((f.fy - g.off) * 0.55 + g.off + (hash(Math.round(f.j * 1e6), 5) - 0.5) * 0.3, f.fy, dk);
      let x = cx + side.sgn * ((REST - gs.adv * (f.front || g.ranged ? 1 : 0.88)) - px) * s - py * s * SKEW, y = cy + py * s * DEPTH;
      // (a narrow stage: the rear rank stands in from the edge of the picture, never half out of it)
      if (edge > 0) x = Math.max(cx - edge + s * 0.42, Math.min(cx + edge - s * 0.42, x));
      let alpha = gs.alpha, rot = -side.sgn * gs.lean, hop = gs.hop * s * (f.front ? 1 : 0.7), flash = 0, sx = 1, sy = 1, walking = gs.walking;
      if (T.fight && hit >= 0 && sinceHit < HIT_TINT_SECS[1] && (f.front || f.fall === hit)) flash = hitTint(sinceHit);
      if (T.fight && hit >= 0 && sinceHit < HIT_STOP && !g.ranged) { sx = 1.1; sy = 0.92; }
      if (f.fall >= 0 && tau >= BATTLE_HITS[f.fall]) {
        const h = BATTLE_HITS[f.fall], fk = outCubic(span(tau, h + 0.02, h + 0.44));
        x += side.sgn * 0.34 * s * fk; rot = side.sgn * 1.42 * fk; hop = Math.sin(Math.min(1, fk) * Math.PI) * s * 0.12;
        // the fallen lie where they fell until the field is left
        alpha *= (1 - 0.5 * fk) * (1 - span(t, PHASE.losses, PHASE.losses + 0.8)); walking = false;
      }
      figs.push({ x, y, s, kind: g.unit, faction: g.faction, face: gs.face, alpha, rot, hop, flash, sx, sy, walking, step: (t * (walking ? 1.8 : 0.6) + f.j) % 1 });
      if (T.fight && g.ranged && !(f.fall >= 0 && tau >= BATTLE_HITS[f.fall])) for (const w of [0, 1]) volleys.push({ x, y: y - s * 0.72, sgn: side.sgn, j: (f.j + w * 0.37) % 1 });
    }
  }
  // the players: each nation's side has its character behind its line, facing the enemy
  const t0c = residents ? PHASE.deploy : 0;
  for (const side of T.sides) {
    if (!side.character || !side.groups.length) continue;
    const act = characterAct(T.wins, side.sgn, tau, t);
    let x = cx + side.sgn * (REST + CHARACTER_STAND.back) * s, alpha = span(t, t0c + 0.2, t0c + 0.6) * (1 - span(t, PHASE.end - 0.5, PHASE.end - 0.1));
    // (a narrow stage: the whole figure stays in the picture, the near rows of a tilted board being drawn a little wider)
    if (edge > 0) x = Math.max(cx - edge + s * 0.56, Math.min(cx + edge - s * 0.56, x));
    // (it comes with its line out of the mist, and goes with it: a side that left the field walks off, one that fell is gone when the field is left)
    if (side.sgn < 0 && !residents) alpha *= span(t, 0.15, 0.95);
    const fk = span(t, PHASE.fates + 0.14, PHASE.fates + 1.4);
    if (fk > 0 && side.fate && side.fate !== 'Stays') alpha *= side.fate === 'Destroyed' ? 1 - span(t, PHASE.losses, PHASE.losses + 0.8) : 1 - 0.92 * smooth(fk);
    figs.push({ character: side.character, x, y: cy - CHARACTER_STAND.up * s, s: s * CHARACTER_STAND.scale, face: -side.sgn, alpha, motion: act.motion, share: act.share, looping: act.looping });
  }
  figs.sort((a, b) => a.y - b.y);
  for (const f of figs) paintFigure(ctx, f);
  // archers and crossbowmen: a volley in the air before each contact, landing with it
  if (volleys.length) for (const h of BATTLE_HITS) {
    for (const v of volleys.slice(0, 8)) {
      const T0 = h - 0.42 + v.j * 0.07, T1 = h - 0.02 + v.j * 0.03;
      if (t < T0 || t > T1 + 0.1) continue;
      const u = span(t, T0, T1);
      paintArrow(ctx, v, { x: cx - v.sgn * (REST - ENGAGE - 0.2 + v.j * 0.5) * s, y: cy - s * 0.3 + (v.j - 0.5) * s * 0.9 }, u, s, k, t > T1 ? 1 - span(t, T1, T1 + 0.1) : 1);
    }
  }
  if (T.fight) {
    const cA = sideColors(T.sides[0].faction), cB = sideColors(T.sides[1].faction);
    // (the attackers stand on the left, the defenders on the right: the shock's halves keep to their sides; the core's light alternates with the blow)
    // (the star: its long points in the colour of the nation that has the better of this contact, `T.wins`)
    for (let j = 0; j < BATTLE_HITS.length; j++) {
      const w = T.wins[j] || (j % 2 ? 1 : -1);
      paintContact(ctx, st, t - BATTLE_HITS[j], HIT_POWER[j], j % 2 ? cB.light : cA.light, j % 2 ? cA.light : cB.light, k, cA.fill, cB.fill, w < 0 ? cA.fill : cB.fill, w < 0 ? cB.fill : cA.fill);
    }
  }
  // the holder's standard
  const holder = T.sides.flatMap(sd => sd.groups.map(g => ({ g, sd }))).find(x => x.g.fate === 'Stays' && x.g.faction < NEUTRAL && x.g.after !== 0 && (!T.fight || x.sd.fate === 'Stays'));
  // (planted upstage of the side's character, so that its cloth flies over the character's head, not on it)
  if (holder && t >= PHASE.fates + 0.55) paintStandard(ctx, cx + holder.sd.sgn * (REST + 0.95) * s - holder.g.off * s * SKEW, cy + holder.g.off * s * DEPTH + s * (holder.sd.character ? -0.62 : 0.1), s * 0.86, holder.g.faction, t, k);
  if (T.fight) {
    const t0 = residents ? PHASE.deploy : 0;
    paintBars(ctx, T, st, t, k, e.numText, e.nameText, outCubic(span(t, t0 + 0.2, t0 + 0.6)) * (1 - span(t, PHASE.end - 0.6, PHASE.end - 0.15)), e.fit, e.layout);
    for (const side of T.sides) paintLosses(ctx, side, st, t, k, e);
  } else if (e.fateText && t >= PHASE.fates + 0.45) {
    const side = T.sides.find(sd => sd.groups.length);
    const ft = side?.fate ? e.fateText(side.fate) : null;
    if (ft) plateText(ctx, ft, cx + side.sgn * REST * s, cy - s * 1.7, k, { accent: sideColors(side.faction).fill, alpha: span(t, PHASE.fates + 0.45, PHASE.fates + 0.8) * (1 - span(t, PHASE.end - 0.6, PHASE.end - 0.1)) });
  }
}

/**
 * Draw a playing scene. `{zoom, now | at, fit (battleFit of the map's width), layout (battleLayout of the stage:
 * the scene fills it), place (keeps a number on the free part of the screen), lossText, fateText, numText, nameText(side)}`:
 * `at` gives the scene's own time directly (the effects layer plays it on
 * its clock). When the effects layer has taken a scene (`play.staged`: it
 * draws it above the dimmed map, fx/battle.mjs), the map's own call draws
 * nothing and only says whether the scene is still playing. Returns false
 * once it is over.
 */
export function paintBattle(ctx, play, { zoom = 1, now = wallNow(), at = null, top = false, fit = 1, layout = null, place = null, lossText = n => `−${n}`, fateText = null, numText = n => String(n), nameText = null, up = null } = {}) {
  if (!play) return false;
  const t = at ?? battleTime(play, now);
  if (t > PHASE.end) return false;
  if (play.staged && !top) return true;
  const plan = battlePlan(play.scene);
  const e = { t, tau: poseTime(t), zoom, k: 1 / Math.max(0.05, zoom), residents: plan.residents, fit, layout, place, lossText, fateText, numText, nameText };
  UP = typeof up === 'function' ? up : null;
  try { for (const T of plan.tiles) paintTile(ctx, T, e); } finally { UP = null; }
  ctx.globalAlpha = 1;
  return true;
}

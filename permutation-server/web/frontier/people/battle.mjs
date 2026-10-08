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
//                 held for 70 ms with the struck figures white, a knockback,
//                 and the losses so far struck over each side while its bar
//                 drains. Archers loose a volley before each contact.
//   4  4.0–5.6 s  the blow that decides it, then the fates (ClashInputs):
//                 Stays plants the standard, Retreated walks off unhurt,
//                 Bounced is thrown back, Withdrew steps aside, Destroyed
//                 falls. The record's own losses stand over each side.
//   5  5.6–7.0 s  the field as it was left; the numbers let go.
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
import { FACTION_FILL, FACTION_DARK, FACTION_LIGHT, sigilPath } from './avatar.mjs';
import { baseDisc, unitFigure, UNIT_KINDS } from './units.mjs';
import { paintMini, miniSheet, miniCell, MINI_CELL_U, MINI_ANCHOR, MINI_SIZES } from './minis.mjs';
import { clamp01, lerp, span, inQuad, inCubic, outQuad, outCubic, outExpo, outBack, inOutQuad } from '../fx/ease.mjs';

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
export function battleScene({ p, q, bell, inputs, before = null, after = null }) {
  const arrivals = (inputs?.arrivals ?? []).filter(a => a.present === 1 || a.present === true);
  if (!arrivals.length) return residentScene({ p, q, bell, before, after });
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
/** Where a side's formation is centred before the charge, and how far it closes for the melee (figure heights). */
const REST = 1.6, ENGAGE = 1.0;
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
    fate: groups.find(g => g.fate && g.fate !== 'Stays')?.fate ?? (groups.length && groups.every(g => g.fate === 'Stays') ? 'Stays' : null),
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
    return { idx: tile.idx, q: h.q, r: h.r, c: project(h.q, h.r), sides, fight: sides.every(s => s.groups.length > 0) };
  }) };
  plans.set(scene, plan);
  return plan;
}

/** Where a tile's scene stands at a zoom: its centre, the figure height `s`, the point of contact and each side's middle (world px). */
export function battleStage(tile, zoom, fit = 1) {
  const s = battleScale(zoom, fit), cx = tile.c.x, cy = tile.c.y + RADIUS * 0.12;
  return { s, cx, cy, contact: { x: cx, y: cy - s * 0.48 }, feet: { x: cx, y: cy + s * 0.05 },
    left: { x: cx - (REST - ENGAGE + 0.1) * s, y: cy }, right: { x: cx + (REST - ENGAGE + 0.1) * s, y: cy } };
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
const INK = '#0c1614', IVORY = '#f4efe0', BRASS = '#c9a24a', BRASS_HI = '#f0d48a';
const SANS = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp01(a).toFixed(3)})`; };

/** Text with a dark outline, readable on any ground. `px` is its size in world units. */
function inkText(ctx, text, x, y, px, color, { align = 'center', weight = 800, alpha = 1, scale = 1 } = {}) {
  if (alpha <= 0.01 || !text) return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(scale * px / 32, scale * px / 32);
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} 32px ${SANS}`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.strokeStyle = rgba(INK, 0.94); ctx.lineWidth = 6.5; ctx.strokeText?.(text, 0, 0);
  ctx.fillStyle = color; ctx.fillText?.(text, 0, 0);
  ctx.restore();
}

/** The white copy of a miniature's frame (the hit flash); null where there is no canvas or the sheet has not loaded. */
const whites = new Map();
function whiteCell(faction, kind, face, walking, step) {
  const img = faction >= 0 && faction < 6 ? miniSheet(faction, MINI_SIZES[0].key) : null;
  if (!img) return null;
  const { row, col } = miniCell(kind, { face, walking, step });
  const key = `${faction}|${row}|${col}`;
  if (whites.has(key)) return whites.get(key);
  let cv = null;
  try {
    const cell = Math.round(img.width / 6);
    cv = typeof globalThis.OffscreenCanvas === 'function' ? new globalThis.OffscreenCanvas(cell, cell) : globalThis.document?.createElement?.('canvas') ?? null;
    if (cv) {
      cv.width = cell; cv.height = cell;
      const g = cv.getContext('2d');
      g.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, cell, cell);
      g.globalCompositeOperation = 'source-in'; g.fillStyle = '#ffffff'; g.fillRect(0, 0, cell, cell);
      // the figure only: the base it stands on and its shadow stay as they are
      const m = g.createLinearGradient(0, cell * (MINI_ANCHOR[1] - 0.2), 0, cell * (MINI_ANCHOR[1] - 0.06));
      m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-in'; g.fillStyle = m; g.fillRect(0, 0, cell, cell);
    }
  } catch { cv = null; }
  whites.set(key, cv);
  return cv;
}

/** The nation whose miniatures stand in for the neutral camp's fighters, drawn drained of colour and washed in leather. */
const CAMP_SHEET = 5;
const camps = new Map();
/** A camp fighter's frame: a miniature greyed and washed brown (the camp has no sheet of its own); null until the sheet has loaded or where there is no canvas. */
function campCell(kind, face, walking, step) {
  const img = miniSheet(CAMP_SHEET, MINI_SIZES[0].key);
  if (!img) return null;
  const { row, col } = miniCell(kind, { face, walking, step });
  const key = `${row}|${col}`;
  if (camps.has(key)) return camps.get(key);
  let cv = null;
  try {
    const cell = Math.round(img.width / 6);
    cv = typeof globalThis.OffscreenCanvas === 'function' ? new globalThis.OffscreenCanvas(cell, cell) : globalThis.document?.createElement?.('canvas') ?? null;
    if (cv) {
      cv.width = cell; cv.height = cell;
      const g = cv.getContext('2d');
      if ('filter' in g) g.filter = 'grayscale(0.85) brightness(1.02) contrast(1.05)';
      g.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, cell, cell);
      if ('filter' in g) g.filter = 'none';
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(112,78,44,0.3)'; g.fillRect(0, 0, cell, cell);
    }
  } catch { cv = null; }
  camps.set(key, cv);
  return cv;
}

/** Start loading the sheets a scene will need (so its first frames already have their figures). */
export function preloadBattle(scene) {
  for (const tile of scene?.tiles ?? []) for (const x of [...(tile.attackers ?? []), ...(tile.defenders ?? [])]) {
    const f = x.faction >= 0 && x.faction < 6 ? x.faction : CAMP_SHEET;
    for (const size of MINI_SIZES) miniSheet(f, size.key);
  }
}

function paintFigure(ctx, f) {
  if (f.alpha <= 0.02) return;
  ctx.save();
  ctx.translate(f.x, f.y - f.hop);
  if (f.rot) ctx.rotate(f.rot);
  if (f.sx !== 1 || f.sy !== 1) ctx.scale(f.sx, f.sy);
  const o = { faction: f.faction, face: f.face, step: f.step, walking: f.walking, alpha: f.alpha };
  const w = f.s * MINI_CELL_U, nation = f.faction >= 0 && f.faction < 6;
  let drawn = false, white = null;
  if (nation) { drawn = paintMini(ctx, 0, 0, f.s, f.kind, o); if (drawn && f.flash > 0.02) white = whiteCell(f.faction, f.kind, f.face, f.walking, f.step); }
  else {
    const cell = campCell(f.kind, f.face, f.walking, f.step);
    if (cell && ctx.drawImage) { ctx.globalAlpha = f.alpha; ctx.drawImage(cell, -w * MINI_ANCHOR[0], -w * MINI_ANCHOR[1], w, w); drawn = true; if (f.flash > 0.02) white = whiteCell(CAMP_SHEET, f.kind, f.face, f.walking, f.step); }
  }
  // until its sheet has loaded a figure is only the shadow it will stand on (a page with no sheets at all draws the plain canvas figure)
  if (!drawn) {
    if (typeof globalThis.Image === 'undefined') { baseDisc(ctx, 0, 0, f.s, f.faction, { alpha: f.alpha }); unitFigure(ctx, 0, -f.s * 0.02, f.s, f.kind, o); }
    else { ctx.fillStyle = `rgba(12,22,20,${(0.28 * f.alpha).toFixed(3)})`; ctx.beginPath(); ctx.ellipse?.(0, 0, f.s * 0.3, f.s * 0.12, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  if (f.flash > 0.02) {
    ctx.globalAlpha = f.alpha * f.flash;
    if (white && ctx.drawImage) ctx.drawImage(white, -w * MINI_ANCHOR[0], -w * MINI_ANCHOR[1], w, w);
    else if (!drawn) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse?.(0, -f.s * 0.45, f.s * 0.24, f.s * 0.5, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

/** How a group stands at scene time `t` (posed at `tau`): its advance toward the enemy, its lean, whether it walks, its alpha and facing. */
function groupState(T, side, g, t, tau, residents) {
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

/** The flash of a contact: a white core, a star and a low shock on the ground, in the two sides' colours. */
function paintContact(ctx, st, u, power, colA, colB, k) {
  const { contact: c, feet, s } = st;
  if (u < 0 || u >= 0.4) return;
  ctx.save();
  // the shock running out along the ground
  const kr = u / 0.4, rr = lerp(s * 0.3, s * 1.7 * Math.sqrt(power), outExpo(kr));
  ctx.strokeStyle = `rgba(239,230,204,${(0.6 * (1 - kr) * (1 - kr)).toFixed(3)})`; ctx.lineWidth = lerp(6, 1, outCubic(kr)) * k;
  ctx.beginPath(); ctx.ellipse?.(feet.x, feet.y, rr, rr * FLATTEN * 0.62, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  const kb = span(u, 0, 0.2);
  if (kb < 1) {
    const r = lerp(s * 0.3, s * 0.85 * Math.sqrt(power), outCubic(kb));
    const g = ctx.createRadialGradient?.(c.x, c.y, 0, c.x, c.y, r);
    if (g?.addColorStop) {
      g.addColorStop(0, `rgba(255,255,255,${((1 - kb) * (1 - kb)).toFixed(3)})`); g.addColorStop(0.3, rgba('#ffe9b8', 0.8 * (1 - kb) * (1 - kb)));
      g.addColorStop(0.62, rgba(kb < 0.5 ? colA : colB, 0.4 * (1 - kb))); g.addColorStop(1, rgba(colA, 0));
      ctx.fillStyle = g;
    } else ctx.fillStyle = `rgba(255,255,255,${(0.5 * (1 - kb)).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
  }
  const ks = span(u, 0, 0.26);
  if (ks < 1) {
    const len = s * 1.25 * Math.sqrt(power) * outBack(Math.min(1, ks * 2.4), 2.2) * (1 - inQuad(ks));
    ctx.lineCap = 'round';
    for (const [ang, m] of [[0, 1], [Math.PI / 2, 0.6], [Math.PI / 4, 0.42], [-Math.PI / 4, 0.42]]) {
      const dx = Math.cos(ang) * len * m, dy = Math.sin(ang) * len * m;
      ctx.strokeStyle = `rgba(255,243,208,${(0.95 * (1 - ks)).toFixed(3)})`; ctx.lineWidth = Math.max(1, 2.6 * (1 - ks)) * k;
      ctx.beginPath(); ctx.moveTo(c.x - dx, c.y - dy); ctx.lineTo(c.x + dx, c.y + dy); ctx.stroke();
    }
  }
  ctx.restore();
}

/** The holder's standard, planted when the fates are known: a pole, a swallow-tail pennon in the nation's colour, a gold finial. */
function paintStandard(ctx, x, y, s, faction, t, k) {
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
  ctx.fillStyle = col.fill;
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
function paintBars(ctx, T, st, t, k, numText, nameText, show, fit = 1) {
  if (show <= 0.01) return;
  const bf = Math.max(0.62, Math.min(1, fit * 1.2));
  const BW = 176 * k * bf, BH = 14 * k, GAP = 52 * k * bf, y = st.cy + st.s * 1.05 + 34 * k;
  const share = lossShare(t), ghost = lossShare(t, 0.32);
  let hit = 0;
  for (const h of BATTLE_HITS) { const u = t - h; if (u >= 0 && u < 0.16) hit = 1 - u / 0.16; }
  ctx.save();
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

/** The numbers over a side: the running total of its losses, struck again at each contact; the record's own total and the fate at the end. */
function paintLosses(ctx, side, st, t, k, lossText, fateText, numText, fit = 1) {
  let hit = -1;
  for (let j = 0; j < BATTLE_HITS.length; j++) if (t >= BATTLE_HITS[j]) hit = j;
  if (hit < 0) return;
  const last = hit === BATTLE_HITS.length - 1;
  const y0 = st.cy - st.s * 2.0;
  // over its side; two long numbers never run into each other (each keeps to its half)
  const final = side.loss ? lossText(side.loss) : '', size = (last ? (fit < 0.8 ? 27 : 32) : 26) * k;
  let half = 0;
  if (last && final) { ctx.save(); ctx.font = `800 32px ${SANS}`; half = ((ctx.measureText?.(final)?.width ?? 0) * size) / 32 / 2 + 7 * k; ctx.restore(); }
  const x = st.cx + side.sgn * Math.max((REST + 0.2) * st.s, half);
  const u = t - BATTLE_HITS[hit];
  const out = last ? 1 - inQuad(span(t, PHASE.end - 0.6, PHASE.end - 0.1)) : 1;
  const pop = lerp(0.35, 1, outBack(span(u, 0, 0.17), 2.6)), rise = 14 * k * outCubic(span(u, 0, 0.5));
  if (side.loss !== null && side.loss > 0) {
    const n = last ? side.loss : Math.round(side.loss * LOSS_BY_HIT[hit]);
    const lost = side.after === 0;
    if (n > 0) inkText(ctx, last ? final : `−${numText(n)}`, x, y0 - rise, size, last && lost ? '#ff8f76' : '#ffb7a3', { alpha: span(u, 0, 0.05) * out, scale: pop });
  }
  if (last && fateText) {
    const ft = side.fate ? fateText(side.fate) : null;
    if (ft) inkText(ctx, ft, x, y0 + 27 * k - rise, 16 * k, IVORY, { weight: 700, alpha: span(t, PHASE.fates + 0.45, PHASE.fates + 0.8) * out });
  }
}

function paintTile(ctx, T, e) {
  const { t, tau, k, residents } = e;
  const st = battleStage(T, e.zoom, e.fit), s = st.s, cx = st.cx, cy = st.cy;
  const mist = residents ? 0 : 1 - span(t, 0.55, 1.5);
  if (mist > 0.01 && T.sides[0].groups.length) paintMist(ctx, cx - REST * s, cy - s * 0.3, s * 1.3, t, mist);
  // the figures, back to front
  const figs = [], volleys = [];
  let hit = -1;
  for (let j = 0; j < BATTLE_HITS.length; j++) if (t >= BATTLE_HITS[j]) hit = j;
  const sinceHit = hit >= 0 ? t - BATTLE_HITS[hit] : Infinity;
  for (const side of T.sides) for (const g of side.groups) {
    const gs = groupState(T, side, g, t, tau, residents);
    for (const f of g.figs) {
      // from a loose crowd into the stance's formation
      const dk = outBack(span(t, PHASE.deploy + f.j * 0.22, PHASE.deploy + 0.6 + f.j * 0.22), 1.25);
      const px = lerp(f.fx * 0.5 - 0.22 + (f.j - 0.5) * 0.34, f.fx, dk), py = lerp((f.fy - g.off) * 0.55 + g.off + (hash(Math.round(f.j * 1e6), 5) - 0.5) * 0.3, f.fy, dk);
      let x = cx + side.sgn * ((REST - gs.adv * (f.front || g.ranged ? 1 : 0.88)) - px) * s - py * s * SKEW, y = cy + py * s * DEPTH;
      let alpha = gs.alpha, rot = -side.sgn * gs.lean, hop = gs.hop * s * (f.front ? 1 : 0.7), flash = 0, sx = 1, sy = 1, walking = gs.walking;
      if (T.fight && hit >= 0 && sinceHit < 0.13 && (f.front || f.fall === hit)) flash = 0.85 * (1 - span(sinceHit, 0.03, 0.13));
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
    const colA = sideColors(T.sides[0].faction).light, colB = sideColors(T.sides[1].faction).light;
    for (let j = 0; j < BATTLE_HITS.length; j++) paintContact(ctx, st, t - BATTLE_HITS[j], HIT_POWER[j], j % 2 ? colB : colA, j % 2 ? colA : colB, k);
  }
  // the holder's standard
  const holder = T.sides.flatMap(sd => sd.groups.map(g => ({ g, sd }))).find(x => x.g.fate === 'Stays' && x.g.faction < NEUTRAL && x.g.after !== 0 && (!T.fight || x.sd.fate === 'Stays'));
  if (holder && t >= PHASE.fates + 0.55) paintStandard(ctx, cx + holder.sd.sgn * (REST + 0.95) * s - holder.g.off * s * SKEW, cy + holder.g.off * s * DEPTH + s * 0.1, s * 0.86, holder.g.faction, t, k);
  if (T.fight) {
    const t0 = residents ? PHASE.deploy : 0;
    paintBars(ctx, T, st, t, k, e.numText, e.nameText, outCubic(span(t, t0 + 0.2, t0 + 0.6)) * (1 - span(t, PHASE.end - 0.6, PHASE.end - 0.15)), e.fit);
    for (const side of T.sides) paintLosses(ctx, side, st, t, k, e.lossText, e.fateText, e.numText, e.fit);
  } else if (e.fateText && t >= PHASE.fates + 0.45) {
    const side = T.sides.find(sd => sd.groups.length);
    const ft = side?.fate ? e.fateText(side.fate) : null;
    if (ft) inkText(ctx, ft, cx + side.sgn * REST * s, cy - s * 1.7, 16 * k, IVORY, { weight: 700, alpha: span(t, PHASE.fates + 0.45, PHASE.fates + 0.8) * (1 - span(t, PHASE.end - 0.6, PHASE.end - 0.1)) });
  }
}

/**
 * Draw a playing scene. `{zoom, now | at, fit (battleFit of the map's width), lossText, fateText, numText, nameText(side)}`:
 * `at` gives the scene's own time directly (the effects layer plays it on
 * its clock). When the effects layer has taken a scene (`play.staged`: it
 * draws it above the dimmed map, fx/battle.mjs), the map's own call draws
 * nothing and only says whether the scene is still playing. Returns false
 * once it is over.
 */
export function paintBattle(ctx, play, { zoom = 1, now = wallNow(), at = null, top = false, fit = 1, lossText = n => `−${n}`, fateText = null, numText = n => String(n), nameText = null } = {}) {
  if (!play) return false;
  const t = at ?? battleTime(play, now);
  if (t > PHASE.end) return false;
  if (play.staged && !top) return true;
  const plan = battlePlan(play.scene);
  const e = { t, tau: poseTime(t), zoom, k: 1 / Math.max(0.05, zoom), residents: plan.residents, fit, lossText, fateText, numText, nameText };
  for (const T of plan.tiles) paintTile(ctx, T, e);
  ctx.globalAlpha = 1;
  return true;
}

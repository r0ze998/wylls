// The walletless demo's travelers (owner r0ze 2026-11-28 16:21, "NPCs part 2: merchants / travelers that walk the
// map; the player can trade with them or talk to them"). Pure: no world, no page. The sample world
// (liveworld.mjs option `travelers`) keeps only what the player did (the trades it took, by visit); everything else —
// where a traveler is, whether it is in reach, its rates — is a function of the turn, so a replayed save
// (demo/src/save.mjs) puts every traveler back where it was.
//
//   the walk    A traveler walks a fixed loop of stops (villages and the inner ring's provinces), on passable tiles of
//               the map, `speed` tiles a turn, by the shortest passable path (breadth-first over the tiles of rings
//               0-2), and rests `rest` turns at every stop. Its place at turn b is (b + its offset) mod its loop's
//               length: no state, no randomness. A traveler is not a host: it is in no province's roster, so it never
//               blocks or meets a march, and it cannot be attacked (v1, Q-NPC-3).
//   the reach   A traveler is "visiting" the player while it stands within `reach` provinces of the player's village.
//               One visit = one unbroken run of such turns; it has its own rates and its own trade limit.
//   the trade   Food ↔ ore in lots of `lot` ore: buy (pay food, get ore) or sell (pay ore, get food), at most
//               `lotsPerVisit` lots a visit. A visit's rates are the traveler's own base moved by a seeded step
//               (sha256 of the traveler and the visit's first turn) — a drifting price, as the same visit always has.
//               Buying is always dearer than selling (no round trip gains).
//   the talk    2-4 short lines a traveler (English + Japanese): flavour that teaches the demo's rules. Never says it is
//               (or is not) a person or a program; never "season" (the world is continuous).
//
// Numbers: TRAVELERS_V1 below (decided by the headless playtests in demo/travelers-playtest.mjs; see the report).
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
import { DIRECTIONS, TILE_OFFSETS, hexDistance, locate, ringProvinces, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';

export const TRAVELERS_V1 = Object.freeze({
  /** Tiles a traveler walks in one turn (a turn is 12 s in the demo). */
  speed: 3,
  /** Turns a traveler rests at each stop. */
  rest: 2,
  /** Provinces from the player's village within which a traveler is visiting (0 = the same province). */
  reach: 1,
  /** Ore in one lot. */
  lot: 10,
  /** Lots (bought + sold) a visit. */
  lotsPerVisit: 3,
  /** Food a lot costs to buy / gives when sold, before the visit's step: [buy, sell] per traveler kind. */
  buy: 30, sell: 18,
  /** The visit's step, food a lot: buy + step × k, sell + step × k, k ∈ {-1, 0, 1}. */
  step: 4,
});

/** The travelers (v1: three). `route`: 'outer' (ring 2), 'inner' (ring 1), 'villages' (the AI villages). */
export const TRAVELERS = Object.freeze([
  Object.freeze({ id: 'tamsin', route: 'outer', bias: 0, name: { en: 'Tamsin, ore carrier', ja: '鉱石運びのタムシン' } }),
  Object.freeze({ id: 'odo', route: 'inner', bias: -1, name: { en: 'Odo, grain dealer', ja: '穀物商のオド' } }),
  Object.freeze({ id: 'lio', route: 'villages', bias: 1, name: { en: 'Lio, peddler', ja: '行商人のリオ' } }),
]);

/** The talk: 3 lines a traveler, English and Japanese. Every line is a rule of this demo as its code plays it. */
export const LINES = Object.freeze({
  tamsin: Object.freeze([
    { en: 'Ore is what armies are made of: every 100 troops you train cost food, ore and gold.', ja: '軍勢は鉱石でできている。兵を100人雇うたびに、食料と鉱石と金がいるよ。' },
    { en: 'Claiming a tile of land costs ore, and every tile you own eats food each turn. Claim what you can feed.', ja: '土地を1マス取るには鉱石がいる。持っているマスは毎ターン食料を食べる。養えるぶんだけ取りなさい。' },
    { en: 'I walk the outer ring of provinces. Each lap takes me past every nation’s border.', ja: 'わたしは外側の州をぐるりと歩く。ひと回りで、どの国の国境のそばも通るよ。' },
  ]),
  odo: Object.freeze([
    { en: 'A farm grows food and a mine digs ore. Build for what your army will need next.', ja: '農場は食料を、鉱山は鉱石を生む。次に軍勢が欲しがるものを建てるといい。' },
    { en: 'A turn here is ten minutes on the world’s clock. Marches arrive on a later turn, never at once.', ja: 'ここの1ターンは、世界の時計で10分。進軍は次のターン以降に着く。すぐには着かない。' },
    { en: 'I keep to the inner ring: from there every nation is close.', ja: 'わたしは内側の輪を回る。そこからなら、どの国も近い。' },
  ]),
  lio: Object.freeze([
    { en: 'I call at every nation’s village. My prices change from visit to visit, so compare before you trade.', ja: 'どの国の村にも寄るよ。値段は来るたびに変わるから、比べてから取り引きしな。' },
    { en: 'Buying ore always costs more food than selling it brings. Trade for what you lack, not for profit.', ja: '鉱石を買うときは、売るときより多くの食料がいる。もうけではなく、足りないものを手に入れるために取り引きしな。' },
    { en: 'Nobody can attack me on the road, and I never stand in the way of a march.', ja: '道を行くわたしを襲う者はいないし、わたしが進軍の邪魔をすることもない。' },
  ]),
});

const le32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b; };
const utf8 = s => new TextEncoder().encode(s);
const hk = h => `${h.q},${h.r}`;

/** The map's passable tiles (rings 0..maxRing): a Set of global hex keys. `passable(p, q, tile)` is the world's. */
export function passableSet(passable, maxRing = 2) {
  const out = new Set();
  for (let d = 0; d <= maxRing; d++) for (const { p, q } of ringProvinces(d)) for (let t = 0; t < TILE_OFFSETS.length; t++) if (passable(p, q, t)) out.add(hk(tileHex(p, q, t)));
  return out;
}

/** The shortest passable path from hex a to hex b (both included), breadth-first in DIRECTIONS order; null when there is none. */
export function pathBetween(open, a, b) {
  const start = hk(a), goal = hk(b);
  if (!open.has(start) || !open.has(goal)) return null;
  const prev = new Map([[start, null]]), queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const h = queue[i];
    if (hk(h) === goal) break;
    for (const [dq, dr] of DIRECTIONS) {
      const n = { q: h.q + dq, r: h.r + dr }, k = hk(n);
      if (!open.has(k) || prev.has(k)) continue;
      prev.set(k, h); queue.push(n);
    }
  }
  if (!prev.has(goal)) return null;
  const out = [];
  for (let h = b; h; h = prev.get(hk(h))) out.push(h);
  return out.reverse();
}

/** The passable tile of province (p, q) nearest its centre (ties: the lower tile index); -1 when none is. */
export function centreTile(p, q, passable) {
  let best = -1, bd = Infinity;
  for (let t = 0; t < TILE_OFFSETS.length; t++) {
    if (!passable(p, q, t)) continue;
    const o = TILE_OFFSETS[t], d = hexDistance(o.q, o.r, 0, 0);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/** The angle of a province around the map's centre (for ordering stops round the map). */
const angleOf = ({ p, q }) => { const h = tileHex(p, q, 30); return Math.atan2(Math.sqrt(3) * (h.r + h.q / 2), 1.5 * h.q); };

/**
 * The stops of a route: `outer` every other province of ring 2, `inner` the six of ring 1 (the other way round),
 * `villages` the AI villages (`villages`: [{p, q, tile}]) round the map. Each stop is `{p, q, tile}`.
 */
export function stopsOf(route, { passable, villages = [] }) {
  const at = list => list.map(({ p, q }) => ({ p, q, tile: centreTile(p, q, passable) })).filter(s => s.tile >= 0);
  if (route === 'outer') return at(ringProvinces(2).sort((a, b) => angleOf(a) - angleOf(b)).filter((_, i) => i % 2 === 0));
  if (route === 'inner') return at(ringProvinces(1).sort((a, b) => angleOf(b) - angleOf(a)));
  if (route === 'villages') return [...villages].sort((a, b) => angleOf(a) - angleOf(b) || a.tile - b.tile).map(v => ({ p: v.p, q: v.q, tile: v.tile }));
  return [];
}

/**
 * A traveler's loop: `{stops, legs: [{stop, path, walk, rest, from}], length}` — leg i walks `path` (stop i-1 → stop i,
 * `walk` turns at `speed`) and then rests `rest` turns at stop i; `from` is the leg's first turn within the loop.
 * A stop no path reaches is left out. Null when fewer than two stops remain.
 */
export function loopOf(stops, open, rules = TRAVELERS_V1) {
  const hexes = stops.map(s => ({ ...s, hex: tileHex(s.p, s.q, s.tile) })).filter(s => open.has(hk(s.hex)));
  const kept = [];
  for (const s of hexes) if (!kept.length || pathBetween(open, kept[0].hex, s.hex)) kept.push(s);
  if (kept.length < 2) return null;
  const legs = [];
  let from = 0;
  for (let i = 0; i < kept.length; i++) {
    const a = kept[(i + kept.length - 1) % kept.length], b = kept[i];
    const path = pathBetween(open, a.hex, b.hex);
    const walk = Math.max(1, Math.ceil((path.length - 1) / rules.speed));
    legs.push({ stop: i, path, walk, rest: rules.rest, from });
    from += walk + rules.rest;
  }
  return { stops: kept.map(({ p, q, tile }) => ({ p, q, tile })), legs, length: from };
}

/** Where a traveler is at turn b: `{hex, p, q, tile, walking, stop, leg, heading}` (heading: the stop it walks to or rests at). */
export function placeAt(loop, offset, b, rules = TRAVELERS_V1) {
  const k = (((b + offset) % loop.length) + loop.length) % loop.length;
  const leg = loop.legs.find((l, i) => k >= l.from && (i === loop.legs.length - 1 || k < loop.legs[i + 1].from));
  const into = k - leg.from;
  const walking = into < leg.walk;
  const step = walking ? Math.min(leg.path.length - 1, into * rules.speed) : leg.path.length - 1;
  const hex = leg.path[step], at = locate(hex.q, hex.r);
  return { hex, p: at.p, q: at.q, tile: at.idx, walking, stop: leg.stop, leg: loop.legs.indexOf(leg), heading: loop.stops[leg.stop] };
}

/** Province distance (the demo's reach unit). */
export const provinceDistance = (a, b) => (Math.abs(a.p - b.p) + Math.abs(a.q - b.q) + Math.abs(a.p + a.q - b.p - b.q)) / 2;

/** Whether the traveler at `place` is visiting a village at `home` ({p, q}). */
export const inReach = (place, home, rules = TRAVELERS_V1) => !!home && provinceDistance(place, home) <= rules.reach;

/** The visit at turn b: its first turn (the run of in-reach turns that holds b), or null when the traveler is away. */
export function visitAt(loop, offset, b, home, rules = TRAVELERS_V1) {
  if (!home || !inReach(placeAt(loop, offset, b, rules), home, rules)) return null;
  let s = b;
  for (let i = 0; i < loop.length; i++) {
    if (!inReach(placeAt(loop, offset, s - 1, rules), home, rules)) return s;
    s--;
  }
  // (a loop that is in reach all the way round: one visit a lap, from the lap's first turn)
  return b - ((((b + offset) % loop.length) + loop.length) % loop.length);
}

/** The next turn after b at which a new visit begins (null if none within a lap). */
export function nextVisit(loop, offset, b, home, rules = TRAVELERS_V1) {
  if (!home) return null;
  for (let x = b + 1; x <= b + loop.length + 1; x++) if (visitAt(loop, offset, x, home, rules) === x) return x;
  return null;
}

/** A visit's rates: food a lot to buy and food a lot when sold. Seeded by the traveler and the visit's first turn. */
export function ratesOf(traveler, visit, seed = 1, rules = TRAVELERS_V1) {
  const h = sha256(utf8('wylls-demo-traveler'), le32(seed), utf8(traveler.id), le32(visit));
  const k = (h[0] % 3) - 1 + (traveler.bias ?? 0);
  const step = Math.max(-1, Math.min(1, k)) * rules.step;
  return { buy: rules.buy + step, sell: rules.sell + step, lot: rules.lot };
}

/**
 * Judge a trade: `{side: 'buy'|'sell', lots, used, food, ore, cap, rates}` (whole units; `used`: lots this visit) →
 * `{ok: true, food, ore}` (the change to each store) or `{ok: false, code}` (Limit, Insufficient, StoreFull, BadData).
 */
export function judgeTrade({ side, lots = 1, used = 0, food, ore, cap, rates }, rules = TRAVELERS_V1) {
  if (!['buy', 'sell'].includes(side) || !Number.isInteger(lots) || lots < 1) return { ok: false, code: 'BadData' };
  if (used + lots > rules.lotsPerVisit) return { ok: false, code: 'Limit' };
  const dOre = (side === 'buy' ? 1 : -1) * lots * rates.lot, dFood = (side === 'buy' ? -rates.buy : rates.sell) * lots;
  if (food + dFood < 0 || ore + dOre < 0) return { ok: false, code: 'Insufficient' };
  if ((dOre > 0 && ore + dOre > cap) || (dFood > 0 && food + dFood > cap)) return { ok: false, code: 'StoreFull' };
  return { ok: true, food: dFood, ore: dOre };
}

/**
 * Every traveler's loop and offset in a world: `{passable(p, q, tile), villages: [{p, q, tile}]}` →
 * `[{...traveler, loop, offset}]` (offsets spread the travelers round their loops; a traveler without a loop is left out).
 */
export function planTravelers({ passable, villages }, rules = TRAVELERS_V1) {
  const open = passableSet(passable);
  return TRAVELERS.map((t, i) => {
    const loop = loopOf(stopsOf(t.route, { passable, villages }), open, rules);
    return loop ? { ...t, loop, offset: Math.floor((loop.length * i) / TRAVELERS.length) } : null;
  }).filter(Boolean);
}

/** What the page reads of one traveler at turn b (the world's record of it; `used`: lots traded this visit). */
export function travelerView(t, b, home, used, seed = 1, rules = TRAVELERS_V1) {
  const at = placeAt(t.loop, t.offset, b, rules), visit = visitAt(t.loop, t.offset, b, home, rules);
  return {
    id: t.id, name: t.name, route: t.route, p: at.p, q: at.q, tile: at.tile, walking: at.walking, heading: at.heading,
    // (the next tiles of its walk this turn and the next: the map's dotted trail)
    trail: t.loop.legs[at.leg].path.slice(Math.max(0, t.loop.legs[at.leg].path.findIndex(h => h.q === at.hex.q && h.r === at.hex.r)), undefined).slice(0, rules.speed * 2 + 1).map(h => { const x = locate(h.q, h.r); return { p: x.p, q: x.q, tile: x.idx }; }),
    visiting: visit !== null, visit, next: visit === null ? nextVisit(t.loop, t.offset, b, home, rules) : null,
    rates: visit !== null ? ratesOf(t, visit, seed, rules) : null, used: visit !== null ? used : 0, left: visit !== null ? Math.max(0, rules.lotsPerVisit - used) : 0,
    lines: LINES[t.id].length,
  };
}


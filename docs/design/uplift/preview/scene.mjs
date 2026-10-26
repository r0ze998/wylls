// The one scene the three art directions are drawn from (docs/design/uplift/01-ART-DIRECTION.ja.md).
// A patch of the frontier, radius 7 around (0, 0), in the client's own geometry (permutation-server/web/map.mjs:
// pointy-top hexes, RADIUS 44, FLATTEN 0.76). Every number here is a SAMPLE for the comparison: no record of a
// season stands behind it. What it holds is what the client can draw from real records today:
//   terrain and ore-bearing tiles     (Province TERRAIN / RESOURCE; S1 ore from hills and mountains near a village)
//   road tiles                        (Province ROAD_MASK)
//   villages with tier and buildings  (SiteMirror tier; the viewer's own Holding: buildings by kind)
//   a vault, a fort, a tower, a palisade, a caravan   (the herald's S1 feeds)
//   standing hosts, a sealed march    (the roster; a sealed march shows its origin and arrival turn only)
export const R = 7;
export const RADIUS = 44;
export const FLATTEN = 0.76;
export const SQRT3 = Math.sqrt(3);
export const project = (q, r) => ({ x: SQRT3 * RADIUS * (q + r / 2), y: RADIUS * 1.5 * r * FLATTEN });
export const key = (q, r) => `${q},${r}`;
export const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export function hexCorners(x, y, rad = RADIUS) {
  return Array.from({ length: 6 }, (_, i) => { const a = (i * 60 - 30) * Math.PI / 180; return [x + Math.cos(a) * rad, y + Math.sin(a) * rad * FLATTEN]; });
}
/** A small seeded generator. */
export function rng(seed) {
  let a = (seed | 0) || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (q, r, n = 0) => { const v = Math.sin(q * 127.1 + r * 311.7 + n * 74.7) * 43758.5453; return v - Math.floor(v); };

// ---------------------------------------------------------------- the land
const WATER = ['3,-7', '3,-6', '2,-5', '2,-4', '1,-3', '1,-2', '3,1', '4,1', '3,2', '4,2'];
const MOUNTAIN = ['-5,-3', '-4,-4', '-6,-1', '-3,-4', '-6,-2', '6,-7', '7,-6'];
const HILLS = ['-5,-1', '-4,-1', '-5,0', '-6,0', '-4,-2', '-5,-2', '-3,-3', '-6,1', '-4,0', '5,-5', '4,-5', '6,-6', '5,-3', '-2,-4'];
const FOREST = ['-4,4', '-3,4', '-2,4', '-1,4', '-4,5', '-3,5', '-2,5', '-5,5', '-1,5', '0,4', '-5,4', '-3,6', '-2,6', '-4,6', '0,5', '-6,6', '-1,6',
  '5,2', '6,1', '6,2', '5,3', '7,0', '6,0', '4,4', '-7,4', '-6,4', '-6,5', '-7,5', '-7,6', '-7,7', '1,6', '2,5'];
const PLAINS = ['-2,1', '-1,0', '-1,1', '-2,2', '-3,2', '-3,1', '-1,2', '0,1', '0,0', '0,-1', '1,-1', '2,-1', '-2,0', '-3,0', '0,2', '1,1', '-1,-1', '-2,-1', '1,0', '2,0', '3,-1'];
const ORE = new Set(['-5,-1', '-4,-1', '-5,0', '-4,-2', '-3,-3', '5,-3', '5,-5']);
/** Road tiles (Province ROAD_MASK): the town, the ford, the fort; the town and the hill village. */
export const ROAD = ['-2,1', '-1,0', '0,-1', '1,-1', '2,-1', '3,-1', '-3,1', '-4,1', '-5,0'];

export const TILES = [];
for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
  const k = key(q, r);
  const terrain = WATER.includes(k) ? 'Water' : MOUNTAIN.includes(k) ? 'Mountain' : HILLS.includes(k) ? 'Hills' : FOREST.includes(k) ? 'Forest'
    : PLAINS.includes(k) ? 'Plains' : (hash(q, r) < 0.42 ? 'Plains' : 'Grassland');
  TILES.push({ q, r, k, terrain, ore: ORE.has(k), road: ROAD.includes(k), v: 1 + Math.floor(hash(q, r, 3) * 3), ...project(q, r) });
}
export const tileAt = new Map(TILES.map(t => [t.k, t]));
export const passable = t => t && t.terrain !== 'Water' && t.terrain !== 'Mountain';

// ---------------------------------------------------------------- the people
/** Nations (palette.mjs): 0 Aster (the viewer), 2 Cinder, 3 Dunmar. */
export const VIEWER = 0;
export const VILLAGES = [
  // the viewer's town: farms 2, woodcutter 1, quarry 1, the S1 workshop (buildings by kind: the Holding's own record)
  { id: 'lamar', name: 'ラマール', en: 'Lamar', q: -2, r: 1, faction: 0, tier: 1, own: true, annex: [2, 1, 1, 0, 0, 0, 1], workshop: true, garrison: 300 },
  // a hill village of another nation: its ore comes from the hills round it (S1: radius 2 in its province)
  { id: 'olsen', name: 'オルセン', en: 'Olsen', q: -5, r: 0, faction: 2, tier: 0, own: false, annex: null, garrison: 90 },
  // the far side
  { id: 'verde', name: 'ヴェルデ', en: 'Verde', q: 6, r: -4, faction: 3, tier: 1, own: false, annex: null, garrison: 120 },
];
/** The land each village works (its colour on the board): tier 0 → 1 ring, tier 1 → 2 rings. */
export const WORKED = [1, 2, 2, 3];

export const STRUCTURES = [
  { kind: 'vault', q: 0, r: -1, faction: 0, own: true, name: '渡しの倉' },
  { kind: 'fort', q: 3, r: -1, faction: 0, own: true, name: '東の要塞' },
  { kind: 'tower', q: 5, r: -2, faction: 3, own: false, cover: 2 },
  { kind: 'palisade', q: 5, r: 0, faction: 3, own: false },
];
/** A caravan of the viewer's: from the vault to the fort, ore 30, on the road; everything about it is public. */
export const CARAVANS = [
  { from: { q: 0, r: -1 }, to: { q: 3, r: -1 }, share: 0.42, faction: 0, own: true, cargo: [['鉱石', 'ore', 30]], departTurn: 41, arriveTurn: 45, path: ['0,-1', '1,-1', '2,-1', '3,-1'] },
];
/** Standing hosts (the roster): unit, troops, stamina of 120. */
export const HOSTS = [
  { id: 'h1', q: -1, r: 0, faction: 0, own: true, unit: 'Pikeman', name: '長槍兵', troops: 600, stamina: 112 },
  { id: 'h2', q: -2, r: 2, faction: 0, own: true, unit: 'Scout', name: '斥候', troops: 100, stamina: 120 },
  { id: 'e1', q: 5, r: -1, faction: 3, own: false, unit: 'Crossbowman', name: '弩兵', troops: 420, stamina: 80 },
];
/** Another nation's sealed march: its origin, size and arrival turn are public; its destination is not. */
export const SEALED = [{ fromQ: 6, fromR: -4, faction: 3, troops: 300, unit: '騎士', departTurn: 41, arriveTurn: 44 }];

export const NOW = { turn: 42, left: '6:12' };

// ---------------------------------------------------------------- the selected state
/** The selected host and where its march could go (hex steps over passable land, at most 6 shown near). */
export function reachOf(host, steps = 5) {
  const seen = new Map([[key(host.q, host.r), 0]]), out = [];
  let front = [{ q: host.q, r: host.r }];
  for (let d = 1; d <= steps; d++) {
    const next = [];
    for (const h of front) for (const [dq, dr] of DIRS) {
      const q = h.q + dq, r = h.r + dr, k = key(q, r), t = tileAt.get(k);
      if (!passable(t) || seen.has(k)) continue;
      // another nation's palisade stops a march (S1 stop rule, stance war)
      if (STRUCTURES.some(s => s.kind === 'palisade' && s.q === q && s.r === r && s.faction !== host.faction)) continue;
      seen.set(k, d); next.push({ q, r }); out.push({ ...t, d });
    }
    front = next;
  }
  return out;
}
/** The route the planner takes from the host to the target (a hex line over passable land). */
export function routeTo(from, to) {
  const n = dist(from, to), out = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const x = from.q + (to.q - from.q) * t + 1e-6, z = from.r + (to.r - from.r) * t + 1e-6, y = -x - z;
    let rx = Math.round(x), rz = Math.round(z); const ry = Math.round(y);
    const dx = Math.abs(rx - x), dz = Math.abs(rz - z), dy = Math.abs(ry - y);
    if (dx > dz && dx > dy) rx = -rz - ry; else if (dz > dy) rz = -rx - ry;
    out.push({ q: rx, r: rz });
  }
  return out;
}
/**
 * The decision of the selected state: the host h1 and three things it could do this turn. Every figure is a SAMPLE:
 * the client computes the arrival turn and stamina from fmarch.mjs, the tower's wear from the S1 rule (1% a minute
 * walked in an enemy tower's range, at most 30%), and the forecast with the rules kernel (hud/forecast.mjs).
 */
export const DECISION = {
  host: 'h1',
  target: { q: 5, r: -1 },
  options: [
    { id: 'assault', title: '弩兵 420 を攻める', verb: '突撃', arrive: 45, stamina: 74, towerWear: '最大 12%', route: [{ q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }, { q: 2, r: -1 }, { q: 3, r: -1 }, { q: 4, r: -1 }, { q: 5, r: -1 }],
      forecast: { left: [310, 470], fates: [['勝つ', 9], ['退く', 3]], runs: 12 }, risk: ['敵の物見櫓の範囲を 2 マス通る', '到着までに別の軍が来るかは分からない（封印中の進軍 1）'] },
    { id: 'hold', title: '東の要塞に入る', verb: '守る', arrive: 44, stamina: 74, towerWear: '最大 6%', route: [{ q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }, { q: 2, r: -1 }, { q: 3, r: -1 }],
      forecast: null, risk: ['敵の物見櫓の範囲を 1 マス通る'] },
    { id: 'escort', title: '隊商の道の途中で待つ', verb: '待ち構える', arrive: 44, stamina: 74, towerWear: 'なし', route: [{ q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }, { q: 2, r: -1 }],
      forecast: null, risk: ['待っている軍は物見櫓に削られない'] },
  ],
};

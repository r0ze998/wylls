// The prototype's world: MOCK DATA, labelled as such on every screen. Its
// shapes are the page's own (decoded Holding and Province fields, the
// herald's S1 feeds, /h/events bodies), and every number on screen is worked
// out from it by the rules code the tests pin (../src). Nothing here was
// recorded on a chain; the forecast card alone uses a recorded local-chain
// Province (fixtures/uxs1-keep-two-turns.json, turn 619).
import { decodeRecord } from '../../../permutation-server/web/frontier/flog.mjs';
import { TILE_OFFSETS } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { encodeBody, cargoBytes } from '../src/records.mjs';
import { KIND_TOWER, KIND_PALISADE, KIND_FORT } from '../src/s1walk.mjs';

export const MOCK = true;
const H = 3600;
/** Genesis and "now": turn 610 of a 14-day S1 season (S1_LOCAL_14D: 2,016 turns, joins until 1,512). */
export const GENESIS = 1_800_000_000;
export const NOW_BELL = 610;
export const SEASON = Object.freeze({ seasonId: 7, genesisTs: GENESIS, endBell: 2016, joinCloseBell: 1512, layoutVersion: 2, programVersion: 4 });
export const nowTs = () => GENESIS + NOW_BELL * 600 + 130;

export const ME = Object.freeze({ faction: 2, tag: 0x51a7n, wallet: 'MockWa11et1111111111111111111111111111111111' });
export const NATIONS = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'];

// ------------------------------------------------------------------ land: two provinces side by side, and their neighbours
const ALL = (1n << 61n) - 1n;
/** Terrain per tile, by a fixed hash (0 grass, 1 plains, 2 forest, 3 hills, 4 mountain, 5 water). */
function terrainOf(p, q, t) {
  const h = ((p * 73856093) ^ (q * 19349663) ^ (t * 83492791)) >>> 0;
  const o = TILE_OFFSETS[t], ring = (Math.abs(o.q) + Math.abs(o.r) + Math.abs(o.q + o.r)) / 2;
  if (t === 30) return 1;
  const x = h % 100;
  if (ring === 4 && x < 6) return 5;
  if (x < 6) return 4;
  if (x < 24) return 2;
  if (x < 36) return 3;
  if (x < 62) return 0;
  return 1;
}
export const PROVINCES = [[0, 0], [1, 0], [0, 1], [1, -1], [-1, 1], [0, -1]];
export const TERRAIN = new Map(PROVINCES.map(([p, q]) => [`${p},${q}`, Array.from({ length: 61 }, (_, t) => terrainOf(p, q, t))]));
/** Ore deposits the S1 lens shows (iron). */
export const IRON = new Set(['0,0,33', '1,0,40', '1,0,47']);
const mask = (p, q, pred) => TERRAIN.get(`${p},${q}`).reduce((m, ter, t) => (pred(ter, t) ? m | (1n << BigInt(t)) : m), 0n);
export const LANDS = PROVINCES.map(([p, q]) => ({ p, q,
  passable: ALL & mask(p, q, ter => ter !== 4 && ter !== 5),
  rough: mask(p, q, ter => ter === 2 || ter === 3),
  road: p === 0 && q === 0 ? mask(0, 0, (_, t) => [30, 38, 31].includes(t)) : 0n }));

// ------------------------------------------------------------------ who stands where
export const STANCES = Array.from({ length: 6 }, (_, n) => Array.from({ length: 6 }, (_, f) => (n === 4 && f === 2 ? 1 : n === 2 && f === 4 ? 1 : 0)));
/** The herald's h/structures.json, as map/s1marks.mjs reads it. */
export const STRUCTURES = [
  { kind: KIND_PALISADE, p: 1, q: 0, tile: 8, faction: 3, ownerTag: '77' },
  { kind: KIND_TOWER, p: 1, q: 0, tile: 13, faction: 3, ownerTag: '77' },
  { kind: KIND_TOWER, p: 0, q: 0, tile: 38, faction: 2, ownerTag: String(ME.tag) },
  { kind: KIND_FORT, p: 0, q: 0, tile: 23, faction: 2, ownerTag: String(ME.tag), troops: 400 },
  { kind: KIND_PALISADE, p: 0, q: 1, tile: 8, faction: 4, ownerTag: '91' },
];
/** Storehouses (h/caravans.json vaults). */
export const VAULTS = [
  { p: 1, q: 0, tile: 30, ownerTag: String(ME.tag), faction: 2, gen: 1, label: '北の貯蔵庫', have: [0, 600, 900, 0, 0, 0, 0, 0] },
];
const store = (v, perHour, cap = 6000) => ({ value: BigInt(v) * 1000n, rate: BigInt(Math.round(perHour * 1000)), cap: BigInt(cap) * 1000n, t0: BigInt(nowTs()), frac: 0n });
/** The viewer's village (a decoded Holding, settled now). */
export const VILLAGE = { p: 0, q: 0, site: 0, tile: 30, gen: 1, state: 2, tier: 1, faction: 2, flags: 0, name: 'ハルデン', shieldUntil: 0,
  stores: [store(1800, 22), store(3100, 30), store(700, 8), store(120, 6), store(40, 0), store(1400, 12), store(300, 5), store(0, 0)],
  production: [40_000, 30_000, 8_000, 6_000, 0, 12_000, 5_000, 0].map(BigInt), upkeep: [18_000, 0, 0, 0, 0, 0, 0, 0].map(BigInt), queue: [], reserve: [300, 0, 0, 0, 0, 0, 0, 0] };
/** Villages on the map: the viewer's, a Dunmar one, an Ember one (at passage), a free city. */
export const VILLAGES = [
  { p: 0, q: 0, tile: 30, faction: 2, tier: 1, own: true, name: 'ハルデン' },
  { p: 1, q: 0, tile: 44, faction: 3, tier: 2, own: false, name: 'グラム砦町', siege: { by: 2, progress: 0 } },
  { p: 0, q: 1, tile: 30, faction: 4, tier: 0, own: false, name: 'セラ', shield: true },
  { p: 1, q: -1, tile: 30, faction: 3, tier: 1, own: false, name: 'ヴェント' },
];
/** Hosts the viewer sees (Province entries: faction, troops in milli). */
export const HOSTS = [
  { p: 0, q: 0, tile: 30, faction: 2, troops: 300_000, own: true, id: 'h1', unit: 0 },
  { p: 1, q: 0, tile: 13, faction: 3, troops: 240_000, own: false, id: 'x1', unit: 2 },
  { p: 0, q: 0, tile: 45, faction: 4, troops: 120_000, own: false, id: 'x2', unit: 0 },
];
/** What the viewer has in sight: the east of the northern province is out of sight (level 1). */
export const sight = (p, q, t) => {
  if (p === 1 && q === 0) return TILE_OFFSETS[t].q >= 2 ? 1 : 3;
  if (p === 0 && q === 0) return 3;
  return 2;
};
/** Decoded-Province-like records the caravan preview reads (entries, sites). */
export function provinces() {
  const out = new Map();
  for (const [p, q] of PROVINCES) {
    const vs = VILLAGES.filter(v => v.p === p && v.q === q);
    out.set(`${p},${q}`, { province: { p, q, sites: vs.map(v => v.tile), siteCount: vs.length, siteMirror: vs.map(v => ({ state: 1, faction: v.faction })),
      entries: HOSTS.filter(h => h.p === p && h.q === q).map(h => ({ state: 1, tile: h.tile, faction: h.faction, troops: h.troops, unit: h.unit, own: !!h.own })) } });
  }
  return out;
}

// ------------------------------------------------------------------ the records since the viewer last confirmed (bodies the page decodes itself)
const OTHER = 0x77n;
const raw = [
  [5101, 'CARAVAN_SENT', 560, { owner_tag: ME.tag, seq: 3, faction: 2 }],
  [5108, 'RAID_OPENED', 566, { owner_tag: ME.tag, seq: 3, p: 1, q: 0, bell: 566, raider_tag: OTHER }],
  [5122, 'CARAVAN_RAIDED', 572, { owner_tag: ME.tag, seq: 3, p: 1, q: 0, bell: 566, choice: 0, by: 1, raider_tag: OTHER, taken: cargoBytes([0, 300, 0, 0, 0, 120, 0, 0]) }],
  [5140, 'NATION_PROPOSED', 580, { faction: 2, id: 4, kind: 1, target_faction: 3, value: 0, proposer_tag: 0x88n, close_bell: 724 }],
  [5166, 'NATION_DECIDED', 590, { faction: 2, id: 3, passed: 1, kind: 1, target_faction: 4, value: 1, yes: 4, no: 1 }],
  [5170, 'CLASH', 592, { p: 0, q: 0, bell: 592, engagements: 1 }],
  [5190, 'CARAVAN_SETTLED', 600, { owner_tag: ME.tag, seq: 2, outcome: 0, cargo: cargoBytes([400, 0, 0, 0, 0, 0, 0, 0]) }],
  [5203, 'SIEGE_DECLARED', 604, { p: 0, q: 0, site: 0, attacker: 3, owner_faction: 2, owner_tag: ME.tag, required: 44 }],
  [5211, 'CARAVAN_SETTLED', 606, { owner_tag: OTHER, seq: 9, outcome: 0, cargo: cargoBytes([5, 0, 0, 0, 0, 0, 0, 0]) }],
];
// (CLASH is an M1 kind with its own table in flog.mjs; built by hand here: p, q, bell, then digests and counts)
function clashBody(p, q, bell, engagements) {
  const b = new Uint8Array(6 + 12 + 32 + 32 + 4 + 9 + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = 41; v.setUint32(2, bell, true); v.setInt32(6, p, true); v.setInt32(10, q, true); v.setUint32(14, bell, true); v.setUint32(6 + 12 + 64, engagements, true);
  return b;
}
export const RECORDS = raw.map(([seq, name, bell, f]) => ({ seq: String(seq), record: name === 'CLASH' ? decodeRecord(clashBody(f.p, f.q, f.bell, f.engagements)) : decodeRecord(encodeBody(name, bell, f)) }));
/** The cursor the mock "page" read from: the viewer's confirmed mark is 5100 (turn 559) on the first visit. */
export const READ_AFTER = '5100';
export const FIRST_MARK = { v: 1, seasonId: '7', wallet: ME.wallet, confirmedSeq: '5100', confirmedBell: 559, confirmedAt: nowTs() - 9 * H };

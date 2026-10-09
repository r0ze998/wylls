// The fixture world of the screenshot smoke (web design §13.2): one small
// localnet season on the test beacon, built from the ABI layout table by
// the same encoder as the node tests' herald fixtures
// (test/fixtures/frontier/make-fixtures.mjs), so every account the page
// decodes is byte-exact. Nothing here came from a chain.
//
// The viewer is the page's own dev wallet with a fixed key (the page reads
// `ps-dev-wallet` from its storage; the test writes it before load) and a
// fixed in-game key, so /h/me can name them. Five viewer stages:
//   none         no Citizen yet (join and faction)
//   joined       a Citizen with its in-game key, no land (the site picker)
//   ticket       a Citizen with an open ticket for three candidate sites of its
//                home wedge (the wait for the village)
//   provisional  a Citizen with a provisional Holding at province (2,0): a
//                hamlet, no hosts yet (they come with a final village)
//   holding      a Citizen with a final Holding at province (2,0), three hosts
//                (one marching, one free, one Scout) and a resolved clash at
//                bell 39 in its province (report, tracker, bell sheet)
//
// The live mode (UX design 12.4; liveworld.mjs keeps its state): every builder
// below takes an optional last argument, the live view `lv` (plain data: the
// clock, the Holding's and the Province's changed fields, the records logged
// since). Without it each answer is byte for byte what it was before the
// live mode existed.
import { readFileSync } from 'node:fs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { ACCOUNTS } from '../../permutation-server/web/frontier/abi.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { decode as fromBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { KINDS } from '../../permutation-server/web/frontier/flog.mjs';
import { ringProvinces, regionOf, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { pack, encodePath, commit as sealCommit, ctHash as sealCtHash, sealRoot as sealRootOf, sealRound } from '../../permutation-server/web/frontier/seal.mjs';
import { entryOf, bookKey } from '../../permutation-server/web/frontier/marchbook.mjs';
import { encodeAccount, fixtures, PROGRAM, SEASON_ID, GENESIS_TS, BELL, LATEST_UNIX, LATEST_SLOT } from '../test/fixtures/frontier/make-fixtures.mjs';

export { PROGRAM, SEASON_ID, GENESIS_TS, BELL, LATEST_UNIX, LATEST_SLOT };
export const DEV_WALLET_NAME = 'Dev Wallet (localnet)';
/** The dev wallet's and the in-game key's seeds (test keys, never funded anywhere). */
export const DEV_SEED = new Uint8Array(32).fill(0x11);
export const SESSION_SEED = new Uint8Array(32).fill(0x22);
// The home province's sites and passable camp tile follow frontier.wasm's
// generate_province for ring seed 03…03 (the fixture season's ring 2), so
// the tile LOD, the site picker and the path planner agree.
export const HOME_SITES = Object.freeze([22, 39, 3, 7, 10, 19, 24, 26, 43, 56, 0, 29]);
export const CAMP_TILE = 32;
export const HOME = Object.freeze({ p: 2, q: 0, site: 3, gen: 0, tile: HOME_SITES[3] });
export const REPORT_BELL = BELL - 1;
/** The viewer stages the fixture answers for. */
export const STAGES = Object.freeze(['none', 'joined', 'ticket', 'provisional', 'holding']);
/** The ticket of stage `ticket`: its bell and its three candidate sites (free sites of the home wedge's ring 2). */
export const TICKET_BELL = BELL + 1;
export const TICKET_SITES = Object.freeze([{ p: 2, q: 0, site: 5 }, { p: 1, q: 1, site: 4 }, { p: 1, q: 1, site: 6 }]);
const NO_BELL = 0xffffffff;
const b64 = b => Buffer.from(b).toString('base64');

export const HOSTS = Object.freeze({
  marching: hostId({ ...HOME, seq: 7 }),
  free: hostId({ ...HOME, seq: 8 }),
  scout: hostId({ ...HOME, seq: 9 }),
});

/** Keys and addresses of the viewer (async: WebCrypto Ed25519). */
export async function viewer() {
  const wallet = (await keyFromSeed(DEV_SEED)).publicKey;
  const session = (await keyFromSeed(SESSION_SEED)).publicKey;
  const A = seasonAddresses(PROGRAM, SEASON_ID);
  return { wallet, session, citizen: A.of('Citizen', { wallet }), holding: A.of('Holding', HOME), A };
}

/**
 * Whether `storageFor` writes the live mode's march book when it is not told (`live` omitted): the fixture server
 * sets it with `live(on)`, so a caller that only knows `srv.live(true)` and `storageFor(…)` (the preview's boot
 * page) gets the storage the live world needs.
 */
let liveStorage = false;
export const setLiveStorage = on => { liveStorage = !!on; };

/** localStorage the page finds at load for a viewer stage and language (`live`: also this device's record of the viewer's sealed march, see `liveBook`). */
export function storageFor(v, { stage, lang, intro = false, live = liveStorage }) {
  const out = { 'ps-lang': lang, 'ps-dev-wallet': toHex(DEV_SEED), 'ps-wallet': DEV_WALLET_NAME };
  // a returning player: the title card was seen (the "intro" scene opens it as a first visit does)
  if (!intro) out['ps-fintro:v1'] = '1';
  if (stage !== 'none') out[`ps-fsession:localnet:${PROGRAM}:${SEASON_ID}:${v.wallet}`] = toHex(SESSION_SEED);
  if (live && stage === 'holding') out[bookKey({ cluster: 'localnet', programId: PROGRAM, seasonId: SEASON_ID }, v.wallet)] = JSON.stringify(liveBook(v));
  return out;
}

// ------------------------------------------------------------------ accounts
function citizenBytes(v, stage) {
  const land = stage === 'holding' || stage === 'provisional', ticket = stage === 'ticket';
  return encodeAccount('Citizen', {
    wallet: fromBase58(v.wallet), session: fromBase58(v.session), sessionExpiry: GENESIS_TS + 30 * 86_400, faction: 0,
    flags: stage === 'holding' ? 1 | 4 : stage === 'provisional' ? 1 | 8 : 1, holdingsN: land ? 1 : 0, exploresFloorLeft: 3, joinBell: 2, vigilStartMin: 0,
    holding: land ? [{ p: HOME.p, q: HOME.q, site: HOME.site, gen: HOME.gen }] : [], ticketBell: ticket ? TICKET_BELL : NO_BELL, citizenTag: 0x5eed_0001n,
    ...(ticket ? { ticketSites: TICKET_SITES.map(x => ({ ...x })), ticketNext: 0, ticketEscrow: 10_000_000n } : {}),
  });
}

const accrual = (value, rate, cap) => ({ value: value * 1000, rate: rate * 1000, cap: cap * 1000, t0: LATEST_UNIX - 1800, frac: 0 });
function holdingBytes(v, stage = 'holding', lv = null) {
  // a provisional village: a hamlet founded a moment ago; it harvests and builds, and has no hosts yet
  if (stage === 'provisional') return encodeAccount('Holding', {
    p: HOME.p, q: HOME.q, site: HOME.site, gen: HOME.gen, tile: HOME.tile, state: 1, ownerCitizen: fromBase58(v.citizen), faction: 0, order: 1, tier: 0,
    ticketBell: BELL - 1, foundedTs: LATEST_UNIX - 900, foundedDay: 0, hostSeq: 0, lastOwnerAction: LATEST_UNIX - 300, shieldUntil: LATEST_UNIX + 7_200,
    stores: [accrual(300, 40, 6_000), accrual(200, 30, 6_000), accrual(150, 25, 6_000), accrual(60, 10, 4_000), accrual(0, 5, 2_000), accrual(0, 0, 2_000), accrual(0, 0, 1_000), accrual(0, 0, 1_000)],
    queue: [], reserve: [0, 0, 0, 0, 0, 0, 0, 0], transit: [null, null, null, null], finalTs: LATEST_UNIX + 9_000,
  });
  return encodeAccount('Holding', {
    p: HOME.p, q: HOME.q, site: HOME.site, gen: HOME.gen, tile: HOME.tile, state: 2, ownerCitizen: fromBase58(v.citizen), faction: 0, order: 1, tier: 1,
    ticketBell: 3, foundedTs: GENESIS_TS + 1_300, foundedDay: 0, hostSeq: 10, lastOwnerAction: LATEST_UNIX - 3_600, shieldUntil: LATEST_UNIX + 7_200,
    stores: HOLDING_STORES.map(s => accrual(...s)),
    queue: [{ doneAt: LATEST_UNIX + 1_500, kind: 1, arg: 0, delta: 0 }],
    reserve: [...HOLDING_RESERVE],
    transit: [null, marchingTransit(), null, null],
    finalTs: GENESIS_TS + 20_000,
    // the live mode: what the turn and the viewer's accepted orders changed (liveworld.mjs)
    ...(lv ? lv.holding : {}),
  });
}
/** The final village's stores (whole units: value, per hour, cap), its reserve by unit, and its host on the road. */
export const HOLDING_STORES = Object.freeze([[1_200, 40, 6_000], [800, 30, 6_000], [650, 25, 6_000], [300, 10, 4_000], [120, 5, 2_000], [90, 0, 2_000], [40, 0, 1_000], [20, 0, 1_000]].map(Object.freeze));
export const HOLDING_RESERVE = Object.freeze([300, 0, 0, 0, 0, 0, 100, 0]);
export const HOLDING_STORES_T0 = LATEST_UNIX - 1800;
export const marchingTransit = (sealRoot = 'a5'.repeat(32)) => ({ state: 1, unit: 0, faction: 0, originTile: HOME.tile, originP: HOME.p, originQ: HOME.q, hostId: HOSTS.marching, departBell: BELL - 1, arriveBell: BELL + 3,
  departTs: LATEST_UNIX - 900, depMass: 400, marchStamina: 74, sealRoot, tip: 14_472, flags: 3 });

const FREE_MIRROR = () => Array.from({ length: 12 }, () => ({ state: 0, faction: 6, pend0Bell: NO_BELL, pend1Bell: NO_BELL, wallItem0Bell: NO_BELL, wallItem1Bell: NO_BELL }));
/** A province account: the home province carries the viewer's holding, hosts and the camp; every other one is open land. */
export const HOME_ENTRIES = () => [
  { id: HOSTS.marching, faction: 0, unit: 0, tile: HOME.tile, state: 3, troops: 400_000, staminaValue: 46, staminaBell: BELL - 1, dealtBps: 10_000, fromBell: 20 },
  { id: HOSTS.free, faction: 0, unit: 0, tile: HOME.tile, state: 1, troops: 600_000, staminaValue: 110, staminaBell: BELL, dealtBps: 10_000, fromBell: 30 },
  { id: HOSTS.scout, faction: 0, unit: 6, tile: HOME.tile, state: 1, troops: 100_000, staminaValue: 120, staminaBell: BELL, dealtBps: 10_000, fromBell: 30 },
];
/** `lv` (the live view, home province only): `{entries?, garrison?, …Province fields}` in place of the fixture's own. */
function provinceBytes(p, q, stage = 'holding', lv = null) {
  const home = p === HOME.p && q === HOME.q;
  const mirror = FREE_MIRROR();
  const entries = [];
  const hamlet = stage === 'provisional';
  const { entries: liveEntries = null, garrison: liveGarrison = null, ...liveFields } = home && lv ? lv : {};
  if (home) {
    mirror[HOME.site] = { state: 1, faction: 0, order: 1, tier: hamlet ? 0 : 1, gen: HOME.gen, garrison: hamlet ? 0 : liveGarrison ?? 300_000, pend0Bell: NO_BELL, pend1Bell: NO_BELL, wallItem0Bell: NO_BELL, wallItem1Bell: NO_BELL };
    mirror[7] = { state: 1, faction: 2, order: 1, tier: 1, gen: 0, garrison: 120_000, pend0Bell: NO_BELL, pend1Bell: NO_BELL, wallItem0Bell: NO_BELL, wallItem1Bell: NO_BELL };
    if (!hamlet) entries.push(...(liveEntries ?? HOME_ENTRIES()));
  } else if ((p * 7 + q * 3) % 4 === 0) {
    mirror[0] = { state: 1, faction: ((p + 6) % 6 + 6) % 6, order: 1, tier: 1, gen: 0, garrison: 90_000, pend0Bell: NO_BELL, pend1Bell: NO_BELL, wallItem0Bell: NO_BELL, wallItem1Bell: NO_BELL };
  }
  return encodeAccount('Province', {
    eventSeq: 9, p, q, ring: (Math.abs(p) + Math.abs(q) + Math.abs(p + q)) / 2, wedge: wedgeOf(p, q) ?? 0xff, region: regionOf(p, q), resolvedNext: BELL + 1, openedBell: 3,
    nEntries: entries.length, nSitesUsed: mirror.filter(m => m.state === 1).length, rosterEpoch: 4, sites: home ? HOME_SITES : [2, 5, 9, 14, 20, 24, 30, 36, 41, 47, 52, 58], siteCount: 12,
    passableMask: (1n << 61n) - 1n, siteMirror: mirror, entries,
    camp: home ? { tile: CAMP_TILE, state: 1, troops: 250, nextCheckDay: 1, gen: 1 } : { tile: 0, state: 0, troops: 0, nextCheckDay: 1, gen: 0 },
    ...liveFields,
  });
}

/** The overview of ring d (§9.3), a few sites held per province. */
function overviewBytes(d) {
  const provs = ringProvinces(d).sort((a, b) => a.p - b.p || a.q - b.q);
  const out = new Uint8Array(32 + 24 * provs.length), dv = new DataView(out.buffer);
  out.set(Buffer.from('PSFOV1\0\0', 'latin1'), 0);
  dv.setBigUint64(8, BigInt(SEASON_ID), true);
  dv.setUint16(16, d, true);
  dv.setUint16(18, provs.length, true);
  dv.setUint32(20, BELL, true);
  dv.setBigUint64(24, BigInt(LATEST_SLOT), true);
  provs.forEach((v, i) => {
    const o = 32 + 24 * i;
    dv.setInt16(o, v.p, true);
    dv.setInt16(o + 2, v.q, true);
    let owners = 0n, sites = 0;
    const home = v.p === HOME.p && v.q === HOME.q;
    for (let s = 0; s < 12; s++) {
      const held = home ? s === HOME.site || s === 7 : d > 0 && (s + i) % 5 === 0;
      const f = home ? (s === HOME.site ? 0 : 2) : (i + d) % 6;
      owners |= BigInt(held ? f : 7) << BigInt(3 * s);
      sites |= (held ? 1 : home && s === 11 ? 2 : 0) << (2 * s);
    }
    for (let j = 0; j < 5; j++) out[o + 4 + j] = Number((owners >> BigInt(8 * j)) & 0xffn);
    out[o + 9] = sites & 0xff; out[o + 10] = (sites >> 8) & 0xff; out[o + 11] = (sites >> 16) & 0xff;
    for (let f = 0; f < 7; f++) out[o + 12 + f] = home ? (f === 0 ? 3 : 0) : f === (i + d) % 6 ? 1 : 0;
    out[o + 19] = home ? 1 : 0;
    dv.setUint32(o + 20, BELL + 1, true);
  });
  return out;
}

// ------------------------------------------------------------------ the clash of bell 39 in the home province
const hid = (site, gen, seq) => hostId({ p: HOME.p, q: HOME.q, site, gen, seq });
const ARRIVALS = [
  { hostId: hid(7, 0, 1), citizenTag: 11n, depMass: 900, troops: 900_000, stamina: 60, retreat: 0, dealt: 10_000, faction: 2, unit: 0, tile: HOME.tile, stance: 1, present: 1, fate: 5, troopsAfter: 0 },
  { hostId: HOSTS.free, citizenTag: 0x5eed_0001n, depMass: 600, troops: 600_000, stamina: 90, retreat: 15_000, dealt: 10_000, faction: 0, unit: 0, tile: CAMP_TILE, stance: 3, present: 1, fate: 1, troopsAfter: 520_000 },
];
function clashInputsBytes() {
  return encodeAccount('ClashInputs', { p: HOME.p, q: HOME.q, bell: REPORT_BELL, arrivalsMask: 0xffffff, flags: 2, nPresent: 2, arrivals: ARRIVALS });
}
export function clashReport() {
  const region = regionOf(HOME.p, HOME.q);
  return { v: 1, bell: REPORT_BELL, province: [HOME.p, HOME.q], inputs_b64: b64(clashInputsBytes()), seed: '5e'.repeat(32),
    anchor: { key: `an:${REPORT_BELL},${region}`, A: GENESIS_TS + 600 * BELL + 2 }, cache: { key: `sd:${REPORT_BELL},${region},0` },
    outcomeDigest: '3c'.repeat(32), inputDigest: '00'.repeat(32), decoded: { engagements: 3 } };
}

// ------------------------------------------------------------------ the live turn's clash (UX design 12.4)
/** The second raid of the neighbouring village of Cinder (site 7 of the home province): its host, by its own id. */
export const RAIDER = hid(7, 0, 2);
/**
 * The clash the live turn reports: the raid on the viewer's village at bell `bell`. The existing report's first
 * arrival (900 spearmen of Cinder on the village's tile, destroyed), in its own position of the ClashInputs
 * (faction × 4 + i), with the Province before the bell (`province_before_b64`, the field the herald's reports
 * carry): the viewer's host and garrison stood there with a little more than they have now.
 */
export function liveClashReport(bell) {
  const region = regionOf(HOME.p, HOME.q);
  const arrivals = Array.from({ length: 24 }, () => null);
  arrivals[2 * 4] = { ...ARRIVALS[0], hostId: RAIDER };
  const inputs = encodeAccount('ClashInputs', { p: HOME.p, q: HOME.q, bell, arrivalsMask: 1 << 8, flags: 2, nPresent: 1, arrivals, resolvedTs: GENESIS_TS + 600 * (bell + 2) + 70 });
  const before = provinceBytes(HOME.p, HOME.q, 'holding', { resolvedNext: bell, garrison: 340_000,
    entries: HOME_ENTRIES().map(e => (e.id === HOSTS.free ? { ...e, troops: 640_000 } : e)) });
  return { v: 1, bell, province: [HOME.p, HOME.q], inputs_b64: b64(inputs), seed: '5e'.repeat(32), province_before_b64: b64(before),
    anchor: { key: `an:${bell},${region}`, A: GENESIS_TS + 600 * (bell + 1) + 2 }, cache: { key: `sd:${bell},${region},0` },
    outcomeDigest: '3d'.repeat(32), inputDigest: '00'.repeat(32), decoded: { engagements: 3 } };
}

// ------------------------------------------------------------------ the live world's sealed march (UX design 12.4)
/**
 * The viewer's march on the road (the fixture's marching host, transit record 1): in the live world this device
 * sealed it, so the page holds its record (the march book) and knows where it goes: the camp of the home province,
 * four tiles along the way frontier.wasm's planner gives a Spearman (`MARCH_DIRS`). The plaintext, the commitment
 * and the seal root are the page's own arithmetic (seal.mjs); the 165 seal bytes are filler (no time-lock is made
 * here: nothing opens them, and the page checks them only against the root).
 */
export const MARCH_DIRS = Object.freeze([5, 0, 0, 0]);
export const MARCH_ARRIVE = BELL + 3;
function liveMarch() {
  const path = encodePath(MARCH_DIRS);
  const plain = pack({ version: 1, hostId: HOSTS.marching, arriveBell: MARCH_ARRIVE, destP: HOME.p, destQ: HOME.q, destTile: CAMP_TILE, stance: 1, retreatBps: 0, pathLen: path.pathLen, path: path.path });
  const salt = new Uint8Array(32).fill(0x5a), seal = Uint8Array.from({ length: 165 }, (_, i) => (i * 7 + 3) & 0xff);
  const commit = sealCommit(plain, salt), ct = sealCtHash(seal);
  return { plain, salt, seal, commit, ctHash: ct, sealRoot: sealRootOf(commit, ct) };
}
/** The seal root the live world's transit record carries (hex). */
export const liveSealRoot = () => toHex(liveMarch().sealRoot);
/** The page's march book for the live world: one entry, written as the page writes it (marchbook.mjs `entryOf`), landed. */
export function liveBook(v) {
  const m = liveMarch();
  const round = sealRound({ genesisTs: GENESIS_TS, drand: { genesis: SEASON.drand.genesis, period: SEASON.drand.period } }, MARCH_ARRIVE);
  const e = entryOf({ host: HOSTS.marching, transitSlot: 1, departBell: BELL - 1, arriveBell: MARCH_ARRIVE, holding: v.holding, ...m, round, tip: 14_472n,
    route: { dirs: [...MARCH_DIRS] }, origin: { p: HOME.p, q: HOME.q, tile: HOME.tile } }, () => 0);
  return [{ ...e, state: 'landed' }];
}
/** An ArrivalSlot of the viewer's (faction 0): the account a Reveal creates in the destination province. */
export const arrivalSlotBytes = ({ p, q, bell, i = 0, unit = 0, stance = 0, tile, retreatBps = 0, hostId: id, depMass }) =>
  encodeAccount('ArrivalSlot', { p, q, bell, faction: 0, i, unit, stance, tile, retreatBps, hostId: id, citizenTag: 0x5eed_0001n, depMass, dealtBps: 10_000 });
/** The ArrivalSlot of that march once it is revealed (the envelope of its arrival bell carries it): `{key, slot, bytes}`. */
export function liveArrivalSlot() {
  const bytes = arrivalSlotBytes({ p: HOME.p, q: HOME.q, bell: MARCH_ARRIVE, stance: 1, tile: CAMP_TILE, hostId: HOSTS.marching, depMass: 400 });
  return { key: `ar:${HOME.p},${HOME.q},${MARCH_ARRIVE},0,0`, slot: LATEST_SLOT + 1_500, bytes: b64(bytes) };
}

// ------------------------------------------------------------------ PS2 events (§6), encoded field for field from flog.mjs's table
function ps2(kind, bell, fields) {
  const spec = KINDS[kind];
  const parts = [Uint8Array.of(1, kind, bell & 0xff, (bell >> 8) & 0xff, (bell >> 16) & 0xff, (bell >>> 24) & 0xff)];
  for (const [name, len] of [...spec.key, ...spec.payload]) {
    const v = fields[name] ?? 0;
    const b = new Uint8Array(len);
    if (v instanceof Uint8Array) b.set(v.slice(0, len));
    else { let x = BigInt(v); if (x < 0n) x += 1n << BigInt(8 * len); for (let i = 0; i < len; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } }
    parts.push(b);
  }
  parts.push(Uint8Array.of(0));
  return Buffer.concat(parts);
}
/** One PS2 record body for the live world's log (liveworld.mjs): `ps2(kind, bell, fields)`. */
export const record = ps2;
/** `extra`: the live world's records after the fixture's own, `[{kind, bell, fields}]` (their seqs follow the season record's head). */
export function events(extra = null) {
  const list = [
    ps2(4, 3, { d: 2, t_open: GENESIS_TS + 1_800 }),
    ps2(6, 3, { p: HOME.p, q: HOME.q, ring: 2, wedge: wedgeOf(HOME.p, HOME.q), region: regionOf(HOME.p, HOME.q), site_count: 12, camp_tile: CAMP_TILE, camp_troops: 250 }),
    ps2(10, 4, {}),
    ps2(14, 5, { p: HOME.p, q: HOME.q, site: HOME.site, outcome: 0 }),
    ps2(16, 29, { p: HOME.p, q: HOME.q, site: HOME.site, final_ts: GENESIS_TS + 20_000 }),
    ps2(43, 30, { p: HOME.p, q: HOME.q, tile: CAMP_TILE, troops: 250, day: 0 }),
    ps2(30, 36, { host_id: hid(7, 0, 1), origin_p: 3, origin_q: -1, origin_tile: 20, depart_bell: 36, arrive_bell: REPORT_BELL, dep_mass: 900 }),
    ps2(41, 39, { p: HOME.p, q: HOME.q, bell: REPORT_BELL, engagements: 3 }),
    ps2(30, 39, { host_id: HOSTS.marching, origin_p: HOME.p, origin_q: HOME.q, origin_tile: HOME.tile, depart_bell: BELL - 1, arrive_bell: BELL + 3, dep_mass: 400 }),
    ps2(34, 40, { host_id: hid(7, 0, 1), outcome: 4 }),
  ];
  const base = 800;
  const out = list.map((body, i) => ({ seq: String(base + i), slot: LATEST_SLOT - 1_000 + i * 50, sig: String(i + 1).repeat(64).slice(0, 64), body_b64: b64(body) }));
  (extra ?? []).forEach((x, i) => out.push({ seq: String(HEAD_SEQ + 1 + i), slot: LATEST_SLOT + 100 + i * 50, sig: String((i % 9) + 1).repeat(64), body_b64: b64(ps2(x.kind, x.bell, x.fields)) }));
  return out;
}
/** The season record's event head before the live world logs anything. */
export const HEAD_SEQ = 812;

// ------------------------------------------------------------------ the herald's files
const SEASON = JSON.parse(fixtures().get('season.json').toString());
/**
 * The node tests' season record, with the M1_LOCAL_7D dormancy and release
 * times written into the Season bytes (the shared fixture leaves them 0,
 * which would show every holding as dormant).
 */
const PRESET = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/presets.json', import.meta.url), 'utf8')).presets.find(x => x.name === 'M1_LOCAL_7D').fields;
function seasonBytes() {
  const b = Buffer.from(SEASON.bytes_b64, 'base64');
  const field = name => ACCOUNTS.Season.fields.find(f => f[0] === name)[1];
  b.writeUInt32LE(PRESET.dormant_after_secs, field('DORMANT_AFTER_SECS'));
  b.writeUInt32LE(PRESET.release_after_secs, field('RELEASE_AFTER_SECS'));
  return b.toString('base64');
}
const SEASON_B64 = seasonBytes();
/** `lv` (the live view): the clock the live world keeps (`latestUnix`, `latestSlot`) and its event head. */
export const seasonRecord = (lv = null) => ({ ...SEASON, headSeq: '812', bytes_b64: SEASON_B64, ...(lv ? { headSeq: String(lv.headSeq), latestUnix: lv.latestUnix, latestSlot: lv.latestSlot } : {}) });

/** `/h/me/{wallet}` for a stage (a wallet that has not joined: a record with no Citizen). */
export function meRecord(v, stage, lv = null) {
  if (stage === 'none') return { v: 1, wallet: v.wallet, citizen: null, holdings: [], slots: [] };
  const rec = { v: 1, wallet: v.wallet, citizen: { address: v.citizen, bytes_b64: b64(citizenBytes(v, stage)) }, holdings: [], slots: [], quota: { left: lv?.quotaLeft ?? 38, resetsAt: GENESIS_TS + 86_400 } };
  if (stage === 'holding' || stage === 'provisional') rec.holdings = [{ address: v.holding, bytes_b64: b64(holdingBytes(v, stage, stage === 'holding' ? lv : null)) }];
  return rec;
}

/** `/h/province/{P},{Q}/{bell}` (the latest file is bell 40's); `stage` matters for the home province only (a provisional village is a hamlet without hosts). */
export function provinceEnvelope(p, q, bell = BELL, stage = 'holding', lv = null) {
  const home = p === HOME.p && q === HOME.q && stage === 'holding' ? lv : null;
  return { v: 1, key: `pv:${p},${q}`, bell, slot: LATEST_SLOT - 50, seq: '9', head: '7e'.repeat(32), bytes: b64(provinceBytes(p, q, stage, home?.province ?? null)),
    slots: (home?.slots ?? []).filter(s => Number(s.key.split(',')[2]) === bell), day: null, inputs: null };
}

export const overview = d => Buffer.from(overviewBytes(d));

/** The roster of ring d (herald roster.rs): every held site of the overview gets a fixed citizen tag. */
function rosterBytes(d) {
  const provs = ringProvinces(d).sort((a, b) => a.p - b.p || a.q - b.q);
  const ov = overviewBytes(d);
  const out = new Uint8Array(32 + 196 * provs.length), dv = new DataView(out.buffer);
  out.set(ov.subarray(0, 32), 0);
  out.set(Buffer.from('PSFRS1\0\0', 'latin1'), 0);
  provs.forEach((v, i) => {
    const o = 32 + 196 * i, oo = 32 + 24 * i;
    dv.setInt16(o, v.p, true); dv.setInt16(o + 2, v.q, true);
    const sites = ov[oo + 9] | (ov[oo + 10] << 8) | (ov[oo + 11] << 16);
    for (let s = 0; s < 12; s++) {
      if (((sites >> (2 * s)) & 3) !== 1) continue;
      dv.setBigUint64(o + 4 + s * 16, 0x5eed0000n + BigInt((v.p + 64) * 4096 + (v.q + 64) * 16 + s), true);
      dv.setUint32(o + 12 + s * 16, 1, true);
      out[o + 16 + s * 16] = (s + i) % 4;
    }
  });
  return out;
}
export const roster = d => Buffer.from(rosterBytes(d));

/** `/h/bell/{b}/region/{r}`: anchored and seeded up to bell 40, open after it. */
export function bellRegion(bell, region, lv = null) {
  if (bell > (lv?.anchoredThrough ?? BELL)) return { v: 1, bell, region, anchor: null, S: null, caches: [], tombstoned: false, archived: false, resolved: [] };
  const a = GENESIS_TS + 600 * (bell + 1) + 2;
  const anchor = encodeAccount('BellAnchor', { bell, region, net: 2, round: 35_732_412, a, slot: 100_000, sig48: '93'.repeat(48) });
  return { v: 1, bell, region, anchor: { key: `an:${bell},${region}`, bytes_b64: b64(anchor) }, S: 35_732_633, caches: [{ nonce: 0, round: 35_732_633, seed: '5e'.repeat(32), A: a }],
    tombstoned: false, archived: false, resolved: bell === REPORT_BELL || bell === lv?.clashBell ? [[HOME.p, HOME.q]] : [] };
}

// Independent byte correspondence, not execution/authentication verification.
// Prefix fields: generated production fcodec V2. Wide trailers and land records: frontier-abi world_index/{holding,land,
// rules} and layout::world::province_fund (offsets pinned below, from those sources).
// Every village, province and land number the host reports must equal the account bytes it also returns; the browser
// re-reads them, it never computes, projects or generates them (terrain included: it is only read, never derived here).
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
const fail = () => { throw new Error('EvidenceMismatch'); };
const check = x => { if (!x) fail(); };
const bytes = s => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x,16));
const hex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const owner = '12'.repeat(32);
const text = b => String.fromCharCode(...b);
/** Province v2 prefix (frontier-abi v2/layout/province.rs) and wide trailer (world_index/land.rs `province`). */
const PV = Object.freeze({ P: 64, Q: 66, WEDGE: 70, REGION: 71, RESOLVED_NEXT: 72, OPENED_BELL: 76, PASSABLE_MASK: 264,
  SITES: 250, TRAILER: 4736, WORLD: 4740, SORT_KEY: 4772, SEED_ROUND: 4792, RING_SEED: 4800, FUNDED: 4832, SIZE: 4864 });
/** Wide ring seed (world_index/land.rs `ring_seed`, 192 B). */
const RS = Object.freeze({ SIZE: 192, SEASON: 8, STATUS: 18, STATUS_SEEDED: 2, RING: 20, ROUND: 40, SEED: 48, WORLD: 80, CREATED: 112 });
/** Rules configuration (world_index/rules.rs `rules_config`, 96 B). */
const RC = Object.freeze({ SIZE: 96, SEASON: 8, VERSION: 16, RULES: 18, WORLD: 24, AUTHORITY: 56 });
/** ProvinceFund (layout/world.rs `province_fund`, 128 B, short header). */
const PF = Object.freeze({ SIZE: 128, SEASON: 8, WEDGE: 16, PROVINCES_OPENED: 20, PROVINCES_FUNDED: 44 });
/** The land module's pinned literals (land_bootstrap.rs ORIGINAL_*): what the provenance labels say they are. */
export const LAND_PINS = Object.freeze({ seedHex: '81'.repeat(32), seedRound: 32547581n, rules: [1, 2, 2, 1], authorityHex: 'aa'.repeat(32) });
function sortCheck(b, offset, p, q) { const d = new DataView(b.buffer,b.byteOffset,b.byteLength), rp = ringPosition(BigInt(p),BigInt(q)); check(d.getBigUint64(offset,false) === rp.ring && b[offset+8] === rp.wedge && d.getBigUint64(offset+9,false) === rp.pos); }
function raw(r, key) { const a = r.evidence.accounts.find(a=>a.keyHex===key); check(a && a.ownerHex===owner); return { a, b: bytes(a.dataHex) }; }
function account(r,key,size,magic) { const { b } = raw(r, key); check(b.length===size && text(b.slice(0,8))===magic && new DataView(b.buffer).getUint16(16,true)===3); return b; }
const holdingPrefix = r => decodePrefix('Holding', account(r,r.holding.accountKeyHex,1344,'PSFXWHL1'), {profile:2});
/** The two accounts an economy command may write: the holding and the Citizen its own bytes name as owner. */
export function villageAccountKeys(r) { return [r.holding.accountKeyHex, hex(holdingPrefix(r).ownerCitizen)]; }
/** Account keys added, removed and modified (data, lamports or owner) from `prev` to `next`. */
export function landChangedKeys(prev, next) {
  const a = new Map(prev.evidence.accounts.map(x => [x.keyHex, x])), b = new Map(next.evidence.accounts.map(x => [x.keyHex, x]));
  return {
    added: [...b.keys()].filter(k => !a.has(k)),
    removed: [...a.keys()].filter(k => !b.has(k)),
    modified: [...b.keys()].filter(k => a.has(k) && (a.get(k).dataHex !== b.get(k).dataHex || a.get(k).lamports !== b.get(k).lamports || a.get(k).ownerHex !== b.get(k).ownerHex)),
  };
}
function checkVillage(r, v) {
  const s = r.village;
  check(v.tier === s.tier && v.flags === s.flags && String(v.lastOwnerAction) === s.lastOwnerAction);
  check(v.stores.length === 8 && v.production.length === 8 && v.queue.length === 4 && v.reserve.length === 8);
  v.stores.forEach((x, i) => check(String(x.value) === s.stores[i].value && String(x.rate) === s.stores[i].rate && String(x.cap) === s.stores[i].cap && String(x.t0) === s.stores[i].t0));
  v.production.forEach((x, i) => check(String(x) === s.production[i]));
  v.queue.forEach((x, i) => check(String(x.doneAt) === s.queue[i].doneAt && x.kind === s.queue[i].kind && x.arg === s.queue[i].arg && String(x.delta) === s.queue[i].delta));
  v.reserve.forEach((x, i) => check(x === s.reserve[i]));
  // the owner citizen is one of the returned accounts, under the program
  const c = r.evidence.accounts.find(a => a.keyHex === hex(v.ownerCitizen));
  check(c && c.ownerHex === owner && c.dataHex.length === 2 * 384);
}
/** The LOCAL land records, re-read from their bytes: ring 129 Seeded with the pinned literal seed and round, the
 * provinces-created count the host reports, the prototype rule bytes under the pinned authority, six funds whose
 * wedge bytes are 0..5 and whose opening counters add up to the number of provinces opened. Returns the record's
 * seed and round so every province trailer can be bound to it. */
function checkLand(r, seasonHex) {
  const l = r.land;
  const { b: s } = raw(r, l.ringSeedKeyHex), sd = new DataView(s.buffer);
  check(s.length === RS.SIZE && text(s.slice(0, 8)) === 'PSFXWRS1' && hex(s.slice(RS.SEASON, RS.SEASON + 8)) === seasonHex);
  check(s[RS.STATUS] === RS.STATUS_SEEDED && sd.getBigUint64(RS.RING, true) === BigInt(l.ring));
  check(hex(s.slice(RS.WORLD, RS.WORLD + 32)) === r.map.worldHex && sd.getBigUint64(RS.CREATED, true) === BigInt(l.provincesCreated));
  const seedHex = hex(s.slice(RS.SEED, RS.SEED + 32)), round = sd.getBigUint64(RS.ROUND, true);
  check(seedHex === LAND_PINS.seedHex && round === LAND_PINS.seedRound);
  const { b: c } = raw(r, l.rulesConfigKeyHex), cd = new DataView(c.buffer);
  check(c.length === RC.SIZE && text(c.slice(0, 8)) === 'PSFXWRC1' && hex(c.slice(RC.SEASON, RC.SEASON + 8)) === seasonHex);
  check(cd.getUint16(RC.VERSION, true) === 1 && LAND_PINS.rules.every((x, i) => c[RC.RULES + i] === x));
  check(hex(c.slice(RC.WORLD, RC.WORLD + 32)) === r.map.worldHex && hex(c.slice(RC.AUTHORITY, RC.AUTHORITY + 32)) === LAND_PINS.authorityHex);
  let opened = 0, funded = 0;
  l.fundKeysHex.forEach((k, w) => {
    const { b: f } = raw(r, k), fd = new DataView(f.buffer);
    check(f.length === PF.SIZE && text(f.slice(0, 8)) === 'PSF1PFND' && hex(f.slice(PF.SEASON, PF.SEASON + 8)) === seasonHex && f[PF.WEDGE] === w);
    opened += fd.getUint32(PF.PROVINCES_OPENED, true); funded += fd.getUint32(PF.PROVINCES_FUNDED, true);
  });
  check(opened === l.opened && funded === l.opened);
  return { seedHex, round };
}
export function checkEvidence(r) {
  const h=account(r,r.holding.accountKeyHex,1344,'PSFXWHL1'), hd=new DataView(h.buffer), v=decodePrefix('Holding',h,{profile:2});
  check(hd.getUint16(1280,true)===1 && h[1282]===1 && hex(h.slice(1288,1320))===r.map.worldHex);
  sortCheck(h,1320,r.map.origin.p,r.map.origin.q);
  check(v.reserve[0]===r.holding.reserveUnits && String(v.escrow)===r.holding.escrowLamports && String(v.poolOwed)===r.holding.poolOwedLamports && h[1286]===r.holding.openTransits && v.tile===r.holding.tile);
  check(v.site<12 && v.p===0 && v.q===0);
  checkVillage(r, v);
  const ref=bytes(r.host.refHex); check(ref[0]===1 && hex(ref.slice(1,33))===r.map.worldHex && ref[50]===v.site && ref[51]===v.gen); sortCheck(ref,33,r.map.origin.p,r.map.origin.q);
  const seed = checkLand(r, hex(h.slice(8, 16)));
  for(const p of r.map.provinces) {
    const { a } = raw(r, p.accountKeyHex);
    const b=account(r,p.accountKeyHex,PV.SIZE,'PSFXWPV1'), d=new DataView(b.buffer);
    check(d.getUint16(PV.TRAILER,true)===1 && b[PV.TRAILER+2]===1 && b[PV.TRAILER+3]===15 && hex(b.slice(PV.WORLD,PV.WORLD+32))===r.map.worldHex && d.getInt16(PV.P,true)===0 && d.getInt16(PV.Q,true)===0);
    // the province's identity: its sort key is the reported coordinate, its prefix wedge that key's wedge
    sortCheck(b,PV.SORT_KEY,p.p,p.q);
    check(b[PV.WEDGE] === p.wedge && p.wedge === ringPosition(BigInt(p.p), BigInt(p.q)).wedge && b[PV.REGION] === p.region);
    check(String(d.getBigUint64(PV.PASSABLE_MASK,true))===p.passableMask);
    check(d.getUint32(PV.RESOLVED_NEXT,true) === p.resolvedNext && d.getUint32(PV.OPENED_BELL,true) === p.openedBell);
    // its terrain seed and round are the ring seed record's (fixtures and openings alike)
    check(hex(b.slice(PV.RING_SEED, PV.RING_SEED+32)) === seed.seedHex && d.getBigUint64(PV.SEED_ROUND,true) === seed.round);
    const isOrigin = p.p===r.map.origin.p && p.q===r.map.origin.q, isDest = p.p===r.map.destination.p && p.q===r.map.destination.q;
    if(isOrigin) check(b[PV.SITES+v.site]===v.tile);
    // the horizon cursors are the fixtures' own bytes, not a host claim
    if(isOrigin) check(p.resolvedNext === r.horizon.originResolvedNext);
    if(isDest) check(p.resolvedNext === r.horizon.destinationResolvedNext);
    // an opened province was funded with exactly its own lamports
    if(p.source === 'opened') check(String(d.getBigUint64(PV.FUNDED,true)) === a.lamports);
  }
  // v4: the bound march's destination cursor is that province's own RESOLVED_NEXT bytes
  const mb = r.marchBinding;
  if (mb) {
    const { b } = raw(r, mb.destination.accountKeyHex);
    check(b.length === PV.SIZE && new DataView(b.buffer).getUint32(PV.RESOLVED_NEXT, true) === r.horizon.selectedDestinationResolvedNext);
  } else check(r.horizon.selectedDestinationResolvedNext === null);
  checkTransit(r);
  // Host/combat/returned projections are intentionally not independently decoded here.
  return true;
}

/** The byte ranges of an opened province that no handler may change after its opening (land_bootstrap.rs
 * `GATED`: header identity, prefix identity, opened bell, terrain, trailer). Everything else (event chain, resolve
 * cursor, roads, site mirror, entries, camp, keep, score) may evolve under real resolves. */
export const PROVINCE_GATED = Object.freeze([[0, 24], [64, 72], [76, 80], [128, 280], [4736, 4864]].map(r => Object.freeze(r)));
/** Whether two province account images agree on every GATED range (and have the province size). */
export function gatedEqual(aHex, bHex) {
  if (aHex.length !== 2 * PV.SIZE || bHex.length !== 2 * PV.SIZE) return false;
  return PROVINCE_GATED.every(([s, e]) => aHex.slice(2 * s, 2 * e) === bHex.slice(2 * s, 2 * e));
}
/** The wide transit record (world_index/march.rs `WideTransit`, 288 B, no magic): offsets of the fields read. */
const TR = Object.freeze({ LEN: 288, VERSION: 0, STATE: 1, HAS_DEST: 7, HOST: 8, ORIGIN_KEY: 64, DEST_KEY: 116, ARRIVE_BELL: 172, SEAL_ROOT: 200 });
/** Transit state per phase (layout/player.rs transit STATE_*, `MarchState::Gathered` = 4); null: no live record. */
export const TRANSIT_STATE_BY_PHASE = Object.freeze({ ready: null, departed: 1, travelling: 2, revealed: 2, resolved: 4, settled: null, returned: null });
const provinceKeyOf = (worldHex, p, q) => { const rp = ringPosition(BigInt(p), BigInt(q)); const be = v => v.toString(16).padStart(16, '0'); return `01${worldHex}${be(rp.ring)}${rp.wedge.toString(16).padStart(2, '0')}${be(rp.pos)}`; };
/** The live transit of THIS host, found by its version byte, its exact length and the host reference at HOST. While
 * a march is in flight there must be exactly one, program-owned, in the phase's state, from the origin, for bell 20,
 * whose seal root is the binding's root (and, once gathered, whose destination is the bound destination's key).
 * Outside a march there must be none (a settled transit is an emptied image). This is a layout read of the record
 * the real Depart wrote; it does not open, decrypt or authenticate the sealed order. */
function checkTransit(r) {
  const mine = r.evidence.accounts.filter(a => a.dataHex.length === 2 * TR.LEN && a.dataHex.slice(0, 2) === '01'
    && a.dataHex.slice(2 * TR.HOST, 2 * (TR.HOST + 56)) === r.host.refHex);
  const want = TRANSIT_STATE_BY_PHASE[r.phase];
  if (want === null) { check(mine.length === 0); return; }
  const mb = r.marchBinding;
  check(mine.length === 1 && mb && mine[0].ownerHex === owner);
  const b = bytes(mine[0].dataHex), d = new DataView(b.buffer);
  check(b[TR.STATE] === want && d.getUint32(TR.ARRIVE_BELL, true) === mb.arriveBell);
  check(hex(b.slice(TR.SEAL_ROOT, TR.SEAL_ROOT + 32)) === mb.order.rootHex);
  check(hex(b.slice(TR.ORIGIN_KEY, TR.ORIGIN_KEY + 50)) === provinceKeyOf(r.map.worldHex, r.map.origin.p, r.map.origin.q));
  check(b[TR.HAS_DEST] === (want === 4 ? 1 : 0));
  if (want === 4) check(hex(b.slice(TR.DEST_KEY, TR.DEST_KEY + 50)) === provinceKeyOf(r.map.worldHex, mb.destination.p, mb.destination.q));
}

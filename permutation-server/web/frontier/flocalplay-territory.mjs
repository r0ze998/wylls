// PLAYER TERRITORY (territory-impl, owner decisions 2026-11-24 12:09 JST): the single-tile claim (0xDA op 7
// WideClaimTile) as a page-signed act, the two territory records, and the decided V1 numbers (owner 13:15).
//
// This module is the ONE builder the page (flocalplay-act.mjs, the wallet signs), the relay (gateway
// local-play-act.mjs, which rebuilds the stated intent and refuses anything not byte for byte the same) and the
// operator AI residents use. Source of truth: frontier-abi world_index/territory.rs (records, V1 numbers),
// wide_ix.rs ClaimTile + CLAIM_TILE (wire), permutation-frontier proc/wide_territory.rs (the handler).
//
//   accounts  [actor s] [payer s,w] [season r] [citizen w] [wide province r] [territory province w]
//             [territory player w] [home holding w] [home province r] [system r]
//             then the reach witness when named (a wide province of the claimer's nation's land, or the territory
//             record of a province where the claimer owns a tile), read-only
//   data      0xDA ‖ 0xFF ‖ 0x01 ‖ 0x07 ‖ p i64 LE ‖ q i64 LE ‖ tile u8 ‖ witness u8 ‖ village u8 (0: the distance is
//             measured to the first home)
//   addresses with_seed(season, 'wn' ‖ hex(sha256('PSF-WIDE-TERRITORY-PROVINCE-v1' ‖ sort key)[..15]), program),
//             with_seed(season, 'wu' ‖ hex(sha256('PSF-WIDE-TERRITORY-PLAYER-v1' ‖ citizen)[..15]), program)
import { seasonAddresses, withSeed } from './faddr.mjs';
import { sortKeyOf, wideHoldingAddress } from './fwide.mjs';
import { ringPosition } from './map/wide.mjs';
import { wideProvinceAddress, distance, FIRST_WIDE_RING } from './flocalplay-wide.mjs';
import { setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit, requestHeapFrame } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';
import { decode } from '../sdk/base58.mjs';
import { toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const TERRITORY_CLAIM = 'TerritoryClaim';
/** The two territory records' sizes (frontier-abi territory_province::SIZE / territory_player::SIZE): the first claim of
 * a province creates its record from the payer, a player's first claim its summary (devnet: the claimer pays, owner TQ-12 (a)). */
export const TERRITORY_PROVINCE_BYTES = 672, TERRITORY_PLAYER_BYTES = 320;
/** The claim's CU limit: the runtime's ceiling, as the wide claim (not measured on the SBF build yet). */
export const TERRITORY_CLAIM_CU = 1_400_000;
export const TERRITORY_CLAIM_HEAP = 256 * 1024;
export const WITNESS_NONE = 0, WITNESS_NATION_LAND = 1, WITNESS_OWN = 2;
const SYSTEM = '11111111111111111111111111111111';

/**
 * The numbers of territory rule V1 (frontier-abi TERRITORY_V1; DECIDED by the owner 2026-11-24 13:15, inbox
 * 2026-11-24-1315-territory-numbers-decided.md TQ-1..TQ-5; upkeep ×10 by Q-LP15-1 (b), owner 2026-11-25 09:33): upkeep per tile 330 milli-food/h
 * + 160 milli-food/h per province of distance beyond 3 from
 * the nearest own village (home included), fixed at the claim; a claim costs 10 ore + 2 % per tile owned; reach 3 provinces from the home, a nation
 * land province or a province where the claimer owns a tile; 1 claim per turn; unpaid upkeep blocks claims, then after
 * 24 turns the farthest tile returns, one per turn.
 */
export const TERRITORY_V1 = Object.freeze({
  upkeep: Object.freeze({ flat: 330, perRank: 0, perDistance: 160, freeDistance: 3 }),
  cost: Object.freeze({ base: 10, perOwnedBps: 200 }),
  range: 3,
  claimsPerTurn: 1,
  decayAfterBells: 24,
  costResource: 3,
  upkeepResource: 0,
});

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const wideText = v => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(v);

export const territoryProvinceSeed = (p, q) => 'wn' + toHex(sha256(utf8('PSF-WIDE-TERRITORY-PROVINCE-v1'), sortKeyOf(BigInt(p), BigInt(q))).slice(0, 15));
export const territoryProvinceAddress = (seasonAddress, programId, p, q) => withSeed(seasonAddress, territoryProvinceSeed(p, q), programId);
export const territoryPlayerSeed = citizen => 'wu' + toHex(sha256(utf8('PSF-WIDE-TERRITORY-PLAYER-v1'), Uint8Array.from(decode(citizen))).slice(0, 15));
export const territoryPlayerAddress = (seasonAddress, programId, citizen) => withSeed(seasonAddress, territoryPlayerSeed(citizen), programId);

/** The ore (whole units) of the next claim while owning `tiles` (kernel claim_cost: base + base × owned × bps / 10,000). */
export function claimCostV1(tiles) {
  const b = BigInt(TERRITORY_V1.cost.base);
  return Number(b + (b * BigInt(tiles) * BigInt(TERRITORY_V1.cost.perOwnedBps)) / 10_000n);
}

/** The upkeep (milli-food per hour) one more tile at `dist` provinces adds. */
/** The own wide village (of `villages`, `{p, q, site}`) nearer to `target` than the first home `home`, or null (TQ-2). */
export function nearerOwnVillage(home, target, villages) {
  let best = null, bd = distance(home, target);
  for (const v of Array.isArray(villages) ? villages : []) {
    try { const d = distance(v, target); if (d < bd) { bd = d; best = { p: String(v.p), q: String(v.q), site: Number(v.site) }; } } catch { /* not a coordinate */ }
  }
  return best;
}

export function tileUpkeepV1(dist) {
  const u = TERRITORY_V1.upkeep;
  return u.flat + u.perDistance * Math.max(0, dist - u.freeDistance);
}

/**
 * The checked intent `{name: 'TerritoryClaim', subject: {holding, target: {p, q}, witness?: {kind, p, q}}, fields:
 * {tile}}`: the paying first home a legacy village (ring ≤ 128), the target a wide province (decimal strings), within
 * the range of the home or of the witness (kind 'nation': a wide province of the claimer's nation's land; 'own': a
 * province where the claimer owns a tile — whether that is so is the program's check), tile 0-60. Throws a code.
 */
export function territoryClaimIntent(subject, fields, code = 'LocalActShape') {
  const withW = subject !== null && typeof subject === 'object' && Object.hasOwn(subject, 'witness');
  const withV = subject !== null && typeof subject === 'object' && Object.hasOwn(subject, 'village');
  check(exactKeys(subject, ['holding', 'target', ...(withW ? ['witness'] : []), ...(withV ? ['village'] : [])]) && exactKeys(fields, ['tile']), code);
  const h = subject.holding, t = subject.target, w = withW ? subject.witness : null, vg = withV ? subject.village : null;
  // (verify-pr206-209, owner TQ-2: upkeep distance from the NEAREST own village — an own wide village nearer than the
  //  first home is named; the program checks it is the claimer's and takes min(home, village))
  if (vg) {
    check(exactKeys(vg, ['p', 'q', 'site']) && wideText(vg.p) && wideText(vg.q) && int(vg.site, 0, 11), code);
    let vr; try { vr = ringPosition(BigInt(vg.p), BigInt(vg.q)).ring; } catch { fail(code); }
    check(vr >= FIRST_WIDE_RING, code);
  }
  check(exactKeys(h, ['p', 'q', 'site']) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11), code);
  check(exactKeys(t, ['p', 'q']) && wideText(t.p) && wideText(t.q), code);
  if (w) check(exactKeys(w, ['kind', 'p', 'q']) && (w.kind === 'nation' || w.kind === 'own') && wideText(w.p) && wideText(w.q), code);
  let ha, ta, wa;
  try { ha = ringPosition(BigInt(h.p), BigInt(h.q)).ring; ta = ringPosition(BigInt(t.p), BigInt(t.q)).ring; wa = w ? ringPosition(BigInt(w.p), BigInt(w.q)).ring : null; } catch { fail(code); }
  check(ha <= 128n, 'LocalActWideHolding');
  check(ta >= FIRST_WIDE_RING, code);
  if (w) check(wa >= FIRST_WIDE_RING && distance(w, t) <= TERRITORY_V1.range, code);
  else check(distance(h, t) <= TERRITORY_V1.range, code);
  check(int(fields.tile, 0, 60), code);
  const subj = { holding: Object.freeze({ p: h.p, q: h.q, site: h.site }), target: Object.freeze({ p: t.p, q: t.q }) };
  if (w) subj.witness = Object.freeze({ kind: w.kind, p: w.p, q: w.q });
  if (vg) subj.village = Object.freeze({ p: vg.p, q: vg.q, site: vg.site });
  return Object.freeze({ name: TERRITORY_CLAIM, subject: Object.freeze(subj), fields: Object.freeze({ tile: fields.tile }) });
}

/** The 0xDA op 7 instruction of `intent` for `wallet` (actor and payer) in the Season `seasonId` of `programId`. */
export function territoryClaimInstruction(intent, { programId, seasonId, wallet }) {
  const A = seasonAddresses(programId, String(seasonId));
  const h = intent.subject.holding, t = intent.subject.target, w = intent.subject.witness ?? null;
  const citizen = A.of('Citizen', { wallet });
  const keys = [
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: A.season, isSigner: false, isWritable: false },
    { pubkey: citizen, isSigner: false, isWritable: true },
    { pubkey: wideProvinceAddress(A.season, programId, t.p, t.q), isSigner: false, isWritable: false },
    { pubkey: territoryProvinceAddress(A.season, programId, t.p, t.q), isSigner: false, isWritable: true },
    { pubkey: territoryPlayerAddress(A.season, programId, citizen), isSigner: false, isWritable: true },
    { pubkey: A.of('Holding', h), isSigner: false, isWritable: true },
    { pubkey: A.of('Province', h), isSigner: false, isWritable: false },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ];
  let wbyte = WITNESS_NONE;
  if (w) {
    wbyte = w.kind === 'nation' ? WITNESS_NATION_LAND : WITNESS_OWN;
    const addr = w.kind === 'nation' ? wideProvinceAddress(A.season, programId, w.p, w.q) : territoryProvinceAddress(A.season, programId, w.p, w.q);
    keys.push({ pubkey: addr, isSigner: false, isWritable: false });
  }
  const vg = intent.subject.village ?? null;
  if (vg) keys.push({ pubkey: wideHoldingAddress(A.season, programId, BigInt(vg.p), BigInt(vg.q), vg.site), isSigner: false, isWritable: false });
  const data = new Uint8Array(23), dv = new DataView(data.buffer);
  data[0] = 0xda; data[1] = 0xff; data[2] = 0x01; data[3] = 0x07;
  dv.setBigInt64(4, BigInt(t.p), true); dv.setBigInt64(12, BigInt(t.q), true);
  data[20] = intent.fields.tile; data[21] = wbyte; data[22] = vg ? 1 : 0;
  return { programId, keys, data };
}

/** The whole message: the claim under its compute budget, the wallet as fee payer. */
export function territoryClaimMessage(intent, { programId, seasonId, wallet, blockhash, loadedLimit }) {
  const prefix = [setComputeUnitLimit(TERRITORY_CLAIM_CU), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(loadedLimit), requestHeapFrame(TERRITORY_CLAIM_HEAP)];
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, territoryClaimInstruction(intent, { programId, seasonId, wallet })] }));
}

// ---------------------------------------------------------------- records (read-only views)

const u64 = (b, o) => new DataView(b.buffer, b.byteOffset).getBigUint64(o, true);
const u32 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);
const i64 = (b, o) => new DataView(b.buffer, b.byteOffset).getBigInt64(o, true);
const magic = (b, m) => [...m].every((c, i) => b[i] === c.charCodeAt(0));

/** A territory province record (672 B, 'PSFXWTN1') → `{owners: [tag string | null] × 61, dist, owned, keepTile}`, or null. */
export function decodeTerritoryProvince(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 672 || !magic(bytes, 'PSFXWTN1')) return null;
  const owners = [], dist = [];
  for (let i = 0; i < 61; i++) { const t = u64(bytes, 104 + 8 * i); owners.push(t === 0n ? null : t.toString()); dist.push(bytes[592 + i]); }
  return { rule: bytes[18], owned: bytes[19], keepTile: bytes[69], owners, dist };
}

/** A territory player summary (320 B, 'PSFXWTU1') → its fields (tag as a decimal string), or null. */
export function decodeTerritoryPlayer(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 320 || !magic(bytes, 'PSFXWTU1')) return null;
  const tiles = u32(bytes, 92), excess = u64(bytes, 96);
  const u = TERRITORY_V1.upkeep;
  const hist = [];
  for (let i = 0; i < 64; i++) hist.push(u16(bytes, 176 + 2 * i));
  return {
    rule: bytes[18], unpaid: bytes[19] === 1, citizenTag: u64(bytes, 84).toString(), faction: bytes[129], tiles,
    excessSum: Number(excess), paidTo: Number(i64(bytes, 104)), unpaidSince: bytes[19] === 1 ? u32(bytes, 120) : null,
    lastClaimBell: u32(bytes, 124), claimsInBell: bytes[128], lastDecayBell: u32(bytes, 132), released: u32(bytes, 136),
    claimed: u32(bytes, 140), hist,
    // (upkeep per hour in milli-food: tiles × flat + per_distance × Σ excess; V1 has no per-rank term)
    upkeepMilliPerHour: tiles * u.flat + u.perDistance * Number(excess),
  };
}

/** The Citizen tag the records name an owner by: the first 8 bytes of the Citizen address, little-endian. */
export function citizenTagOf(citizen) {
  const b = Uint8Array.from(decode(citizen));
  return u64(b, 0).toString();
}

/**
 * The territory facts of the provinces a herald wide route captured (`{route: [{p, q, capture: {bytes_b64}}]}`): a Map
 * "p,q" → `{siteTiles, keepTile}` for each province of a territory world (its trailer byte RSV_53 = 4,736 + 53 is 1:
 * frontier-abi world_index/land.rs territory_rule_of; the site tiles are Province v2 SITES @250, SITE_COUNT @262; the
 * keep's tile KEEP @4480). A province of a world without territory is absent.
 */
export function territoryOfRoute(route) {
  const out = new Map();
  for (const r of Array.isArray(route?.route) ? route.route : []) {
    try {
      const b64 = r?.capture?.bytes_b64;
      if (typeof b64 !== 'string') continue;
      const b = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(b64, 'base64')) : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      if (b.length !== 4864 || b[4789] !== 1) continue;
      const n = Math.min(b[262], 12);
      out.set(`${r.p},${r.q}`, { siteTiles: Array.from(b.subarray(250, 250 + n)), keepTile: b[4480] });
    } catch { /* unreadable: not a territory province here */ }
  }
  return out;
}

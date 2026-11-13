// The player's own ExpeditionReveal, built in the browser from the reveal half
// `seal-wide.mjs` returned at sealing time ({plain (136), salt (32)}) and the
// seal's public ct_hash. Parity targets:
//   permutation-frontier/src/proc/wide_expedition_reveal.rs (account shape,
//   checks), frontier-abi world_index::wide_ix::{ExpeditionReveal, REVEAL},
//   expedition_dispatch_ix (the version-2 wrapper, Kind::Reveal),
//   world_index::{arrival, land, march} seeds, wide_expedition_route::path_tiles.
//
// The instruction data necessarily carries the plaintext and salt: sending it
// IS the reveal. Nothing here stores, logs or sends anything; the caller signs
// the returned message with the player's wallet and submits it once. Before
// building, the public seal root of the transit is checked against
// commit(plain, salt) and ct_hash, so a reveal that cannot match is never
// produced. The destination and the route come from the committed plaintext
// itself, never from a caller's choice.
import { decode, encode } from '../sdk/base58.mjs';
import { fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { compileMessage, COMPUTE_BUDGET_PROGRAM } from '../sdk/solana-tx.mjs';
import { withSeed, seedOf } from './faddr.mjs';
import { ringPosition } from './map/wide.mjs';
import { unpackWidePlain, validateWidePlain, decodeWideProvinceKey, traceWideDirections, WIDE_PLAIN_LEN } from './fexpedition-seal.mjs';
import { commitWide } from './seal-wide.mjs';

export const REVEAL_INNER_LEN = 4 + 2 + WIDE_PLAIN_LEN + 96; // 238
export const REVEAL_WIRE_LEN = 4 + REVEAL_INNER_LEN; // 242
export const TAG_REVEAL = 0xee;
const ENVELOPE_ESCAPE = 0xff, ENVELOPE_VERSION = 1, OP_EXPEDITION_REVEAL = 1;
const DISPATCH_VERSION = 2, KIND_REVEAL = 2;
export const BELLS_PER_DAY = 144;
export const ARCHIVE_ENTRIES = 72;
const SYSTEM = '11111111111111111111111111111111';
const IX_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';

export class RevealBuildError extends Error {
  constructor(code) { super(code); this.name = 'RevealBuildError'; this.code = code; }
}
const check = (ok, code) => { if (!ok) throw new RevealBuildError(code); };
const int = (n, max, code) => { check(Number.isInteger(n) && n >= 0 && n <= max, code); return n; };
const bytes = (x, n, code) => {
  const b = typeof x === 'string' ? (/^([0-9a-f]{2})*$/.test(x) ? fromHex(x) : null) : x instanceof Uint8Array ? x : null;
  check(b !== null && b.length === n, code);
  return b;
};
const address = (s, code) => {
  let b; try { b = decode(s); } catch { throw new RevealBuildError(code); }
  check(typeof s === 'string' && b.length === 32 && b.some(x => x !== 0) && encode(b) === s, code);
  return b;
};
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sortKey = (p, q) => {
  const r = ringPosition(BigInt(p), BigInt(q)), b = new Uint8Array(17), v = new DataView(b.buffer);
  v.setBigUint64(0, r.ring, false); b[8] = r.wedge; v.setBigUint64(9, r.pos, false); return b;
};
const pathStep = (path, i) => { const bit = 3 * i, lo = Math.floor(bit / 8); return ((path[lo] | ((path[lo + 1] ?? 0) << 8)) >>> (bit % 8)) & 7; };

/** The public account addresses of one reveal (tags/domains as world_index). */
export function revealAddresses({ program, season, holding, transitSlot, faction, arriveBell, destKey, destRegion }) {
  address(program, 'Program'); address(season, 'Season'); const hb = address(holding, 'Holding');
  int(transitSlot, 3, 'TransitSlot'); int(faction, 255, 'Faction'); int(arriveBell, 0xffffffff, 'ArriveBell'); int(destRegion, 15, 'Region');
  const dk = bytes(destKey, 50, 'Dest'); const d = decodeWideProvinceKey(toHex(dk));
  const derive = seed => withSeed(season, seed, program);
  const hashed = (tag, domain, ...parts) => derive(tag + toHex(sha256(utf8(domain), ...parts).slice(0, 15)));
  return Object.freeze({
    transit: hashed('wm', 'PSF-WIDE-TRANSIT-SEED-v1', hb, Uint8Array.of(transitSlot)),
    anchor: derive(seedOf('BellAnchor', { bell: arriveBell, region: destRegion })),
    archive: derive(seedOf('AnchorArchive', { region: destRegion, part: Math.floor(arriveBell / ARCHIVE_ENTRIES) })),
    beaconLog: derive(seedOf('BeaconLog', { region: destRegion })),
    inputs: hashed('wi', 'PSF-WIDE-CLASH-INPUTS-SEED-v1', dk, le32(arriveBell)),
    destProvince: hashed('wp', 'PSF-WIDE-PROVINCE-SEED-v1', sortKey(d.p, d.q)),
    arrivalDay: hashed('wd', 'PSF-WIDE-ARRIVAL-DAY-SEED-v1', dk, le32(Math.floor(arriveBell / BELLS_PER_DAY))),
    slots: Object.freeze([0, 1, 2, 3].map(i => hashed('wa', 'PSF-WIDE-ARRIVAL-SLOT-SEED-v1', dk, le32(arriveBell), Uint8Array.of(faction, i)))),
    /** A route province's address by family: original (ring ≤ 128) or wide. */
    province: key => {
      const k = decodeWideProvinceKey(key);
      return BigInt(k.ring) <= 128n ? derive(seedOf('Province', { p: Number(k.p), q: Number(k.q) })) : hashed('wp', 'PSF-WIDE-PROVINCE-SEED-v1', sortKey(k.p, k.q));
    },
  });
}

/** The 242 wire bytes: the version-2 wrapper of ExpeditionReveal. */
export function revealInstructionData({ transitSlot, targetI, plain, salt, ctHash, beneficiary }) {
  const out = new Uint8Array(REVEAL_WIRE_LEN);
  out.set([TAG_REVEAL, ENVELOPE_ESCAPE, DISPATCH_VERSION, KIND_REVEAL], 0);
  out.set([TAG_REVEAL, ENVELOPE_ESCAPE, ENVELOPE_VERSION, OP_EXPEDITION_REVEAL], 4);
  out[8] = int(transitSlot, 3, 'TransitSlot'); out[9] = int(targetI, 3, 'TargetSlot');
  out.set(bytes(plain, WIDE_PLAIN_LEN, 'PlainLength'), 10);
  out.set(bytes(salt, 32, 'SaltLength'), 10 + WIDE_PLAIN_LEN);
  out.set(bytes(ctHash, 32, 'CtHashLength'), 42 + WIDE_PLAIN_LEN);
  out.set(address(beneficiary, 'Beneficiary'), 74 + WIDE_PLAIN_LEN);
  return out;
}

/**
 * The reveal instruction. `transit` holds the transit's PUBLIC facts (from its
 * bridge record): `{slot, faction, host (56 hex), arriveBell, sealRoot (32),
 * origin: {p, q, tile}}`. `destRegion` is the destination Province's region
 * as read from it; `targetI` the slot the program will admit into (wide_admit
 * over the four slots; 0 when all are empty). `reveal` is the in-memory half
 * `{plain, salt}`, `ctHash` the seal's.
 */
export function buildExpeditionReveal({ program, season, wallet, holding, transit, destRegion, targetI, reveal, ctHash, beneficiary = wallet }) {
  address(wallet, 'Wallet');
  check(transit !== null && typeof transit === 'object', 'Transit');
  const plain = bytes(reveal?.plain, WIDE_PLAIN_LEN, 'PlainLength');
  const salt = bytes(reveal?.salt, 32, 'SaltLength');
  const ct = bytes(ctHash, 32, 'CtHashLength');
  const typed = unpackWidePlain(plain);
  validateWidePlain(typed, { host: transit.host, arriveBell: transit.arriveBell });
  // the public seal root must be this reveal's: seal_root = sha256(commit ‖ ct_hash)
  check(same(sha256(commitWide(plain, salt), ct), bytes(transit.sealRoot, 32, 'SealRoot')), 'SealRootMismatch');
  const dest = decodeWideProvinceKey(typed.dest);
  check(BigInt(dest.ring) > 128n, 'DestNotWide');
  // the route's provinces, as path_tiles: [dest] then each new province stepped into
  const directions = Array.from({ length: typed.pathLen }, (_, i) => pathStep(fromHex(typed.path), i));
  check(directions.length > 0, 'Path');
  const o = transit.origin;
  check(o !== null && typeof o === 'object', 'Origin');
  const trace = traceWideDirections({ world: dest.world, origin: { p: String(o.p), q: String(o.q), tile: o.tile }, directions,
    destination: { p: dest.p, q: dest.q, tile: typed.destTile } });
  check(trace.accountKeys[0] === typed.dest && trace.accountKeys.length <= 4, 'Path');
  int(targetI, 3, 'TargetSlot');
  const a = revealAddresses({ program, season, holding, transitSlot: transit.slot, faction: transit.faction, arriveBell: transit.arriveBell, destKey: typed.dest, destRegion });
  const rows = [
    ['fee_payer', wallet, true, true], ['season', season, false, false], ['holding', holding, false, false], ['transit', a.transit, false, false],
    ['anchor', a.anchor, false, false], ['archive', a.archive, false, false], ['beaconlog', a.beaconLog, false, false],
    ['inputs', a.inputs, false, false], ['dest_province', a.destProvince, false, false], ['arrivalday', a.arrivalDay, false, true],
    ...a.slots.map((s, i) => ['slot', s, false, i === targetI]),
    ['ix_sysvar', IX_SYSVAR, false, false], ['system', SYSTEM, false, false],
    ...trace.accountKeys.slice(1).map(k => ['path_province', a.province(k), false, false]),
  ];
  const keys = rows.map(([name, pubkey, isSigner, isWritable]) => Object.freeze({ name, pubkey, isSigner, isWritable }));
  const data = revealInstructionData({ transitSlot: transit.slot, targetI, plain, salt, ctHash: ct, beneficiary });
  return Object.freeze({ programId: program, keys: Object.freeze(keys), data,
    toJSON() { return { programId: program, keys: keys.map(k => k.name + ':' + k.pubkey), data: '<reveal: redacted>' }; } });
}

const budgetIx = (tag, value, size) => {
  const d = new Uint8Array(size + 1); d[0] = tag;
  const v = new DataView(d.buffer); size === 8 ? v.setBigUint64(1, BigInt(value), true) : v.setUint32(1, value, true);
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: d };
};

/**
 * The unsigned legacy message: compute limit, zero price, loaded-data limit
 * then the reveal; local SBF play additionally requests its fixed 256 KiB heap.
 * The wallet pays and signs. Generic callers retain the three-budget form.
 */
export function revealMessage({ instruction, wallet, recentBlockhash, cuLimit, loadedLimit, heapFrame = null }) {
  int(cuLimit, 1_400_000, 'CuLimit'); int(loadedLimit, 64 * 1024 * 1024, 'LoadedLimit');
  check(cuLimit > 0 && loadedLimit > 0, 'Budget');
  check(heapFrame === null || heapFrame === 256 * 1024, 'HeapFrame');
  check(instruction?.keys?.[0]?.pubkey === wallet, 'FeePayer');
  return compileMessage({ feePayer: wallet, recentBlockhash, instructions: [
    budgetIx(2, cuLimit, 4), budgetIx(3, 0, 8), budgetIx(4, loadedLimit, 4),
    ...(heapFrame === null ? [] : [budgetIx(1, heapFrame, 4)]),
    { programId: instruction.programId, keys: instruction.keys, data: instruction.data },
  ] });
}

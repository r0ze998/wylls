// Review-only WidePlain codec and exact tile geometry. Parity targets:
// frontier-abi/src/world_index/{key,seal,tiles}.rs and
// permutation-frontier/src/proc/wide_expedition_route.rs::path_tiles.
// No sealing, signing, state reads, account mutation or execution surface.
import { fromHex, toHex } from '../sdk/bytes.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { WIDE_BOUND, parseWideInt, ringPosition, worldIdOf } from './map/wide.mjs';

export const WIDE_PLAIN_LEN = 136;
export const WIDE_PLAIN_VERSION = 2;
export const WIDE_PATH_STEPS = 32;
export const WIDE_PATH_PROVINCES = 4;
export const TILE_COORD_BOUND = 13n * WIDE_BOUND + 4n;
export const WIDE_PLAIN_OFFSETS = Object.freeze({ version: 0, host: 1, arriveBell: 57, dest: 61,
  destTile: 111, stance: 112, retreatBps: 113, pathLen: 115, path: 116, reserved: 128 });

export class ExpeditionSealError extends Error {
  constructor(code) { super(code); this.name = 'ExpeditionSealError'; this.code = code; }
}
const check = (yes, code) => { if (!yes) throw new ExpeditionSealError(code); };
const integer = (n, max, code) => { check(Number.isInteger(n) && n >= 0 && n <= max, code); return n; };
const obj = (o, code) => check(o !== null && typeof o === 'object' && !Array.isArray(o), code);
const bytes = (s, n, code) => {
  check(typeof s === 'string' && s.length === n * 2 && /^[0-9a-f]+$/.test(s), code);
  return fromHex(s);
};
const worldBytes = world => { const b = bytes(world, 32, 'World'); check(b.some(x => x !== 0), 'World'); return b; };
const freeze = value => {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const abs = n => n < 0n ? -n : n;
const distance = (q, r) => (abs(q) + abs(r) + abs(q + r)) / 2n;
const floor61 = n => n >= 0n ? n / 61n : (n - 60n) / 61n;
const coord = s => {
  try { return parseWideInt(s); } catch { throw new ExpeditionSealError('Coord'); }
};
const tileCoord = s => {
  // The tile bound has 20 digits, or 21 characters with a minus sign.
  check(typeof s === 'string' && s.length <= 21 && /^(0|-?[1-9][0-9]*)$/.test(s), 'TileCoord');
  const n = BigInt(s); check(abs(n) <= TILE_COORD_BOUND, 'OutOfWorld'); return n;
};
const sortBytes = (p, q) => {
  const { ring, wedge, pos } = ringPosition(p, q), b = new Uint8Array(17), v = new DataView(b.buffer);
  v.setBigUint64(0, ring, false); b[8] = wedge; v.setBigUint64(9, pos, false); return b;
};

/** Exact canonical 50-byte ProvinceKey, represented as lowercase hex. */
export function canonicalWideProvinceKey({ world, p, q }) {
  const b = new Uint8Array(50); b[0] = 1; b.set(worldBytes(world), 1); b.set(sortBytes(coord(p), coord(q)), 33);
  return toHex(b);
}

/** Strict identity decoding; does not assert a province exists or is open. */
export function decodeWideProvinceKey(key) {
  const b = bytes(key, 50, 'Dest'), v = new DataView(b.buffer);
  check(b[0] === 1, 'KeyVersion'); const world = toHex(b.slice(1, 33)); worldBytes(world);
  const ring = v.getBigUint64(33, false), wedge = b[41], pos = v.getBigUint64(42, false);
  check(wedge < 6 && (ring === 0n ? wedge === 0 && pos === 0n : pos < ring), 'KeyCoord');
  let p = ring - pos, q = pos;
  for (let i = 0; i < wedge; i++) [p, q] = [-q, p + q];
  check(abs(p) <= WIDE_BOUND && abs(q) <= WIDE_BOUND, 'KeyCoord');
  check(toHex(sortBytes(p, q)) === toHex(b.slice(33)), 'KeyCoord');
  return freeze({ key, world, p: p.toString(), q: q.toString(), ring: ring.toString() });
}

/** Full 56-byte host reference, never a truncated legacy host id. */
export function decodeWideHostRef(host) {
  const b = bytes(host, 56, 'Host');
  const key = decodeWideProvinceKey(toHex(b.slice(0, 50)));
  integer(b[50], 11, 'HostSite');
  return freeze({ host, ...key, site: b[50], gen: b[51], seq: new DataView(b.buffer).getUint32(52, true) });
}

/** Original issuer only; standing origin is supplied separately to the trace. */
export function canonicalOriginalHostRef({ world, p, q, site, gen, seq }) {
  const key = canonicalWideProvinceKey({ world, p, q });
  check(BigInt(decodeWideProvinceKey(key).ring) <= 128n, 'OriginalHostRequired');
  const b = new Uint8Array(56); b.set(fromHex(key));
  b[50] = integer(site, 11, 'HostSite'); b[51] = integer(gen, 255, 'HostGeneration');
  new DataView(b.buffer).setUint32(52, integer(seq, 0xffffffff, 'HostSequence'), true);
  return toHex(b);
}

function plainShape(plain) {
  obj(plain, 'Plain');
  integer(plain.version, 255, 'Version'); decodeWideHostRef(plain.host); decodeWideProvinceKey(plain.dest);
  integer(plain.arriveBell, 0xffffffff, 'ArriveBell'); integer(plain.destTile, 255, 'Tile');
  integer(plain.stance, 255, 'Stance'); integer(plain.retreatBps, 0xffff, 'Retreat');
  integer(plain.pathLen, 255, 'PathTooLong'); bytes(plain.path, 12, 'Path'); bytes(plain.reserved, 8, 'Reserved');
}

/** Rust pack parity for typed fields. Call validateWidePlain for semantic checks. */
export function packWidePlain(plain) {
  plainShape(plain);
  const b = new Uint8Array(WIDE_PLAIN_LEN), v = new DataView(b.buffer);
  b[0] = plain.version; b.set(fromHex(plain.host), 1); v.setUint32(57, plain.arriveBell, true);
  b.set(fromHex(plain.dest), 61); b[111] = plain.destTile; b[112] = plain.stance;
  v.setUint16(113, plain.retreatBps, true); b[115] = plain.pathLen;
  b.set(fromHex(plain.path), 116); b.set(fromHex(plain.reserved), 128); return b;
}

/** Rust unpack parity: identities decode strictly; remaining semantics are separate. */
export function unpackWidePlain(input) {
  check(input instanceof Uint8Array && input.length === WIDE_PLAIN_LEN, 'PlainLength');
  const b = Uint8Array.from(input), v = new DataView(b.buffer);
  const plain = { version: b[0], host: toHex(b.slice(1, 57)), arriveBell: v.getUint32(57, true),
    dest: toHex(b.slice(61, 111)), destTile: b[111], stance: b[112], retreatBps: v.getUint16(113, true),
    pathLen: b[115], path: toHex(b.slice(116, 128)), reserved: toHex(b.slice(128)) };
  plainShape(plain); return freeze(plain);
}

function pathStep(path, i) {
  const bit = 3 * i, lo = Math.floor(bit / 8), shift = bit % 8;
  return ((path[lo] | ((path[lo + 1] ?? 0) << 8)) >>> shift) & 7;
}

/** Validates the committed host/bell, world and all Rust WidePlain constraints. */
export function validateWidePlain(plain, expected) {
  plainShape(plain); obj(expected, 'Expected'); decodeWideHostRef(expected.host);
  integer(expected.arriveBell, 0xffffffff, 'ArriveBell');
  check(plain.version === WIDE_PLAIN_VERSION, 'Version');
  check(plain.reserved === '00'.repeat(8), 'Reserved');
  check(plain.host === expected.host, 'HostMismatch'); check(plain.arriveBell === expected.arriveBell, 'ArriveMismatch');
  check(decodeWideProvinceKey(plain.dest).world === decodeWideHostRef(plain.host).world, 'WorldMismatch');
  check(plain.pathLen <= WIDE_PATH_STEPS, 'PathTooLong');
  const path = fromHex(plain.path), used = 3 * plain.pathLen;
  for (let i = 0; i < path.length; i++) {
    const bits = Math.min(8, Math.max(0, used - 8 * i));
    check((path[i] & (255 ^ ((1 << bits) - 1))) === 0, 'PathBits');
  }
  for (let i = 0; i < plain.pathLen; i++) check(pathStep(path, i) < 6, 'Direction');
  check(plain.destTile < 61, 'Tile'); check(plain.stance <= 3, 'Stance'); check(plain.retreatBps <= 60000, 'Retreat');
  return true;
}

/** The deployed 32 × 3-bit little-bit-order path, no generated material. */
export function encodeWideDirections(directions) {
  check(Array.isArray(directions) && directions.length <= WIDE_PATH_STEPS, 'PathTooLong');
  const path = new Uint8Array(12);
  for (let i = 0; i < directions.length; i++) {
    const d = integer(directions[i], 5, 'Direction'), bit = 3 * i, lo = Math.floor(bit / 8), shift = bit % 8;
    path[lo] |= (d << shift) & 255;
    if (shift > 5) path[lo + 1] |= d >>> (8 - shift);
  }
  return freeze({ pathLen: directions.length, path: toHex(path) });
}

// The radius-4 offsets are enumerated exactly as geometry::TILE_OFFSETS.
const OFFSETS = [];
for (let q = -4n; q <= 4n; q++) for (let r = -4n; r <= 4n; r++) {
  if (distance(q, r) <= 4n) OFFSETS.push(Object.freeze([q, r]));
}
Object.freeze(OFFSETS);
const DIRECTIONS = freeze([[1n, 0n], [1n, -1n], [0n, -1n], [-1n, 0n], [-1n, 1n], [0n, 1n]]);
const centre = (p, q) => [9n * p + 4n * q, -4n * p + 5n * q];
const address = (world, p, q, tile, tileQ, tileR) => freeze({ world,
  key: canonicalWideProvinceKey({ world, p: p.toString(), q: q.toString() }),
  p: p.toString(), q: q.toString(), tile, tileQ: tileQ.toString(), tileR: tileR.toString(),
  ring: ringPosition(p, q).ring.toString() });

/** Address to global tile coordinates, with no global coordinate through Number. */
export function wideTileAt({ world, p, q, tile }) {
  worldBytes(world); const pp = coord(p), pq = coord(q); integer(tile, 60, 'Tile');
  const [cq, cr] = centre(pp, pq), [oq, or] = OFFSETS[tile];
  return address(world, pp, pq, tile, cq + oq, cr + or);
}

/** Global tile to its unique bounded province and tile, using Euclidean division. */
export function locateWideTile({ world, tileQ, tileR }) {
  worldBytes(world); const q = tileCoord(tileQ), r = tileCoord(tileR);
  const p0 = floor61(5n * q - 4n * r), q0 = floor61(4n * q + 9n * r);
  let best = null;
  for (let dp = -1n; dp <= 1n; dp++) for (let dq = -1n; dq <= 1n; dq++) {
    const p = p0 + dp, pq = q0 + dq, [cq, cr] = centre(p, pq), d = distance(q - cq, r - cr);
    if (best === null || d < best.d) best = { p, pq, cq, cr, d };
  }
  check(abs(best.p) <= WIDE_BOUND && abs(best.pq) <= WIDE_BOUND, 'OutOfWorld');
  const tile = OFFSETS.findIndex(([oq, or]) => q - best.cq === oq && r - best.cr === or);
  check(tile >= 0, 'OutOfWorld'); return address(world, best.p, best.pq, tile, q, r);
}

/**
 * Geometry ONLY, matching path_tiles account order, not verify_route's land check.
 * Destination first, then other first-entered provinces. Origin is included only
 * if an entered tile belongs to it. This does not prove terrain, cost or timing.
 */
export function traceWideDirections({ world, origin, directions, destination }) {
  worldBytes(world); obj(origin, 'Origin');
  const path = encodeWideDirections(directions);
  const start = wideTileAt({ world, p: origin.p, q: origin.q, tile: origin.tile });
  let tile = start; const steps = [];
  for (const d of directions) {
    const [dq, dr] = DIRECTIONS[d];
    tile = locateWideTile({ world, tileQ: (BigInt(tile.tileQ) + dq).toString(), tileR: (BigInt(tile.tileR) + dr).toString() });
    steps.push(tile);
  }
  if (destination !== undefined) {
    obj(destination, 'Destination');
    if (destination.world !== undefined) check(destination.world === world, 'WorldMismatch');
    const dest = wideTileAt({ world, p: destination.p, q: destination.q, tile: destination.tile });
    check(tile.key === dest.key && tile.tile === dest.tile, 'EndpointMismatch');
  }
  if (origin.world !== undefined) check(origin.world === world, 'WorldMismatch');
  const accountKeys = path.pathLen === 0 ? [] : [tile.key];
  for (const step of steps) if (!accountKeys.includes(step.key)) {
    check(accountKeys.length < WIDE_PATH_PROVINCES, 'PathProvinces'); accountKeys.push(step.key);
  }
  return freeze({ verification: 'geometry-only', executable: false, admitted: false, pathComplete: path.pathLen > 0,
    origin: start, endpoint: tile, accountKeys, steps, directions: [...directions] });
}

function publicAddress(s) {
  check(typeof s === 'string' && s.length >= 32 && s.length <= 44, 'PublicAddress');
  let b; try { b = decode(s); } catch { throw new ExpeditionSealError('PublicAddress'); }
  check(b.length === 32 && b.some(x => x !== 0) && encode(b) === s, 'PublicAddress');
}

/**
 * Controlled original→wide candidate from the actual standing origin. Supplying
 * that origin does NOT authenticate a resident; the UI must pin its selected
 * source. Arrival is user input, never computed from unverified geometry.
 */
export function prepareOriginalOutboundPlain({ program, season, host, origin, directions, arriveBell, stance, retreatBps }) {
  publicAddress(program); publicAddress(season); check(program !== season, 'PublicAddress');
  const world = worldIdOf(season, program), ref = decodeWideHostRef(host);
  check(ref.world === world, 'WorldMismatch'); check(BigInt(ref.ring) <= 128n, 'OriginalHostRequired');
  const route = traceWideDirections({ world, origin, directions });
  check(route.pathComplete, 'EmptyPath');
  check(BigInt(route.origin.ring) <= 128n, 'OriginalOriginRequired');
  check(BigInt(route.endpoint.ring) > 128n, 'WideDestinationRequired');
  const path = encodeWideDirections(directions);
  const plain = { version: WIDE_PLAIN_VERSION, host, arriveBell, dest: route.endpoint.key,
    destTile: route.endpoint.tile, stance, retreatBps, ...path, reserved: '00'.repeat(8) };
  validateWidePlain(plain, { host, arriveBell });
  return freeze({ version: 1, kind: 'original-outbound-plaintext-review', ...route, world, host,
    plainHex: toHex(packWidePlain(plain)), pathLen: path.pathLen, pathHex: path.path,
    arriveBell, stance, retreatBps, terrainVerified: false, costVerified: false, arrivalVerified: false });
}

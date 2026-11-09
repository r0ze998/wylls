// Closed original-host outbound role proposal, matching fclient's
// original_expedition_depart_draft and world_index::wide_ix::EXPEDITION_DEPART.
// Public addresses only. No account read, key input, executable object,
// authorization, admission, sealing, signature or transport is provided here.
import { decode, encode } from '../sdk/base58.mjs';
import { fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { parseWideInt, ringPosition, worldIdOf } from './map/wide.mjs';
import { withSeed, seedOf, hostId, hostParts } from './faddr.mjs';

const SYSTEM = '11111111111111111111111111111111';
const check = ok => { if (!ok) throw Object.assign(new Error('OutboundRoleContract'), { code: 'OutboundRoleContract' }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function publicBytes(value) {
  check(typeof value === 'string' && value.length >= 32 && value.length <= 44);
  let bytes; try { bytes = decode(value); } catch { check(false); }
  check(bytes.length === 32 && bytes.some(b => b !== 0) && encode(bytes) === value);
  return bytes;
}
function originalCoord(value, world) {
  check(object(value) && typeof value.p === 'string' && typeof value.q === 'string');
  check(value.world === undefined || value.world === world);
  let p, q;
  try { p = parseWideInt(value.p); q = parseWideInt(value.q); } catch { check(false); }
  check(ringPosition(p, q).ring <= 128n);
  // This conversion is exact only after the original-family bound above.
  return { p: Number(p), q: Number(q) };
}
function originalHost(host, world) {
  check(typeof host === 'string' && /^[0-9a-f]{112}$/.test(host));
  const bytes = fromHex(host), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(bytes[0] === 1 && toHex(bytes.slice(1, 33)) === world);
  const ring = view.getBigUint64(33, false), wedge = bytes[41], pos = view.getBigUint64(42, false);
  check(ring <= 128n && wedge < 6 && (ring === 0n ? wedge === 0 && pos === 0n : pos < ring));
  let p = ring - pos, q = pos;
  for (let i = 0; i < wedge; i++) [p, q] = [-q, p + q];
  const canonical = ringPosition(p, q);
  check(canonical.ring === ring && canonical.wedge === wedge && canonical.pos === pos && bytes[50] < 12);
  const home = { p: Number(p), q: Number(q), site: bytes[50], gen: bytes[51], seq: view.getUint32(52, true) };
  const roundTrip = hostParts(hostId(home));
  check(roundTrip && ['p', 'q', 'site', 'gen', 'seq'].every(k => roundTrip[k] === home[k]));
  return home;
}

/**
 * Nine immutable ordered public roles, not an executable instruction.
 * source.host is the full canonical 56-byte lowercase-hex original reference.
 * source.origin is its observed current original Province, not necessarily its
 * issuer. Optional source.home/world/holding are consistency checks only:
 * issuer addresses always derive from the full host, never supplied home data.
 * The wallet-derived Citizen must match source.original_owner. This equality
 * does not prove actual ownership, issuance, current residency or a free slot.
 * False flags describe minimum contracts, not permission to execute. Effective
 * flags are unioned only for actor=payer and province=holding_province aliases.
 */
export function canonicalOutboundRoles(source, { transitSlot } = {}) {
  check(object(source) && Number.isInteger(transitSlot) && transitSlot >= 0 && transitSlot < 4);
  const { program, season, wallet, payer, original_owner: owner } = source;
  publicBytes(program); publicBytes(season); publicBytes(wallet); publicBytes(payer); publicBytes(owner);
  check(program !== season);
  const world = worldIdOf(season, program);
  check(world !== '0'.repeat(64) && (source.world === undefined || source.world === world));
  const home = originalHost(source.host, world), origin = originalCoord(source.origin, world);
  if (source.home !== undefined) {
    const claimed = originalCoord(source.home, world);
    check(claimed.p === home.p && claimed.q === home.q);
    for (const k of ['site', 'gen', 'seq']) check(source.home[k] === home[k]);
  }
  const derive = seed => withSeed(season, seed, program);
  const citizen = derive(seedOf('Citizen', { wallet }));
  check(citizen === owner);
  const holding = derive(seedOf('Holding', home));
  check(source.holding === undefined || source.holding === holding);
  const transit = derive('wm' + toHex(sha256(utf8('PSF-WIDE-TRANSIT-SEED-v1'), publicBytes(holding), Uint8Array.of(transitSlot)).slice(0, 15)));
  const rows = [
    ['actor', wallet, true, false], ['payer', payer, true, true],
    ['season', season, false, false], ['citizen', citizen, false, true],
    ['holding', holding, false, true], ['province', derive(seedOf('Province', origin)), false, true],
    ['system', SYSTEM, false, false], ['holding_province', derive(seedOf('Province', home)), false, false],
    ['transit', transit, false, true],
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i !== 6) { publicBytes(row[1]); check(row[1] !== program); }
    for (let j = 0; j < i; j++) if (rows[j][1] === row[1]) {
      check((j === 0 && i === 1) || (j === 5 && i === 7));
      rows[j][2] = row[2] = rows[j][2] || row[2];
      rows[j][3] = row[3] = rows[j][3] || row[3];
    }
  }
  return Object.freeze(rows.map(([name, address, signer, writable]) => Object.freeze({ name, address, signer, writable })));
}

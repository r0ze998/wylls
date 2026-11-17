// Public identity/address parity with world_index::{key,land,roster,march}
// and fclient::wide_resident_draft. No account reads or executable objects.
import { decode, encode } from '../sdk/base58.mjs';
import { fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { parseWideInt, ringPosition, worldIdOf } from './map/wide.mjs';
import { withSeed, seedOf, hostId, hostParts } from './faddr.mjs';

const check = ok => { if (!ok) throw new Error('ExpeditionIdentity'); };
const publicBytes = s => { check(typeof s === 'string' && s.length >= 32 && s.length <= 44); const b = decode(s); check(b.length === 32 && b.some(x => x !== 0) && encode(b) === s); return b; };
const sortKey = (p, q) => {
  const r = ringPosition(p, q), b = new Uint8Array(17), v = new DataView(b.buffer);
  v.setBigUint64(0, r.ring, false); b[8] = r.wedge; v.setBigUint64(9, r.pos, false); return b;
};
/** Decode only the original host family, with exact canonical reference bytes. */
function original(request) {
  check(typeof request.host === 'string' && /^[0-9a-f]{112}$/.test(request.host));
  const b = fromHex(request.host), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  check(b[0] === 1 && toHex(b.slice(1, 33)) === worldIdOf(request.season, request.program));
  const ring = v.getBigUint64(33, false), wedge = b[41], pos = v.getBigUint64(42, false);
  check(ring <= 128n && wedge < 6 && (ring === 0n ? wedge === 0 && pos === 0n : pos < ring));
  let p = ring - pos, q = pos;
  for (let i = 0; i < wedge; i++) [p, q] = [-q, p + q];
  check(toHex(sortKey(p, q)) === toHex(b.slice(33, 50)) && b[50] < 12);
  const h = { p: Number(p), q: Number(q), site: b[50], gen: b[51], seq: v.getUint32(52, true) };
  const parts = hostParts(hostId(h));
  check(parts && ['p', 'q', 'site', 'gen', 'seq'].every(k => parts[k] === h[k]));
  return h;
}

export function canonicalExpeditionAccounts(request) {
  publicBytes(request.program); publicBytes(request.season); publicBytes(request.original_owner);
  check(request.program !== request.season);
  const home = original(request), p = parseWideInt(request.standing.p), q = parseWideInt(request.standing.q);
  check(ringPosition(p, q).ring > 128n);
  const sort = sortKey(p, q), key = new Uint8Array(50);
  key[0] = 1; key.set(fromHex(worldIdOf(request.season, request.program)), 1); key.set(sort, 33);
  const derive = seed => withSeed(request.season, seed, request.program);
  const hashed = (tag, domain, ...parts) => derive(tag + toHex(sha256(utf8(domain), ...parts).slice(0, 15)));
  const holding = derive(seedOf('Holding', home));
  const accounts = {
    original_holding: holding,
    original_home: derive(seedOf('Province', home)),
    wide_standing: hashed('wp', 'PSF-WIDE-PROVINCE-SEED-v1', sort),
    wide_roster: hashed('wo', 'PSF-WIDE-ROSTER-SEED-v1', key),
    owned_bridges: Array.from({ length: 4 }, (_, i) => hashed('wm', 'PSF-WIDE-TRANSIT-SEED-v1', publicBytes(holding), Uint8Array.of(i))),
  };
  return { standing_key: toHex(key), accounts,
    citizen: request.wallet === null ? null : derive('ct' + toHex(sha256(utf8('PSF-CIT'), publicBytes(request.wallet)).slice(0, 15))) };
}

/** Ordered minimum effective role flags, never signatures or authorization. */
export function canonicalExpeditionRoles(request, action) {
  check(action === 'Dissolve' || action === 'Return');
  publicBytes(request.payer);
  const { accounts: a, citizen } = canonicalExpeditionAccounts(request);
  if (action === 'Dissolve') check(citizen !== null && citizen === request.original_owner);
  const rows = action === 'Dissolve' ? [
    ['actor', request.wallet, true, request.wallet === request.payer], ['payer', request.payer, true, true],
    ['season', request.season, false, false], ['citizen', citizen, false, true], ['holding', a.original_holding, false, true],
    ['standing', a.wide_standing, false, true], ['roster', a.wide_roster, false, false], ['home', a.original_home, false, false],
  ] : [
    ['payer', request.payer, true, true], ['season', request.season, false, false], ['standing', a.wide_standing, false, true],
    ['roster', a.wide_roster, false, true], ['holding', a.original_holding, false, true], ['home', a.original_home, false, false],
  ];
  rows.forEach((r, i) => {
    publicBytes(r[1]); check(r[1] !== request.program);
    for (let j = 0; j < i; j++) if (rows[j][1] === r[1]) check(action === 'Dissolve' && j === 0 && i === 1);
  });
  return rows.map(([name, address, signer, writable]) => ({ name, address, signer, writable }));
}

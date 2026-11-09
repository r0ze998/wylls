// Private-candidate original-origin resident receipts. Read-only raw-byte
// checks, never authorization, authenticated history, a live balance or a
// public instruction. Both families retain the original full host identity.
import { toHex, fromHex } from '../../sdk/bytes.mjs';
import { encode } from '../../sdk/base58.mjs';
import { sha256 } from '../../sdk/sha256.mjs';
import { seedOf, withSeed } from '../faddr.mjs';
import { captureAddress } from './widecapture.mjs';
import { ringOfWide, WideError } from './wide.mjs';

const fail = ok => { if (!ok) throw new WideError('BadWideHistory', 'BadWideHistory'); };
const zero = a => a.every(x => x === 0);
export const isResidentKind = (format, kind) => format === 'PS2' && kind === 149 || format === 'PSW1' && kind === 26;

/** `host` and `province` are already checked by wideHistoryIdentity. Names
 * and addresses are recomputed from the exact body, not trusted summaries.
 * Chain heads remain observations: no previous account headers are here.
 */
export function residentOf(body, { format, name, host, province, holding }, pins) {
  fail(body instanceof Uint8Array && body.length >= 323 && body.length <= 405);
  const wide = format === 'PSW1';
  fail((wide ? body[0] === 0x82 && body[1] === 26 : format === 'PS2' && body[0] === 1 && body[1] === 149));
  fail(body[6] === 1 && body[8] === 0 && body[9] === 0 && [1, 2].includes(body[7]));
  const action = body[7] === 1 ? 'dissolve' : 'return';
  fail(name === `${wide ? 'WIDE_' : ''}ORIGINAL_RESIDENT_${action.toUpperCase()}`);
  fail(holding === null && host && province && host.world === province.world);
  fail(ringOfWide(host.p, host.q) <= 128n && ringOfWide(province.p, province.q) >= 129n);
  fail(toHex(body.subarray(10, 66)) === host.keyHex && toHex(body.subarray(130, 180)) === province.keyHex);
  const originalOwner = encode(body.subarray(66, 98));
  const holdingAddress = encode(body.subarray(98, 130));
  const provinceAddress = encode(body.subarray(180, 212));
  fail([66, 98, 180].every(at => !zero(body.subarray(at, at + 32))));
  fail(new Set([originalOwner, holdingAddress, provinceAddress]).size === 3);
  fail(holdingAddress === withSeed(pins.seasonAddress, seedOf('Holding', { p: host.p, q: host.q, site: host.site }), pins.programId));
  fail(provinceAddress === captureAddress('province', fromHex(province.keyHex).subarray(33), null, pins.seasonAddress, pins.programId));
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const bell = v.getUint32(2, true), entry = body[212], unit = body[213];
  const troopsMilli = v.getUint32(214, true), pendingBell = v.getUint32(218, true), creditedUnits = v.getUint32(222, true);
  fail(entry < 56 && unit < 8 && pendingBell !== 0xffffffff);
  fail(action === 'dissolve' ? pendingBell === bell && creditedUnits === 0 : pendingBell <= bell && creditedUnits === Math.floor(troopsMilli / 1000));
  const operationId = toHex(body.subarray(226, 258)), inputDigest = toHex(body.subarray(258, 290)), outputDigest = toHex(body.subarray(290, 322));
  fail(operationId === toHex(sha256('PSF-BOUNDARY-RESIDENT-OP-v1', body.subarray(258, 290), body.subarray(290, 322))));
  const entities = wide ? [1] : action === 'dissolve' ? [4, 5] : [5];
  fail(body[322] === entities.length && body.length === 323 + 41 * entities.length);
  const links = entities.map((entity, i) => {
    const at = 323 + 41 * i, sequence = v.getBigUint64(at + 1, true);
    fail(body[at] === entity && sequence > 0n);
    return Object.freeze({ entity, sequence, head: toHex(body.subarray(at + 9, at + 41)) });
  });
  return Object.freeze({ action, family: wide ? 'wide' : 'original', bell, originalOwner, holdingAddress, provinceAddress,
    entry, unit, troopsMilli, pendingBell, creditedUnits, operationId, inputDigest, outputDigest,
    links: Object.freeze(links), publicDispatch: false, executable: false });
}

/** Pair only opposite parts in the SAME captured transaction, never by the
 * digest alone. Page boundaries leave a part unpaired, not invalid/complete.
 * Even a pair says nothing about provenance or authenticated prior chains.
 */
export function residentPairs(rows) {
  const groups = new Map(), pairs = new Map();
  for (const r of rows) {
    if (!r.resident) continue;
    const key = `${r.archiveSequence}:${r.resident.operationId}`;
    const group = groups.get(key) ?? []; group.push(r); groups.set(key, group);
  }
  for (const group of groups.values()) {
    fail(group.length <= 2);
    if (group.length !== 2) continue;
    const [a, b] = group;
    fail(a.resident.family !== b.resident.family && a.ordinal !== b.ordinal);
    // All body bytes after the family-specific header and before chain tail
    // must be identical; the bell is also part of the pair identity.
    fail(toHex(a.body.subarray(2, 322)) === toHex(b.body.subarray(2, 322)));
    pairs.set(a.event, b.event); pairs.set(b.event, a.event);
  }
  return pairs;
}

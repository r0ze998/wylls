// Explicit read-only candidate receipt codecs. Shape, public address and hash
// checks do not authenticate a capture, chain history, economics or live state.
import { toHex, fromHex } from '../../sdk/bytes.mjs';
import { encode } from '../../sdk/base58.mjs';
import { sha256 } from '../../sdk/sha256.mjs';
import { seedOf, withSeed } from '../faddr.mjs';
import { captureAddress } from './widecapture.mjs';
import { ringOfWide, WideError } from './wide.mjs';
const fail = ok => { if (!ok) throw new WideError('BadWideHistory', 'BadWideHistory'); };
const zero = a => a.every(x => x === 0);
const hex = (b, a, n) => toHex(b.subarray(a, a + n));
const addr = (b, a) => encode(b.subarray(a, a + 32));
const original = k => k && ringOfWide(k.p, k.q) <= 128n;
const wide = k => k && ringOfWide(k.p, k.q) >= 129n;
const derived = (pins, kind, k) => withSeed(pins.seasonAddress, seedOf(kind, k), pins.programId);
const bridge = (pins, b, at, slot) => withSeed(pins.seasonAddress, 'wm' + toHex(sha256('PSF-WIDE-TRANSIT-SEED-v1', b.subarray(at, at + 32), new Uint8Array([slot])).subarray(0, 15)), pins.programId);
const provinceAddress = (pins, k) => wide(k) ? captureAddress('province', fromHex(k.keyHex).subarray(33), null, pins.seasonAddress, pins.programId) : derived(pins, 'Province', k);
export const isExpeditionKind = (f, k) => f === 'PS2' && [145, 146, 147, 148].includes(k) || f === 'PSW1' && k >= 18 && k <= 25 || f === 'PSWC';
function links(b, at, entities, positive = true) {
  fail(b.length === at + 1 + 41 * entities.length && b[at] === entities.length);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Object.freeze(entities.map((entity, i) => {
    const p = at + 1 + i * 41, sequence = v.getBigUint64(p + 1, true);
    fail(b[p] === entity && (!positive || sequence > 0n));
    return Object.freeze({ entity, sequence, head: hex(b, p + 9, 32) });
  }));
}
function receipt(b, at, domain, actions, conquest = false) {
  fail(b.length >= at + 100 && b[at] === 1 && actions.includes(b[at + 1]) && b[at + 2] === 0 && b[at + 3] === 0);
  const action = b[at + 1], operationId = hex(b, at + 4, 32);
  const prefix = new Uint8Array(conquest ? [action, 0] : [1, action]);
  fail(operationId === toHex(sha256(domain, prefix, b.subarray(at + 36, at + 68), b.subarray(at + 68, at + 100))));
  return { action, operationId, inputDigest: hex(b, at + 36, 32), outputDigest: hex(b, at + 68, 32) };
}
const conquestReceipt = (b, at, actions) => receipt(b, at, 'PSF-WIDE-CONQUEST-OP-v1', actions, true);
const CQ_NAMES = { 18: 'DECLARED', 19: 'DEBITED', 20: 'RESOLVED', 21: 'SETTLED', 22: 'CAPTURED', 23: 'CREDITED', 24: 'TABLE_CLOSED' };

/** Identity summaries have already passed wideHistoryIdentity. Every displayed
 * binding is checked again against the body. No instruction bytes are built. */
export function expeditionOf(b, r, pins) {
  const { format, kind, name, host, province, holding } = r;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let out;
  if (format === 'PSWC') {
    fail(b.length === 169 && b[0] === 1 && kind === null && r.action === 7 && name === 'WIDE_CONQUEST_SIDECAR_CLOSED');
    fail(host === null && province === null && holding === null && addr(b, 1) === pins.seasonAddress);
    out = { ...conquestReceipt(b, 69, [7]), stage: 'sidecar_closed', bell: v.getUint32(65, true), citizen: addr(b, 33), links: Object.freeze([]), family: 'sidecar' };
  } else {
    fail(b.length >= 10 && b[0] === (format === 'PS2' ? 1 : 0x82) && b[1] === kind);
    const bell = v.getUint32(2, true);
    if (kind === 146) {
      fail(format === 'PS2' && b[6] === 1 && [1, 2].includes(b[7]) && b[8] < 4 && b[9] === 0 && holding === null);
      const action = b[7], slot = b[8];
      fail(original(host) && original(province) && hex(b, 10, 56) === host.keyHex && hex(b, 130, 50) === province.keyHex);
      fail(addr(b, 98) === derived(pins, 'Holding', host) && addr(b, 180) === provinceAddress(pins, province) && addr(b, 212) === bridge(pins, b, 98, slot));
      fail(action === 1 ? !zero(b.subarray(66, 98)) : zero(b.subarray(66, 98)));
      fail(new Set([98, 180, 212, ...(action === 1 ? [66] : [])].map(at => addr(b, at))).size === (action === 1 ? 4 : 3));
      const stage = action === 1 ? 'depart' : 'settle_origin';
      fail(name === `ORIGINAL_EXPEDITION_${stage.toUpperCase()}`);
      out = { ...receipt(b, 244, 'PSF-LEGACY-EXPEDITION-OP-v1', [action]), stage, bell, slot, family: 'original', links: links(b, 344, action === 1 ? [4, 5, 6] : [5, 6]) };
    } else if (kind === 147) {
      fail(format === 'PS2' && b[6] === 1 && [1, 2].includes(b[7]) && b[8] === 0 && b[9] === 0 && holding === null);
      fail(wide(province) && hex(b, 10, 50) === province.keyHex);
      const reveal = b[7] === 1, stage = reveal ? 'reveal' : 'gather', at = reveal ? 213 : 60;
      fail(name === `ORIGINAL_EXPEDITION_${stage.toUpperCase()}`);
      if (reveal) {
        fail(original(host) && hex(b, 60, 56) === host.keyHex && !zero(b.subarray(116, 148)) && b[212] < 4);
        fail(addr(b, 148) === derived(pins, 'Holding', host) && addr(b, 180) === bridge(pins, b, 148, b[212]));
      } else fail(host === null);
      out = { ...receipt(b, at, 'PSF-EXPEDITION-PRODUCER-OP-v1', [b[7]]), stage, bell, family: 'original', links: links(b, at + 100, []) };
    } else if (kind === 148 || kind === 25) {
      const isWide = kind === 25, flags = b[7], slot = b[8];
      fail(format === (isWide ? 'PSW1' : 'PS2') && b[6] === 1 && (flags & ~7) === 0 && (flags & 3) !== 3 && slot < 4 && b[9] === 0);
      fail(name === `${isWide ? 'WIDE_' : ''}ORIGINAL_EXPEDITION_SETTLE_MEMBER` && holding === null);
      fail(original(host) && wide(province) && hex(b, 10, 56) === host.keyHex && hex(b, 162, 50) === province.keyHex && !zero(b.subarray(66, 98)));
      fail(addr(b, 98) === derived(pins, 'Holding', host) && addr(b, 130) === bridge(pins, b, 98, slot) && addr(b, 212) === provinceAddress(pins, province));
      fail(flags & 1 ? hex(b, 244, 50) === host.keyHex.slice(0, 100) : zero(b.subarray(244, 294)));
      fail(flags & 2 ? !zero(b.subarray(294, 326)) : zero(b.subarray(294, 326)));
      fail(flags & 4 ? hex(b, 326, 32) === hex(b, 66, 32) : zero(b.subarray(326, 358)));
      const addresses = [addr(b, 98), addr(b, 130), addr(b, 212), ...(flags & 1 ? [derived(pins, 'Province', host)] : []), ...(flags & 2 ? [addr(b, 294)] : []), ...(flags & 4 ? [addr(b, 326)] : [])];
      fail(new Set(addresses).size === addresses.length && [98, 130, 212].every(at => !zero(b.subarray(at, at + 32))));
      const operationId = hex(b, 358, 32);
      fail(operationId === toHex(sha256('PSF-BOUNDARY-SETTLEMENT-OP-v1', b.subarray(390, 422), b.subarray(422, 454))));
      out = { stage: 'settle_member', bell, slot, operationId, inputDigest: hex(b, 390, 32), outputDigest: hex(b, 422, 32), family: isWide ? 'wide' : 'original',
        pairClass: 'settlement', pairRole: isWide ? 'wide' : 'original', pairBody: hex(b, 2, 452), links: links(b, 454, isWide ? [1] : [5, ...(flags & 1 ? [6] : []), ...(flags & 2 ? [5] : []), ...(flags & 4 ? [4] : [])]) };
    } else if (kind === 145) {
      fail(format === 'PS2' && b[6] === 1 && [1, 2].includes(b[7]) && b[8] === 0 && b[9] === 0 && holding === null);
      fail(original(host) && original(province) && hex(b, 10, 56) === host.keyHex && host.keyHex.slice(0, 100) === province.keyHex && addr(b, 66) === derived(pins, 'Holding', host));
      const debit = b[7] === 1, stage = debit ? 'conquest_debit' : 'conquest_credit';
      fail(name === `ORIGINAL_${stage.toUpperCase()}`);
      out = { ...conquestReceipt(b, 98, debit ? [1] : [4, 5]), stage, bell, family: 'original', pairClass: 'conquest', pairRole: 'source', pairBody: hex(b, 98, 100), sourceReference: true, links: links(b, 198, [5]) };
    } else {
      fail(format === 'PSW1' && kind >= 18 && kind <= 24 && name === `WIDE_CONQUEST_${CQ_NAMES[kind]}` && host === null && wide(province));
      const holdingKey = [19, 22, 23].includes(kind), at = holdingKey ? 62 : 56;
      if (holdingKey) fail(holding && holding.hostSequence === 0 && holding.generation >= 1 && holding.generation <= 254 && holding.keyHex.slice(0, 100) === province.keyHex && hex(b, 6, 56) === holding.keyHex);
      else fail(holding === null && hex(b, 6, 50) === province.keyHex);
      const actions = { 18: [1], 19: [1], 20: [2], 21: [3, 4], 22: [5], 23: [4, 5], 24: [6] };
      const c = conquestReceipt(b, at, actions[kind]);
      const paired = [18, 19, 22, 23].includes(kind) || kind === 21 && c.action === 4;
      out = { ...c, stage: `conquest_${CQ_NAMES[kind].toLowerCase()}`, bell, family: 'wide', links: links(b, at + 100, kind === 22 ? [1, 2] : kind === 24 ? [] : holdingKey ? [2] : [1], false),
        ...(paired ? { pairClass: 'conquest', pairRole: [19, 23].includes(kind) ? 'source' : 'target', pairBody: hex(b, at, 100) } : {}) };
    }
  }
  return Object.freeze({ ...out, executable: false, receiptVerification: 'unverified', sourceVerification: 'unverified', originalChainVerification: 'unverified' });
}

// Only match parts visible on this page from the SAME captured transaction.
// Missing parts remain observations. Neither a pair nor a digest is provenance.
export function expeditionPairs(rows) {
  const groups = new Map(), result = new Map();
  for (const r of rows) if (r.expedition?.pairClass) {
    const x = r.expedition, key = `${r.archiveSequence}:${x.pairClass}:${x.operationId}`;
    const g = groups.get(key) ?? []; g.push(r); groups.set(key, g);
  }
  for (const g of groups.values()) {
    fail(g.length <= 2); if (g.length !== 2) continue;
    const [a, b] = g, x = a.expedition, y = b.expedition;
    fail(a.ordinal !== b.ordinal && x.pairRole !== y.pairRole && x.bell === y.bell && x.pairBody === y.pairBody);
    result.set(a.event, b.event); result.set(b.event, a.event);
  }
  return result;
}

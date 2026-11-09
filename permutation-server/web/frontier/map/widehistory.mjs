// Read-only observations from the separate typed index. Never terrain, game
// authority, account authentication or a proof of complete event history.
import { fromBase64, toBase64, toHex } from '../../sdk/bytes.mjs';
import { parseWideInt, ringPosition, worldIdOf, WideError } from './wide.mjs';
const NAMES = ['','WIDE_MUSTER','WIDE_DISSOLVE','WIDE_RESOLVE','WIDE_RETURN','WIDE_STRANDED','WIDE_ROSTER_CLOSED','WIDE_DEPARTED','WIDE_TRANSIT_SETTLED','WIDE_DEPARTURE_SETTLED','WIDE_REVEALED','WIDE_GATHERED','WIDE_RECORD_CLOSED','WIDE_TRANSIT_CLOSED','WIDE_PROVINCE_CLOSED','WIDE_ECONOMY','WIDE_ECONOMY_MIRROR'];
const fail = (ok, code = 'BadWideHistory') => { if (!ok) throw new WideError(code, code); };
const uint = s => { fail(typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s)); const n = BigInt(s); fail(n <= 0xffffffffffffffffn); return n; };
function scope(v, pins) {
  fail(v?.v === 1 && v.experimental === true && v.readOnly === true);
  fail(v.sourceCoverage === 'unknown' && v.captureVerification === 'unverified');
  fail(pins?.programId && pins?.seasonAddress && pins?.seasonId !== undefined, 'WrongSeason');
  fail(v.program === pins.programId && v.seasonAddress === pins.seasonAddress && v.season === String(pins.seasonId), 'WrongSeason');
  fail(v.world === worldIdOf(pins.seasonAddress, pins.programId), 'WorldMismatch');
  fail(typeof v.snapshot === 'string' && /^[0-9a-f]{64}$/.test(v.snapshot));
  return { world: v.world, through: uint(v.indexedThrough), snapshot:v.snapshot };
}
export function parseWideIndexStatus(v, pins) {
  const s = scope(v, pins);
  fail(['observed', 'incomplete', 'blocked'].includes(v.state) && typeof v.caughtUp === 'boolean' && v.automaticWrites === false);
  fail(v.caughtUp === (v.state === 'observed'));
  return { ...s, state: v.state, sourceCoverage: 'unknown', captureVerification: 'unverified' };
}
export function wideHistoryIdentity(v, world, host = false) {
  fail(v && v.world === world && typeof v.keyHex === 'string' && new RegExp(`^[0-9a-f]{${host ? 112 : 100}}$`).test(v.keyHex));
  fail(v.keyHex.slice(0, 2) === '01' && v.keyHex.slice(2, 66) === world);
  const p = parseWideInt(v.p), q = parseWideInt(v.q);
  const rp = ringPosition(p, q);
  const base = `01${world}${rp.ring.toString(16).padStart(16, '0')}${rp.wedge.toString(16).padStart(2, '0')}${rp.pos.toString(16).padStart(16, '0')}`;
  fail(v.keyHex.slice(0, 100) === base);
  if (host) {
    fail(Number.isInteger(v.site) && v.site >= 0 && v.site < 12 && Number.isInteger(v.generation) && v.generation >= 0 && v.generation <= 255 && Number.isInteger(v.hostSequence) && v.hostSequence >= 0 && v.hostSequence <= 0xffffffff);
    const seq = new Uint8Array(4); new DataView(seq.buffer).setUint32(0, v.hostSequence, true);
    fail(v.keyHex === `${base}${v.site.toString(16).padStart(2,'0')}${v.generation.toString(16).padStart(2,'0')}${toHex(seq)}`);
  }
  return { ...v, p, q };
}

// frontier-abi world_index::{economy,event}: header 6, holding key 56,
// receipt 80, count 1, then exactly the kind's 41-byte links. These are
// format checks, not digest/chain replay, authentication or live state.
function economyOf(body, kind) {
  const entities = kind === 16 ? [1, 2] : [2];
  const payload = 62, tail = payload + 80;
  fail(body.length === tail + 1 + entities.length * 41);
  fail(body[payload] === 1 && body[tail] === entities.length);
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const tag = body[payload + 1], arg = body[payload + 2], n = dv.getUint32(payload + 3, true);
  let action;
  if (tag === 0) {
    fail(arg === 0 && n === 0);
    action = { kind: 'harvest' };
  } else if (tag === 1) {
    fail(arg <= 8 && n === 0);
    action = { kind: 'build', item: arg };
  } else {
    fail(tag === 2 && arg < 7 && n > 0);
    action = { kind: 'train', unit: arg, n };
  }
  fail(kind === (tag === 1 && (arg === 6 || arg === 7) ? 16 : 15));
  fail(body[payload + 15] === 0 || body[payload + 15] === 1);
  const links = entities.map((entity, i) => {
    const at = tail + 1 + i * 41;
    fail(body[at] === entity);
    return Object.freeze({ entity, sequence: dv.getBigUint64(at + 1, true), head: toHex(body.slice(at + 9, at + 41)) });
  });
  return Object.freeze({
    action: Object.freeze(action), nowTs: dv.getBigInt64(payload + 7, true), becameFinal: body[payload + 15] === 1,
    inputDigest: toHex(body.slice(payload + 16, payload + 48)), outputDigest: toHex(body.slice(payload + 48, tail)),
    links: Object.freeze(links),
  });
}

export function parseWideIndexPage(v, { pins, through, snapshot, after = 0n, limit = 20 } = {}) {
  const s = scope(v, pins);
  fail(s.through === BigInt(through) && s.snapshot === snapshot, 'WideIndexChanged');
  fail(uint(v.after) === BigInt(after) && v.limit === limit && Number.isInteger(limit) && limit >= 1 && limit <= 256);
  fail(Array.isArray(v.events) && v.events.length <= limit && typeof v.more === 'boolean');
  let previous = BigInt(after);
  const rows = v.events.map(r => {
    const event = uint(r?.event), archiveSequence = uint(r.archiveSequence), ordinal = uint(r.ordinal);
    fail(event === previous + 1n && archiveSequence > 0n && archiveSequence <= s.through);
    previous = event;
    fail(r.format === 'PS2' || r.format === 'PSW1');
    fail(typeof r.body_b64 === 'string' && r.body_b64.length > 0 && r.body_b64.length <= 16384);
    const body = fromBase64(r.body_b64); fail(body.length > 6 && body.length <= 8192 && toBase64(body) === r.body_b64);
    fail(Number.isInteger(r.kind) && body[1] === r.kind && typeof r.name === 'string' && /^[A-Z0-9_]{1,40}$/.test(r.name));
    let province = null, holding = null, host = null, economy = null;
    if (r.format === 'PSW1') {
      fail(body[0] === 0x82 && r.kind >= 1 && r.kind <= 16 && r.name === NAMES[r.kind]);
      province = wideHistoryIdentity(r.province, s.world);
      if (r.holding !== null) { holding = wideHistoryIdentity(r.holding, s.world, true); fail(holding.hostSequence === 0); }
      if (r.host !== null) host = wideHistoryIdentity(r.host, s.world, true);
      if (r.kind === 15 || r.kind === 16) {
        // An economy key names a holding, never a phantom sequence-zero
        // host. Its own province is the attribution, not a second key.
        fail(host === null && holding !== null && holding.generation >= 1 && holding.generation <= 254);
        fail(ringPosition(holding.p, holding.q).ring >= 129n);
        fail(holding.keyHex.slice(0, 100) === province.keyHex && toHex(body.slice(6, 62)) === holding.keyHex);
        economy = economyOf(body, r.kind);
      } else {
        const hostKeyed = ![3,6,11,12,14].includes(r.kind);
        fail(Boolean(host) === Boolean(holding) && Boolean(host) === hostKeyed);
        fail(body.length > 6 + (hostKeyed ? 106 : 50));
        fail(toHex(body.slice(hostKeyed ? 62 : 6, hostKeyed ? 112 : 56)) === province.keyHex);
        if (host) fail(toHex(body.slice(6,62)) === host.keyHex);
        if (host) fail(host.p === holding.p && host.q === holding.q && host.site === holding.site && host.generation === holding.generation);
      }
    } else {
      fail(body[0] === 1 && r.name === 'PS2' && r.province === null && r.holding === null && r.host === null);
    }
    return { event, archiveSequence, ordinal, format: r.format, kind: r.kind, name: r.name, province, holding, host, economy, body };
  });
  fail(uint(v.next) === previous && (!v.more || rows.length === limit));
  return { ...s, rows, next: previous, more: v.more, sourceCoverage: 'unknown', captureVerification: 'unverified' };
}

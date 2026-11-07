// Read-only observations from the separate typed index. Never terrain, game
// authority, account authentication or a proof of complete event history.
import { fromBase64, toBase64, toHex } from '../../sdk/bytes.mjs';
import { parseWideInt, ringPosition, worldIdOf, WideError } from './wide.mjs';
const NAMES = ['','WIDE_MUSTER','WIDE_DISSOLVE','WIDE_RESOLVE','WIDE_RETURN','WIDE_STRANDED','WIDE_ROSTER_CLOSED','WIDE_DEPARTED','WIDE_TRANSIT_SETTLED','WIDE_DEPARTURE_SETTLED','WIDE_REVEALED','WIDE_GATHERED','WIDE_RECORD_CLOSED','WIDE_TRANSIT_CLOSED','WIDE_PROVINCE_CLOSED'];
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
function identity(v, world, host = false) {
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
    let province = null, holding = null, host = null;
    if (r.format === 'PSW1') {
      fail(body[0] === 0x82 && r.kind >= 1 && r.kind <= 14 && r.name === NAMES[r.kind]);
      province = identity(r.province, s.world);
      if (r.holding !== null) { holding = identity(r.holding, s.world, true); fail(holding.hostSequence === 0); }
      if (r.host !== null) host = identity(r.host, s.world, true);
      const hostKeyed = ![3,6,11,12,14].includes(r.kind);
      fail(Boolean(host) === Boolean(holding) && Boolean(host) === hostKeyed);
      fail(body.length > 6 + (hostKeyed ? 106 : 50));
      fail(toHex(body.slice(hostKeyed ? 62 : 6, hostKeyed ? 112 : 56)) === province.keyHex);
      if (host) fail(toHex(body.slice(6,62)) === host.keyHex);
      if (host) fail(host.p === holding.p && host.q === holding.q && host.site === holding.site && host.generation === holding.generation);
    } else {
      fail(body[0] === 1 && r.name === 'PS2' && r.province === null && r.holding === null && r.host === null);
    }
    return { event, archiveSequence, ordinal, format: r.format, kind: r.kind, name: r.name, province, holding, host, body };
  });
  fail(uint(v.next) === previous && (!v.more || rows.length === limit));
  return { ...s, rows, next: previous, more: v.more, sourceCoverage: 'unknown', captureVerification: 'unverified' };
}

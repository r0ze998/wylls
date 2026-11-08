// TEST-ONLY fake of the local economy host bridge (never served, never imported by the demo itself).
//
// It speaks the same line protocol as the real host but implements NO economics: it only moves between two byte sets
// supplied by the test (the original harvest "pre" bytes and any "post" bytes), counts revisions, and keeps a clock. Which
// bytes are "post" is the test's choice; nothing is derived from them.
import { PROTOCOL, MODE, AUTH, INITIAL_NOW, REPLY_KEYS, ADVANCE_SECONDS } from './local-model.mjs';

const hex = b => Buffer.from(b).toString('hex');

/** Patch an ordinary (184 B) receipt's action (6 bytes at 63) and time (i64 LE at 69). */
export function patchRecord(base, actionBytes, now) {
  let b = Uint8Array.from(base);
  if (actionBytes[0] === 1 && [6, 7].includes(actionBytes[1]) && b.length === 184) {
    const mirror = new Uint8Array(225); mirror.set(b.subarray(0, 143));
    mirror[1] = 16; mirror[142] = 2; mirror[143] = 1; mirror.set(b.subarray(143), 184); b = mirror;
  }
  b.set(actionBytes, 63);
  new DataView(b.buffer).setBigInt64(69, BigInt(now), true);
  return b;
}
export const ACTION = Object.freeze({
  harvest: () => Uint8Array.of(0, 0, 0, 0, 0, 0),
  build: item => Uint8Array.of(1, item, 0, 0, 0, 0),
  train: (unit, n) => { const a = new Uint8Array(6); a[0] = 2; a[1] = unit; new DataView(a.buffer).setUint32(2, n, true); return a; },
});

/**
 * `pre` / `post` = {season, citizen, holding, province} (Uint8Array); `record` = a 184 B ordinary receipt used as a template.
 * Options: `refuseWhen(line) -> code|null` (default: refuse `build 8`).
 * Test controls: `calls` (every line received), `hook` (one-shot: (replyObj, line) → replyObj | string | Error),
 * `hold()` (the NEXT exchange waits until the returned release() is called), `closed`.
 */
export function createFakeBridge({ pre, post, record, refuseWhen = line => (/^act \d+ build 8$/.test(line) ? 'RefusedByHost' : null) }) {
  const st = { revision: 0, now: BigInt(INITIAL_NOW), phase: 'pre', record: null };
  const bridge = { calls: [], hook: null, closed: false, gate: null };
  let command = 'get', action = null;
  const reply = (status, code) => {
    const s = st.phase === 'pre' ? pre : post;
    return {
      protocol: PROTOCOL, mode: MODE, auth: AUTH, command, action, status, revision: st.revision, now: String(st.now), code,
      seasonHex: hex(pre.season), citizenHex: hex(s.citizen), holdingHex: hex(s.holding), provinceHex: hex(s.province),
      recordHex: st.record ? hex(st.record) : null,
    };
  };
  bridge.state = st;
  bridge.hold = () => { let release; bridge.gate = new Promise(r => { release = r; }); return release; };
  bridge.exchange = async line => {
    bridge.calls.push(line);
    if (bridge.closed) { const e = new Error('closed'); e.code = 'Closed'; throw e; }
    if (bridge.gate) { const g = bridge.gate; bridge.gate = null; await g; }
    st.record = null;
    command = line.split(' ')[0]; action = command === 'act' ? line.split(' ')[2] : null;
    let out;
    const m = /^(get|act (\d+) (harvest|build (\d+)|train (\d+) (\d+))|advance (\d+) (\d+)|reset (\d+))$/.exec(line);
    if (!m) { command = 'invalid'; action = null; out = reply('refused', 'BAD_COMMAND'); }
    else if (line === 'get') out = reply('ok', null);
    else {
      const rev = Number(m[2] ?? m[7] ?? m[9]);
      const code = rev !== st.revision ? 'STALE_REVISION' : refuseWhen(line);
      if (code) out = reply('refused', code);
      else if (line.startsWith('reset')) { st.revision++; st.now = BigInt(INITIAL_NOW); st.phase = 'pre'; st.record = null; out = reply('ok', null); }
      else if (line.startsWith('advance')) {
        if (!ADVANCE_SECONDS.includes(Number(m[8]))) out = reply('refused', 'BAD_SECONDS');
        else { st.revision++; st.now += BigInt(m[8]); out = reply('ok', null); }
      } else {
        st.revision++; st.phase = 'post';
        const t = String(st.now);
        if (m[3] === 'harvest') st.record = patchRecord(record, ACTION.harvest(), t);
        else if (m[4] !== undefined) { const item = Number(m[4]); st.record = patchRecord(record, ACTION.build(item), t); }
        else st.record = patchRecord(record, ACTION.train(Number(m[5]), Number(m[6])), t);
        out = reply('ok', null);
      }
    }
    if (bridge.hook) {
      const h = bridge.hook; bridge.hook = null;
      const r = h(out, line);
      if (r instanceof Error) throw r;
      if (typeof r === 'string') return r;
      out = r;
    }
    return JSON.stringify(Object.fromEntries(REPLY_KEYS.map(k => [k, out[k]])));
  };
  bridge.close = () => { bridge.closed = true; };
  return bridge;
}

// Workstream 07: PS2 record bodies of the v2 log kinds, built from the
// generated log table (sdk/frontier/abi-v2-logs.mjs) — the bytes a herald's
// /h/events page carries in `body_b64`. For tests and the prototype's mock
// world only: the page decodes them with its own flog.mjs decodeRecord, so a
// mock never bypasses the page's decoder.
import { LOGS } from '../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';

/** ver ‖ kind ‖ bell u32 ‖ key ‖ payload ‖ no links, as base64. Fields not given are zero. */
export function encodeBody(name, bell, fields = {}) {
  const spec = LOGS.kinds.find(k => k.name === name);
  if (!spec) throw new Error(`no log kind ${name}`);
  const parts = [...spec.key, ...spec.payload];
  const b = new Uint8Array(6 + parts.reduce((a, f) => a + f.len, 0) + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) {
    const x = fields[f.name];
    if (x instanceof Uint8Array) b.set(x.subarray(0, f.len), o);
    else if (x !== undefined) {
      if (f.len === 8) v.setBigUint64(o, BigInt(x), true);
      else if (f.len === 4) v.setInt32(o, Number(x), true);
      else if (f.len === 2) v.setUint16(o, Number(x), true);
      else if (f.len === 1) b[o] = Number(x);
    }
    o += f.len;
  }
  return toBase64(b);
}

/** Eight u32 whole units (caravan.rs cargo_log). */
export function cargoBytes(arr) {
  const b = new Uint8Array(32), v = new DataView(b.buffer);
  arr.forEach((n, i) => v.setUint32(i * 4, n, true));
  return b;
}

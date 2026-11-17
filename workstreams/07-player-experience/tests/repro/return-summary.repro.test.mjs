// REPRO (workstream 07): these tests pin a defect AS THE BASE PAGE HAS IT (a997a756, before patches/). They pass
// on the base and are EXPECTED TO FAIL once the patch that fixes the defect is applied. They are evidence, not part of
// any regular suite: the regular tests are ../*.test.mjs here and permutation-gateway/test/web-frontier-ws07-*.test.mjs
// in the patches (INTEGRATION.ja.md §2).
// Workstream 07, claim 3 of the brief: when is the "what happened" empty, and
// which S1 events does it miss? Then the return summary of src/return-summary.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeRecord, KINDS as M1_KINDS } from '../../../../permutation-server/web/frontier/flog.mjs';
import { LOGS } from '../../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../../../permutation-server/web/sdk/bytes.mjs';
import { snapshot, diffFeed } from '../../../../permutation-server/web/frontier/hud/feed.mjs';
import { CHRONICLE_WINDOW, chronicleStart } from '../../../../permutation-server/web/frontier/controller.mjs';
import { setLang } from '../../../../permutation-server/web/lang.mjs';
import * as RS from '../../src/return-summary.mjs';

const CONTROLLER = readFileSync(new URL('../../../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const SERVER_RS = readFileSync(new URL('../../../../frontier-node/crates/herald/src/server.rs', import.meta.url), 'utf8');

/** A PS2 body of an S1 kind, from the v2 log table: ver ‖ kind ‖ bell u32 ‖ key ‖ payload ‖ no links. */
function body(name, bell, fields) {
  const spec = LOGS.kinds.find(k => k.name === name);
  const parts = [...spec.key, ...spec.payload];
  const len = 6 + parts.reduce((a, f) => a + f.len, 0) + 1;
  const b = new Uint8Array(len), v = new DataView(b.buffer);
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
const cargo = arr => { const b = new Uint8Array(32), v = new DataView(b.buffer); arr.forEach((n, i) => v.setUint32(i * 4, n, true)); return b; };
const ME = 0x1234n, OTHER = 0x9999n;
const rec = (seq, name, bell, fields) => ({ seq: String(seq), record: decodeRecord(body(name, bell, fields)) });
const me = { tag: ME, faction: 2, holdings: [{ p: 1, q: 0, site: 3 }], hostOf: () => null };
const EVENTS = [
  rec(101, 'CARAVAN_SENT', 300, { owner_tag: ME, seq: 4, faction: 2 }),
  rec(102, 'RAID_OPENED', 304, { owner_tag: ME, seq: 4, p: 2, q: 0, bell: 304, raider_tag: OTHER }),
  rec(103, 'CARAVAN_RAIDED', 306, { owner_tag: ME, seq: 4, p: 2, q: 0, bell: 304, choice: 0, by: 1, raider_tag: OTHER, taken: cargo([0, 300, 0, 0, 0, 120, 0, 0]) }),
  rec(104, 'VAULT_SEIZED', 310, { p: 2, q: 0, tile: 7, captor_tag: OTHER, prev_tag: ME }),
  rec(105, 'NATION_DECIDED', 320, { faction: 2, id: 1, passed: 1, kind: 1, target_faction: 4, value: 0, yes: 3, no: 1 }),
  rec(106, 'NATION_DECIDED', 320, { faction: 5, id: 1, passed: 1, kind: 1, target_faction: 2, value: 0, yes: 3, no: 0 }),
  rec(107, 'SIEGE_DECLARED', 330, { p: 1, q: 0, site: 3, attacker: 4, owner_faction: 2, owner_tag: ME, required: 40 }),
  rec(108, 'CARAVAN_SETTLED', 331, { owner_tag: OTHER, seq: 1, outcome: 0, cargo: cargo([5, 0, 0, 0, 0, 0, 0, 0]) }),
];

test('REPRO: the page\'s first look is never news, whatever happened before it opened', () => {
  const FS = { marches: [], holdings: [{ p: 1, q: 0, site: 3, state: 2, tier: 1, queue: [] }], chronicle: EVENTS, nowBell: 340, chain: { now: () => 0 }, citizen: { faction: 2 } };
  assert.deepEqual(diffFeed(null, snapshot(FS)), [], 'hud/feed.mjs: "A first snapshot (prev null) is not news"');
});

test('REPRO: even between two looks, no S1 loss becomes a notification (a caravan raided, a storehouse seized, a siege on the village)', () => {
  const holdings = [{ p: 1, q: 0, site: 3, state: 2, tier: 1, queue: [] }];
  const before = snapshot({ marches: [], holdings, chronicle: [], nowBell: 300, chain: { now: () => 0 }, citizen: { faction: 2 } });
  const after = snapshot({ marches: [], holdings, chronicle: EVENTS, nowBell: 340, chain: { now: () => 0 }, citizen: { faction: 2 } }, 0, before);
  assert.deepEqual(diffFeed(before, after), []);
});

test('REPRO: the chronicle starts 500 events behind the head and keeps 400; the herald itself keeps them all', () => {
  assert.equal(CHRONICLE_WINDOW, 500);
  assert.equal(chronicleStart(10_000), 9_500);
  assert.match(CONTROLLER, /FS\.chronicle = \[\.\.\.\(FS\.chronicle \?\? \[\]\), \.\.\.records\]\.slice\(-400\)/);
  assert.match(SERVER_RS, /\.route\("\/h\/events", get\(events\)\)/);
  assert.match(SERVER_RS, /events_after\(after, EVENTS_PAGE\)/, 'a page from any `after`, from the index');
});

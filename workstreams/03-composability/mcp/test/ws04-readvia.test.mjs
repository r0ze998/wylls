// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// readVia on ③'s reads of workstream 04's registry — how this server asked, from its own configuration of ④'s client
// (workstream 05 fada02f9's words: 'gateway' | 'store-only' | null), never from ④'s receipt; a path, not success,
// freshness or chain finality:
//   V1 readViaOf: only the two words, anything else null
//   V2 an answering read stores readVia beside `at`; a receipt's own readVia field is ignored
//   V3 an unqueryable receipt keeps the earlier readVia (it belongs to the kept `at`) and puts this attempt's path in
//      readErrorVia; a failed read the same; the next answering read drops readErrorVia
//   V4 a stale readErrorVia never stays beside a newer readErrorAt
//   V5 bin/wylls-mcp.mjs derives actsReadVia from the same gatewayPort value it gives ④'s client (truthiness, as
//      ④'s status `read && gatewayPort`), not from the variable's presence
//   V6 server.mjs: register is store-only; consult tags the status read with the configured value and a failed
//      registration as store-only; get_run_status tags list rows store-only, re-reads with the configured value, and
//      keeps the stored row for an unqueryable re-read
// KEY-FREE: imports receipt-port.mjs (→ ports.mjs, which imports nothing); reads bin/wylls-mcp.mjs and server.mjs as
// text (not imported). Plain objects only; nothing is signed, sent, fetched or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WS04_UNQUERYABLE, readViaOf, ws04ActAfterRead, ws04ActAfterFailedRead } from '../src/receipt-port.mjs';

const KEY = 'ws03:lnk_a:req-0001';
const T1 = '2026-11-17T00:00:01.000Z', T2 = '2026-11-17T00:00:02.000Z', T3 = '2026-11-17T00:00:03.000Z', T4 = '2026-11-17T00:00:04.000Z';
const registered = { run4Id: 'act-0000000000000001', runId: 'op_1', registeredAt: '2026-11-17T00:00:00.000Z', receiptVersion: 'p04-acts/0.1', state: 'registered', registeredVia: 'store-only' };
const receipt = (extra = {}) => ({ run4Id: 'act-0000000000000001', receiptVersion: 'p04-acts/0.1', state: 'unknown', final: false, next: 'hold', newAttemptAllowed: false,
  cancel: null, retention: null, conflict: null, signature: 'S', idempotencyKey: KEY, source: 'mcp', ...extra });

test('V1 the two words only', () => {
  assert.deepEqual(['gateway', 'store-only', null, undefined, 'bridge', 'GATEWAY', 1, ''].map(readViaOf), ['gateway', 'store-only', null, null, null, null, null, null]);
});

test('V2 beside at; never from the receipt', () => {
  const act = ws04ActAfterRead(registered, receipt({ readVia: 'gateway' }), { key: KEY, at: T1, readVia: 'store-only' }).act;
  assert.deepEqual([act.at, act.readVia, act.registeredVia], [T1, 'store-only', 'store-only']);
  assert.equal(ws04ActAfterRead(registered, receipt({ readVia: 'gateway' }), { key: KEY, at: T1 }).act.readVia, null, 'not told: null, whatever the receipt says');
});

test('V3 an unqueryable or failed attempt is not shown as this read', () => {
  const known = ws04ActAfterRead(registered, receipt(), { key: KEY, at: T1, readVia: 'gateway' }).act;
  const u = ws04ActAfterRead(known, receipt({ state: 'unqueryable', next: 'read-again' }), { key: KEY, at: T2, readVia: 'gateway' }).act;
  assert.deepEqual([u.state, u.at, u.readVia, u.readError, u.readErrorAt, u.readErrorVia], ['unknown', T1, 'gateway', WS04_UNQUERYABLE, T2, 'gateway']);
  const f = ws04ActAfterFailedRead(known, 'Spawn: x', T2, 'store-only');
  assert.deepEqual([f.at, f.readVia, f.readErrorAt, f.readErrorVia], [T1, 'gateway', T2, 'store-only']);
  const next = ws04ActAfterRead(u, receipt({ state: 'pending', next: 'wait' }), { key: KEY, at: T3, readVia: 'gateway' }).act;
  assert.deepEqual([next.at, next.readVia, 'readErrorVia' in next, 'readError' in next], [T3, 'gateway', false, false]);
  // A first-ever unqueryable: no readVia or at is made up.
  const first = ws04ActAfterRead(registered, receipt({ state: 'unqueryable' }), { key: KEY, at: T1, readVia: 'gateway' }).act;
  assert.deepEqual(['at' in first, 'readVia' in first, first.readErrorVia, first.registeredVia], [false, false, 'gateway', 'store-only']);
});

test('V4 no stale readErrorVia', () => {
  const a = ws04ActAfterFailedRead(registered, 'StoreError: locked', T2, 'gateway');
  const b = ws04ActAfterFailedRead(a, 'Inconsistent: other key', T4);
  assert.deepEqual([b.readErrorAt, 'readErrorVia' in b], [T4, false]);
});

test('V5 bin: from the same port value ④\'s client gets', () => {
  const bin = readFileSync(new URL('../bin/wylls-mcp.mjs', import.meta.url), 'utf8');
  assert.match(bin, /const gatewayPort = env\.WYLLS_MCP_WS04_GATEWAY_PORT \? Number\(env\.WYLLS_MCP_WS04_GATEWAY_PORT\) : null;\n\s+acts = createActsClient\(\{ bin: env\.WYLLS_MCP_WS04_RUNEXEC, db: env\.WYLLS_MCP_WS04_DB, gatewayPort \}\);/);
  assert.match(bin, /actsReadVia = gatewayPort \? 'gateway' : 'store-only';/);
  assert.match(bin, /createWyllsMcp\(\{ auth, game, store, log, receipts, acts, actsReadVia \}\)/);
  assert.doesNotMatch(bin, /bridge: true/);
});

test('V6 server: register, consult and get_run_status', () => {
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /const statusVia = readViaOf\(actsReadVia\);/);
  assert.match(src, /state: op\.ws04Act\?\.state \?\? r\.state, registeredVia: 'store-only' \};/);
  assert.match(src, /if \(!op\.ws04Act\?\.run4Id\) \{ via = 'store-only'; await register\(op, link\); via = statusVia; \}/);
  assert.match(src, /ws04ActAfterRead\(op\.ws04Act, a, \{ key: keyOf\(op\), at, scrub, readVia: statusVia \}\)/);
  assert.match(src, /ws04ActAfterFailedRead\(op\.ws04Act, `\$\{e\?\.code \?\? 'Error'\}: \$\{scrub\(e\?\.message\)\}`, at, via\)/);
  assert.match(src, /const stored = \{ \.\.\.a, readVia: 'store-only' \};/);
  assert.match(src, /s\.state === 'unqueryable' \? \{ \.\.\.stored, readError: WS04_UNQUERYABLE, readErrorVia: statusVia,/);
  assert.match(src, /: \{ \.\.\.s, readVia: statusVia \}\);/);
  assert.match(src, /it is not freshness, success or chain finality, and source is who registered the act/);
});

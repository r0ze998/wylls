// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// server.handle initialize: InitializeRequestParams (MCP 2025-03-26 / 2025-06-18 / 2025-11-25) needs protocolVersion
// (string), capabilities (object) and clientInfo {name, version} (strings). Missing or mistyped ones are -32602; an
// unknown version STRING with valid params still gets the latest supported version; extra fields are not refused.
// KEY-FREE: reads src/server.mjs as TEXT (importing it would load game.mjs and the web frontier); the condition is
// evaluated on its own with `new Function` (no import, no I/O).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const handle = server.slice(server.indexOf('async function handle(msg, principal)'), server.indexOf('\n  return { handle,'));
const m = /const isObj = (v => .+);\n\s+if \((!isObj\(p\)[\s\S]+?)\) \{\n\s+return error\(-32602/.exec(handle);
const refused = m && new Function('p', `const isObj = ${m[1]}; return ${m[2]};`);

const OK = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } };

test('I1 valid params pass, including an unknown version string and extra fields', () => {
  assert.ok(refused, 'the condition is found');
  assert.equal(refused(OK), false);
  assert.equal(refused({ ...OK, protocolVersion: '1999-01-01' }), false, 'an unknown version string: the fallback, not invalid');
  assert.equal(refused({ ...OK, capabilities: { roots: { listChanged: true }, sampling: {} }, clientInfo: { name: 'c', version: '1', title: 'C', icons: [] }, _meta: { x: 1 } }), false, 'extra fields are not refused');
});

test('I2 missing or mistyped params are refused', () => {
  for (const p of [undefined, null, [], 'x',
    { ...OK, protocolVersion: undefined }, { ...OK, protocolVersion: 20250618 },
    { ...OK, capabilities: undefined }, { ...OK, capabilities: null }, { ...OK, capabilities: [] },
    { ...OK, clientInfo: undefined }, { ...OK, clientInfo: [] }, { ...OK, clientInfo: { name: 'c' } },
    { ...OK, clientInfo: { version: '1' } }, { ...OK, clientInfo: { name: 1, version: '1' } }]) {
    assert.equal(refused(p), true, JSON.stringify(p));
  }
});

test('I3 the answer and the order: -32602 through error() (null for a notification), before the version is chosen', () => {
  const init = handle.slice(handle.indexOf("case 'initialize': {"), handle.indexOf("case 'notifications/initialized'"));
  assert.match(init, /return error\(-32602, 'invalid params: initialize needs protocolVersion \(string\), capabilities \(object\) and clientInfo \{name, version\} \(strings\)'\);/);
  assert.ok(init.indexOf('return error(-32602') < init.indexOf('const asked = msg.params?.protocolVersion;'));
  assert.match(init, /protocolVersion: PROTOCOL_VERSIONS\.includes\(asked\) \? asked : PROTOCOL_VERSIONS\[0\]/, 'the negotiation is unchanged');
});

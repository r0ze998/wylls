// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// JSON-RPC notifications get no response (JSON-RPC 2.0; MCP 2025-06-18 basic/Messages): server.handle returns null for
// a valid message without `id`, for every method, and http.mjs answers that with 202 and no body. An invalid message
// is still answered -32600 with id null. KEY-FREE: reads src/server.mjs and src/http.mjs as TEXT only; importing
// server.mjs would load game.mjs and the web frontier, which this test deliberately does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const http = readFileSync(new URL('../src/http.mjs', import.meta.url), 'utf8');
const handle = server.slice(server.indexOf('async function handle(msg, principal)'), server.indexOf('\n  return { handle,'));

test('N1 reply and answer give null for a notification', () => {
  assert.ok(handle.length > 0, 'handle() found');
  assert.match(handle, /const reply = result => \(notification \? null : \{ jsonrpc: '2\.0', id: msg\.id, result \}\);/);
  assert.match(handle, /const answer = \(code, message\) => \(notification \? null : error\(code, message\)\);/);
  assert.match(handle, /const notification = msg\.id === undefined;/);
});

test('N2 after the envelope check, every response goes through reply or answer (no bare error, no literal response)', () => {
  const body = handle.slice(handle.indexOf('const notification = msg.id === undefined;'));
  assert.doesNotMatch(body, /return error\(/, 'no error() returned past the envelope check');
  assert.doesNotMatch(body, /return \{ jsonrpc:/, 'no literal response object');
  for (const m of [/return answer\(-32602, unknownToolText\(name\)\);/, /default: return answer\(-32601, /]) assert.match(body, m);
  // notifications/initialized and notifications/cancelled: null, as before.
  assert.match(body, /case 'notifications\/initialized': case 'notifications\/cancelled': return null;/);
});

test('N3 an invalid message is still answered -32600 with id null, before notification is decided', () => {
  const env = handle.indexOf("return error(-32600, 'invalid request');");
  assert.ok(env > 0 && env < handle.indexOf('const notification = msg.id === undefined;'));
  assert.match(handle, /const error = \(code, message\) => \(\{ jsonrpc: '2\.0', id: msg\?\.id \?\? null, error: \{ code, message \} \}\);/);
});

test('N4 the transport: null → 202 with no body; a batch is still refused', () => {
  assert.match(http, /const out = await mcp\.handle\(msg, principal\);\n\s+if \(out === null\) \{ res\.writeHead\(202\); return res\.end\(\); \}/);
  assert.match(http, /batches are not supported/);
});

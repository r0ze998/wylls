// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// src/http.mjs POST /mcp: Mcp-Session-Id goes only on the response to a successful initialize (one with `result`),
// never on an error response; a notification answers 202 with no header, as before. KEY-FREE: reads src/http.mjs as
// TEXT (importing it would load server.mjs and game.mjs); the header condition is evaluated on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const http = readFileSync(new URL('../src/http.mjs', import.meta.url), 'utf8');
const m = /const headers = (msg\.method === 'initialize' && out\.result !== undefined) \? \{ 'mcp-session-id': randomBytes\(16\)\.toString\('hex'\) \} : \{\};/.exec(http);
const gets = m && new Function('msg', 'out', `return ${m[1]};`);

test('S1 a successful initialize gets a session id', () => {
  assert.ok(gets, 'the header line is found');
  assert.equal(gets({ method: 'initialize' }, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }), true);
});

test('S2 an initialize error response gets none; other methods get none', () => {
  assert.equal(gets({ method: 'initialize' }, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }), false);
  assert.equal(gets({ method: 'initialize' }, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }), false);
  for (const method of ['tools/list', 'tools/call', 'ping']) assert.equal(gets({ method }, { jsonrpc: '2.0', id: 1, result: {} }), false, method);
});

test('S3 order unchanged: a null answer (notification) is 202 before any header is chosen', () => {
  const nul = http.indexOf('if (out === null) { res.writeHead(202); return res.end(); }');
  const hdr = http.indexOf("const headers = msg.method === 'initialize' && out.result !== undefined");
  assert.ok(nul > 0 && nul < hdr);
  assert.match(http, /return send\(res, 200, out, headers\);/);
});

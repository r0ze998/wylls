// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with its
// own approval, through the repository's key-free guard.
//
// POST /mcp answers in JSON-RPC also when its body cannot be read (src/http.mjs, 2026-11-17):
//   B1 a body that is not JSON → HTTP 400, JSON-RPC parse error -32700 with id null (JSON-RPC 2.0 §5.1)
//   B2 a body over the size limit → HTTP 413, JSON-RPC -32600 with id null
//   B3 the order is unchanged: the bearer token is checked first (401), then the MCP-Protocol-Version header, then the
//      body; nothing reaches mcp.handle on a body that could not be read
//   B4 body() keeps its OAuth-shaped answers for the OAuth routes; any other error is still thrown to the outer catch
// KEY-FREE: imports node:test, node:assert/strict and node:fs; src/http.mjs is read as text (it imports the gateway's
// owner-auth module, so it is not imported here). Nothing is served, bound or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/http.mjs', import.meta.url), 'utf8');
const mcp = src.slice(src.indexOf("case 'POST /mcp': {"), src.indexOf('default:', src.indexOf("case 'POST /mcp': {")));

test('B1 not JSON: -32700, id null, HTTP 400', () => {
  assert.match(mcp, /if \(e instanceof OAuthError && e\.status === 400\) return send\(res, 400, \{ jsonrpc: '2\.0', id: null, error: \{ code: -32700, message: 'parse error: the body is not JSON' \} \}\);/);
});

test('B2 too large: -32600, id null, HTTP 413', () => {
  assert.match(mcp, /if \(e instanceof OAuthError && e\.status === 413\) return send\(res, 413, \{ jsonrpc: '2\.0', id: null, error: \{ code: -32600, message: 'the request body is too large' \} \}\);/);
});

test('B3 the order: token, protocol version, body, then handle', () => {
  const at = k => mcp.indexOf(k);
  const order = ['auth.principal(req.headers.authorization)', "req.headers['mcp-protocol-version']", 'msg = await body(req)', 'await mcp.handle(msg, principal)'].map(at);
  assert.ok(order.every(i => i > 0) && order.every((i, n) => n === 0 || i > order[n - 1]), JSON.stringify(order));
  assert.doesNotMatch(mcp, /const msg = await body\(req\);/, 'no unguarded read');
});

test('B4 body() unchanged for the OAuth routes; other errors still thrown', () => {
  assert.match(src, /throw new OAuthError\(413, 'invalid_request', 'body too large'\)/);
  assert.match(src, /throw new OAuthError\(400, 'invalid_request', 'body is not JSON'\)/);
  assert.match(mcp, /return send\(res, 400, \{ jsonrpc: '2\.0', id: null, error: \{ code: -32700, message: 'parse error: the body is not JSON' \} \}\);\n\s+throw e;\n\s+\}/);
});

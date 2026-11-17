// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// server.handle: a request id that is present and is neither a string nor an integer (MCP 2025-06-18 basic/Requests)
// is refused before dispatch, -32600 with id null; strings, integers (0 and negatives included) and an absent id
// (a notification) are unchanged. KEY-FREE: reads src/server.mjs as TEXT (importing it would load game.mjs and the
// web frontier); the one predicate line is evaluated on its own with `new Function` (no import, no I/O).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const handle = server.slice(server.indexOf('async function handle(msg, principal)'), server.indexOf('\n  return { handle,'));
const line = /const badId = (.+);\n/.exec(handle)?.[1];
const badId = new Function('msg', `return ${line};`); // the source's own predicate, nothing else

test('R1 the predicate: refused ids', () => {
  assert.ok(line, 'the predicate line is found');
  for (const id of [null, true, false, 1.5, -0.25, [], [1], {}, { a: 1 }]) assert.equal(badId({ jsonrpc: '2.0', id, method: 'ping' }), true, JSON.stringify(id));
});

test('R2 the predicate: kept ids, an absent id, and non-object messages', () => {
  for (const id of ['', 'a', '1', 0, 1, -1, 2 ** 53 + 2, 1e21]) assert.equal(badId({ jsonrpc: '2.0', id, method: 'ping' }), false, String(id));
  assert.equal(badId({ jsonrpc: '2.0', method: 'notifications/initialized' }), false, 'no id: a notification');
  for (const m of [null, 1, 'x', true]) assert.equal(badId(m), false, `${m}: left to the envelope check`);
});

test('R3 order and answer: refused before the envelope check, notification and dispatch; id null, never echoed', () => {
  const at = s => { const i = handle.indexOf(s); assert.ok(i >= 0, s); return i; };
  const refuse = at("if (badId) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: id must be a string or an integer' } };");
  assert.ok(refuse < at('return invalid();'));
  assert.ok(refuse < at('const notification = msg.id === undefined;'));
  assert.ok(refuse < at('switch (msg.method) {'));
});

test('R4 unchanged: the envelope answer, reply/error and the dispatcher pin', () => {
  assert.match(handle, /const invalid = \(\) => \(\{ jsonrpc: '2\.0', id: msg\?\.id \?\? null, error: \{ code: -32600, message: 'invalid request' \} \}\);/);
  assert.match(handle, /const reply = result => \(notification \? null : \{ jsonrpc: '2\.0', id: msg\.id, result \}\);/);
  assert.match(handle, /const fn = toolNamed\(tools, name\);\n\s+if \(!fn\) return error\(-32602, unknownToolText\(name\)\);/);
});

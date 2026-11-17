// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with its
// own approval, through the repository's key-free guard.
//
// listen() (src/listen.mjs, re-exported by src/http.mjs) settles on start-up either way, with no port bound here: the
// server is a server-shaped EventEmitter handed in through `createServer`.
//   L1 listening → resolves with that server; both one-shot listeners removed
//   L2 a start-up 'error' (EADDRINUSE) → rejects with the same error object; both removed; no resolve
//   L3 server.listen throwing synchronously (a bad port) → rejects with that error; both removed
//   L4 after a successful start, a later 'error' is not swallowed by listen (no listener of its own is left)
//   L5 port and host are passed through as given (no other port, no retry); the handler goes to createServer
//   L6 src/http.mjs re-exports listen from listen.mjs and no longer builds its own promise
// KEY-FREE: imports node:test, node:assert/strict, node:events, node:fs and ../src/listen.mjs (which imports node:http
// only and binds nothing unless createServer binds). Nothing is bound, sent or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { listen } from '../src/listen.mjs';

/** A server-shaped object: `mode` says what listen(port, host) does. */
function fake(mode, err = null) {
  const s = new EventEmitter();
  s.calls = [];
  s.listen = (port, host) => {
    s.calls.push([port, host]);
    if (mode === 'throw') throw err;
    queueMicrotask(() => (mode === 'ok' ? s.emit('listening') : s.emit('error', err)));
    return s;
  };
  return s;
}
const counts = s => [s.listenerCount('error'), s.listenerCount('listening')];

test('L1 listening resolves with the server', async () => {
  const s = fake('ok');
  assert.equal(await listen(() => {}, { createServer: () => s }), s);
  assert.deepEqual(counts(s), [0, 0]);
});

test('L2 a start-up error rejects with that error', async () => {
  const e = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:41960'), { code: 'EADDRINUSE' });
  const s = fake('error', e);
  await assert.rejects(listen(() => {}, { port: 41960, createServer: () => s }), x => x === e);
  assert.deepEqual(counts(s), [0, 0]);
});

test('L3 a synchronous throw rejects too', async () => {
  const e = Object.assign(new RangeError('options.port should be >= 0 and < 65536'), { code: 'ERR_SOCKET_BAD_PORT' });
  const s = fake('throw', e);
  await assert.rejects(listen(() => {}, { port: 70000, createServer: () => s }), x => x === e);
  assert.deepEqual(counts(s), [0, 0]);
});

test('L4 a later error is not swallowed', async () => {
  const s = fake('ok');
  await listen(() => {}, { createServer: () => s });
  assert.throws(() => s.emit('error', new Error('later')), /later/, 'no listener of listen() is left to catch it');
});

test('L5 port, host and handler as given', async () => {
  const s = fake('ok');
  const h = () => {};
  let got = null;
  await listen(h, { port: 41960, host: '127.0.0.1', createServer: x => { got = x; return s; } });
  assert.equal(got, h);
  assert.deepEqual(s.calls, [[41960, '127.0.0.1']]);
  const d = fake('ok');
  await listen(h, { createServer: () => d });
  assert.deepEqual(d.calls, [[0, '127.0.0.1']], 'the defaults as before');
});

test('L6 http.mjs re-exports it', () => {
  const src = readFileSync(new URL('../src/http.mjs', import.meta.url), 'utf8');
  assert.match(src, /export \{ listen \} from '\.\/listen\.mjs';/);
  assert.doesNotMatch(src, /new Promise\(resolve => \{\n\s+const s = http\.createServer/);
  assert.doesNotMatch(src, /^import http from 'node:http';$/m);
});

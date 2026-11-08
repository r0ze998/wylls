// Key-free tests of the host bridge with a FAKE spawn: no child process is started, nothing is read from the real host path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createChildBridge, resolveHostBinary, BridgeError, EXPECTED_HOST_PATH, HOST_ENV, REPO_ROOT, STDERR_TAIL_BYTES, STDERR_TOTAL_LIMIT,
} from '../screens/wide-march-local/host-bridge.mjs';
import { HOST_REL_PATH, MAX_REPLY_BYTES } from '../screens/wide-march-local/local-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tick = () => new Promise(r => setImmediate(r));
const code = c => e => e instanceof BridgeError && e.code === c;

function fakeSpawn({ stdinError = false } = {}) {
  const calls = [];
  const spawnFn = (file, args, opts) => {
    const child = new EventEmitter();
    child.written = [];
    child.killed = [];
    child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(chunk.toString('latin1')); cb(stdinError ? new Error('EPIPE') : undefined); } });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = sig => { child.killed.push(sig); return true; };
    calls.push({ file, args, opts, child });
    return child;
  };
  return { spawnFn, calls };
}
const FILE = '/fixed/host/local_march_demo';
const make = async (opts = {}, spawnOpts) => {
  const f = fakeSpawn(spawnOpts);
  const bridge = await createChildBridge({ spawnFn: f.spawnFn, resolveBinary: async () => FILE, ...opts });
  return { bridge, child: f.calls[0].child, calls: f.calls };
};
const reply = (child, text) => child.stdout.write(Buffer.from(text, 'latin1'));

test('resolveHostBinary: the exact fixed regular executable file, no symlink anywhere', async () => {
  assert.deepEqual([...HOST_REL_PATH], ['.local', 'wide-march-demo', 'target', 'debug', 'examples', 'local_march_demo']);
  assert.equal(EXPECTED_HOST_PATH, join(REPO_ROOT, ...HOST_REL_PATH));
  const root = '/repo';
  const expected = join(root, ...HOST_REL_PATH);
  const file = { isFile: () => true, mode: 0o755 };
  const base = { repoRoot: root, realpathFn: async p => p, statFn: async () => file };
  assert.equal(await resolveHostBinary(base), expected);
  // the repo root itself may be a link; the binary path below its realpath may not
  assert.equal(await resolveHostBinary({ ...base, realpathFn: async p => (p === root ? '/real/repo' : p) }), join('/real/repo', ...HOST_REL_PATH));
  await assert.rejects(resolveHostBinary({ ...base, realpathFn: async p => (p === expected ? '/elsewhere/evil' : p) }), code('HostPathMismatch'));
  await assert.rejects(resolveHostBinary({ ...base, realpathFn: async p => (p === expected ? join(root, 'other') : p) }), code('HostPathMismatch'));
  await assert.rejects(resolveHostBinary({ ...base, realpathFn: async p => { if (p === expected) throw new Error('ENOENT'); return p; } }), code('HostMissing'));
  await assert.rejects(resolveHostBinary({ ...base, statFn: async () => { throw new Error('ENOENT'); } }), code('HostMissing'));
  await assert.rejects(resolveHostBinary({ ...base, statFn: async () => ({ isFile: () => false, mode: 0o755 }) }), code('HostNotRegular'));
  await assert.rejects(resolveHostBinary({ ...base, statFn: async () => ({ isFile: () => true, mode: 0o644 }) }), code('HostNotExecutable'));
});

test('spawn: once, no shell, no arguments, closed environment, own directory; nothing inherited', async () => {
  process.env.WYLLS_TEST_SECRET_KEY = 'must-not-leak';
  process.env.FIXTURE_EXPORT_DIR = '/must/not/leak';
  try {
    const { calls } = await make();
    assert.equal(calls.length, 1);
    const { file, args, opts } = calls[0];
    assert.equal(file, FILE);
    assert.deepEqual(args, []);
    assert.equal(opts.shell, false);
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.deepEqual(opts.env, { ...HOST_ENV });
    assert.deepEqual(Object.keys(opts.env).sort(), ['LANG', 'LC_ALL', 'RUST_BACKTRACE']);
    assert.ok(!('WYLLS_TEST_SECRET_KEY' in opts.env) && !('FIXTURE_EXPORT_DIR' in opts.env) && !('PATH' in opts.env));
    assert.equal(opts.cwd, '/fixed/host');
    assert.equal(opts.detached, false);
    assert.ok(Object.isFrozen(HOST_ENV));
  } finally { delete process.env.WYLLS_TEST_SECRET_KEY; delete process.env.FIXTURE_EXPORT_DIR; }
});

test('a host that cannot be resolved is never spawned', async () => {
  const f = fakeSpawn();
  await assert.rejects(createChildBridge({ spawnFn: f.spawnFn, resolveBinary: async () => { throw new BridgeError('HostMissing'); } }), code('HostMissing'));
  assert.equal(f.calls.length, 0);
});

test('exchange: one command line out, one reply line back', async () => {
  const { bridge, child } = await make();
  assert.equal(bridge.alive, true);
  const p = bridge.exchange('act 0 harvest');
  await tick();
  assert.deepEqual(child.written, ['act 0 harvest\n']);
  reply(child, '{"ok":true}\n');
  assert.equal(await p, '{"ok":true}');
  // a reply split across chunks
  const q = bridge.exchange('get');
  await tick();
  reply(child, '{"a"'); await tick(); reply(child, ':1}\n');
  assert.equal(await q, '{"a":1}');
  assert.equal(bridge.alive, true);
});

test('exchange: command shape is checked before anything is written, and does not kill the host', async () => {
  const { bridge, child } = await make();
  for (const bad of ['', 'get\n', 'a\rb', 'é', 'x'.repeat(129), 5, null, undefined, ['get']]) {
    await assert.rejects(bridge.exchange(bad), code('BadCommand'), String(bad).slice(0, 20));
  }
  assert.deepEqual(child.written, []);
  assert.equal(bridge.alive, true);
  const p = bridge.exchange('x'.repeat(128)); // exactly at the bound
  await tick(); assert.equal(child.written.length, 1);
  reply(child, 'r\n');
  assert.equal(await p, 'r');
});

test('only one command in flight; a second is refused, not queued', async () => {
  const { bridge, child } = await make();
  const p = bridge.exchange('get');
  await assert.rejects(bridge.exchange('get'), code('Busy'));
  await tick();
  assert.deepEqual(child.written, ['get\n']);
  reply(child, 'ok\n');
  assert.equal(await p, 'ok');
  assert.equal(bridge.alive, true);
});

test('reply of exactly 1 MiB passes; one byte more is Oversize and kills the host for good', async () => {
  let t = await make();
  let p = t.bridge.exchange('get');
  reply(t.child, `${'a'.repeat(MAX_REPLY_BYTES)}\n`);
  assert.equal((await p).length, MAX_REPLY_BYTES);

  t = await make();
  p = t.bridge.exchange('get');
  const rejected = assert.rejects(p, code('Oversize'));
  reply(t.child, `${'a'.repeat(MAX_REPLY_BYTES + 1)}\n`);
  await rejected;
  assert.equal(t.bridge.alive, false);
  assert.equal(t.bridge.deadReason, 'Oversize');
  assert.deepEqual(t.child.killed, ['SIGKILL']);

  // no newline at all: also bounded
  t = await make();
  p = t.bridge.exchange('get');
  const r2 = assert.rejects(p, code('Oversize'));
  reply(t.child, 'b'.repeat(MAX_REPLY_BYTES + 5));
  await r2;
});

test('malformed output kills the host: non-ASCII, CR, empty line, two lines, unsolicited output', async () => {
  const cases = [
    ['Malformed', Buffer.from([0x7b, 0xc3, 0xa9, 0x7d, 0x0a])],
    ['Malformed', Buffer.from('{}\r\n')],
    ['Malformed', Buffer.from('\n')],
    ['Malformed', Buffer.from([0x7b, 0x00, 0x7d, 0x0a])],
    ['Protocol', Buffer.from('{}\n{}\n')],
    ['Protocol', Buffer.from('{}\nextra')],
  ];
  for (const [want, bytes] of cases) {
    const { bridge, child } = await make();
    const p = bridge.exchange('get');
    const rej = assert.rejects(p, code(want), JSON.stringify(bytes.toString('latin1')));
    child.stdout.write(bytes);
    await rej;
    assert.equal(bridge.alive, false);
    await assert.rejects(bridge.exchange('get'), code('Closed'));
  }
  const { bridge, child } = await make();
  child.stdout.write('hello\n'); // nothing in flight
  await tick();
  assert.equal(bridge.alive, false);
  assert.equal(bridge.deadReason, 'Unsolicited');
  await assert.rejects(bridge.exchange('get'), code('Closed'));
});

test('timeout, exit, spawn error and stdin failure: the host is dead; there is no retry and no second spawn', async () => {
  // timeout
  let t = await make({ timeoutMs: 15 });
  await assert.rejects(t.bridge.exchange('get'), code('Timeout'));
  assert.equal(t.bridge.alive, false);
  assert.deepEqual(t.child.killed, ['SIGKILL']);
  await assert.rejects(t.bridge.exchange('get'), code('Closed'));
  assert.equal(t.calls.length, 1, 'never respawned');
  assert.deepEqual(t.child.written, ['get\n'], 'the command was not re-sent');

  // exit while a command is in flight
  t = await make();
  let p = t.bridge.exchange('get');
  const rej = assert.rejects(p, code('Exit'));
  t.child.emit('exit', 1, null);
  await rej;
  await assert.rejects(t.bridge.exchange('get'), code('Closed'));
  assert.equal(t.calls.length, 1);

  // exit while idle: the next command is refused
  t = await make();
  t.child.emit('close', 0);
  assert.equal(t.bridge.alive, false);
  await assert.rejects(t.bridge.exchange('get'), code('Closed'));

  // spawn error
  t = await make();
  p = t.bridge.exchange('get');
  const rej2 = assert.rejects(p, code('SpawnError'));
  t.child.emit('error', new Error('ENOENT'));
  await rej2;

  // stdin failure
  t = await make({}, { stdinError: true });
  await assert.rejects(t.bridge.exchange('get'), code('Exit'));
  assert.equal(t.bridge.alive, false);
});

test('close() kills once and ends everything', async () => {
  const { bridge, child } = await make();
  const p = bridge.exchange('get');
  const rej = assert.rejects(p, code('Closed'));
  bridge.close();
  await rej;
  assert.deepEqual(child.killed, ['SIGKILL']);
  assert.equal(bridge.alive, false);
  bridge.close(); // idempotent
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('stderr is drained into a bounded tail, never forwarded, and a flood kills the host', async () => {
  const { bridge, child } = await make();
  child.stderr.write('a'.repeat(STDERR_TAIL_BYTES * 2));
  child.stderr.write('TAIL');
  await tick();
  assert.equal(bridge.stderrTail.length, STDERR_TAIL_BYTES);
  assert.ok(bridge.stderrTail.endsWith('TAIL'));
  assert.equal(bridge.alive, true);
  const p = bridge.exchange('get');
  const rej = assert.rejects(p, code('StderrFlood'));
  for (let sent = 0; sent <= STDERR_TOTAL_LIMIT; sent += 65536) child.stderr.write(Buffer.alloc(65536, 0x78));
  await rej;
  assert.equal(bridge.alive, false);
  assert.ok(bridge.stderrTail.length <= STDERR_TAIL_BYTES);
});

test('bridge source: fixed spawn only, no shell, no inherited environment, no client-controlled options', async () => {
  const src = (await readFile(join(HERE, '..', 'screens', 'wide-march-local', 'host-bridge.mjs'), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal((src.match(/\bspawnFn\(/g) ?? []).length, 1, 'one spawn site');
  assert.ok(src.includes('spawnFn(file, [],'), 'no arguments');
  assert.ok(src.includes('shell: false'));
  assert.ok(!/shell:\s*true/.test(src));
  for (const bad of ['process.env', 'execFile', 'exec(', 'execSync', 'spawnSync', 'fork(', 'fetch(', 'node:net', 'node:http', 'writeFile', 'setTimeout(() => spawn', 'respawn', 'restart']) {
    assert.ok(!src.includes(bad), `host-bridge.mjs mentions ${bad}`);
  }
  // test hooks are explicit dependency names, not path/argv/env options
  assert.ok(!/deps\.(path|file|args|argv|env|cwd|shell|command)\b/.test(src));
});

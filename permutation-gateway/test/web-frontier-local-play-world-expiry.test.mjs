// The local-play launcher's world-expiry contract (`--world-ttl-minutes`, `expiry`) and the page's pure reading of it
// (`flocalplay-expiry.mjs`). PURE / stand-in only: no runner, no world, no herald; the HTTP case uses a fake launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORLD_TTL_MS, WORLD_EXPIRY_SCHEMA, parseWorldTtl, worldExpiry, expiryOf, parseConfig, WorldManager, createLauncherServer,
} from '../src/frontier/local-play-launcher.mjs';
import { expiryView, expiryStable, WORLD_EXPIRY_SCHEMA as PAGE_SCHEMA } from '../../permutation-server/web/frontier/flocalplay-expiry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WALLET = '11111111111111111111111111111112';
const OTHER = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const INSTANCE = 'ab'.repeat(32);
const code = fn => { try { fn(); return null; } catch (e) { return e.code; } };

test('the CLI life is whole decimal minutes only; absent keeps two hours; nothing is rounded or clamped', () => {
  assert.equal(parseWorldTtl(undefined), WORLD_TTL_MS);
  assert.equal(WORLD_TTL_MS, 7_200_000, 'the default is unchanged');
  assert.equal(parseWorldTtl('120'), 7_200_000);
  assert.equal(parseWorldTtl('1'), 60_000);
  assert.equal(parseWorldTtl('900'), 54_000_000, 'longer than 14 hours is a valid operator choice (no fixed cap)');
  for (const bad of ['0', '-5', '1.5', 'NaN', 'Infinity', '', '+5', '05', '1e3', ' 5', '5 ', '0x10', 'abc', '9'.repeat(30), '153722867280913']) {
    assert.equal(code(() => parseWorldTtl(bad)), 'InvalidWorldTtl', `refused: ${JSON.stringify(bad)}`);
  }
  for (const bad of [5, null, {}, ['5']]) assert.equal(code(() => parseWorldTtl(bad)), 'InvalidWorldTtl', 'only the command line string');
});

test('a world\'s end is fixed once at its TTL origin and must be a safe integer within a Date', () => {
  assert.equal(worldExpiry(1_000, 7_200_000), 7_201_000);
  for (const [s, t] of [[-1, 1], [1.5, 1], [NaN, 1], [Infinity, 1], [1, 0], [1, -1], [1, 1.5], [8.64e15, 1], [Number.MAX_SAFE_INTEGER, 1]]) {
    assert.equal(code(() => worldExpiry(s, t)), 'WorldExpiryUnrepresentable', `refused: ${s} + ${t}`);
  }
  const e = expiryOf(1_000, 60_000, INSTANCE);
  assert.ok(Object.isFrozen(e));
  assert.deepEqual({ ...e }, { schema: WORLD_EXPIRY_SCHEMA, startedAt: 1_000, ttlMs: 60_000, expiresAt: 61_000, instance: INSTANCE });
  assert.equal(expiryOf(1_000, 60_000, undefined).instance, null, 'no instance stated: null, never made up');
  assert.equal(PAGE_SCHEMA, WORLD_EXPIRY_SCHEMA, 'the page reads the launcher\'s schema');
});

async function fakeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-expiry-'));
  await fs.mkdir(path.join(root, 'permutation-server/web'), { recursive: true });
  await fs.mkdir(path.join(root, 'permutation-gateway/src/frontier'), { recursive: true });
  await fs.writeFile(path.join(root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), '');
  for (const f of ['runner', 'herald', 'depart', 'preview', 'resident', 'a.so']) await fs.writeFile(path.join(root, f), '');
  const args = ['--root', root, '--data', path.join(root, 'data'), '--runner', path.join(root, 'runner'), '--herald', path.join(root, 'herald'),
    '--depart', path.join(root, 'depart'), '--preview', path.join(root, 'preview'), '--resident', path.join(root, 'resident'),
    '--artifact', path.join(root, 'a.so'), '--artifact-sha', 'c'.repeat(64)];
  return { root, args };
}

test('parseConfig: the flag is optional, parsed once, and duplicates or malformed values refuse the start', async () => {
  const { root, args } = await fakeRoot();
  try {
    assert.equal((await parseConfig(args)).worldTtlMs, WORLD_TTL_MS, 'absent: two hours');
    assert.equal((await parseConfig([...args, '--world-ttl-minutes', '840'])).worldTtlMs, 50_400_000, '14 hours');
    await assert.rejects(parseConfig([...args, '--world-ttl-minutes', '60', '--world-ttl-minutes', '90']), e => e.code === 'InvalidArguments', 'duplicate');
    await assert.rejects(parseConfig([...args, '--world-ttl-minutes', '0']), e => e.code === 'InvalidWorldTtl');
    await assert.rejects(parseConfig([...args, '--world-ttl-minutes', '1.5']), e => e.code === 'InvalidWorldTtl');
    await assert.rejects(parseConfig([...args, '--world-ttl-minutes']), e => e.code === 'InvalidArguments', 'empty');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

function fakeLaunch(calls) {
  return async (config, wallet) => {
    calls.push(wallet);
    const started = 1_000_000 + calls.length;
    return { herald: 'http://localhost:41926', stop: async () => {}, expiry: expiryOf(started, config.worldTtlMs, INSTANCE) };
  };
}

test('the manager keeps the world\'s end as it came: a second start, a list or a later read never extends it', async () => {
  const calls = [];
  const m = new WorldManager({ worldTtlMs: 600_000 }, fakeLaunch(calls));
  const a = await m.start(WALLET);
  assert.equal(a.expiry.expiresAt, a.expiry.startedAt + 600_000);
  const again = await m.start(WALLET);
  assert.equal(calls.length, 1, 'the same address: the same world, not launched again');
  assert.deepEqual(again.expiry, a.expiry, 'a second start answers the same end');
  const listed = m.list().find(w => w.wallet === WALLET);
  assert.deepEqual(listed.expiry, a.expiry, 'the list answers the same end');
  await new Promise(r => setTimeout(r, 15));
  assert.deepEqual(m.list().find(w => w.wallet === WALLET).expiry, a.expiry, 'time passing recomputes nothing');
  await m.close();
});

const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const post = (port, route, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
  });
  req.on('error', reject); req.end(data);
});

test('HTTP cannot choose or extend a world\'s life: only {wallet} / {} are taken, and the answers carry the fixed end', async () => {
  const calls = [], port = await freePort();
  const c = { port, worldPort: 41924, worldTtlMs: 900_000, web: here };
  const { server, manager } = createLauncherServer(c, new WorldManager(c, fakeLaunch(calls)));
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  try {
    for (const body of [{ wallet: WALLET, ttl: 999_999_999 }, { wallet: WALLET, worldTtlMinutes: 900 }, { wallet: WALLET, expiry: { expiresAt: 9e12 } }]) {
      const r = await post(port, '/local-play/start', body);
      assert.equal(r.status, 400, `refused: ${JSON.stringify(body)}`); assert.equal(r.body.error, 'InvalidWallet');
    }
    assert.equal(calls.length, 0, 'nothing launched by a refused body');
    const ok = await post(port, '/local-play/start', { wallet: WALLET });
    assert.equal(ok.status, 200); assert.equal(ok.body.expiry.ttlMs, 900_000, 'the operator\'s CLI value');
    const again = await post(port, '/local-play/start', { wallet: WALLET });
    assert.deepEqual(again.body.expiry, ok.body.expiry, 'a second start: the same end');
    const listed = await post(port, '/local-play/worlds', {});
    assert.deepEqual(listed.body.worlds.find(w => w.wallet === WALLET).expiry, ok.body.expiry, 'the list: the same end');
    const extra = await post(port, '/local-play/worlds', { extend: true });
    assert.equal(extra.status, 400, 'the list takes {} only');
  } finally { server.close(); server.closeAllConnections(); await manager.close(); }
});

test('the page shows a known end only for an exact statement of ITS world, and the real-clock remaining time only', () => {
  const good = { ...expiryOf(1_000, 3_600_000, INSTANCE) };
  const v = expiryView(good, INSTANCE, 1_000 + 600_000);
  assert.deepEqual({ ...v }, { state: 'known', instance: INSTANCE, expiresAt: 3_601_000, remainingMs: 3_000_000, ttlMs: 3_600_000 });
  assert.equal(expiryView(good, INSTANCE, 9e12).remainingMs, 0, 'past its end: 0, never negative');
  const unknown = (p, inst = INSTANCE, now = 5_000) => expiryView(p, inst, now);
  for (const [p, why] of [[null, 'absent'], [undefined, 'absent'], [[], 'malformed'], ['x', 'malformed'],
    [{ ...good, extra: 1 }, 'malformed'], [(({ ttlMs, ...r }) => r)(good), 'malformed'], [{ ...good, schema: 'v0' }, 'schema'],
    [{ ...good, ttlMs: 1.5 }, 'malformed'], [{ ...good, startedAt: -1 }, 'malformed'], [{ ...good, ttlMs: 0 }, 'malformed'],
    [{ ...good, expiresAt: Number.MAX_SAFE_INTEGER }, 'malformed'], [{ ...good, expiresAt: good.expiresAt + 1 }, 'inconsistent'],
    [{ ...good, instance: null }, 'no-instance'], [{ ...good, instance: '0'.repeat(64) }, 'no-instance'], [{ ...good, instance: 'AB'.repeat(32) }, 'no-instance']]) {
    const r = unknown(p);
    assert.equal(r.state, 'unknown', JSON.stringify(p)); assert.equal(r.why, why, JSON.stringify(p));
    assert.ok(!('remainingMs' in r) && !('expiresAt' in r), 'unknown carries no time at all (no default two hours)');
  }
  assert.equal(unknown(good, 'cd'.repeat(32)).why, 'other-instance', 'another world\'s statement');
  assert.equal(unknown(good, null).why, 'other-instance', 'this page\'s instance not known');
  assert.equal(unknown(good, INSTANCE, NaN).why, 'clock');
  // a reconnect or refreshed list: the same end only; a moved end is not believed
  const shown = expiryView(good, INSTANCE, 5_000);
  assert.equal(expiryStable(shown, expiryView({ ...good }, INSTANCE, 9_000)), true);
  assert.equal(expiryStable(shown, expiryView({ ...good, ttlMs: good.ttlMs + 60_000, expiresAt: good.expiresAt + 60_000 }, INSTANCE, 9_000)), false, 'an end that moved');
  assert.equal(expiryStable(shown, expiryView(null, INSTANCE, 9_000)), false);
  // another world with the SAME start millisecond and the SAME life (so the same end): still not the same world
  const OTHER_INSTANCE = 'cd'.repeat(32);
  const twin = expiryView({ ...good, instance: OTHER_INSTANCE }, OTHER_INSTANCE, 9_000);
  assert.equal(twin.state, 'known'); assert.equal(twin.expiresAt, shown.expiresAt); assert.equal(twin.ttlMs, shown.ttlMs);
  assert.equal(expiryStable(shown, twin), false, 'another instance with an identical end is not stable');
  assert.equal(expiryStable(twin, shown), false);
  assert.equal(expiryStable(null, shown), false);
});

test('the page module reads only its arguments: no import, no request, no timer, no text', () => {
  const src = readFileSync(path.join(here, '../../permutation-server/web/frontier/flocalplay-expiry.mjs'), 'utf8');
  for (const word of ['import ', 'fetch(', 'setInterval', 'setTimeout', 'XMLHttpRequest', 'L`', '/local-play/']) assert.ok(!src.includes(word), `no ${word}`);
});

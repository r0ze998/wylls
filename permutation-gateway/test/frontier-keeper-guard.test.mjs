// fix-gw-highs (security audit H-1, H-2, M-2): the gateway's guard in front
// of keeper A's anonymous routes — a global bucket per route over every
// client address, the same body answered from the last answer, refusal
// counters, herald-forwarded loopback clients limited when the relay runs
// behind a public proxy, and the config refusing a live cluster without
// saying what is in front of the herald. No network except a 127.0.0.1:0
// stand-in keeper; no key (an address only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { encode as base58 } from '../client/src/base58.mjs';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { pack, revealMaterial } from '../client/src/frontier/seal.mjs';
import { createFrontierApps, clientOf } from '../src/frontier/app.mjs';
import { checkFrontierConfig, loadFrontierConfig } from '../src/frontier/config.mjs';
import { KeeperLink } from '../src/frontier/keeperlink.mjs';
import { KeeperGuard } from '../src/frontier/keeper-guard.mjs';
import { RateLimiter } from '../src/guards.mjs';
import { call } from './gateway-fixtures.mjs';

const PROGRAM = base58(new Uint8Array(32).fill(0x51)); // an address only
const A = new FrontierAddresses({ programId: PROGRAM, seasonId: 5n });
const OPERATOR = 'op-token';

/** A stand-in keeper that counts what it is asked; `answer(url, body)` → [status, json]. */
async function standInKeeper(answer = url => (url === '/v1/reveal' ? [202, { accepted: true, track: 'r1' }] : [200, { queued: true, blocking: [] }])) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b);
      seen.push({ url: req.url, body });
      const [status, json] = answer(req.url, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { seen, link: new KeeperLink({ url: `http://127.0.0.1:${srv.address().port}`, token: 'kpr' }), close: () => new Promise(r => srv.close(r)) };
}

function relay({ keeper, cfg = {}, now = Date.now, log = () => {}, limits = null }) {
  const pool = {}; // (the keeper routes never touch the relay pool)
  const config = { cluster: 'localnet', programId: PROGRAM, seasonId: '5', heraldPeer: '127.0.0.1', heraldUrl: 'http://127.0.0.1:41040', minPoolSol: 1, operatorToken: OPERATOR, ...cfg };
  const apps = createFrontierApps({ cfg: config, connection: {}, pool, keeper, store: { state: {}, save() {} }, log, now });
  if (limits) apps.ctx.keeperGuard.limits = limits; // (small buckets: the test counts what passes)
  return apps;
}

const material = (i, salt = 2) => revealMaterial({
  holding: A.holding(-3, 7, i % 200), transitSlot: 1,
  plain: pack({ hostId: BigInt(i + 1), arriveBell: 147, destP: 0, destQ: 0, destTile: 0, stance: 0, retreatBps: 0, pathLen: 0, path: new Uint8Array(12) }),
  salt: new Uint8Array(32).fill(salt), seal: new Uint8Array(165).fill(3),
});
const fromHerald = ip => ({ ip: '127.0.0.1', headers: { 'x-forwarded-for': ip } });

test('H-1: forged reveals from many addresses share one global bucket (here shrunk to 30 / 2 per s); the rest never reach the keeper (503 KeeperUnavailable, reason KeeperBusy)', async () => {
  const k = await standInKeeper();
  let t = 1_000_000;
  try {
    const r = relay({ keeper: k.link, now: () => t, limits: { 'POST /f/reveal': { burst: 30, perSecond: 2 }, 'POST /f/nudge': { burst: 60, perSecond: 4 } } });
    const answers = [];
    for (let i = 0; i < 80; i++) {
      // a fresh holding and a fresh address each time: the per-holding and per-address buckets never fill
      const a = await call(r.public, 'POST', '/f/reveal', { body: material(i), ...fromHerald(`198.51.${i >> 8}.${i & 255}`) });
      answers.push(a);
    }
    assert.equal(k.seen.length, 30, 'the global burst');
    const busy = answers.filter(a => a.status === 503);
    assert.equal(busy.length, 50);
    assert.deepEqual(busy[0].json, { error: 'the keeper is busy; ask again later', code: 'KeeperUnavailable', reason: 'KeeperBusy' });
    t += 5_000; // 2/s: ten more
    for (let i = 100; i < 120; i++) await call(r.public, 'POST', '/f/reveal', { body: material(i), ...fromHerald(`203.0.113.${i}`) });
    assert.equal(k.seen.length, 40);
    const op = await call(r.operator, 'GET', '/f/operator/keeper-guard', { headers: { authorization: `Bearer ${OPERATOR}` } });
    assert.equal(op.json.events.reveal_busy_global, 60);
    assert.equal(op.json.events.reveal_forwarded_ok, 40);
    const KG = (await import('../src/frontier/keeper-guard.mjs')).KEEPER_GLOBAL_LIMITS;
    assert.ok(KG['POST /f/reveal'].perSecond >= 100, 'the shipped bucket caps raw volume only (keeper A filters forgeries)');
    assert.equal((await call(r.public, 'GET', '/f/operator/keeper-guard', { ...fromHerald('198.51.100.1') })).status, 404, 'operator listener only');
  } finally { await k.close(); }
});

test('the same body again is answered from the last answer (in flight too); a 5xx is never kept', async () => {
  let down = false;
  const k = await standInKeeper(url => (down ? [503, { code: 'KeeperBusy' }] : url === '/v1/reveal' ? [202, { accepted: true, track: 'r7' }] : [200, { queued: true, blocking: [] }]));
  let t = 1_000_000;
  try {
    const r = relay({ keeper: k.link, now: () => t });
    const same = await Promise.all(Array.from({ length: 8 }, (_, i) => call(r.public, 'POST', '/f/reveal', { body: material(1), ...fromHerald(`198.51.100.${i + 1}`) })));
    assert.ok(same.every(a => a.status === 202 && a.json.track === 'r7'));
    assert.equal(k.seen.length, 1, 'eight identical posts, one keeper call');
    for (let i = 0; i < 5; i++) await call(r.public, 'POST', '/f/nudge', { body: { province: [2, -1], bell: 40 }, ...fromHerald(`198.51.100.${i + 20}`) });
    assert.equal(k.seen.length, 2);
    t += 11_000; // the nudge window (10 s) is over, the reveal's (30 s) is not
    await call(r.public, 'POST', '/f/nudge', { body: { province: [2, -1], bell: 40 }, ...fromHerald('198.51.100.40') });
    await call(r.public, 'POST', '/f/reveal', { body: material(1), ...fromHerald('198.51.100.41') });
    assert.equal(k.seen.length, 3);
    down = true;
    for (let i = 0; i < 3; i++) {
      const a = await call(r.public, 'POST', '/f/reveal', { body: material(9), ...fromHerald(`198.51.100.${i + 50}`) });
      assert.equal(a.status, 502);
      assert.equal(a.json.code, 'KeeperUnavailable');
      assert.equal(a.json.reason, 'KeeperBusy', "the keeper's own code rides along");
    }
    assert.equal(k.seen.length, 6, 'a keeper 5xx is asked again');
  } finally { await k.close(); }
});

test('H-2: nudge shapes stay strict at the gateway (u32 bell, i16 province); the keeper judges the bell window', async () => {
  const k = await standInKeeper();
  try {
    const r = relay({ keeper: k.link });
    for (const body of [{ province: [2, -1], bell: 2 ** 32 }, { province: [2, -1], bell: -1 }, { province: [40_000, 0], bell: 1 }, { province: [2], bell: 1 }, { province: [2, -1], bell: 1.5 }]) {
      assert.equal((await call(r.public, 'POST', '/f/nudge', { body, ...fromHerald('198.51.100.9') })).status, 400, JSON.stringify(body));
    }
    assert.equal(k.seen.length, 0);
    const op = await call(r.operator, 'GET', '/f/operator/keeper-guard', { headers: { authorization: `Bearer ${OPERATOR}` } });
    assert.equal(op.json.events.nudge_refused_shape, 5);
  } finally { await k.close(); }
});

test('M-2: behind a public proxy a herald-forwarded loopback client is limited (one shared bucket, counted); a direct loopback bot stays exempt', async () => {
  const k = await standInKeeper();
  const lines = [];
  try {
    const nudge = (r, i, who) => call(r.public, 'POST', '/f/nudge', { body: { province: [2, -1], bell: i }, ...who });
    // localnet, no proxy said: local play's browser comes through the herald as 127.0.0.1 and is exempt (unchanged)
    const local = relay({ keeper: k.link });
    const lc = [];
    for (let i = 0; i < 20; i++) lc.push((await nudge(local, i, fromHerald('127.0.0.1'))).status);
    assert.ok(lc.every(s => s === 200), JSON.stringify(lc));
    // --public-proxy xff: the proxy sent no X-Forwarded-For, so the herald forwarded its own loopback address
    const strict = relay({ keeper: k.link, cfg: { publicProxy: 'xff' }, log: l => lines.push(l) });
    const sc = [];
    for (let i = 0; i < 20; i++) sc.push((await nudge(strict, 100 + i, fromHerald('127.0.0.1'))).json.code ?? 'ok');
    assert.equal(sc.filter(c => c === 'RateLimited').length, 10, `burst 10 for all of them together: ${sc}`);
    assert.ok(lines.some(l => /unattributed_client=/.test(l)), lines.join('\n'));
    // a bot on the public listener itself (no herald header): exempt
    const bots = [];
    for (let i = 0; i < 20; i++) bots.push((await nudge(strict, 200 + i, { ip: '127.0.0.1' })).status);
    assert.ok(bots.every(s => s === 200));
    // a devnet relay without --dev is strict even if the flag were missing (config refuses that; belt and braces)
    assert.equal(clientOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1' } }, { heraldPeer: '127.0.0.1', cluster: 'devnet', dev: false }).exempt, false);
    assert.equal(clientOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.7' } }, { heraldPeer: '127.0.0.1', publicProxy: 'xff' }).ip, '198.51.100.7');
  } finally { await k.close(); }
});

test('M-2: a live cluster without --dev must say what is in front of the herald (--public-proxy xff|none)', () => {
  const base = { cluster: 'devnet', port: 41030, publicPort: 41033, publicHost: '127.0.0.1', heraldPeer: '127.0.0.1', poolSize: 150, programId: PROGRAM, seasonId: '1', minPoolSol: 1, dev: false, publicProxy: null };
  assert.ok(checkFrontierConfig(base).some(p => /--public-proxy is required on cluster devnet/.test(p)));
  assert.ok(!checkFrontierConfig({ ...base, publicProxy: 'xff' }).some(p => /public-proxy/.test(p)));
  assert.ok(!checkFrontierConfig({ ...base, publicProxy: 'none' }).some(p => /public-proxy/.test(p)));
  assert.ok(checkFrontierConfig({ ...base, publicProxy: 'nginx' }).some(p => /'xff'.*'none'/.test(p)));
  assert.ok(!checkFrontierConfig({ ...base, dev: true }).some(p => /public-proxy/.test(p)), '--dev (offline tests) may leave it out');
  assert.ok(!checkFrontierConfig({ ...base, cluster: 'localnet' }).some(p => /public-proxy/.test(p)));
  const flags = ['--program', PROGRAM, '--season', '1', '--port', '41632', '--public-port', '41633', '--dev', '--pool-size', '1'];
  assert.equal(loadFrontierConfig([...flags, '--public-proxy', 'xff']).publicProxy, 'xff');
  assert.equal(loadFrontierConfig(flags, { FRONTIER_PUBLIC_PROXY: 'none' }).publicProxy, 'none');
});

test('the guard logs at most one summary line per 10 s', async () => {
  let t = 0;
  const lines = [];
  const g = new KeeperGuard({ limiter: new RateLimiter({ now: () => t }), now: () => t, log: l => lines.push(l), limits: { 'POST /f/reveal': { burst: 1, perSecond: 0.001 } } });
  await g.run('POST /f/reveal', { a: 1 }, async () => ({ status: 202, body: {} }));
  for (let i = 0; i < 50; i++) await assert.rejects(g.run('POST /f/reveal', { a: i + 2 }, async () => ({ status: 202, body: {} })));
  assert.equal(lines.length, 1);
  t += 10_001;
  await assert.rejects(g.run('POST /f/reveal', { a: 999 }, async () => ({ status: 202, body: {} })));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /reveal_busy_global=50\b/, "the 49 held back and the new one");
});

test('verify-pr166: keeper A\'s new 503s (KeeperBusy, RevealNotIndexed) reach the page as 502 KeeperUnavailable (the marchbook asks again, not one of its two self attempts); real refusals keep their code', async () => {
  const { unreached } = await import('../../permutation-server/web/frontier/marchbook.mjs');
  let answer = [503, { error: 'busy', code: 'KeeperBusy', detail: 'spent' }];
  const k = await standInKeeper(url => (url === '/v1/reveal' ? answer : [200, { queued: true, blocking: [] }]));
  try {
    const r = relay({ keeper: k.link });
    const a = await call(r.public, 'POST', '/f/reveal', { body: material(1), ...fromHerald('198.51.100.1') });
    assert.deepEqual([a.status, a.json.code], [502, 'KeeperUnavailable']);
    assert.ok(unreached(a.json.code), 'not one of the page\'s two self attempts');
    answer = [503, { error: 'not indexed', code: 'RevealNotIndexed', detail: 'x' }];
    const b = await call(r.public, 'POST', '/f/reveal', { body: material(2), ...fromHerald('198.51.100.2') });
    assert.deepEqual([b.status, b.json.code], [502, 'KeeperUnavailable']);
    assert.ok(unreached(b.json.code));
    answer = [409, { error: 'mismatch', code: 'CommitMismatch', detail: 'x' }];
    const c = await call(r.public, 'POST', '/f/reveal', { body: material(3), ...fromHerald('198.51.100.3') });
    assert.deepEqual([c.status, c.json.code], [409, 'CommitMismatch']);
    assert.equal(unreached(c.json.code), false);
  } finally { await k.close(); }
});

test('verify-pr166: X-Forwarded-For spoofing behind --public-proxy xff — only the last hop (the herald\'s) counts; a client-written loopback is the shared bucket, never exempt', async () => {
  const k = await standInKeeper();
  try {
    const r = relay({ keeper: k.link, cfg: { publicProxy: 'xff', cluster: 'devnet' } });
    const nudge = (i, xff) => call(r.public, 'POST', '/f/nudge', { body: { province: [2, -1], bell: i }, ip: '127.0.0.1', headers: { 'x-forwarded-for': xff } });
    // a passthrough proxy that lets the client write the left entries: the right-most (the herald's) is the client
    const spoof = [];
    for (let i = 0; i < 14; i++) spoof.push((await nudge(1000 + i, `127.0.0.1, 10.0.0.${i}, 203.0.113.9`)).json?.code ?? 'ok');
    assert.equal(spoof.filter(c => c === 'RateLimited').length, 4, `one bucket for 203.0.113.9: ${spoof}`);
    // loopback spellings as the herald's entry: all the shared `unattributed` bucket (burst 10), none exempt
    const lo = [];
    for (const [i, x] of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '1.2.3.4, 127.0.0.1', 'garbage'].entries()) {
      for (let j = 0; j < 3; j++) lo.push((await nudge(2000 + i * 10 + j, x)).json?.code ?? 'ok');
    }
    assert.ok(lo.filter(c => c === 'RateLimited').length >= 8, `18 posts, one 10-burst bucket: ${lo}`);
    // oversized body: refused before the keeper
    const big = await call(r.public, 'POST', '/f/reveal', { body: JSON.stringify({ ...material(5), pad: 'x'.repeat(70 * 1024) }), ip: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.77' } });
    assert.equal(big.status, 413);
    assert.equal(k.seen.filter(s => s.url === '/v1/reveal').length, 0);
  } finally { await k.close(); }
});

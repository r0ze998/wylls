// (2026-11-20, verify-pr114) Adversarial probes of the public read-only endpoint and the owner server's new opt-ins,
// written by the independent verifier (not the author). Real loopback sockets, the fixture herald, generated test
// keys only; no relay, chain, network or real key.
//   V1  a keyless flood (no header, bad tokens) does not starve key holders: the global bucket is spent by
//       authenticated callers only
//   V2  X-Forwarded-For: ignored without a trusted proxy (spraying it buys no new bucket); with one, only the
//       right-most entry counts (left entries and a second header line written by the client buy nothing)
//   V3  scope/tool matrix: every tool × every key tool list; a refused tool hits no herald and spends no quota; a key
//       file with any other scope (spellings included) is refused whole
//   V4  token shapes: scheme case, spaces, tabs, swapped id/secret between two keys, long, unicode → 401, never echoed
//   V5  no token crosses servers: a public key on the owner server and a real owner access token on the public one → 401
//   V6  revocation and expiry edges; a deleted key file accepts no key (fail closed)
//   V7  tool-name tricks (__proto__, toString, case, spaces, non-strings) → -32602, no herald, no quota; a
//       tools/call notification is charged like a call
//   V8  concurrency: N parallel calls against burst B → exactly B pass; a new session (initialize) does not reset quota
//   V9  audit: query strings, unknown paths, X-Forwarded-For, arguments, unknown tool names carrying a wallet → none
//       of it in the log (unknown paths are logged as "(other)")
//   V10 Host/Origin variants (case, trailing dot, userinfo, IPv6, "null" Origin, other port)
//   V11 body: 16 KB + 1 chunked → 413; parse errors; no herald hit
//   V12 default OFF + loopback: settings refuse no-herald, no-keys, 0.0.0.0/::/LAN binds; the bin exits 2 with an
//       empty env and opens no port; the public bin's import graph reaches no relay, seal, signing or store module
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KeyRing, newKey, parseKeyFile, writeKeyFile, KeyFileError } from '../src/api-keys.mjs';
import { PUBLIC_TOOLS, PublicReader } from '../src/public-tools.mjs';
import { createPublicMcp, createPublicHandler, PUBLIC_PATH } from '../src/public-mcp.mjs';
import { createAudit } from '../src/audit.mjs';
import { listen } from '../src/http.mjs';
import { publicSettings } from '../bin/public-settings.mjs';
import { mcpSettings } from '../bin/mcp-settings.mjs';
import { world, server, connect, client, HERALD } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(here, '..');
const NAMES = PUBLIC_TOOLS.map(t => t.name);
const ARGS = { get_public_holding: { p: 9, q: 9, site: 0 } };

async function publicWorld() {
  const w = await world();
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    seen.push(`${init.method ?? 'GET'} ${u.pathname}`);
    const json = o => ({ status: 200, ok: true, json: async () => o });
    if (u.pathname === '/h/standings/latest.json') return json({ v: 1, rows: [] });
    if (u.pathname.startsWith('/h/holding/') || u.pathname === '/h/season/final.json') return { status: 404, ok: false, json: async () => ({}) };
    return w.fetch(url, init);
  };
  return { w, seen, fetch };
}

async function publicServer(pw, { keys = [], ring = null, anonymous = false, limits = {}, audit = null, trustProxy = false } = {}) {
  const clock = { t: Date.now() };
  const reader = new PublicReader({ base: HERALD, fetch: pw.fetch, now: () => clock.t });
  const mcp = createPublicMcp({ reader });
  const keyRing = ring ?? new KeyRing({ keys: keys.map(k => k.entry), now: () => clock.t });
  let handler;
  const srv = await listen((req, res) => handler(req, res));
  const port = srv.address().port;
  const origin = `http://127.0.0.1:${port}`;
  handler = createPublicHandler({ mcp, keys: keyRing, anonymous, allowedHosts: mcpSettings({}).allowedHosts, origin, now: () => clock.t, limits, audit, trustProxy });
  let id = 0;
  const call = async (method, params, { token, headers = {}, auth, url = PUBLIC_PATH, notify = false } = {}) => {
    const authz = auth !== undefined ? { authorization: auth } : token ? { authorization: `Bearer ${token}` } : {};
    const r = await fetch(`${origin}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...authz, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id: ++id }), method, ...(params ? { params } : {}) }) });
    const t = await r.text();
    let body = null;
    try { body = t ? JSON.parse(t) : null; } catch { body = t; }
    return { status: r.status, headers: r.headers, body, text: t };
  };
  const tool = (name, args, o) => call('tools/call', { name, arguments: args }, o);
  return { srv, port, origin, clock, call, tool, close: () => new Promise(r => srv.close(r)) };
}

/** A raw request over a real socket: exact headers (several lines for one name allowed), optional chunked body. */
function raw(port, { method = 'POST', target = PUBLIC_PATH, headers = [], body = null, chunks = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, setHost: false, headers }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (chunks) { for (const c of chunks) req.write(c); req.end(); } else req.end(body ?? '');
  });
}
const rpcBody = (method = 'ping', params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

// ------------------------------------------------------------------ V1
test('V1 a keyless flood does not starve key holders (the global bucket is spent after authentication)', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const s = await publicServer(pw, { keys: [k], limits: { globalRate: { burst: 5, everySecs: 1000 } } });
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal((await s.call('ping')).status, 401);
      assert.equal((await s.call('ping', null, { token: `wylls_pk_${'0'.repeat(16)}_${'A'.repeat(43)}` })).status, 401);
      assert.equal((await s.call('ping', null, { auth: 'Bearer junk' })).status, 401);
    }
    for (let i = 0; i < 5; i++) assert.equal((await s.call('ping', null, { token: k.token })).status, 200, `keyed call ${i} after the flood`);
    const busy = await s.call('ping', null, { token: k.token });
    assert.equal(busy.status, 429, 'the global bucket still bounds authenticated traffic');
    assert.equal(busy.body.error.data.reason, 'global');
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ V2
test('V2 X-Forwarded-For is trusted only behind a configured proxy, and then only its right-most entry', async () => {
  const pw = await publicWorld();
  const limits = { anonRate: { burst: 2, everySecs: 1000 }, globalRate: { burst: 10_000, everySecs: 1 } };
  const s = await publicServer(pw, { anonymous: true, limits });
  try {
    const xff = i => ({ 'x-forwarded-for': `10.0.0.${i}` });
    assert.equal((await s.call('ping', null, { headers: xff(1) })).status, 200);
    assert.equal((await s.call('ping', null, { headers: xff(2) })).status, 200);
    for (let i = 3; i < 10; i++) assert.equal((await s.call('ping', null, { headers: xff(i) })).status, 429, 'a sprayed XFF buys no bucket without a trusted proxy');
  } finally { await s.close(); }

  const p = await publicServer(pw, { anonymous: true, limits, trustProxy: true });
  try {
    // the proxy appends 203.0.113.7; the client writes anything to its left
    const via = left => ['x-forwarded-for', `${left}, 203.0.113.7`];
    assert.equal((await raw(p.port, { headers: [['host', `127.0.0.1:${p.port}`], ['content-type', 'application/json'], via('1.1.1.1')].flat(), body: rpcBody() })).status, 200);
    assert.equal((await raw(p.port, { headers: [['host', `127.0.0.1:${p.port}`], ['content-type', 'application/json'], via('2.2.2.2')].flat(), body: rpcBody() })).status, 200);
    for (const left of ['3.3.3.3', '4.4.4.4, 5.5.5.5', '']) {
      const r = await raw(p.port, { headers: [['host', `127.0.0.1:${p.port}`], ['content-type', 'application/json'], via(left)].flat(), body: rpcBody() });
      assert.equal(r.status, 429, `left part "${left}" buys nothing`);
    }
    // two header lines: node joins them with ", "; the proxy's own (last) line still wins
    const two = await raw(p.port, { headers: ['host', `127.0.0.1:${p.port}`, 'content-type', 'application/json', 'x-forwarded-for', '9.9.9.9', 'x-forwarded-for', '203.0.113.7'], body: rpcBody() });
    assert.equal(two.status, 429, 'a client-written first XFF line buys nothing');
    // another real client (another right-most entry) has its own bucket
    assert.equal((await raw(p.port, { headers: ['host', `127.0.0.1:${p.port}`, 'content-type', 'application/json', 'x-forwarded-for', '198.51.100.1'], body: rpcBody() })).status, 200);
  } finally { await p.close(); }
});

// ------------------------------------------------------------------ V3
test('V3 scope/tool matrix: every tool against every key tool list; refused tools touch nothing', async () => {
  const pw = await publicWorld();
  const all = newKey({ label: 'all' });
  const one = Object.fromEntries(NAMES.map(n => [n, newKey({ label: `only-${n}`, tools: [n], perDay: 1000 })]));
  const s = await publicServer(pw, { keys: [all, ...Object.values(one)], limits: { keyRate: { burst: 10_000, everySecs: 1 }, globalRate: { burst: 10_000, everySecs: 1 } } });
  try {
    for (const n of NAMES) assert.equal((await s.tool(n, ARGS[n] ?? {}, { token: all.token })).status, 200, `all-key ${n}`);
    for (const [allowed, k] of Object.entries(one)) {
      assert.deepEqual((await s.call('tools/list', null, { token: k.token })).body.result.tools.map(t => t.name), [allowed]);
      for (const n of NAMES) {
        const before = pw.seen.length;
        const r = await s.tool(n, ARGS[n] ?? {}, { token: k.token });
        if (n === allowed) { assert.equal(r.status, 200); assert.ok('result' in r.body, `${allowed} may call ${n}`); continue; }
        assert.equal(r.body.error.code, -32602, `${allowed}-key calling ${n}`);
        assert.equal(pw.seen.length, before, `${allowed}-key calling ${n}: no herald read`);
      }
    }
    // a refused tool spent no quota: a perDay-2 key restricted to season burns 0 on standings
    const two = newKey({ label: 'two', tools: ['get_world_season'], perDay: 2 });
    const s2 = await publicServer(pw, { keys: [two] });
    try {
      for (let i = 0; i < 5; i++) assert.equal((await s2.tool('get_standings', {}, { token: two.token })).body.error.code, -32602);
      assert.equal((await s2.tool('get_world_season', {}, { token: two.token })).status, 200);
      assert.equal((await s2.tool('get_world_season', {}, { token: two.token })).status, 200);
      assert.equal((await s2.tool('get_world_season', {}, { token: two.token })).status, 429);
    } finally { await s2.close(); }
  } finally { await s.close(); }
  // any other scope, in any spelling, refuses the key file as a whole
  const e = newKey({ label: 'x' }).entry;
  for (const scopes of [['wylls.read'], ['wylls.caravan'], ['wylls.public', 'wylls.read'], ['wylls.public', 'wylls.caravan'], ['WYLLS.PUBLIC'], ['wylls.public '], [' wylls.public'], ['wylls.public\u0000'], [''], [], ['*'], [{}]]) {
    assert.throws(() => parseKeyFile({ v: 1, keys: [e, { ...newKey({ label: 'y' }).entry, scopes }] }), KeyFileError, JSON.stringify(scopes));
  }
});

// ------------------------------------------------------------------ V4
test('V4 token shapes: every malformed or swapped token is 401 and never echoed', async () => {
  const pw = await publicWorld();
  const a = newKey({ label: 'a' });
  const b = newKey({ label: 'b' });
  const s = await publicServer(pw, { keys: [a, b] });
  try {
    const [, idA, secA] = /^wylls_pk_([0-9a-f]{16})_(.+)$/.exec(a.token);
    const [, idB, secB] = /^wylls_pk_([0-9a-f]{16})_(.+)$/.exec(b.token);
    const bad = [
      `bearer ${a.token}`, `BEARER ${a.token}`, `Bearer  ${a.token}`, `Bearer\t${a.token}`, `Bearer ${a.token}x`,
      `Bearer wylls_pk_${idA}_${secB}`, `Bearer wylls_pk_${idB}_${secA}`, `Bearer wylls_pk_${idA.toUpperCase()}_${secA}`,
      `Bearer ${a.token.replace('wylls_pk_', 'WYLLS_PK_')}`, `Bearer ${a.token}, Bearer ${b.token}`, `Bearer ${'A'.repeat(301)}`,
      `Bearer ${a.token.slice(0, -1)}é`, 'Bearer', 'Bearer ', `Basic ${Buffer.from(`x:${a.token}`).toString('base64')}`,
    ];
    for (const h of bad) {
      let r;
      try { r = await s.call('ping', null, { auth: h }); } catch { continue; } // fetch itself refuses some header bytes
      assert.equal(r.status, 401, JSON.stringify(h));
      assert.ok(!r.text.includes(secA) && !r.text.includes(secB), 'no secret echoed');
    }
    // a trailing space is optional whitespace that node:http strips before the server sees it (RFC 9110 §5.5)
    assert.equal((await s.call('ping', null, { auth: `Bearer ${a.token} ` })).status, 200);
    assert.equal((await s.call('ping', null, { token: a.token })).status, 200, 'the real token still works');
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ V5
test('V5 no token crosses servers: public key → owner server 401; real owner access token → public server 401', async () => {
  const w = await world();
  const o = await server(w);
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const p = await publicServer(pw, { keys: [k] });
  try {
    const c = await connect(o, w);
    assert.ok(c.access_token, 'an owner link was made');
    assert.equal((await client(o, c.access_token).rpc('tools/list')).status, 200, 'the owner token works where it was issued');
    const ownerWithKey = await client(o, k.token).rpc('tools/list');
    assert.equal(ownerWithKey.status, 401, 'a public key is no owner token');
    const r = await p.call('tools/list', null, { token: c.access_token });
    assert.equal(r.status, 401, 'an owner token is no public key');
    assert.match(r.headers.get('www-authenticate'), /invalid_token/);
    assert.equal((await p.call('tools/list', null, { token: c.refresh_token })).status, 401, 'nor is a refresh token');
  } finally { await p.close(); await o.close(); }
});

// ------------------------------------------------------------------ V6
test('V6 revocation and expiry edges; a deleted key file accepts no key (fail closed)', () => {
  const clock = { t: 1_800_000_000_000 };
  const exp = newKey({ label: 'exp', expiresAt: clock.t });
  const later = newKey({ label: 'later' });
  const soon = { ...later.entry, revokedAt: clock.t + 10 };
  const ring = new KeyRing({ keys: [exp.entry, soon], now: () => clock.t });
  assert.equal(ring.verify(exp.token).message, 'the key has expired', 'expiresAt == now is expired');
  assert.ok(ring.verify(later.token).key, 'a revocation dated later is not yet in force');
  clock.t += 10;
  assert.equal(ring.verify(later.token).message, 'the key was revoked');

  const dir = mkdtempSync(path.join(tmpdir(), 'ws03-v6-'));
  try {
    const file = path.join(dir, 'keys.json');
    const live = newKey({ label: 'live' });
    writeKeyFile(file, [live.entry]);
    const c2 = { t: Date.now() };
    const logs = [];
    const r2 = new KeyRing({ file, now: () => c2.t, recheckMs: 1000, log: m => logs.push(m) });
    assert.ok(r2.verify(live.token).key);
    rmSync(file);
    c2.t += 1000;
    assert.equal(r2.verify(live.token).error, 'invalid_token', 'the operator deleted the key file: no key works');
    assert.match(logs.at(-1), /cannot be read/);
    // the file comes back: its keys work again
    writeKeyFile(file, [live.entry]);
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    c2.t += 1000;
    assert.ok(r2.verify(live.token).key, 'a restored file is read again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ V7
test('V7 tool-name tricks are unknown tools: no herald read, no quota; a tools/call notification is charged', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k', perDay: 3 });
  const s = await publicServer(pw, { keys: [k], limits: { keyRate: { burst: 10_000, everySecs: 1 } } });
  try {
    const before = pw.seen.length;
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'GET_WORLD_SEASON', 'get_world_season ', ' get_world_season', 'get_world_seasоn', 'get_world_season\u0000', 1, null, {}, ['get_world_season'], true]) {
      const r = await s.call('tools/call', { name, arguments: {} }, { token: k.token });
      assert.equal(r.status, 200, JSON.stringify(name));
      assert.equal(r.body.error.code, -32602, JSON.stringify(name));
    }
    assert.equal(pw.seen.length, before, 'no herald read');
    // quota 3: a notification call (no id → 202) is still charged
    assert.equal((await s.call('tools/call', { name: 'get_world_season', arguments: {} }, { token: k.token, notify: true })).status, 202);
    assert.equal((await s.tool('get_world_season', {}, { token: k.token })).status, 200);
    assert.equal((await s.tool('get_world_season', {}, { token: k.token })).status, 200);
    const over = await s.tool('get_world_season', {}, { token: k.token });
    assert.equal(over.status, 429, 'the notification spent a unit');
    assert.equal(over.body.error.data.reason, 'quota');
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ V8
test('V8 concurrency: parallel calls cannot exceed the burst; a new session does not reset the quota', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const s = await publicServer(pw, { keys: [k], limits: { keyRate: { burst: 4, everySecs: 1000 }, globalRate: { burst: 10_000, everySecs: 1 } } });
  try {
    const rs = await Promise.all(Array.from({ length: 25 }, () => s.tool('get_world_season', {}, { token: k.token })));
    assert.equal(rs.filter(r => r.status === 200).length, 4);
    assert.equal(rs.filter(r => r.status === 429).length, 21);
  } finally { await s.close(); }
  const q = newKey({ label: 'q', perDay: 2 });
  const s2 = await publicServer(pw, { keys: [q], limits: { keyRate: { burst: 10_000, everySecs: 1 } } });
  try {
    const init = () => s2.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }, { token: q.token });
    await init();
    await s2.tool('get_world_season', {}, { token: q.token });
    await s2.tool('get_world_season', {}, { token: q.token });
    const i2 = await init();
    assert.equal(i2.status, 200);
    const r = await s2.tool('get_world_season', {}, { token: q.token, headers: { 'mcp-session-id': i2.headers.get('mcp-session-id') } });
    assert.equal(r.status, 429, 'quota is per key, not per session');
  } finally { await s2.close(); }
});

// ------------------------------------------------------------------ V9
test('V9 audit: no query, unknown path, forwarded address, argument or wallet reaches the log', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const wallet = pw.w.o;
  const lines = [];
  const audit = createAudit({ write: l => lines.push(l), server: 'public', salt: 's' });
  const s = await publicServer(pw, { keys: [k], audit, trustProxy: true, anonymous: false });
  try {
    await s.call('ping', null, { token: k.token, url: `${PUBLIC_PATH}?key=${k.token}&wallet=${wallet}` });
    await s.call('ping', null, { token: k.token, url: `/public/mcp/${wallet}` });
    await s.call('ping', null, { token: k.token, url: `/h/me/${wallet}` });
    await s.call('ping', null, { token: k.token, headers: { 'x-forwarded-for': '198.51.100.23, 203.0.113.99' } });
    await s.tool('get_public_holding', { p: 1, q: 2, site: 3, owner: wallet }, { token: k.token });
    await s.tool(`get_${wallet}`, {}, { token: k.token });
    await s.tool(wallet.toLowerCase(), {}, { token: k.token });
    await s.call('ping', null, { auth: `Bearer ${k.token}x` });
    await new Promise(r => setTimeout(r, 30));
    const all = lines.join('');
    assert.equal(lines.length, 8);
    for (const secret of [k.token, k.token.slice(-43), wallet, wallet.toLowerCase(), '198.51.100.23', '203.0.113.99', '127.0.0.1', 'key=', '"owner"', 'Bearer']) assert.ok(!all.includes(secret), `audit holds ${secret}`);
    const routes = lines.map(l => JSON.parse(l).route);
    assert.deepEqual(routes.slice(0, 3), [`POST ${PUBLIC_PATH}`, 'POST (other)', 'POST (other)']);
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ V10
test('V10 Host and Origin variants', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const s = await publicServer(pw, { keys: [k] });
  try {
    const go = (host, origin) => raw(s.port, { headers: [...(host === null ? [] : ['host', host]), 'content-type', 'application/json', 'authorization', `Bearer ${k.token}`, ...(origin ? ['origin', origin] : [])], body: rpcBody() });
    // numeric spellings of 127.0.0.1 (WHATWG URL normalises them) are loopback literals, not names an attacker can
    // re-point: allowed, and harmless for DNS rebinding
    for (const h of [`LOCALHOST:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`, `127.0.0.1:${s.port}`, '127.1', '2130706433']) assert.equal((await go(h)).status, 200, h);
    for (const h of ['localhost.', `127.0.0.1:1@evil.example`, 'evil.example', '127.0.0.2', '0.0.0.0', '[::ffff:127.0.0.1]', 'localhost.evil.example', '']) {
      assert.equal((await go(h)).status, 403, `host ${JSON.stringify(h)}`);
    }
    for (const o of ['null', `${s.origin}/`, `http://127.0.0.1:${s.port + 1}`, `https://127.0.0.1:${s.port}`, 'http://localhost', 'https://evil.example']) {
      assert.equal((await go(`127.0.0.1:${s.port}`, o)).status, 403, `origin ${o}`);
    }
    assert.equal((await go(`127.0.0.1:${s.port}`, s.origin)).status, 200);
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ V11
test('V11 body limits and shapes: 413 on 16 KB + 1 (chunked), parse errors, nothing reaches the herald', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const s = await publicServer(pw, { keys: [k] });
  try {
    const before = pw.seen.length;
    const h = ['host', `127.0.0.1:${s.port}`, 'content-type', 'application/json', 'authorization', `Bearer ${k.token}`];
    const big = await raw(s.port, { headers: h, chunks: Array.from({ length: 17 }, () => 'x'.repeat(1024)) });
    assert.equal(big.status, 413);
    assert.equal((await raw(s.port, { headers: h, body: '{"jsonrpc":"2.0",' })).status, 400);
    assert.equal((await raw(s.port, { headers: h, body: '"just a string"' })).status, 400);
    assert.equal((await raw(s.port, { headers: h, body: '[' + rpcBody('tools/call', { name: 'get_world_season' }) + ']' })).status, 400);
    assert.equal((await raw(s.port, { headers: h, body: '['.repeat(8000) + ']'.repeat(8000) })).status, 400);
    assert.equal((await raw(s.port, { method: 'GET', headers: h })).status, 405);
    assert.equal(pw.seen.length, before);
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ V12
test('V12 default OFF and loopback; the public bin reaches no acting module', async () => {
  const H = 'http://127.0.0.1:1';
  assert.match(publicSettings({}).error, /WYLLS_MCP_PUBLIC_HERALD/);
  assert.match(publicSettings({ WYLLS_MCP_PUBLIC_HERALD: H }).error, /WYLLS_MCP_PUBLIC_KEYS/);
  const ok = publicSettings({ WYLLS_MCP_PUBLIC_HERALD: H, WYLLS_MCP_PUBLIC_KEYS: '/x' });
  assert.equal(ok.host, '127.0.0.1');
  assert.equal(ok.anonymous, false);
  assert.equal(ok.trustProxy, false);
  assert.equal(ok.remoteBind, false);
  for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '127.0.0.1.nip.io']) {
    assert.match(publicSettings({ WYLLS_MCP_PUBLIC_HERALD: H, WYLLS_MCP_PUBLIC_KEYS: '/x', WYLLS_MCP_PUBLIC_HOST: host }).error ?? '', /WYLLS_MCP_PUBLIC_HOST/, host);
  }
  for (const v of ['0', 'true', 'yes']) {
    assert.ok(publicSettings({ WYLLS_MCP_PUBLIC_HERALD: H, WYLLS_MCP_PUBLIC_KEYS: '/x', WYLLS_MCP_PUBLIC_ANONYMOUS: v }).error, `ANONYMOUS=${v}`);
    assert.ok(publicSettings({ WYLLS_MCP_PUBLIC_HERALD: H, WYLLS_MCP_PUBLIC_KEYS: '/x', WYLLS_MCP_PUBLIC_TRUST_PROXY: v }).error, `TRUST_PROXY=${v}`);
  }
  // the bin with an empty environment refuses to start (exit 2) and opens nothing
  const r = spawnSync(process.execPath, [path.join(MCP_ROOT, 'bin/wylls-mcp-public.mjs')], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 2, r.stderr);
  // the bin's whole relative import graph: no relay, seal, store, signing, capability, agent-wallet or send module
  const seen = new Set();
  const walk = f => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) walk(path.resolve(path.dirname(f), m[1] ?? m[2]));
  };
  walk(path.join(MCP_ROOT, 'bin/wylls-mcp-public.mjs'));
  const files = [...seen].map(f => path.relative(path.resolve(MCP_ROOT, '../../..'), f));
  assert.ok(files.length >= 10, files.join(" "));
  for (const f of files) {
    assert.doesNotMatch(f, /relay|seal|\/(store|auth|game|tools|server|seal)\.mjs$|agent\/|owner-auth|capabilit|wallet|sign|keypair|send|caravan|chain\.mjs/i, `the public bin imports ${f}`);
  }
  const text = files.map(f => readFileSync(path.resolve(MCP_ROOT, '../../..', f), 'utf8')).join('\n');
  assert.doesNotMatch(text, /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/, 'no write HTTP method in the public graph');
  // (the herald client's graph derives addresses with web/sdk/solana-tx.mjs: curve checks and PDAs, never a signature)
  assert.doesNotMatch(text, /\b(sendTransaction|signTransaction|signMessage|secretKey|privateKey|nacl)\b|\.sign\(/);
});

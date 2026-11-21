// (2026-11-20, ③ public exposure) The public read-only endpoint, API keys with scopes, rate limits and quotas, the
// audit log, and the guards that must still hold (Host, Origin, NEVER_DELEGATED). Real loopback sockets (node:http,
// ephemeral ports), the fixture herald's real account bytes; no relay, chain, key file outside a temp dir, or network.
//   E1 rate-limit.mjs: burst, refill, cost, refusal spends nothing, LRU eviction (never the whole table), daily roll
//   E2 api-keys.mjs: issue/verify, unknown/revoked/expired, constant shape; acting scopes refused; file mode; reload
//   E3 the public endpoint: Host and Origin first (403, no tool runs), 401 without a key / with an owner-link token
//   E4 tools: list (read-only, no write names), season and holding from real bytes, argument checks, key tool lists
//   E5 limits: per-key burst (429 + retry-after), tool cost, daily quota, global bucket, anonymous mode per address
//   E6 per-tool scopes: a tool needing a scope the caller lacks → 403 insufficient_scope with the scope challenge
//   E7 only public herald GETs leave the public server; ResultTooLarge; batch/size/parse/405/404
//   E8 audit: one line per request, no token / argument / raw address; owner server lines; rotation
//   E9 settings: public server (loopback, keys or anonymous, rates) and owner server opt-ins (all off when unset)
//   E10 NEVER_DELEGATED: still refused by the agent policy; no MCP tool (owner or public) reaches one; public modules
//       import no send path
//   E11 owner server: the daily quota per link (429 before the tool runs) and clientAddress with/without a proxy
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TokenBuckets, DailyQuota, parseRate } from '../src/rate-limit.mjs';
import { KeyRing, newKey, parseKeyFile, writeKeyFile, KeyFileError, PUBLIC_SCOPE } from '../src/api-keys.mjs';
import { PUBLIC_TOOLS, PublicReader, plain, MAX_RESULT_BYTES } from '../src/public-tools.mjs';
import { createPublicMcp, createPublicHandler, PUBLIC_PATH } from '../src/public-mcp.mjs';
import { createAudit, clientAddress } from '../src/audit.mjs';
import { listen, createHandler } from '../src/http.mjs';
import { publicSettings } from '../bin/public-settings.mjs';
import { ownerExposureSettings } from '../bin/owner-exposure-settings.mjs';
import { TOOLS, COOP_TOOL } from '../src/tools.mjs';
import { mcpSettings } from '../bin/mcp-settings.mjs';
import { world, HERALD, GATEWAY_ROOT } from './fixture.mjs';
import { createHerald } from '../../../../permutation-server/web/frontier/herald.mjs';
import { pathToFileURL } from 'node:url';

const policy = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/policy.mjs')).href);
const contract = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/contract.mjs')).href);

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ws03-public-'));

// ------------------------------------------------------------------ E1
test('E1 token buckets and daily quotas', () => {
  const clock = { t: 1_000_000 };
  const b = new TokenBuckets({ burst: 3, everySecs: 2, now: () => clock.t, maxKeys: 2 });
  for (let i = 0; i < 3; i++) assert.equal(b.take('a').ok, true);
  const r = b.take('a');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterSecs, 2);
  clock.t += 2_000;
  assert.equal(b.take('a').ok, true, 'one refilled after everySecs');
  assert.equal(b.take('a').ok, false);
  // a cost larger than what is left is refused and spends nothing
  clock.t += 4_000; // 2 tokens
  assert.equal(b.take('a', 3).ok, false);
  assert.equal(b.take('a', 2).ok, true, 'the refused call spent nothing');
  // LRU: past maxKeys only the least recently used key is forgotten
  b.take('b'); b.take('a'); b.take('c');
  assert.equal(b.size, 2);
  assert.equal(b.take('a').ok, false, 'a (recently used) kept its spent state');
  assert.throws(() => new TokenBuckets({ burst: 0, everySecs: 1 }));
  assert.deepEqual(parseRate('30/1'), { burst: 30, everySecs: 1 });
  assert.deepEqual(parseRate('10/0.5'), { burst: 10, everySecs: 0.5 });
  for (const bad of ['', '0/1', '1/0', 'x/1', '1', '-1/2', '1/2/3']) assert.equal(parseRate(bad), null, bad);

  const day = 86_400_000;
  const q = new DailyQuota({ perDay: 5, now: () => clock.t });
  clock.t = 10 * day + 100;
  assert.equal(q.take('k', 3).ok, true);
  const no = q.take('k', 3);
  assert.equal(no.ok, false);
  assert.equal(no.remaining, 2);
  assert.equal(no.resetAt, 11 * day);
  assert.equal(q.take('k', 2).ok, true, 'a refused take spends nothing');
  assert.equal(q.take('k', 1, 7).ok, true, 'a per-key allowance overrides the default');
  clock.t = 11 * day;
  assert.equal(q.take('k', 5).remaining, 0, 'a new UTC day starts again');
});

// ------------------------------------------------------------------ E2
test('E2 API keys: issue, verify, refuse; acting scopes are never a key\'s', () => {
  const clock = { t: Date.now() };
  const a = newKey({ label: 'agent-a', now: clock.t });
  const b = newKey({ label: 'agent-b', expiresAt: clock.t + 1000, tools: ['get_world_season'] });
  const c = newKey({ label: 'agent-c' });
  c.entry.revokedAt = clock.t - 1;
  assert.match(a.token, /^wylls_pk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(a.entry).includes(a.token.split('_').pop()), 'the entry holds no secret');
  const ring = new KeyRing({ keys: [a.entry, b.entry, c.entry], now: () => clock.t });
  assert.equal(ring.verify(a.token).key.id, a.entry.id);
  assert.deepEqual(ring.verify(a.token).key.scopes, [PUBLIC_SCOPE]);
  assert.deepEqual(ring.verify(b.token).key.tools, ['get_world_season']);
  assert.equal(ring.verify(c.token).message, 'the key was revoked');
  // same id, other secret
  const forged = `${a.token.slice(0, -43)}${a.token.endsWith('A'.repeat(43)) ? 'B' : 'A'}${'A'.repeat(42)}`;
  assert.equal(ring.verify(forged).message, 'unknown key');
  assert.equal(ring.verify('wylls_pk_0000000000000000_' + 'A'.repeat(43)).message, 'unknown key');
  for (const t of ['', 'Bearer x', a.token + 'x', null]) assert.equal(ring.verify(t).error, 'invalid_token');
  clock.t += 1000;
  assert.equal(ring.verify(b.token).message, 'the key has expired');
  for (const v of [JSON.stringify(ring.verify(forged)), JSON.stringify(ring.verify(a.token + 'x'))]) assert.ok(!v.includes('wylls_pk_'), 'no token echoed');

  // acting scopes refused, whole file
  for (const scopes of [['wylls.caravan'], ['wylls.read'], [PUBLIC_SCOPE, 'wylls.caravan'], []]) {
    assert.throws(() => parseKeyFile({ v: 1, keys: [{ ...a.entry, scopes }] }), KeyFileError, JSON.stringify(scopes));
  }
  assert.throws(() => parseKeyFile({ v: 1, keys: [a.entry, { ...b.entry, id: a.entry.id }] }), /unique/);
  assert.throws(() => parseKeyFile({ v: 2, keys: [] }), KeyFileError);
  assert.throws(() => parseKeyFile({ v: 1, keys: [{ ...a.entry, rate: 'fast' }] }), /rate/);
  assert.throws(() => parseKeyFile({ v: 1, keys: [{ ...a.entry, label: '' }] }), /label/);
});

test('E2b the key file: 0600 only, reloaded on change, a broken edit keeps the keys loaded before', () => {
  const dir = tmp();
  const file = path.join(dir, 'keys.json');
  const a = newKey({ label: 'a' });
  writeKeyFile(file, [a.entry]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(file, 0o644);
  assert.throws(() => new KeyRing({ file }), /chmod 600/);
  chmodSync(file, 0o600);
  const clock = { t: Date.now() };
  const logs = [];
  const ring = new KeyRing({ file, now: () => clock.t, recheckMs: 1000, log: m => logs.push(m) });
  assert.ok(ring.verify(a.token).key);
  // revoke via the file: seen after recheckMs
  const revoked = { ...a.entry, revokedAt: clock.t - 1 };
  writeKeyFile(file, [revoked]);
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.ok(ring.verify(a.token).key, 'not re-read before recheckMs');
  clock.t += 1000;
  assert.equal(ring.verify(a.token).message, 'the key was revoked');
  // a broken edit: the revoked state stays (never opens the door)
  writeFileSync(file, '{not json', { mode: 0o600 });
  utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  clock.t += 1000;
  assert.equal(ring.verify(a.token).message, 'the key was revoked');
  assert.match(logs.at(-1), /refused .*keeping the keys loaded before/);
  // an edit that adds an acting scope is refused the same way
  writeFileSync(file, JSON.stringify({ v: 1, keys: [{ ...a.entry, scopes: ['wylls.caravan'] }] }), { mode: 0o600 });
  utimesSync(file, new Date(), new Date(Date.now() + 15_000));
  clock.t += 1000;
  assert.equal(ring.verify(a.token).message, 'the key was revoked');
  assert.match(logs.at(-1), /acting is an owner-signed link/);
});

// ------------------------------------------------------------------ the public server under test

/** The fixture herald (real Season/Holding bytes) plus the public JSON files; every request recorded. */
async function publicWorld({ big = false } = {}) {
  const w = await world();
  const h = createHerald({ base: HERALD, fetch: (...x) => w.fetch(...x) });
  const me = await h.me(w.o);
  const hold = me.holdings[0];
  const raw = await (await w.fetch(`${HERALD}/h/me/${w.o}`)).json();
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    seen.push(`${init.method ?? 'GET'} ${u.origin}${u.pathname}`);
    const json = o => ({ status: 200, ok: true, json: async () => o });
    if (u.pathname === '/h/standings/latest.json') return json(big ? { v: 1, rows: 'x'.repeat(MAX_RESULT_BYTES + 10) } : { v: 1, rows: [{ nation: 1, score: 3 }] });
    if (u.pathname === `/h/holding/${hold.p},${hold.q},${hold.site}.json`) return json({ bytes_b64: raw.holdings[0].bytes_b64 });
    if (u.pathname.startsWith('/h/holding/')) return { status: 404, ok: false, json: async () => ({}) };
    if (u.pathname === '/h/season/final.json') return { status: 404, ok: false, json: async () => ({}) };
    return w.fetch(url, init);
  };
  return { w, hold, seen, fetch };
}

async function publicServer(pw, { keys = [], anonymous = false, limits = {}, tools, audit = null, trustProxy = false, allowedHosts = mcpSettings({}).allowedHosts, origins = [] } = {}) {
  const clock = { t: Date.now() };
  const reader = new PublicReader({ base: HERALD, fetch: pw.fetch, now: () => clock.t });
  const mcp = createPublicMcp({ reader, ...(tools ? { tools } : {}) });
  const ring = new KeyRing({ keys: keys.map(k => k.entry), now: () => clock.t });
  let handler;
  const srv = await listen((req, res) => handler(req, res));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  handler = createPublicHandler({ mcp, keys: ring, anonymous, allowedHosts, origin, origins, now: () => clock.t, limits, audit, trustProxy });
  let id = 0;
  const call = async (method, params, { token, headers = {}, raw = null } = {}) => {
    const r = await fetch(`${origin}${PUBLIC_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }) });
    const t = await r.text();
    return { status: r.status, headers: r.headers, body: t ? JSON.parse(t) : null };
  };
  const tool = (name, args, o) => call('tools/call', { name, arguments: args }, o);
  return { srv, origin, clock, call, tool, close: () => new Promise(r => srv.close(r)) };
}

/** A raw request with exactly this Host header over a real socket. */
function rawPost(port, host, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, 'content-type': 'application/json', ...(origin ? { origin } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: PUBLIC_PATH, method: 'POST', headers, setHost: false }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_world_season' } }));
  });
}

// ------------------------------------------------------------------ E3
test('E3 Host and Origin are checked first; no key → 401; an owner-link token is not a key', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const s = await publicServer(pw, { keys: [k], anonymous: true });
  try {
    const port = s.srv.address().port;
    const before = pw.seen.length;
    for (const h of ['evil.example', `evil.example:${port}`, '127.0.0.1.evil.example']) {
      const r = await rawPost(port, h);
      assert.equal(r.status, 403, h);
      assert.equal(JSON.parse(r.body).error_description, 'host not allowed');
    }
    const o = await rawPost(port, `127.0.0.1:${port}`, { origin: 'https://evil.example' });
    assert.equal(o.status, 403);
    assert.equal(JSON.parse(o.body).error_description, 'origin not allowed');
    assert.equal(pw.seen.length, before, 'a refused Host or Origin reaches no tool and no herald');
    // the server's own origin is allowed
    assert.equal((await rawPost(port, `127.0.0.1:${port}`, { origin: s.origin })).status, 200);
  } finally { await s.close(); }

  const s2 = await publicServer(pw, { keys: [k] });
  try {
    const none = await s2.call('tools/list');
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="wylls-public"');
    // an OAuth access token of the owner server (base64url, 43 chars) is refused: issued for another resource
    const link = await s2.call('tools/list', null, { token: 'q'.repeat(43) });
    assert.equal(link.status, 401);
    assert.match(link.headers.get('www-authenticate'), /error="invalid_token"/);
    assert.match(link.body.error.message, /accepts no other token/);
    const bad = await s2.call('tools/list', null, { token: `${k.token.slice(0, -1)}${k.token.endsWith('A') ? 'B' : 'A'}` });
    assert.equal(bad.status, 401);
    assert.ok(!JSON.stringify(bad.body).includes('wylls_pk_'), 'the token is not echoed');
    assert.equal((await s2.call('tools/list', null, { headers: { authorization: 'Basic abc' } })).status, 401);
  } finally { await s2.close(); }
});

// ------------------------------------------------------------------ E4
test('E4 the tools: read-only, real bytes, checked arguments, the key\'s own tool list', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const only = newKey({ label: 'season-only', tools: ['get_world_season'] });
  const s = await publicServer(pw, { keys: [k, only] });
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }, { token: k.token });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'wylls-mcp-public');
    assert.match(init.body.result.instructions, /fog of war is the client's drawing/);
    assert.match(init.headers.get('mcp-session-id'), /^[0-9a-f]{32}$/);
    const list = (await s.call('tools/list', null, { token: k.token })).body.result.tools;
    assert.deepEqual(list.map(t => t.name), ['get_world_season', 'get_standings', 'get_nations', 'get_sieges', 'get_season_final', 'get_public_holding']);
    for (const t of list) {
      assert.deepEqual([t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.openWorldHint], [true, false, false], t.name);
      assert.ok(!('scopes' in t) && !('cost' in t), 'internal fields are not listed');
    }
    const ownerNames = [...TOOLS, COOP_TOOL].map(t => t.name);
    assert.ok(list.every(t => !ownerNames.includes(t.name)), 'no owner tool is public');

    const season = await s.tool('get_world_season', {}, { token: k.token });
    assert.equal(season.body.result.isError, false);
    assert.match(season.body.result.structuredContent.season, /^\d+$/);
    assert.ok(!JSON.stringify(season.body).includes('bytes_b64'), 'account bytes are not passed through');
    const hold = await s.tool('get_public_holding', { p: pw.hold.p, q: pw.hold.q, site: pw.hold.site }, { token: k.token });
    assert.equal(hold.body.result.isError, false, JSON.stringify(hold.body));
    assert.match(hold.body.result.structuredContent.holding.ownerCitizen, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const missing = await s.tool('get_public_holding', { p: 9, q: 9, site: 0 }, { token: k.token });
    assert.equal(missing.body.result.structuredContent.error.code, 'NotFound');
    assert.equal((await s.tool('get_season_final', {}, { token: k.token })).body.result.structuredContent.error.code, 'NotFound');
    assert.equal((await s.tool('get_standings', {}, { token: k.token })).body.result.structuredContent.standings.rows[0].score, 3);
    for (const args of [{ p: 1, q: 1 }, { p: 1.5, q: 1, site: 0 }, { p: 1, q: 1, site: 12 }, { p: 1, q: 1, site: 0, wallet: 'x' }, []]) {
      const r = await s.tool('get_public_holding', args, { token: k.token });
      assert.equal(r.body.error.code, -32602, JSON.stringify(args));
    }
    assert.equal((await s.tool('send_caravan', { planId: 'x', requestId: 'aaaaaaaa' }, { token: k.token })).body.error.code, -32602);
    assert.equal((await s.tool('constructor', {}, { token: k.token })).body.error.code, -32602);
    // a key limited to one tool sees and calls that one only
    assert.deepEqual((await s.call('tools/list', null, { token: only.token })).body.result.tools.map(t => t.name), ['get_world_season']);
    assert.equal((await s.tool('get_standings', {}, { token: only.token })).body.error.code, -32602);
    assert.equal((await s.tool('get_world_season', {}, { token: only.token })).body.result.isError, false);
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ E5
test('E5 limits: per key, tool cost, daily quota, global, anonymous per address', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const k2 = newKey({ label: 'k2', rate: '100/1', perDay: 3 });
  const s = await publicServer(pw, { keys: [k, k2], anonymous: true, limits: { keyRate: { burst: 3, everySecs: 10 }, anonRate: { burst: 2, everySecs: 10 }, keyPerDay: 100, anonPerDay: 100, globalRate: { burst: 1000, everySecs: 1 } } });
  try {
    // get_standings costs 2: request (1) + cost-1 (1) = 2 of 3
    assert.equal((await s.tool('get_standings', {}, { token: k.token })).status, 200);
    const r = await s.tool('get_standings', {}, { token: k.token });
    assert.equal(r.status, 429, 'the extra cost does not fit');
    assert.equal(r.body.error.data.reason, 'rate');
    assert.match(r.headers.get('retry-after'), /^\d+$/);
    assert.equal((await s.call('ping', null, { token: k.token })).status, 429, 'the bucket is empty');
    s.clock.t += 30_000;
    assert.equal((await s.call('ping', null, { token: k.token })).status, 200, 'refilled');
    // a key's own rate and daily quota (3 units): season 1 + holding 1 + standings 2 → over
    assert.equal((await s.tool('get_world_season', {}, { token: k2.token })).status, 200);
    assert.equal((await s.tool('get_world_season', {}, { token: k2.token })).status, 200);
    const q = await s.tool('get_standings', {}, { token: k2.token });
    assert.equal(q.status, 429);
    assert.equal(q.body.error.data.reason, 'quota');
    assert.ok(q.body.error.data.resetAt > s.clock.t);
    assert.equal((await s.tool('get_world_season', {}, { token: k2.token })).status, 200, 'the refused call spent nothing of the quota');
    // anonymous: its own (smaller) bucket per address
    assert.equal((await s.call('ping')).status, 200);
    assert.equal((await s.call('ping')).status, 200);
    assert.equal((await s.call('ping')).status, 429);
    assert.equal((await s.call('ping', null, { token: k.token })).status, 200, 'a key is not charged for the anonymous caller');
  } finally { await s.close(); }

  const g = await publicServer(pw, { keys: [k], limits: { globalRate: { burst: 2, everySecs: 100 } } });
  try {
    assert.equal((await g.call('ping', null, { token: k.token })).status, 200);
    assert.equal((await g.call('ping', null, { token: k.token })).status, 200);
    const busy = await g.call('ping', null, { token: k.token });
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error.data.reason, 'global');
  } finally { await g.close(); }
});

// ------------------------------------------------------------------ E6
test('E6 per-tool scopes: a missing scope is a 403 insufficient_scope challenge, before the tool runs', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  let ran = 0;
  const extra = { ...PUBLIC_TOOLS[0], name: 'get_world_season', scopes: [PUBLIC_SCOPE, 'wylls.public.bulk'] };
  const s = await publicServer(pw, { keys: [k], tools: [extra, PUBLIC_TOOLS[1]] });
  const orig = PublicReader.prototype.get_world_season;
  PublicReader.prototype.get_world_season = async function () { ran++; return orig.call(this); };
  try {
    const r = await s.tool('get_world_season', {}, { token: k.token });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="wylls-public", error="insufficient_scope", scope="wylls.public wylls.public.bulk"');
    assert.equal(ran, 0, 'the tool did not run');
    assert.equal((await s.tool('get_standings', {}, { token: k.token })).status, 200);
  } finally { PublicReader.prototype.get_world_season = orig; await s.close(); }
});

// ------------------------------------------------------------------ E7
test('E7 only public herald GETs leave the server; size and shape refusals', async () => {
  const pw = await publicWorld({ big: true });
  const k = newKey({ label: 'k' });
  const s = await publicServer(pw, { keys: [k] });
  try {
    for (const t of PUBLIC_TOOLS) await s.tool(t.name, t.name === 'get_public_holding' ? { p: pw.hold.p, q: pw.hold.q, site: pw.hold.site } : {}, { token: k.token });
    assert.ok(pw.seen.length >= PUBLIC_TOOLS.length);
    for (const line of pw.seen) assert.match(line, new RegExp(`^GET ${HERALD.replace(/[.]/g, '\\.')}/h/`), line);
    const big = await s.tool('get_standings', {}, { token: k.token });
    assert.equal(big.body.result.structuredContent.error.code, 'ResultTooLarge');
    const tk = { token: k.token };
    assert.equal((await s.call(null, null, { ...tk, raw: '[{"jsonrpc":"2.0","id":1,"method":"ping"}]' })).body.error.message, 'batches are not supported');
    assert.equal((await s.call(null, null, { ...tk, raw: '{nope' })).body.error.code, -32700);
    assert.equal((await s.call(null, null, { ...tk, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'y'.repeat(17_000) } }) })).status, 413);
    assert.equal((await s.call('ping', null, { ...tk, headers: { 'mcp-protocol-version': '1999-01-01' } })).status, 400);
    assert.equal((await s.call(null, null, { ...tk, raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
    assert.equal((await s.call('resources/list', null, tk)).body.error.code, -32601);
    assert.equal((await fetch(`${s.origin}${PUBLIC_PATH}`)).status, 405);
    assert.equal((await fetch(`${s.origin}/mcp`, { method: 'POST' })).status, 404, 'the owner endpoint is not here');
    assert.equal((await fetch(`${s.origin}/oauth/register`, { method: 'POST' })).status, 404, 'no authorization server here');
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ E8
test('E8 audit lines: who and what, never a token, an argument or a raw address', async () => {
  const pw = await publicWorld();
  const k = newKey({ label: 'k' });
  const lines = [];
  const audit = createAudit({ write: l => lines.push(l), server: 'public', salt: 'test-salt' });
  const s = await publicServer(pw, { keys: [k], audit });
  try {
    await s.tool('get_public_holding', { p: pw.hold.p, q: pw.hold.q, site: pw.hold.site }, { token: k.token });
    await s.call('tools/list');
    await s.tool('get_public_holding', { p: 1, q: 1 }, { token: k.token });
    await new Promise(r => setTimeout(r, 20));
    const rows = lines.map(l => JSON.parse(l));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => [r.status, r.who.kind, r.tool ?? null, r.outcome]), [[200, 'key', 'get_public_holding', 'ok'], [401, 'none', null, 'Unauthenticated'], [200, 'key', 'get_public_holding', 'rpc32602']]);
    assert.equal(rows[0].who.id, k.entry.id);
    assert.equal(rows[0].route, `POST ${PUBLIC_PATH}`);
    assert.match(rows[0].addr, /^[0-9a-f]{16}$/);
    const all = lines.join('');
    for (const secret of [k.token, k.token.split('_').pop(), '127.0.0.1', '::1', 'Bearer', String(pw.hold.p) === '0' ? 'never-matches' : `"p":${pw.hold.p}`]) assert.ok(!all.includes(secret), secret);
  } finally { await s.close(); }

  // ip off; file rotation
  const dir = tmp();
  const file = path.join(dir, 'audit.jsonl');
  const a2 = createAudit({ file, ip: 'off', maxBytes: 300 });
  for (let i = 0; i < 4; i++) a2.record({ route: 'POST /mcp', status: 200, ms: 1, addr: '10.0.0.1', who: { kind: 'link', linkId: 'L1' }, tool: 'get_connection', outcome: 'ok' });
  assert.ok(existsSync(`${file}.1`), 'rotated once');
  const txt = readFileSync(file, 'utf8') + readFileSync(`${file}.1`, 'utf8');
  assert.ok(!txt.includes('10.0.0.1') && !txt.includes('"addr"') && !txt.includes('L1'), 'no address, no raw link id');
  assert.match(txt, /"id":"l:[0-9a-f]{16}"/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(createAudit({}), null, 'off when not configured');
  assert.throws(() => createAudit({ write: () => {}, ip: 'raw' }));
});

// ------------------------------------------------------------------ E9
test('E9 settings: the public server and the owner server opt-ins', () => {
  const base = { WYLLS_MCP_PUBLIC_HERALD: 'http://127.0.0.1:41940', WYLLS_MCP_PUBLIC_KEYS: '/tmp/k.json' };
  const d = publicSettings(base);
  assert.equal(d.error, undefined);
  assert.equal(d.port, 41961);
  assert.equal(d.host, '127.0.0.1');
  assert.equal(d.endpoint, 'http://127.0.0.1:41961/public/mcp');
  assert.equal(d.anonymous, false);
  assert.equal(d.trustProxy, false);
  assert.equal(d.audit, null);
  assert.deepEqual(d.allowedHosts, ['127.0.0.1', 'localhost', '[::1]']);
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_HOST: '0.0.0.0' }).error, /^WYLLS_MCP_PUBLIC_HOST: a loopback host/);
  assert.equal(publicSettings({ ...base, WYLLS_MCP_PUBLIC_HOST: '0.0.0.0', WYLLS_MCP_PUBLIC_ALLOW_REMOTE_BIND: '1' }).remoteBind, true);
  assert.match(publicSettings({ WYLLS_MCP_PUBLIC_HERALD: 'http://h' }).error, /^WYLLS_MCP_PUBLIC_KEYS: a key file is required/);
  assert.equal(publicSettings({ WYLLS_MCP_PUBLIC_HERALD: 'http://h', WYLLS_MCP_PUBLIC_ANONYMOUS: '1' }).anonymous, true);
  assert.match(publicSettings({ WYLLS_MCP_PUBLIC_KEYS: 'k' }).error, /^WYLLS_MCP_PUBLIC_HERALD/);
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_PORT: 'x' }).error, /^WYLLS_MCP_PUBLIC_PORT:/);
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_ORIGIN: 'https://x.example/p' }).error, /^WYLLS_MCP_PUBLIC_ORIGIN:/);
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_ALLOWED_HOSTS: 'http://x' }).error, /^WYLLS_MCP_PUBLIC_ALLOWED_HOSTS:/);
  assert.deepEqual(publicSettings({ ...base, WYLLS_MCP_PUBLIC_ORIGIN: 'https://Pub.example.org' }).allowedHosts, ['127.0.0.1', 'localhost', '[::1]', 'pub.example.org']);
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_RATE: 'fast' }).error, /^WYLLS_MCP_PUBLIC_RATE:/);
  assert.deepEqual(publicSettings({ ...base, WYLLS_MCP_PUBLIC_RATE: '5/2' }).limits.keyRate, { burst: 5, everySecs: 2 });
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_PER_DAY: '0' }).error, /^WYLLS_MCP_PUBLIC_PER_DAY:/);
  for (const n of ['WYLLS_MCP_PUBLIC_ANONYMOUS', 'WYLLS_MCP_PUBLIC_TRUST_PROXY']) assert.match(publicSettings({ ...base, [n]: 'yes' }).error, new RegExp(`^${n}: 1 or unset`));
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_AUDIT_IP: 'raw' }).error, /AUDIT_IP/);
  assert.match(publicSettings({ ...base, WYLLS_MCP_PUBLIC_ORIGINS: 'https://a.example/x' }).error, /ORIGINS/);
  for (const e of Object.values({ a: publicSettings({ ...base, WYLLS_MCP_PUBLIC_RATE: 'secret-value' }).error })) assert.ok(!e.includes('secret-value'), 'never quotes the value');

  assert.deepEqual(ownerExposureSettings({}), { audit: null, auditIp: 'hash', auditSalt: null, trustProxy: false, linkPerDay: null });
  assert.deepEqual(ownerExposureSettings({ WYLLS_MCP_AUDIT: '/tmp/a', WYLLS_MCP_AUDIT_IP: 'off', WYLLS_MCP_TRUST_PROXY: '1', WYLLS_MCP_LINK_PER_DAY: '200' }), { audit: '/tmp/a', auditIp: 'off', auditSalt: null, trustProxy: true, linkPerDay: 200 });
  for (const [k, v] of [['WYLLS_MCP_AUDIT_IP', 'raw'], ['WYLLS_MCP_TRUST_PROXY', 'true'], ['WYLLS_MCP_LINK_PER_DAY', '0'], ['WYLLS_MCP_LINK_PER_DAY', 'x']]) assert.match(ownerExposureSettings({ [k]: v }).error, new RegExp(`^${k}:`));
  // the bin passes them through, all off when unset
  const bin = readFileSync(new URL('../bin/wylls-mcp.mjs', import.meta.url), 'utf8');
  assert.match(bin, /const exposure = ownerExposureSettings\(env\);\nif \(exposure\.error\) \{ console\.error\(exposure\.error\); process\.exit\(2\); \}/);
  const pub = readFileSync(new URL('../bin/wylls-mcp-public.mjs', import.meta.url), 'utf8');
  assert.match(pub, /await listen\(handler, \{ port: s\.port, host: s\.host \}\)/);
  assert.doesNotMatch(pub.replace(/\/\/.*$/gm, ''), /WYLLS_MCP_TEST_AS|\bAuth\b|JsonStore|\bGame\b|relay/i, 'no authorization server, store, game or relay in the public server (code, not comments)');
});

// ------------------------------------------------------------------ E10
test('E10 NEVER_DELEGATED still holds; no MCP tool reaches one; public modules import no send path', () => {
  // (IssueGrant/RevokeGrant joined with ② rights, c50ec3d8 / #119: issuance is wallet-only, owner decision ② A)
  assert.deepEqual([...contract.NEVER_DELEGATED], ['Join', 'SetSession', 'PlaceHome', 'FileTicket', 'FileOutpost', 'DeclareSiege', 'RetireHost', 'IssueGrant', 'RevokeGrant']);
  for (const n of contract.NEVER_DELEGATED) {
    // even a policy that lists it cannot allow it
    assert.throws(() => policy.checkAllowed({ allowed: [n] }, n), e => e.code === 'ActionNotAllowed', n);
    assert.throws(() => policy.normalisePolicy({ allowed: [n], budget: { total: '1', perDay: '1' } }), e => e.code === 'BadRequest' && /never be delegated/.test(e.message), n);
    assert.ok(!contract.AGENT_ACTIONS.includes(n), `${n} is no agent action`);
  }
  // owner tools: the only write is send_caravan (SendCaravan, delegable); no tool name or schema names a NEVER_DELEGATED action
  const owner = [...TOOLS, COOP_TOOL];
  assert.deepEqual(owner.filter(t => t.annotations.readOnlyHint !== true).map(t => t.name), ['send_caravan']);
  const snake = n => n.replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`);
  for (const t of [...owner, ...PUBLIC_TOOLS]) {
    const text = JSON.stringify({ name: t.name, inputSchema: t.inputSchema });
    for (const n of contract.NEVER_DELEGATED) {
      assert.ok(!text.includes(`"${n}"`) && !t.name.includes(snake(n)), `${t.name} names ${n}`);
    }
  }
  // the public server's modules import no send path, key, store or relay client
  for (const f of ['src/public-mcp.mjs', 'src/public-tools.mjs', 'src/api-keys.mjs', 'src/rate-limit.mjs', 'src/audit.mjs', 'src/exposure.mjs', 'bin/wylls-mcp-public.mjs', 'bin/public-settings.mjs']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    for (const i of imports) assert.doesNotMatch(i, /agent|gateway|relay|solana-tx|talk|seal|store|game\.mjs|auth\.mjs|confirm|receipt|ports\.mjs/, `${f} imports ${i}`);
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /method: 'POST'|\bsubmit\(|signMessage|\/f\/agent/, f);
  }
});

// ------------------------------------------------------------------ E11
test('E11 owner server: daily quota per link before the tool runs; audit lines; proxy address', async () => {
  const issuer = 'http://127.0.0.1:41999';
  let ran = 0;
  const principal = { linkId: 'LINK-SECRET-ID', owner: 'OwnerWallet111', agentId: 'a', scopes: ['wylls.read'] };
  const auth = { issuer, now: () => Date.now(), principal: h => { if (h !== 'Bearer ' + 'x'.repeat(30)) { const e = new Error('nope'); e.error = 'invalid_token'; throw e; } return principal; }, wwwAuthenticate: x => `Bearer ${x}` };
  const mcp = { handle: async m => { ran++; return { jsonrpc: '2.0', id: m.id, result: { content: [], isError: false } }; } };
  const lines = [];
  const audit = createAudit({ write: l => lines.push(l), server: 'owner' });
  const srv = await listen(createHandler({ auth, mcp, allowedHosts: mcpSettings({}).allowedHosts, audit, linkQuota: new DailyQuota({ perDay: 2 }) }));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/mcp`;
    const post = (auth_, method = 'tools/call') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth_ ? { authorization: auth_ } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'get_connection', arguments: { secretArg: 'S3CR3T' } } }) });
    const tok = 'Bearer ' + 'x'.repeat(30);
    assert.equal((await post(tok)).status, 200);
    assert.equal((await post(tok, 'tools/list')).status, 200, 'only tools/call counts');
    assert.equal((await post(tok)).status, 200);
    const over = await post(tok);
    assert.equal(over.status, 429);
    assert.equal((await over.json()).error.data.reason, 'quota');
    assert.equal(ran, 3, 'the refused call did not run');
    assert.equal((await post(null)).status, 401);
    await new Promise(r => setTimeout(r, 20));
    const rows = lines.map(l => JSON.parse(l));
    assert.deepEqual(rows.map(r => [r.status, r.outcome]), [[200, 'ok'], [200, 'ok'], [200, 'ok'], [429, 'QuotaExceeded'], [401, 'Unauthenticated']]);
    assert.match(rows[0].who.id, /^l:[0-9a-f]{16}$/);
    const all = lines.join('');
    for (const s of ['LINK-SECRET-ID', 'OwnerWallet111', 'S3CR3T', 'xxxxxxxxxx', '127.0.0.1']) assert.ok(!all.includes(s), s);
  } finally { await new Promise(r => srv.close(r)); }

  // clientAddress: the peer unless a proxy is trusted; then the right-most X-Forwarded-For entry only
  const req = (xff) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  assert.equal(clientAddress(req('1.2.3.4'), false), '127.0.0.1');
  assert.equal(clientAddress(req('6.6.6.6, 1.2.3.4'), true), '1.2.3.4', 'a client-written left entry is not trusted');
  assert.equal(clientAddress(req(undefined), true), '127.0.0.1');
  assert.equal(clientAddress(req(' , '), true), '127.0.0.1');
});

test('E12 plain(): BigInt, 32-byte keys, other bytes, *_b64 dropped', () => {
  assert.deepEqual(plain({ a: 1n, k: new Uint8Array(32), b: new Uint8Array([1, 2]), bytes_b64: 'x', n: [2n, null] }), { a: '1', k: '11111111111111111111111111111111', b: 'AQI=', n: ['2', null] });
});

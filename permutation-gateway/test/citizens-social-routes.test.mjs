// AC4: the HTTP routes of the social service (contract §8.2, §6.2 rules 6-7):
// the route table (and the absent pact route), refusal bodies and statuses,
// per-IP limits from X-Forwarded-For (trusted only from a loopback peer),
// IPs kept in memory only, the port rule, and compatibility with the real
// herald client (web/frontier/herald.mjs) on real account bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTS } from '../../permutation-server/web/frontier/abi.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { toBase64 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { finalHolding } from '../citizens/social/book.mjs';
import { clientIp, createIpLimiter, isLoopback, portAllowed } from '../citizens/social/limits.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { OPTIONS, SEASON, UNIX0, builders, fakeHerald, get, makeCitizen, makeClock, post, tmpAiDir } from './fixtures/ai-social-kit.mjs';

function world(extra = {}) {
  const clock = makeClock();
  const dir = tmpAiDir();
  const cits = { alice: makeCitizen('alice', { faction: 0 }), bob: makeCitizen('bob', { faction: 1 }) };
  const herald = fakeHerald(Object.values(cits));
  const t = { ms: 1_000_000 };
  const social = createSocial({ herald, aiDir: dir.dir, roster: { season: SEASON, ai: [], script: { wallets: [] }, seat: null }, clock, season: SEASON, now: () => t.ms, config: { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } }, ...extra });
  return { clock, dir, cits, herald, social, t, b: builders(clock) };
}

test('the route table: talk, ballot, inbox, council, council/call; every pact path is 404; nothing else is routed', async () => {
  const w = world();
  for (const path of ['/f/ai/pact', '/f/ai/pacts', '/gw/f/ai/pact', '/gw/f/ai/pacts', '/f/ai/standings.json', '/f/ai/nothing', '/f/ai', '/f/ai/', '/h/ai/pacts/index.json', '/f/aix/talk', '/other']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await w.social.routes.dispatch({ method, path, body: '{}' });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.body.code, 'NotFound');
    }
  }
  // wrong verbs on real routes
  assert.equal((await w.social.routes.dispatch({ method: 'PUT', path: '/f/ai/talk' })).status, 405);
  assert.equal((await w.social.routes.dispatch({ method: 'GET', path: '/f/ai/ballot' })).status, 405);
  assert.equal((await w.social.routes.dispatch({ method: 'POST', path: '/f/ai/council' })).status, 405);
  assert.equal((await w.social.routes.dispatch({ method: 'POST', path: '/f/ai/inbox' })).status, 405);
  // /gw/f/ai/* is the same service
  const t = w.b.talk(w.cits.alice, { text: 'via gw' });
  const r = await post(w.social, '/gw/f/ai/talk', t.body);
  assert.equal(r.status, 200);
  assert.equal((await get(w.social, '/f/ai/talk')).body.messages[0].text, 'via gw');
  assert.equal((await get(w.social, '/gw/f/ai/talk/')).status, 200, 'a trailing slash is tolerated');
});

test('POST talk: the answer shape, refusals with {error, code, detail} and the right status', async () => {
  const w = world();
  const t = w.b.talk(w.cits.alice, { text: 'hello' });
  const ok = await post(w.social, '/f/ai/talk', t.body);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ['bell', 'id', 'inner', 'ok']);
  // refusals
  const bad = await post(w.social, '/f/ai/talk', { bytes_b64: 'AAAA', sig_b64: toBase64(new Uint8Array(64)) });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body).sort(), ['code', 'detail', 'error']);
  assert.equal(bad.body.code, 'BadBytes');
  assert.equal((await post(w.social, '/f/ai/talk', { ...t.body, sig_b64: toBase64(new Uint8Array(64)) })).body.code, 'BadSignature');
  assert.equal((await post(w.social, '/f/ai/talk', w.b.talk(w.cits.alice, { seq: 0 }).body)).body.code, 'SeqReplay');
  assert.equal((await post(w.social, '/f/ai/talk', w.b.talk(w.cits.alice, { bell: 380, seq: 5000 }).body)).body.code, 'BellSkew');
  assert.equal((await post(w.social, '/f/ai/talk', w.b.talk(w.cits.bob, { channel: 1, target: 4 }).body)).body.code, 'NotMember');
  for (let i = 0; i < 2; i++) assert.equal((await post(w.social, '/f/ai/talk', w.b.talk(w.cits.alice, {}).body)).status, 200);
  const limited = await post(w.social, '/f/ai/talk', w.b.talk(w.cits.alice, {}).body);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RateLimited');
  // a text of 281 characters
  const w2 = world();
  const long = await post(w2.social, '/f/ai/talk', { ...w2.b.talk(w2.cits.alice, { text: 'a'.repeat(280) }).body });
  assert.equal(long.status, 200);
  // not JSON, too large
  assert.equal((await w.social.routes.dispatch({ method: 'POST', path: '/f/ai/talk', body: 'not json' })).body.code, 'BadBytes');
  const huge = await w.social.routes.dispatch({ method: 'POST', path: '/f/ai/talk', body: JSON.stringify({ bytes_b64: 'A'.repeat(9000), sig_b64: 'A' }) });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.code, 'BadBytes');
  // not joined; herald down
  assert.equal((await post(w.social, '/f/ai/talk', w.b.talk(makeCitizen('ghost'), {}).body)).body.code, 'NotEligible');
  w.herald.down = true;
  const later = makeCitizen('later', { faction: 2 });
  w.herald.add(later);
  const down = await post(w.social, '/f/ai/talk', w.b.talk(later, {}).body);
  assert.equal(down.status, 503);
  assert.equal(down.body.code, 'HeraldUnavailable');
});

test('GET shapes: talk (after, channel names and numbers, limit), inbox, council; bad queries are BadBytes', async () => {
  const w = world();
  await post(w.social, '/f/ai/talk', w.b.talk(w.cits.alice, { text: 'w' }).body);
  await post(w.social, '/f/ai/talk', w.b.talk(w.cits.alice, { channel: 1, target: 0, text: 'n' }).body);
  await post(w.social, '/f/ai/talk', w.b.talk(w.cits.bob, { channel: 3, target: w.cits.alice.wallet, text: 'd' }).body);
  const all = (await get(w.social, '/f/ai/talk')).body;
  assert.deepEqual(all.messages.map(m => m.text), ['w', 'n', 'd']);
  assert.deepEqual(Object.keys(all.messages[0]).sort(), ['ai_roster', 'ai_written', 'bell', 'channel', 'id', 'inner', 'kind', 'lang', 'name', 'origin', 'ref', 'tag', 'target', 'text', 'wallet']);
  assert.deepEqual((await get(w.social, '/f/ai/talk', { channel: 'nation' })).body.messages.map(m => m.text), ['n']);
  assert.deepEqual((await get(w.social, '/f/ai/talk', { channel: '3' })).body.messages.map(m => m.text), ['d']);
  assert.deepEqual((await get(w.social, '/f/ai/talk', { after: String(all.messages[1].id) })).body.messages.map(m => m.text), ['d']);
  assert.equal((await get(w.social, '/f/ai/talk', { limit: '1' })).body.messages.length, 1);
  for (const q of [{ channel: 'x' }, { channel: '2' }, { after: 'x' }, { after: '-1' }, { limit: '0' }, { limit: 'a' }]) assert.equal((await get(w.social, '/f/ai/talk', q)).body.code, 'BadBytes', JSON.stringify(q));
  const inbox = await get(w.social, '/f/ai/inbox', { wallet: w.cits.alice.b58 });
  assert.deepEqual(inbox.body.messages.map(m => m.text), ['n', 'd']);
  assert.equal((await get(w.social, '/f/ai/inbox', {})).body.code, 'BadBytes');
  assert.equal((await get(w.social, '/f/ai/inbox', { wallet: 'not*base58' })).body.code, 'BadBytes');
  assert.equal((await get(w.social, '/f/ai/inbox', { wallet: '1111' })).body.code, 'BadBytes');
  const c = await get(w.social, '/f/ai/council', { faction: '0' });
  assert.equal(c.status, 200);
  assert.deepEqual(c.body, { period: null, faction: 0, state: 'none', options: [], motions: [], ballots_cast: 0, closes_bell: null, adopted: false, strike_bell: null, call_commit: null });
  assert.equal((await get(w.social, '/f/ai/council', {})).body.code, 'BadBytes');
  assert.equal((await get(w.social, '/f/ai/council', { faction: '300' })).body.code, 'BadBytes');
  w.social.council.open({ faction: 0, period: 2, c0: 48, candidates: OPTIONS });
  w.clock.set(48);
  const open = (await get(w.social, '/f/ai/council', { faction: '0' })).body;
  for (const k of ['period', 'state', 'options', 'motions', 'ballots_cast', 'closes_bell', 'adopted', 'strike_bell', 'call_commit']) assert.ok(k in open, k);
  assert.equal(open.state, 'motions');
  assert.equal((await get(w.social, '/f/ai/council', { faction: '0', period: '2' })).body.period, 2);
  assert.equal((await get(w.social, '/f/ai/council', { faction: '0', period: '9' })).body.state, 'none');
  // call read: malformed query parts
  for (const q of [{}, { faction: '0', period: '2' }, { faction: '0', period: '2', wallet: w.cits.alice.b58 }, { faction: '0', period: '2', wallet: w.cits.alice.b58, unix: 'x', sig: 'AAAA' },
    { faction: '0', period: '2', wallet: w.cits.alice.b58, unix: String(UNIX0), sig: 'AAAA' }, { faction: '0', period: '2', wallet: '1', unix: String(UNIX0), sig: toBase64(new Uint8Array(64)) }]) {
    assert.equal((await get(w.social, '/f/ai/council/call', q)).body.code, 'BadBytes', JSON.stringify(q));
  }
});

test('per-IP limits: X-Forwarded-For counts only from a loopback peer; POST burst 20 then 1/s; GET burst 40 then 4/s; loopback clients are exempt', async () => {
  const w = world();
  const hit = (method, xff, peer = '127.0.0.1') => w.social.routes.dispatch({ method, path: method === 'POST' ? '/f/ai/talk' : '/f/ai/council', query: { faction: '0' }, body: '{}', headers: xff ? { 'x-forwarded-for': xff } : {}, peer });
  // POST burst of 20 from one client, the 21st is limited
  for (let i = 0; i < 20; i++) assert.notEqual((await hit('POST', '203.0.113.5')).status, 429, `post ${i}`);
  const r = await hit('POST', '203.0.113.5');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RateLimited');
  // another client is not affected; GET has its own bucket for the same client
  assert.notEqual((await hit('POST', '203.0.113.6')).status, 429);
  assert.notEqual((await hit('GET', '203.0.113.5')).status, 429);
  // refill: 1/s
  w.t.ms += 1000;
  assert.notEqual((await hit('POST', '203.0.113.5')).status, 429);
  assert.equal((await hit('POST', '203.0.113.5')).status, 429);
  w.t.ms += 3000;
  for (let i = 0; i < 3; i++) assert.notEqual((await hit('POST', '203.0.113.5')).status, 429);
  assert.equal((await hit('POST', '203.0.113.5')).status, 429);
  // GET burst 40 then 4/s
  for (let i = 0; i < 40; i++) assert.notEqual((await hit('GET', '198.51.100.9')).status, 429, `get ${i}`);
  assert.equal((await hit('GET', '198.51.100.9')).status, 429);
  w.t.ms += 1000;
  for (let i = 0; i < 4; i++) assert.notEqual((await hit('GET', '198.51.100.9')).status, 429);
  assert.equal((await hit('GET', '198.51.100.9')).status, 429);
  // loopback clients (bots) are exempt: no header, or a forwarded loopback address
  for (let i = 0; i < 100; i++) assert.notEqual((await hit('POST', null)).status, 429);
  for (let i = 0; i < 100; i++) assert.notEqual((await hit('POST', '127.0.0.1')).status, 429);
  for (let i = 0; i < 100; i++) assert.notEqual((await hit('POST', '::1')).status, 429);
  // the header is not trusted from a non-loopback peer: the peer is the client
  for (let i = 0; i < 20; i++) assert.notEqual((await hit('POST', '127.0.0.1', '192.0.2.50')).status, 429);
  assert.equal((await hit('POST', '127.0.0.1', '192.0.2.50')).status, 429, 'a spoofed loopback header does not exempt a remote peer');
  // the last entry is the proxy\'s: a client cannot hide behind an earlier one
  for (let i = 0; i < 20; i++) assert.notEqual((await hit('POST', '10.9.9.9, 203.0.113.77')).status, 429);
  assert.equal((await hit('POST', '10.9.9.1, 203.0.113.77')).status, 429);
  // an unreadable value from the proxy is not an exemption
  for (let i = 0; i < 20; i++) await hit('POST', 'garbage');
  assert.equal((await hit('POST', 'garbage')).status, 429);
});

test('limits helpers: loopback, client address, the token bucket, the port rule', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) assert.ok(isLoopback(ip), ip);
  for (const ip of ['10.0.0.1', '::2', '192.168.1.1', undefined, '']) assert.ok(!isLoopback(ip), String(ip));
  assert.equal(clientIp('127.0.0.1', undefined), '127.0.0.1');
  assert.equal(clientIp('127.0.0.1', '1.2.3.4'), '1.2.3.4');
  assert.equal(clientIp('127.0.0.1', ['9.9.9.9', '1.2.3.4']), '1.2.3.4');
  assert.equal(clientIp('127.0.0.1', '[2001:db8::1]'), '2001:db8::1');
  assert.equal(clientIp('127.0.0.1', 'nonsense'), 'unknown');
  assert.equal(clientIp('8.8.8.8', '1.2.3.4'), '8.8.8.8');
  assert.equal(clientIp(undefined, '1.2.3.4'), 'unknown');
  const t = { ms: 0 };
  const lim = createIpLimiter({ now: () => t.ms, maxEntries: 5 });
  for (let i = 0; i < 20; i++) assert.ok(lim.allow('1.1.1.1', 'post'));
  assert.ok(!lim.allow('1.1.1.1', 'post'));
  t.ms += 500;
  assert.ok(!lim.allow('1.1.1.1', 'post'), 'half a second is half a token');
  t.ms += 500;
  assert.ok(lim.allow('1.1.1.1', 'post'));
  for (let i = 0; i < 20; i++) lim.allow(`2.2.2.${i}`, 'get');
  assert.ok(lim.size <= 5, 'the table is capped');
  // the port rule: 41901..41999 (and 0 for tests); never 41900, the MC and playtest blocks, or M1's ports
  for (const p of [41901, 41902, 41980, 41981, 41999, 0]) assert.ok(portAllowed(p), String(p));
  for (const p of [41900, 41899, 41100, 41139, 41300, 41041, 41000, 4185, 4190, 4191, 4194, 18899, 17799, 28899, 27799, 26699, 5185, 5191, 42000, -1, 41981.5, '41981', NaN]) assert.ok(!portAllowed(p), String(p));
});

test('IPs are memory only: no file under AI_DIR contains a client address', async () => {
  const w = world();
  const ip = '198.51.100.123';
  const t = w.b.talk(w.cits.alice, { text: 'ip test' });
  await w.social.routes.dispatch({ method: 'POST', path: '/f/ai/talk', body: JSON.stringify(t.body), headers: { 'x-forwarded-for': ip }, peer: '127.0.0.1' });
  await w.social.routes.dispatch({ method: 'GET', path: '/f/ai/talk', headers: { 'x-forwarded-for': ip }, peer: '127.0.0.1' });
  w.social.closeBell(402);
  assert.ok(w.social.routes.limiter.size > 0, 'the limiter holds it in memory');
  const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const files = walk(w.dir.dir);
  assert.ok(files.length >= 3);
  for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(ip) && !readFileSync(f, 'utf8').includes('x-forwarded'), f);
  // and no response carries one
  const r = await get(w.social, '/f/ai/talk', {}, { 'x-forwarded-for': ip });
  assert.ok(!JSON.stringify(r.body).includes(ip));
  // no pact wording in anything published or stored
  for (const f of files) assert.ok(!/pact|betray|promise|alliance/i.test(readFileSync(f, 'utf8')), `no pact wording in ${f}`);
});

test('listen: loopback only, only a port in the AI range (or 0 in tests); a real request round-trips with headers', async () => {
  const w = world();
  assert.throws(() => w.social.routes.listen({ port: 41900 }), /outside the AI range/);
  assert.throws(() => w.social.routes.listen({ port: 4185 }), /outside the AI range/);
  assert.throws(() => w.social.routes.listen({ port: 41100 }), /outside the AI range/);
  assert.throws(() => w.social.routes.listen({ port: 0, host: '0.0.0.0' }), /loopback/);
  const srv = await w.social.routes.listen({ port: 0 });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const t = w.b.talk(w.cits.alice, { text: 'over http' });
    const r = await fetch(`${base}/f/ai/talk`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.44' }, body: JSON.stringify(t.body) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const g = await (await fetch(`${base}/gw/f/ai/talk?channel=world`)).json();
    assert.equal(g.messages[0].text, 'over http');
    assert.equal((await fetch(`${base}/f/ai/pact`, { method: 'POST', body: '{}' })).status, 404);
    const big = await fetch(`${base}/f/ai/talk`, { method: 'POST', body: 'x'.repeat(40_000) });
    assert.equal(big.status, 413);
    const refused = await fetch(`${base}/f/ai/talk`, { method: 'POST', body: '{"bytes_b64":"AA","sig_b64":"AA"}' });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, 'BadBytes');
  } finally {
    await srv.close();
  }
});

// ------------------------------------------------------------------ the real herald client on real account bytes
const u64 = (b, o, v) => new DataView(b.buffer).setBigUint64(o, BigInt(v), true);
const field = (kind, name) => ACCOUNTS[kind].fields.find(f => f[0] === name);
function accountBytes(kind, set) {
  const layout = ACCOUNTS[kind];
  const b = new Uint8Array(layout.size);
  b.set(new TextEncoder().encode(layout.magic), 0);
  for (const [name, v] of Object.entries(set)) {
    const [, off, len, ty] = field(kind, name);
    if (ty === 'u64' || ty === 'i64') new DataView(b.buffer).setBigInt64(off, BigInt(v), true);
    else if (ty === 'u8') b[off] = v;
    else if (ty === 'u32') new DataView(b.buffer).setUint32(off, v, true);
    else if (/^\[u8;\d+\]$/.test(ty)) b.set(v, off);
    else throw new Error(`test builder: ${ty}`);
    void len;
  }
  return b;
}

test('the real herald client (createHerald over HTTP, real Citizen and Holding bytes) feeds the book: session, expiry, faction, tag and the final-holding vote check', async () => {
  const w0 = world();
  const alice = makeCitizen('real-alice', { faction: 3 });
  const holding = accountBytes('Holding', { SEASON_ID: SEASON, STATE: 2, FACTION: 3 });
  const citizen = accountBytes('Citizen', { SEASON_ID: SEASON, WALLET: alice.wallet, SESSION: alice.key.pub, SESSION_EXPIRY: UNIX0 + 10 ** 6, FACTION: 3, HOLDINGS_N: 1, CITIZEN_TAG: alice.tag });
  void u64;
  const server = createServer((req, res) => {
    if (req.url === `/h/me/${alice.b58}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ v: 1, wallet: alice.b58, citizen: { address: 'x', bytes_b64: toBase64(citizen) }, holdings: [{ address: 'y', bytes_b64: toBase64(holding) }] }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const herald of [createHerald({ base, seasonId: String(SEASON) }), base]) {
      const clock = makeClock();
      const social = createSocial({ herald, aiDir: null, roster: { season: SEASON }, clock, season: SEASON, config: { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } } });
      const b = builders(clock);
      const ok = await post(social, '/f/ai/talk', b.talk(alice, { channel: 1, target: 3, text: 'real bytes' }).body);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const m = (await get(social, '/f/ai/talk')).body.messages[0];
      assert.equal(m.tag, alice.tag.toString(16).padStart(16, '0'), 'the citizen_tag from the Citizen bytes');
      // the council counts the stored final Holding
      social.council.open({ faction: 3, period: 2, c0: clock.bell(), candidates: OPTIONS });
      const mo = await social.book.submit('talk', b.talk(alice, { channel: 1, target: 3, kind: 1, ref: (2n << 8n) | 1n, text: 'move' }).body);
      assert.ok(mo.ok);
      // a signature by another key is refused against the real session key
      const forged = b.talk({ ...alice, key: makeCitizen('other').key }, { text: 'forged' });
      assert.equal((await post(social, '/f/ai/talk', forged.body)).body.code, 'BadSignature');
    }
    // not joined: the real client answers NotFound
    const clock = makeClock();
    const social = createSocial({ herald: createHerald({ base, seasonId: String(SEASON) }), roster: { season: SEASON }, clock, season: SEASON });
    assert.equal((await post(social, '/f/ai/talk', builders(clock).talk(w0.cits.alice, {}).body)).body.code, 'NotEligible');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('a recorded /h/me answer from the real herald (a paused local run, GET only): the Citizen decodes, its Holding is final, the tag is the 16-hex citizen_tag', async () => {
  const me = JSON.parse(readFileSync(new URL('./fixtures/ai-social-me-recorded.json', import.meta.url), 'utf8'));
  const server = createServer((req, res) => { res.writeHead(req.url === `/h/me/${me.wallet}` ? 200 : 404, { 'content-type': 'application/json' }); res.end(req.url === `/h/me/${me.wallet}` ? JSON.stringify(me) : '{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const clock = makeClock();
    const social = createSocial({ herald: `http://127.0.0.1:${server.address().port}`, roster: { season: 7 }, clock, season: 7 });
    const r = await social.book.resolveMe(me.wallet);
    assert.equal(r.ok, true);
    assert.equal(r.citizen.faction, 1);
    assert.equal(r.citizen.session.length, 32);
    assert.equal(r.holdings.length, 1);
    assert.ok(finalHolding(r.holdings[0], UNIX0), 'state 2 is final');
    assert.equal(r.citizen.citizenTag.toString(16), '4784603dd5d3250b');
    assert.equal((await social.book.resolveMe('11111111111111111111111111111111')).ok, false);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('a Call read whose signature kept a "+" unencoded in the query still verifies (a query turns "+" into a space)', async () => {
  const w = world();
  // Find a signature that contains "+" by varying the unix stamp.
  let q;
  w.social.council.open({ faction: 0, period: 2, c0: 402, candidates: OPTIONS });
  for (let i = 0; i < 200 && !q; i++) { const c = w.b.callRead(w.cits.alice, { period: 2, unix: UNIX0 + i }); if (c.sig.includes('+')) q = c; }
  assert.ok(q, 'a signature with + exists in 200 tries');
  const r = await get(w.social, '/f/ai/council/call', { ...q, sig: q.sig.replace(/\+/g, ' ') });
  assert.equal(r.body.code, 'WindowClosed', 'it got past the signature check (no sealed Call yet)');
});

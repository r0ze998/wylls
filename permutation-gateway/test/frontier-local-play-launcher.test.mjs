import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { validWallet, parseStart, WorldManager, createLauncherServer, WORLD_TTL_MS, WORLD_EXPIRY_SCHEMA, CANDIDATE_PROGRAM, candidateMetaAgrees } from '../src/frontier/local-play-launcher.mjs';
// A world's automatic end (2026-11-13 contract): exactly these keys, fixed once at the world's TTL origin with this
// launcher's TTL, `expiresAt == startedAt + ttlMs`, bound to the runner's instance (these stand-in runners state none:
// null). Not loosened: every field is checked.
function assertExpiry(e, ttlMs = WORLD_TTL_MS, instance = null) {
  assert.deepEqual(Object.keys(e), ['schema', 'startedAt', 'ttlMs', 'expiresAt', 'instance']);
  assert.equal(e.schema, WORLD_EXPIRY_SCHEMA);
  assert.ok(Number.isSafeInteger(e.startedAt) && e.startedAt > 0, 'the TTL origin, ms');
  assert.equal(e.ttlMs, ttlMs, 'this launcher\'s TTL');
  assert.equal(e.expiresAt, e.startedAt + e.ttlMs, 'fixed at its origin');
  assert.equal(e.instance, instance, 'bound to the runner instance it stated');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const wallet = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const other = '11111111111111111111111111111111';
const third = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
test('only canonical public keys and exactly one field', () => {
 assert.ok(validWallet(wallet)); assert.equal(parseStart({wallet}), wallet);
 for (const x of [null, {}, {wallet, command:'x'}, {wallet: 'a'}, {wallet: wallet + '1'}, {wallet: 'O'.repeat(32)}, [wallet]]) assert.throws(()=>parseStart(x));
});
test('same wallet double press shares one launch, world limit never evicts a player', async () => {
 let count=0, done; const m=new WorldManager({}, async()=>{count++; await new Promise(r=>done=r); return {herald:'http://localhost:41926',stop(){}};});
 const a=m.start(wallet),b=m.start(wallet); assert.equal(a,b); await Promise.resolve(); assert.equal(count,1); done(); assert.deepEqual(await a,{herald:'http://localhost:41926'});
 const c=m.start(other); await Promise.resolve(); await assert.rejects(m.start(third),e=>e.code==='WorldLimit'); done(); await c; m.close(); await assert.rejects(m.start(third),e=>e.code==='LauncherClosed');
});
test('failed startup frees reservation and old cleanup cannot remove new same-wallet world', async()=>{
 let cleanup; let n=0; const m=new WorldManager({},async(c,w,s,onStop)=>{if(++n===1){cleanup=onStop;throw Error('fail');}return{herald:'http://localhost:41926',stop(){}};});
 await assert.rejects(m.start(wallet)); await m.start(wallet); cleanup(); assert.equal(m.worlds.size,1); m.close();
});
test('shutdown aborts startup without waiting for ready', async()=>{
 let aborted=false; const m=new WorldManager({},async(c,w,s,stop,signal)=>{await new Promise(r=>signal.addEventListener('abort',()=>{aborted=true;r();}));return {herald:'x',stop(){}};});
 const p=m.start(wallet); await Promise.resolve(); m.close(); await assert.rejects(p); assert.equal(aborted,true);
});
function request(port, method, route, body, headers={}) { return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,method,path:route,headers:{host:`localhost:${port}`,...headers}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve({status:res.statusCode,body:s,headers:res.headers}));});req.on('error',reject);req.end(body);});}
test('HTTP is strict same-origin POST; static original page/config paths work', async t=>{
 let called=0; const c={port:41920,web:path.join(root,'permutation-server/web')};
 const {server}=createLauncherServer(c,{start:async w=>{called++;assert.equal(w,wallet);return{herald:'http://localhost:41926'};},close(){}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 // The allowed Host is pinned to configured port, independently of the transport port in this test.
 const h={host:'localhost:41920',origin:'http://localhost:41920','content-type':'application/json'};
 t.after(()=>new Promise(r=>server.close(r)));
 let r=await request(port,'POST','/local-play/start',JSON.stringify({wallet}),h);assert.equal(r.status,200);assert.equal(called,1);
 for (const headers of [{...h,origin:'http://evil.example'},{...h,origin:undefined},{...h,host:'evil.example'},{...h,'content-type':'text/plain'}]) {
  for(const k of Object.keys(headers))if(headers[k]===undefined)delete headers[k];
  r=await request(port,'POST','/local-play/start',JSON.stringify({wallet}),headers);assert.equal(r.status,403);
 }
 assert.equal((await request(port,'GET','/local-play/start',null,h)).status,405);
 assert.equal((await request(port,'POST','/local-play/start','x'.repeat(257),h)).status,413);
 assert.equal((await request(port,'POST','/local-play/start',JSON.stringify({wallet,runner:'/x'}),h)).status,400);
 assert.equal(called,1);
 for(const file of ['frontier/index.html','frontier/config.mjs','frontier/app.mjs','sdk/base58.mjs']){
  r=await request(port,'GET','/frontier/'+file,null,h);assert.equal(r.status,200,file);assert.equal(r.headers['cache-control'],'no-store');
 }
 assert.equal((await request(port,'GET','/',null,h)).headers.location,'/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off');
 assert.notEqual((await request(port,'GET','/frontier/%2e%2e/%2e%2e/etc/passwd',null,h)).status,200);
});

// ---------------------------------------------------------------------------------------------------------------
// The explicit end of a world, the world proxy's limits (routes, origins, destinations, sizes, WebSocket), the static
// page's headers, and a world of stub processes. No key, no chain, no real runner: `startWorld` is run with three
// tiny stand-in executables written to a temporary directory.
import net from 'node:net';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { createWorldProxy, startWorld, parseConfig, HERALD_OUTPUT_MODE, worldTarget, worldPorts, WORLD_POST_ROUTES, WORLD_GET_ROUTES, WORLD_WS_ROUTE, WORLD_BODY_MAX, WORLD_LIMIT, PREPARE_SCALE_MIN, PREPARE_SCALE_MAX, PREPARE_CHAIN_MAX,
  conquestProof, conquestGateway, CONQUEST_WORLD_PRESET, CONQUEST_ARTIFACT_MARKERS, CONQUEST_CAPABILITY_SCHEMA, CONQUEST_WORLD_SCHEMA, CONQUEST_STATEMENT_MS } from '../src/frontier/local-play-launcher.mjs';
import { createHash } from 'node:crypto';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
const tick = () => new Promise(r => setImmediate(r));
const until = async (what, ok, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await ok()) return; await new Promise(r => setTimeout(r, 25)); } assert.fail(`timed out: ${what}`); };
/** One raw exchange: `text` as sent, everything answered until the peer closes (or `ms`). */
const raw = (port, text, ms = 1500) => new Promise(resolve => { let got = ''; const s = net.connect(port, '127.0.0.1', () => s.write(text)); const done = () => { s.destroy(); resolve(got); }; s.on('data', b => { got += b; }); s.on('close', done); s.on('error', done); setTimeout(done, ms).unref(); });
const statusOf = text => Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);

test('at the limit a start is refused with the worlds it runs; only the explicit stop of one named world frees a place', async () => {
  const stops = [];
  const m = new WorldManager({}, async (c, w, slot) => ({ herald: `http://localhost:${41926 + slot * 5}`, stop: async reason => { stops.push([w, reason]); } }));
  await m.start(wallet); await m.start(other);
  const refused = await m.start(third).catch(e => e);
  assert.equal(refused.code, 'WorldLimit'); assert.equal(refused.status, 409);
  assert.deepEqual(refused.worlds.map(w => [w.wallet, w.herald, w.state]), [[wallet, 'http://localhost:41926', 'running'], [other, 'http://localhost:41931', 'running']]);
  assert.ok(refused.worlds.every(w => Number.isFinite(w.startedAt) && Object.keys(w).length === 4), 'public addresses, where, since when, state: nothing else');
  assert.deepEqual(stops, [], 'the refused start stopped nothing'); assert.equal(m.worlds.size, 2);
  await assert.rejects(m.stop(third), e => e.code === 'WorldNotFound' && e.status === 404);
  for (const bad of ['x', '', null, wallet + '1', { wallet }]) await assert.rejects(m.stop(bad), e => e.code === 'InvalidWallet');
  assert.deepEqual(stops, []);
  assert.deepEqual(await m.stop(other), { stopped: true }); assert.deepEqual(stops, [[other, 'requested']], 'only the named world');
  assert.deepEqual(m.list().map(w => w.wallet), [wallet], 'the other world goes on');
  await assert.rejects(m.stop(other), e => e.code === 'WorldNotFound', 'it is gone: a second press finds nothing');
  assert.deepEqual(await m.start(third), { herald: 'http://localhost:41931' }, 'the freed place is the one taken');
  assert.deepEqual(stops, [[other, 'requested']]);
  await m.close(); assert.deepEqual(stops.map(s => s[1]).sort(), ['launcher-closing', 'launcher-closing', 'requested']);
});

test('a world still starting is stopped where it is; the launcher closing waits for its worlds', async () => {
  let n = 0, reason = null;
  const m = new WorldManager({}, async (c, w, s, onStop, signal) => {
    if (++n === 1) { await new Promise(r => signal.addEventListener('abort', r)); reason = signal.reason; throw Object.assign(new Error('WorldStopped'), { code: 'WorldStopped', status: 503 }); }
    return { herald: 'http://localhost:41926', stop() {} };
  });
  const p = m.start(wallet); await tick(); assert.equal(m.list()[0].state, 'starting'); assert.equal(m.list()[0].herald, null);
  const stopping = m.stop(wallet); assert.equal(m.list()[0].state, 'stopping');
  await assert.rejects(m.start(wallet), e => e.code === 'WorldStopping' && e.status === 409, 'not joined to a world that is ending');
  assert.equal(m.stop(wallet) instanceof Promise, true);
  assert.deepEqual(await stopping, { stopped: true }); await assert.rejects(p, e => e.code === 'WorldStopped'); assert.equal(reason, 'requested'); assert.equal(m.worlds.size, 0);
  assert.deepEqual(await m.start(wallet), { herald: 'http://localhost:41926' }, 'the same address may start again');
  // closing: resolved only when every world's own stop has finished
  let release; const ended = [];
  const slow = new WorldManager({}, async (c, w) => ({ herald: 'http://localhost:41926', stop: async r => { await new Promise(x => { release = x; }); ended.push([w, r]); } }));
  await slow.start(wallet); let closed = false; const closing = slow.close().then(() => { closed = true; });
  await tick(); await tick(); assert.equal(closed, false); release(); await closing; assert.deepEqual(ended, [[wallet, 'launcher-closing']]);
  await assert.rejects(slow.start(other), e => e.code === 'LauncherClosed');
});

test('HTTP: the stop route is as strict as the start route; a refusal names the worlds; nothing of the system leaks', { timeout: 120000 }, async t => {
  const calls = []; let startError = null, stopError = null;
  const c = { port: 41920, worldPort: 41924, web: path.join(root, 'permutation-server/web') };
  let listed = [];
  const { server } = createLauncherServer(c, { start: async w => { calls.push(['start', w]); if (startError) throw startError; return { herald: 'http://localhost:41926' }; }, stop: async w => { calls.push(['stop', w]); if (stopError) throw stopError; return { stopped: true }; }, list: () => { calls.push(['list']); return listed; }, close() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  t.after(() => new Promise(r => server.close(r)));
  const h = { host: 'localhost:41920', origin: 'http://localhost:41920', 'content-type': 'application/json' };
  let r = await request(port, 'POST', '/local-play/stop', JSON.stringify({ wallet }), h);
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { stopped: true }); assert.deepEqual(calls, [['stop', wallet]]);
  assert.equal(r.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'"); assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['access-control-allow-origin'], undefined);
  for (const headers of [{ ...h, origin: 'http://evil.example' }, { ...h, origin: 'http://localhost:41926' }, { ...h, origin: 'null' }, { ...h, origin: undefined }, { ...h, host: 'evil.example' }, { ...h, host: 'localhost:41926' }, { ...h, 'content-type': 'text/plain' }, { ...h, 'content-type': 'application/x-www-form-urlencoded' }]) {
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    r = await request(port, 'POST', '/local-play/stop', JSON.stringify({ wallet }), headers); assert.equal(r.status, 403, JSON.stringify(headers));
  }
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await request(port, method, '/local-play/stop', null, h)).status, 405, method);
  assert.equal((await request(port, 'POST', '/local-play/stop', 'x'.repeat(257), h)).status, 413);
  for (const body of ['{', '[]', '"x"', JSON.stringify({ wallet: 'x' }), JSON.stringify({ wallet, all: true }), JSON.stringify({ wallet, pid: 1 }), JSON.stringify({ wallets: [wallet] }), JSON.stringify({})]) assert.equal((await request(port, 'POST', '/local-play/stop', body, h)).status, 400, body);
  assert.deepEqual(calls, [['stop', wallet]], 'none of those reached a world');
  // the manager's own refusals come back as they are; the limit with its worlds
  stopError = Object.assign(new Error('WorldNotFound'), { code: 'WorldNotFound', status: 404 });
  r = await request(port, 'POST', '/local-play/stop', JSON.stringify({ wallet }), h); assert.equal(r.status, 404); assert.deepEqual(JSON.parse(r.body), { error: 'WorldNotFound' });
  const worlds = [{ wallet, herald: 'http://localhost:41926', startedAt: 1, state: 'running' }, { wallet: other, herald: null, startedAt: 2, state: 'starting' }];
  startError = Object.assign(new Error('WorldLimit'), { code: 'WorldLimit', status: 409, worlds });
  r = await request(port, 'POST', '/local-play/start', JSON.stringify({ wallet: third }), h); assert.equal(r.status, 409); assert.deepEqual(JSON.parse(r.body), { error: 'WorldLimit', worlds });
  // anything that is not this launcher's own refusal is one opaque code
  startError = Object.assign(new Error('spawn /secret/path/runner ENOENT'), { code: 'ENOENT', path: '/secret/path/runner' });
  r = await request(port, 'POST', '/local-play/start', JSON.stringify({ wallet: third }), h); assert.equal(r.status, 503); assert.deepEqual(JSON.parse(r.body), { error: 'LauncherUnavailable' });
  // the list, when the page asks: the same strictness, a body that names nothing, public addresses back
  calls.length = 0; listed = worlds;
  r = await request(port, 'POST', '/local-play/worlds', '{}', h); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { worlds }); assert.deepEqual(calls, [['list']]);
  assert.equal(r.headers['access-control-allow-origin'], undefined); assert.equal(r.headers['cache-control'], 'no-store');
  for (const headers of [{ ...h, origin: 'http://evil.example' }, { ...h, origin: 'http://localhost:41926' }, { ...h, origin: undefined }, { ...h, host: 'evil.example' }, { ...h, 'content-type': 'text/plain' }]) {
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    assert.equal((await request(port, 'POST', '/local-play/worlds', '{}', headers)).status, 403, JSON.stringify(headers));
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) assert.equal((await request(port, method, '/local-play/worlds', null, h)).status, 405, method);
  for (const body of ['', '{', '[]', 'null', '"x"', '5', JSON.stringify({ wallet }), JSON.stringify({ all: true }), JSON.stringify({ limit: 100 })]) assert.equal((await request(port, 'POST', '/local-play/worlds', body, h)).status, 400, body);
  assert.equal((await request(port, 'POST', '/local-play/worlds', ' '.repeat(300), h)).status, 413);
  assert.deepEqual(calls, [['list']], 'none of those was answered with the list');
  // no other route: nothing else lists, names or starts anything
  for (const route of ['/local-play', '/local-play/', '/local-play/worlds/', '/local-play/world', '/local-play/start/x', '/local-play/stop/' + wallet, '/local-play/exec', '/h/season', '/gw/f/local-play/info']) assert.equal((await request(port, 'GET', route, null, h)).status, 404, route);
  // the page: the herald's own policy, and beside itself only the two places a world of this launcher can be
  r = await request(port, 'GET', '/frontier/frontier/index.html', null, h); assert.equal(r.status, 200);
  assert.equal(r.headers['content-security-policy'], "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' http://localhost:41926 ws://localhost:41926 http://localhost:41931 ws://localhost:41931; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'");
  assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['referrer-policy'], 'no-referrer'); assert.match(r.headers['content-type'], /^text\/html/);
  assert.equal((await request(port, 'GET', '/frontier/frontier/wasm/frontier.wasm', null, h)).headers['content-type'], 'application/wasm');
  assert.equal((await request(port, 'GET', '/frontier/frontier/flocalplay.css', null, h)).headers['content-type'], 'text/css');
  assert.equal((await request(port, 'HEAD', '/frontier/frontier/index.html', null, h)).status, 200);
  // what is not a file of the page is simply not found
  assert.match((await request(port, 'GET', '/frontier/frontier/', null, h)).headers['content-type'], /^text\/html/, 'a directory is its index page');
  for (const route of ['/frontier/frontier/nope.mjs', '/frontier/frontier', '/frontier/frontier/art/', '/frontier/%E0%A4%A', '/frontier/a%00b', '/frontier/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/frontier/..%2f..%2fpermutation-gateway/src/frontier/local-play-launcher.mjs', '/favicon.ico']) {
    r = await request(port, 'GET', route, null, h); assert.equal(r.status, 404, route); assert.deepEqual(JSON.parse(r.body), { error: 'NotFound' }, route);
  }
  assert.equal((await request(port, 'POST', '/frontier/frontier/index.html', '{}', h)).status, 405);
});

/** A stand-in herald behind a real world proxy. `seen`: what reached it. The proxy's Host is pinned to 41926 whatever port the test listens on. */
async function proxied(t) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', b => { body += b; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(req.url.startsWith('/h/missing') ? 404 : 200, { 'content-type': 'application/json', 'cache-control': 'max-age=30', etag: '"e1"', 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true', 'set-cookie': 'a=b', 'x-secret': '1', location: 'http://evil.example/' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upgraded = new Set();
  upstream.on('upgrade', (req, socket) => { seen.push({ upgrade: req.url, headers: req.headers }); upgraded.add(socket); socket.on('error', () => {}); socket.on('end', () => socket.destroy()); socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); socket.on('data', b => socket.write(b)); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createWorldProxy({ port: 41926, targetPort: upstream.address().port, launcherPort: 41920 });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { await proxy.closeNow(); for (const s of upgraded) s.destroy(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); });
  return { port: proxy.address().port, target: upstream.address().port, seen, proxy, upstream };
}
const H = { host: 'localhost:41926' }, O = { ...H, origin: 'http://localhost:41920' }, J = { ...O, 'content-type': 'application/json' };
const errorOf = r => { try { return JSON.parse(r.body).error; } catch { return null; } };

test('world proxy: the herald\'s reads and the relay\'s pins pass, with nothing of the browser\'s but the path', { timeout: 120000 }, async t => {
  const w = await proxied(t);
  let r = await request(w.port, 'GET', '/h/season', null, { ...O, cookie: 'session=1', authorization: 'Bearer x', 'x-payment': 'abc', 'x-forwarded-for': '203.0.113.9', accept: 'application/json', 'if-none-match': '"e1"' });
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal(w.seen.length, 1); assert.equal(w.seen[0].method, 'GET'); assert.equal(w.seen[0].url, '/h/season'); assert.equal(w.seen[0].body, '');
  assert.deepEqual(Object.keys(w.seen[0].headers).sort(), ['accept', 'connection', 'host'], 'no cookie, authorization, payment, forwarded address or origin goes on');
  assert.equal(w.seen[0].headers.host, `127.0.0.1:${w.target}`, 'always this world\'s herald');
  // what comes back: the answer, its type and caching, and this proxy's own headers; never the herald's `*`, a cookie or a redirect
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:41920'); assert.equal(r.headers.vary, 'Origin'); assert.equal(r.headers['cache-control'], 'max-age=30'); assert.equal(r.headers.etag, '"e1"'); assert.match(r.headers['content-type'], /json/);
  for (const absent of ['access-control-allow-credentials', 'set-cookie', 'x-secret', 'location']) assert.equal(r.headers[absent], undefined, absent);
  assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'"); assert.equal(r.headers['x-frame-options'], 'DENY');
  // the launcher's other name, and no browser at all (the launcher's own readiness probe)
  r = await request(w.port, 'GET', '/h/season', null, { host: '127.0.0.1:41926', origin: 'http://127.0.0.1:41920' }); assert.equal(r.status, 200); assert.equal(r.headers['access-control-allow-origin'], 'http://127.0.0.1:41920');
  r = await request(w.port, 'GET', '/h/status', null, H); assert.equal(r.status, 200); assert.equal(r.headers['access-control-allow-origin'], undefined, 'no origin asked, none named');
  // every shape of read the page makes
  const reads = ['/h/me/' + wallet, '/h/province/-4,0/latest', '/h/holding/1,0,3.json', '/h/overview2/3/12.bin', '/h/events?after=500', '/h/world/wide/route?at=1%2C2%3B3%2C-4', '/h/wide-index/events?after=1&limit=2', '/h/ai/council/3-0.json', '/gw/f/local-play/info'];
  for (const route of reads) { w.seen.length = 0; r = await request(w.port, 'GET', route, null, O); assert.equal(r.status, 200, route); assert.equal(w.seen[0].url, route, 'passed on exactly as asked'); }
  assert.deepEqual(WORLD_GET_ROUTES, ['/gw/f/local-play/info']);
  w.seen.length = 0; r = await request(w.port, 'HEAD', '/h/season', null, O); assert.equal(r.status, 200); assert.equal(w.seen[0].method, 'HEAD');
  r = await request(w.port, 'GET', '/h/missing/x', null, O); assert.equal(r.status, 404, 'the herald\'s own answer'); assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:41920');
  // a body on a read is not passed on
  w.seen.length = 0; r = await request(w.port, 'GET', '/h/season', 'not for you', { ...O, 'content-type': 'text/plain', 'content-length': '11' }); assert.equal(r.status, 200); assert.equal(w.seen[0].body, ''); assert.equal(w.seen[0].headers['content-type'], undefined);
});

test('world proxy: writes are only the local-play relay\'s JSON routes, each with its preflight; no page, no other route', { timeout: 120000 }, async t => {
  const w = await proxied(t);
  for (const route of WORLD_POST_ROUTES) {
    w.seen.length = 0;
    let r = await request(w.port, 'OPTIONS', route, null, { ...O, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' });
    assert.equal(r.status, 204, route); assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:41920'); assert.equal(r.headers['access-control-allow-methods'], 'POST'); assert.equal(r.headers['access-control-allow-headers'], 'content-type');
    assert.equal(r.headers['access-control-allow-credentials'], undefined); assert.equal(w.seen.length, 0, 'the preflight is answered here');
    r = await request(w.port, 'POST', route, '{"a":1}', { ...J, cookie: 'x=1', 'x-payment': 'abc' });
    assert.equal(r.status, 200, route); assert.equal(w.seen.length, 1); assert.equal(w.seen[0].method, 'POST'); assert.equal(w.seen[0].url, route); assert.equal(w.seen[0].body, '{"a":1}');
    assert.deepEqual(Object.keys(w.seen[0].headers).sort(), ['connection', 'content-length', 'content-type', 'host']); assert.equal(w.seen[0].headers['content-type'], 'application/json');
    assert.equal((await request(w.port, 'GET', route, null, O)).status, 405, `${route} is not a read`);
  }
  w.seen.length = 0;
  // the list is the relay's own: every route its tables name, and nothing more
  const tables = await Promise.all(['local-play-relay', 'local-play-reveal', 'local-play-resident', 'local-play-preview', 'local-play-conquest'].map(f => import(`../src/frontier/${f}.mjs`)));
  // (2026-11-12, Fable: the read-only reservation read is one more route of the conquest block, named by its own module)
  const orders = await import('../src/frontier/local-play-conquest-orders.mjs');
  assert.equal(orders.CONQUEST_ORDERS_ROUTE, 'POST /f/local-play/conquest/orders');
  // (2026-11-12, Fable: and the three routes of the page-signed economy commands, named by their own module)
  const economy = await import('../src/frontier/local-play-act.mjs');
  assert.deepEqual(economy.LOCAL_ACT_ROUTES, { context: 'POST /f/local-play/act/context', submit: 'POST /f/local-play/act/submit', status: 'POST /f/local-play/act/status' });
  const named = [...Object.values(tables[0].ROUTES), ...Object.values(tables[1].REVEAL_ROUTES), ...Object.values(tables[2].RESIDENT_ROUTES), tables[3].LOCAL_PLAY_PREVIEW_ROUTE, ...Object.values(tables[4].CONQUEST_ROUTES), orders.CONQUEST_ORDERS_ROUTE,
    ...Object.values(economy.LOCAL_ACT_ROUTES)];
  // (2026-11-13, Opus: and the ordinary march's two routes, named by their own module, served with the economy routes)
  const march = await import('../src/frontier/local-play-march.mjs');
  assert.deepEqual(march.LOCAL_MARCH_ROUTES, { capability: 'POST /f/local-play/march/capability', submit: 'POST /f/local-play/march/submit', status: 'POST /f/local-play/march/status' });
  named.push(...Object.values(march.LOCAL_MARCH_ROUTES));
  // (and every table the relay's listener serves is one of those five: a new one must be added above and to the list)
  const serverSource = (await fsp.readFile(new URL('../src/frontier/local-play-relay-server.mjs', import.meta.url), 'utf8'));
  // (2026-11-12, Fable: the page-signed economy commands are a sixth table, `LOCAL_ACT_ROUTES` of local-play-act.mjs,
  //  served by the listener only when the relay was started with `--economy page-signed-v1`)
  assert.deepEqual([...new Set([...serverSource.matchAll(/\[((?:[A-Z_]+_)?ROUTES?)(?:\.[a-z]+)?\]:/g)].map(m => m[1]))].sort(), ['CONQUEST_ORDERS_ROUTE', 'CONQUEST_ROUTES', 'LOCAL_ACT_ROUTES', 'LOCAL_MARCH_ROUTES', 'LOCAL_PLAY_PREVIEW_ROUTE', 'RESIDENT_ROUTES', 'REVEAL_ROUTES', 'ROUTES']);
  { const from = serverSource.indexOf('...(act ? {'), block = serverSource.slice(from, serverSource.indexOf('} : {}),', from));
    assert.ok(from > 0 && ['context', 'submit', 'status'].every(k => block.includes(`[LOCAL_ACT_ROUTES.${k}]: async body => act.${k}(body),`)), 'the three economy routes stand inside the listener\'s `act` block, nowhere else'); }
  { const from = serverSource.indexOf('...(march ? {'), block = serverSource.slice(from, serverSource.indexOf('} : {}),', from));
    assert.ok(from > 0 && ['capability', 'submit', 'status'].every(k => block.includes(`[LOCAL_MARCH_ROUTES.${k}]: async body => march.${k}(body),`)), 'the three march routes stand inside the listener\'s `march` block, nowhere else'); }
  // (the orders route stands inside the conquest block of the listener, nowhere else: closed with the conquest routes)
  { const from = serverSource.indexOf('...(conquest ? {'), block = serverSource.slice(from, serverSource.indexOf('} : {}),', from));
    assert.ok(from > 0 && block.includes('[CONQUEST_ORDERS_ROUTE]: async body => conquest.orders(body),')); assert.equal([...serverSource.matchAll(/\[CONQUEST_ORDERS_ROUTE\]/g)].length, 1); }
  assert.deepEqual(named.filter(x => x.startsWith('POST ')).map(x => '/gw' + x.slice(5)).sort(), [...WORLD_POST_ROUTES].sort(), 'a relay route must be named in WORLD_POST_ROUTES to be reachable (and none is named that the relay lacks)');
  assert.deepEqual(named.filter(x => x.startsWith('GET ')).map(x => '/gw' + x.slice(4)).sort(), [...WORLD_GET_ROUTES].sort());
  // every other relay route, the page itself, the launcher's routes: not here
  for (const route of ['/gw/f/proto/land', '/gw/f/reveal', '/gw/f/prize', '/gw/f/quota', '/gw/f/join', '/gw/f/expedition/prepare', '/gw/f/local-play/depart', '/gw/f/local-play/depart/submit/x', '/gw/f/local-play/conquest', '/gw/f/local-play/conquest/declare', '/gw/f/local-play/siege/submit', '/gw', '/gw/', '/frontier/frontier/index.html', '/frontier/frontier/app.mjs', '/local-play/start', '/local-play/stop', '/', '/h', '/admin']) {
    for (const [method, headers, body] of [['GET', O, null], ['POST', J, '{}'], ['OPTIONS', { ...O, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, null]]) {
      const r = await request(w.port, method, route, body, headers); assert.ok(r.status === 404 || r.status === 400, `${method} ${route}: ${r.status}`); assert.ok(['WorldRouteDenied', 'BadWorldPath'].includes(errorOf(r)), `${method} ${route}: ${r.body}`);
    }
  }
  // a read is not written to, a pin is not posted, and no other method exists
  for (const [method, route, headers] of [['POST', '/h/season', J], ['POST', '/gw/f/local-play/info', J], ['PUT', '/h/season', J], ['DELETE', '/h/season', O], ['PATCH', WORLD_POST_ROUTES[0], J], ['PUT', WORLD_POST_ROUTES[0], J], ['DELETE', WORLD_POST_ROUTES[0], O]]) assert.equal((await request(w.port, method, route, method === 'DELETE' ? null : '{}', headers)).status, 405, `${method} ${route}`);
  // a preflight for anything but such a write is refused: a read, another method, another header, no or another origin
  const pre = (route, over = {}) => request(w.port, 'OPTIONS', route, null, Object.fromEntries(Object.entries({ ...O, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', ...over }).filter(([, v]) => v !== undefined)));
  const route = WORLD_POST_ROUTES[1];
  for (const [at, over] of [['/h/season', {}], ['/h/season', { 'access-control-request-method': 'GET' }], ['/gw/f/local-play/info', { 'access-control-request-method': 'GET' }], [route, { 'access-control-request-method': 'GET' }], [route, { 'access-control-request-method': 'PUT' }], [route, { 'access-control-request-method': 'DELETE' }], [route, { 'access-control-request-method': undefined }],
    [route, { 'access-control-request-headers': 'content-type, x-payment' }], [route, { 'access-control-request-headers': 'authorization' }], [route, { 'access-control-request-headers': 'content-type,cookie' }], [route, { origin: undefined }], [route, { origin: 'http://evil.example' }]]) {
    const r = await pre(at, over); assert.equal(r.status, 403, `${at} ${JSON.stringify(over)}`); assert.equal(r.headers['access-control-allow-methods'], undefined); assert.equal(r.headers['access-control-allow-headers'], undefined);
  }
  assert.equal(w.seen.length, 0, 'none of it reached the world');
});

test('world proxy: only the launcher page\'s exact origins; a write always names one; never `*`, never credentials', { timeout: 120000 }, async t => {
  const w = await proxied(t);
  const others = ['http://evil.example', 'https://localhost:41920', 'http://localhost:41921', 'http://localhost', 'http://localhost:41920.evil.example', 'http://evil.example:41920', 'http://localhost:41926', 'http://127.0.0.1:41926', 'http://[::1]:41920', 'http://LOCALHOST:41920', 'null', 'file://', ''];
  for (const origin of others) for (const [method, route, body] of [['GET', '/h/season', null], ['GET', '/gw/f/local-play/info', null], ['POST', WORLD_POST_ROUTES[0], '{}'], ['HEAD', '/h/season', null]]) {
    const r = await request(w.port, method, route, body, { ...J, origin });
    assert.equal(r.status, 403, `${method} ${route} from ${origin}`); assert.equal(r.headers['access-control-allow-origin'], undefined, 'no origin is named to a stranger');
    if (method !== 'HEAD') assert.equal(errorOf(r), 'WorldOriginDenied');
  }
  // a write with no Origin at all (a form, a script outside a page): refused; the same read is public and passes
  let r = await request(w.port, 'POST', WORLD_POST_ROUTES[0], '{}', { ...H, 'content-type': 'application/json' }); assert.equal(r.status, 403); assert.equal(errorOf(r), 'WorldOriginDenied');
  assert.equal(w.seen.length, 0, 'none of it reached the world');
  for (const origin of ['http://localhost:41920', 'http://127.0.0.1:41920']) {
    r = await request(w.port, 'POST', WORLD_POST_ROUTES[0], '{}', { ...J, origin });
    assert.equal(r.status, 200); assert.equal(r.headers['access-control-allow-origin'], origin, 'the asking origin itself, never `*`'); assert.equal(r.headers['access-control-allow-credentials'], undefined); assert.equal(r.headers.vary, 'Origin');
  }
});

test('world proxy: the destination is never the request\'s to choose (Host, absolute targets, dot segments, escapes)', { timeout: 120000 }, async t => {
  const w = await proxied(t);
  // this proxy's own two names only
  for (const host of ['evil.example', 'evil.example:41926', 'localhost', 'localhost:41920', 'localhost:41927', '127.0.0.1', '127.0.0.1:41920', '[::1]:41926', '0.0.0.0:41926', 'localhost:41926.evil.example', `127.0.0.1:${w.target}`, `localhost:${w.port}`]) {
    for (const [method, route, body] of [['GET', '/h/season', null], ['POST', WORLD_POST_ROUTES[0], '{}']]) {
      const r = await request(w.port, method, route, body, { ...J, host }); assert.equal(r.status, 403, `${method} Host: ${host}`); assert.equal(errorOf(r), 'WorldOriginDenied'); assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.equal(statusOf(await raw(w.port, 'GET /h/season HTTP/1.0\r\n\r\n')), 403, 'no Host at all');
  // targets that are not a plain path of this world
  const bad = ['http://evil.example/h/season', 'http://localhost:41926/h/season', '//evil.example/h/season', '/h/../gw/f/local-play/depart/submit', '/h/./season', '/h//season', '/h/season/', '/h/%2e%2e/x', '/h/a%2fb', '/h/%2E%2E%2Fgw', '/h/a\\b', '/h/a;b', '/h/a:b@c', '/h/season?x=%00\x7f', '/h/season?a=b#c', '/gw/f/local-play/depart/../../../h/season', '/h/' + 'a'.repeat(2100), '*'];
  for (const target of bad) {
    for (const method of ['GET', 'POST']) {
      const text = await raw(w.port, `${method} ${target} HTTP/1.1\r\nHost: localhost:41926\r\nOrigin: http://localhost:41920\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      assert.ok([400, 404].includes(statusOf(text)), `${method} ${target.slice(0, 60)}: ${text.split('\r\n')[0]}`);
    }
  }
  for (const target of bad) assert.equal(worldTarget(target), null, target.slice(0, 60));
  for (const [target, want] of [['/h/season', { path: '/h/season', query: '' }], ['/h/events?after=5', { path: '/h/events', query: 'after=5' }], ['/h/province/-4,0/latest', { path: '/h/province/-4,0/latest', query: '' }], ['/h/x?', { path: '/h/x', query: '' }]]) assert.deepEqual(worldTarget(target), want);
  for (const notText of [null, undefined, 5, {}, ['/h/season']]) assert.equal(worldTarget(notText), null);
  assert.equal(w.seen.length, 0, 'none of it reached the world');
  // and what does pass goes to this world's herald, whatever the request named
  const r = await request(w.port, 'GET', '/h/season', null, O); assert.equal(r.status, 200); assert.equal(w.seen[0].headers.host, `127.0.0.1:${w.target}`);
});

test('world proxy: a write is JSON of at most 64 KiB; a world that is not there says so', { timeout: 120000 }, async t => {
  const w = await proxied(t); const route = WORLD_POST_ROUTES[0];
  assert.equal(WORLD_BODY_MAX, 65536);
  let r = await request(w.port, 'POST', route, 'x'.repeat(WORLD_BODY_MAX), J); assert.equal(r.status, 200); assert.equal(w.seen[0].body.length, WORLD_BODY_MAX); assert.equal(w.seen[0].headers['content-length'], String(WORLD_BODY_MAX));
  w.seen.length = 0;
  r = await request(w.port, 'POST', route, 'x'.repeat(WORLD_BODY_MAX + 1), J); assert.equal(r.status, 413); assert.equal(errorOf(r), 'BodyTooLarge'); assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:41920', 'the page can read why');
  r = await request(w.port, 'POST', route, 'x'.repeat(300000), J); assert.equal(r.status, 413);
  // no declared length (chunked): counted as it arrives
  r = await new Promise((resolve, reject) => { const q = http.request({ hostname: '127.0.0.1', port: w.port, method: 'POST', path: route, headers: J }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }); q.on('error', reject); for (let i = 0; i < 7; i++) q.write('y'.repeat(10000)); q.end(); });
  assert.equal(r.status, 413);
  // not JSON: a form, plain text, nothing
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', undefined]) {
    const headers = { ...J }; if (type === undefined) delete headers['content-type']; else headers['content-type'] = type;
    r = await request(w.port, 'POST', route, 'a=b', headers); assert.equal(r.status, 415, String(type)); assert.equal(errorOf(r), 'JsonOnly');
  }
  assert.equal(w.seen.length, 0, 'none of it reached the world');
  r = await request(w.port, 'POST', route, '{}', { ...J, 'content-type': 'Application/JSON; charset=utf-8' }); assert.equal(r.status, 200); assert.equal(w.seen[0].headers['content-type'], 'application/json');
  // the herald behind is gone
  w.upstream.closeAllConnections(); await new Promise(x => w.upstream.close(x));
  r = await request(w.port, 'GET', '/h/season', null, O); assert.equal(r.status, 503); assert.equal(errorOf(r), 'WorldNotReady'); assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:41920');
});

test('world proxy: a WebSocket only at /h/ws, from the launcher page, to this world\'s herald', { timeout: 120000 }, async t => {
  const w = await proxied(t);
  const hello = (over = {}, target = WORLD_WS_ROUTE) => { const h = { Host: 'localhost:41926', Origin: 'http://localhost:41920', Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Cookie: 'x=1', Authorization: 'Bearer x', ...over };
    return `GET ${target} HTTP/1.1\r\n` + Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n'; };
  assert.equal(WORLD_WS_ROUTE, '/h/ws');
  for (const [why, text, want] of [['no origin', hello({ Origin: undefined }), 403], ['another origin', hello({ Origin: 'http://evil.example' }), 403], ['the world\'s own origin', hello({ Origin: 'http://localhost:41926' }), 403], ['another host', hello({ Host: 'evil.example' }), 403], ['the launcher\'s host', hello({ Host: 'localhost:41920' }), 403],
    ['a query', hello({}, '/h/ws?x=1'), 404], ['a read', hello({}, '/h/season'), 404], ['the relay', hello({}, '/gw/ws'), 404], ['below it', hello({}, '/h/ws/x'), 404], ['an absolute target', hello({}, 'http://evil.example/h/ws'), 404], ['another protocol', hello({ Upgrade: 'h2c' }), 404]]) {
    assert.equal(statusOf(await raw(w.port, text)), want, why);
  }
  assert.equal(w.seen.length, 0, 'none of it reached the world');
  // the one way through: upgraded by the herald, bytes both ways, and of the browser's headers only the handshake's
  const s = net.connect(w.port, '127.0.0.1'); let got = ''; s.on('data', b => { got += b; }); s.on('error', () => {});
  await once(s, 'connect'); s.write(hello());
  await until('the upgrade', () => got.includes('\r\n\r\n')); assert.equal(statusOf(got), 101);
  s.write('ping-1'); await until('the echo', () => got.endsWith('ping-1'));
  assert.equal(w.seen.length, 1); assert.equal(w.seen[0].upgrade, '/h/ws'); assert.equal(w.seen[0].headers.host, `127.0.0.1:${w.target}`);
  assert.deepEqual(Object.keys(w.seen[0].headers).sort(), ['connection', 'host', 'sec-websocket-key', 'sec-websocket-version', 'upgrade'], 'no origin, cookie or authorization goes on');
  // the world ending ends the connection
  let closed = false; s.on('close', () => { closed = true; }); await w.proxy.closeNow(); await until('the socket closing with the proxy', () => closed);
});

// ---- a world of stand-in processes: startWorld itself
const SEASON = '11111111111111111111111111111111';
/** Whether a process is still there. */
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const portFree = port => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
async function freeBase(n) { for (let i = 0; i < 200; i++) { const base = 20000 + Math.floor(Math.random() * 30000); let ok = true; for (let p = base; p < base + n && ok; p++) ok = await portFree(p); if (ok) return base; } throw new Error('no free ports'); }
/**
 * A temporary checkout with three stand-in executables and a data directory: `{c, tmp}`. `mode` changes the runner.
 * The stand-in runner has what the launcher's preparation uses of the real one, and nothing of a chain: a clock that
 * runs at a scale (`frontier_status`, `frontier_setScale`, applied at the next "slot", every call written to
 * `<tmp>/rpc.log` with its answer), the wide-destination lines once its clock is `lead` seconds past its start (at 1x
 * that is `lead` real seconds), and a keeper line every 120 ms. The stand-in herald serves the destination as a
 * captured record once the runner has opened it.
 */
async function standIns(t, { mode = '', guard = undefined, lead = 45, heraldMode = '' } = {}) {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-launcher-test-')));
  const script = async (file, source) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o755 }); return file; };
  const arg = `const arg = k => process.argv[process.argv.indexOf(k) + 1];\n`;
  const ends = mode === 'deaf' ? `process.on('SIGINT', () => {});\n` : `process.on('SIGINT', () => process.exit(0));\n`;
  const runner = await script(path.join(tmp, 'bin/runner'), arg + ends + `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const MODE = ${JSON.stringify(mode)}, LEAD = ${JSON.stringify(lead)}, T0 = 1785542402, WIDE = 'frontier-local-play-wide-destination-v1', KEEPER = 'frontier-local-play-keeper-v1';
const say = v => console.log(JSON.stringify(v)), log = path.join(__dirname, '..', 'rpc.log');
// (asked for the conquest preset, the stand-in does what the real runner's contract says: the same "opened" line, its
//  rules showing the Free City rule, then ONE line of its own with the top-level key conquest_world; a runner that
//  cannot make the preset does not start)
const PRESET = process.argv.includes('--world-preset');
if (PRESET && MODE === 'refuses-preset') { console.error('localnet-expedition-play: unknown argument --world-preset'); process.exit(2); }
const CONQUEST = PRESET || MODE === 'claims-preset', RULE = CONQUEST && MODE !== 'no-free-city-rule' ? 2 : 1;
const statement = () => ({ schema: 'frontier-local-play-conquest-capability-v1', artifact_sha256: arg('--artifact-sha256'),
  markers: MODE === 'one-marker-statement' ? ['PSF_LOCALNET_EXPEDITION_SBF_BUILD'] : ['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD'],
  program: process.argv.includes('--lane-candidate') ? '68qTstPmwfaDbt1a9hnq7XeyZ4zJBqBKU1esRtQXnKWj' : '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', season: ${JSON.stringify(SEASON)}, rpc: 'http://127.0.0.1:' + (Number(arg('--rpc-port')) + (MODE === 'other-rpc' ? 1 : 0)), world_preset: 'local-conquest-test-v1',
  free_city: { p: MODE === 'city-elsewhere' ? '130' : '129', q: '0', site: 3, tile: 43 }, free_city_count: 1,
  evidence: { consume_ring_seed: 'stand-in-a', set_rules: 'stand-in-b', open_province: 'stand-in-c', province_sha256_at_open: '11'.repeat(32), rules_config_sha256: '22'.repeat(32), province_sha256_read: '11'.repeat(32), read_slot: 9 },
  not_claimed: 'a stand-in: nothing of a chain' });
const state = () => { if (!CONQUEST || MODE === 'no-statement') return;
  // (the real runner, when the province it opened has no Free City: no statement, and its task says it stopped)
  if (MODE === 'no-city-stopped') return say({ schema: WIDE, stopped: 'NoFreeCityAtDestination: the opened Province has no Free City site', world_preset: 'local-conquest-test-v1', conquest_world_stated: false });
  say({ schema: 'frontier-localnet-expedition-play-v1', conquest_world: statement() });
  if (MODE === 'two-statements') say({ schema: 'frontier-localnet-expedition-play-v1', conquest_world: { ...statement(), free_city: { p: '129', q: '0', site: 4, tile: 44 } } }); };
let gameMs = T0 * 1000, slot = 7, scale = 1, pending = null, opened = false;
// (the LOCAL TEST CANDIDATE: asked with --lane-candidate, the stand-in says what the runner's candidate contract says —
//  the candidate id and version, Core and the resident program, and a throwaway seed file in the directory it was given)
const CAND = process.argv.includes('--lane-candidate'), CAND_PROGRAM = '68qTstPmwfaDbt1a9hnq7XeyZ4zJBqBKU1esRtQXnKWj';
const seedFile = CAND || MODE === 'plain-mentions-candidate' ? (MODE === 'seed-outside' ? '/tmp/elsewhere.seed' : path.join(arg('--authority-seed-dir') ?? __dirname, 'candidate-authority.seed')) : null;
if (CAND && MODE !== 'seed-outside') fs.writeFileSync(seedFile, '00'.repeat(32) + '\\n', { mode: 0o600 });
const candidateKeys = CAND || MODE === 'plain-mentions-candidate' ? { lane_candidate: 'localnet-conquest-nft-sbf', program_version: MODE === 'candidate-other-version' ? '0x4804' : '0xc804',
  resident_program: '68TBCtDEfvunEQYEb4cZSBnkPWnu2h6XuvSTmLctZyv5', core_program: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', authority_seed_file: seedFile } : { program_version: '0x4804' };   // (as the real runner states it)
say({ ...candidateKeys, program: ${JSON.stringify(mode === 'other-program' ? SEASON : '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn')}.replace('5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', CAND && MODE !== 'candidate-plain-program' ? CAND_PROGRAM : '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn'), rpc_url: 'http://127.0.0.1:' + arg('--rpc-port'), season: ${JSON.stringify(SEASON)}, season_id: 11,
  player_wallet: ${mode === 'other-wallet' ? JSON.stringify(SEASON) : `arg('--player-wallet')`}, artifact: { sha256: ${mode === 'other-artifact' ? JSON.stringify('00'.repeat(32)) : `arg('--artifact-sha256')`} }, bell_secs: 600,
  ${mode === 'no-time-control' ? '' : `time_control_rpc: ['frontier_pause', 'frontier_resume', 'frontier_setScale', 'frontier_hold', 'frontier_release'],`}
  wide_destination: { mode: 'public-quicknet', dest: [129, 0], t_open: T0 }, args: process.argv.slice(2) });
setInterval(() => {
  slot++; if (pending !== null) { if (!(MODE === 'stalled' && pending !== 1)) scale = pending; pending = null; } gameMs += 50 * scale;
  if (!opened && MODE !== 'never-opens' && MODE !== 'wide-stops' && gameMs >= (T0 + LEAD) * 1000) { opened = true; say({ schema: WIDE, step: 'consumed', detail: { round: 1 } }); say({ schema: WIDE, step: 'rules-set', detail: {} }); say({ schema: WIDE, step: 'opened', detail: { dest: [129, 0], ring: 129, rules: { keep_holder: 1, free_city: RULE, camp: 1, region: 1 } } });
    if (MODE === 'late-statement') setTimeout(state, 700); else state(); }
}, 50);
if (MODE === 'wide-stops') setTimeout(() => say({ schema: WIDE, stopped: 'round 1 was not served in time' }), 400);
setInterval(() => { const bell = Math.floor((gameMs / 1000 - (T0 - 6002)) / 600); say({ schema: KEEPER, running: true, resolved_next: bell - 1, bell, resident: MODE !== 'not-resident', last_error: null, stopped: null, unknown_signature: null }); }, 120);
http.createServer((req, res) => { let b = ''; req.on('data', x => { b += x; }); req.on('end', () => {
  let q = {}; try { q = JSON.parse(b); } catch {}
  let result;
  if (q.method === 'frontier_status') result = { slot, unixTimestamp: Math.floor(gameMs / 1000), scale, pendingScale: pending, paused: false };
  else if (q.method === 'frontier_setScale') { if (!(MODE === 'sticky' && q.params[0] === 1)) pending = q.params[0]; result = MODE === 'answer-lost' && q.params[0] !== 1 ? undefined : { atSlot: slot + 1 }; }
  else if (q.method === 'standin_opened') result = opened;
  if (q.method !== 'standin_opened') fs.appendFileSync(log, JSON.stringify({ method: q.method, params: q.params, result: result === undefined ? null : result }) + '\\n');
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'not here' } } : { jsonrpc: '2.0', id: q.id, result }));
}); }).listen(Number(arg('--rpc-port')), '127.0.0.1');
`);
  const herald = await script(path.join(tmp, 'bin/herald'), arg + `process.on('SIGINT', () => process.exit(0));
// (a compact herald records its output mode in its data directory, as the real one does; 'ignores-output' plays an old herald;
//  'records-v1' records compact-v1 whatever it was asked; 'dies-early' records the asked word, then ends before it listens)
if (process.argv.includes('--output') && ${JSON.stringify(heraldMode)} !== 'ignores-output') { const fs = require('node:fs'); fs.mkdirSync(arg('--data'), { recursive: true }); fs.writeFileSync(require('node:path').join(arg('--data'), 'output-mode'), (${JSON.stringify(heraldMode)} === 'records-v1' ? 'compact-v1' : arg('--output')) + '\\n'); }
if (${JSON.stringify(heraldMode)} === 'dies-early') process.exit(3);
require('node:http').createServer(async (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url.startsWith('/h/world/wide/route')) {
    let open = false; try { const r = await fetch(arg('--rpc') + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'standin_opened', params: [] }) }); open = (await r.json()).result === true; } catch {}
    const state = open && ${JSON.stringify(heraldMode)} !== 'no-capture' ? 'captured' : 'unknown';
    return res.end(JSON.stringify({ asked: req.url, route: [{ p: 129, q: 0, state, capture: state === 'captured' ? {} : null }] }));
  }
  res.end(JSON.stringify({ url: req.url, args: process.argv.slice(2) }));
}).listen(Number(arg('--listen').split(':')[1]), '127.0.0.1');
`);
  await script(path.join(tmp, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), `process.on('SIGINT', () => process.exit(0));\nconsole.log(JSON.stringify({ schema: 'frontier-local-play-relay-v1', listen: '127.0.0.1:' + process.argv[process.argv.indexOf('--listen-port') + 1], args: process.argv.slice(2) }));\nsetInterval(() => {}, 1000);\n`);
  await fsp.mkdir(path.join(tmp, 'data')); await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  const c = { root: tmp, data: path.join(tmp, 'data'), runner, herald, depart: '/abs/depart', preview: '/abs/preview', resident: '/abs/resident', artifact: '/abs/program.so', artifactSha: 'ab'.repeat(32), port: 41920, worldPort: await freeBase(WORLD_LIMIT * 5), web: path.join(tmp, 'permutation-server/web'), ...(guard ? { guard } : {}) };
  t.after(async () => { for (const d of await fsp.readdir(c.data).catch(() => [])) { const pids = JSON.parse(await fsp.readFile(path.join(c.data, d, 'processes.json'), 'utf8').catch(() => '{"pids":[]}')).pids; for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL'); } await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { c, tmp };
}
/** What was asked of the stand-in runner's time control, in order: `[{method, params, result}]`. */
const rpcLog = async tmp => (await fsp.readFile(path.join(tmp, 'rpc.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const worldDir = async c => { const [d] = await fsp.readdir(c.data); return path.join(c.data, d); };
const json = async file => JSON.parse(await fsp.readFile(file, 'utf8'));

test('a world of stand-in processes: ready through its proxy; an explicit stop ends all three and frees its ports', { timeout: 120000 }, async t => {
  const { c } = await standIns(t); const ports = worldPorts(c.worldPort, 0); let stops = 0;
  const w = await startWorld(c, wallet, 0, () => { stops++; });
  assert.equal(w.herald, `http://localhost:${ports.herald}`);
  const dir = await worldDir(c), procs = await json(path.join(dir, 'processes.json'));
  assert.equal(procs.pids.length, 3); assert.ok(procs.pids.every(alive)); assert.deepEqual(procs.ports, [ports.rpc, ports.ws, ports.herald, ports.relay, ports.internalHerald]); assert.equal(procs.wallet, wallet);
  // the proxy stands on the world's public port, in front of the herald; the page's two kinds of request pass
  let r = await request(ports.herald, 'GET', '/h/season', null, { origin: 'http://localhost:41920' }); assert.equal(r.status, 200); assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:41920');
  const heraldArgs = JSON.parse(r.body).args;
  r = await request(ports.herald, 'POST', WORLD_POST_ROUTES[0], '{}', { origin: 'http://localhost:41920', 'content-type': 'application/json' }); assert.equal(r.status, 200);
  assert.equal((await request(ports.herald, 'GET', '/frontier/frontier/index.html', null, {})).status, 404, 'a world serves no page');
  assert.equal((await request(ports.herald, 'GET', '/h/season', null, { origin: 'http://evil.example' })).status, 403);
  // what each process was started with: fixed arguments, the public address, this world's own ports, no page for the herald
  const runnerArgs = (await json(path.join(dir, 'metadata.json'))).args;
  assert.deepEqual(runnerArgs, ['--artifact', '/abs/program.so', '--artifact-sha256', 'ab'.repeat(32), '--player-wallet', wallet, '--rpc-port', String(ports.rpc), '--ws-port', String(ports.ws), '--keeper', 'public-quicknet', '--wide-destination', 'public-quicknet']);
  assert.deepEqual(heraldArgs, ['--data', path.join(dir, 'herald'), '--program', '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', '--season', '11', '--rpc', `http://127.0.0.1:${ports.rpc}`, '--listen', `127.0.0.1:${ports.internalHerald}`, '--source', 'localnet', '--cluster', 'localnet', '--local-play-metadata', path.join(dir, 'metadata.json'), '--relay', `127.0.0.1:${ports.relay}`]);
  assert.ok(!heraldArgs.includes('--web'));
  const relayArgs = JSON.parse((await fsp.readFile(path.join(dir, 'relay.out'), 'utf8')).split('\n')[0]).args;
  assert.deepEqual(relayArgs, ['--local-play', '--rpc', `http://127.0.0.1:${ports.rpc}`, '--program', '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', '--season', SEASON, '--wallet', wallet, '--ruleset-hash', '234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d', '--prepare-bin', '/abs/depart', '--preview-bin', '/abs/preview', '--resident-bin', '/abs/resident', '--cu-limit', '1000000', '--loaded-limit', '67108864', '--listen-port', String(ports.relay)]);
  assert.ok(!relayArgs.includes('--conquest-bin'), 'no conquest CLI unless the launcher\'s own command line names one');
  // the explicit stop
  const stopping = w.stop('requested'); assert.equal(w.stop('again'), stopping, 'one stop, however often asked');
  await stopping;
  assert.ok(procs.pids.every(pid => !alive(pid)), 'all three processes are gone'); assert.equal(stops, 1);
  for (const p of Object.values(ports)) assert.equal(await portFree(p), true, `port ${p} is free again`);
  assert.equal((await json(path.join(dir, 'stopped.json'))).reason, 'requested');
});

test('compact herald output (test worlds): the herald is asked for it, and a world is handed over only once its herald recorded it', { timeout: 120000 }, async t => {
  const { c } = await standIns(t); c.heraldOutput = HERALD_OUTPUT_MODE; let stops = 0;
  const w = await startWorld(c, wallet, 0, () => { stops++; });
  const dir = await worldDir(c), ports = worldPorts(c.worldPort, 0);
  const heraldArgs = JSON.parse((await request(ports.herald, 'GET', '/h/season', null, { origin: 'http://localhost:41920' })).body).args;
  assert.deepEqual(heraldArgs.slice(-2), ['--output', 'compact-v1'], 'the option, last, exactly');
  assert.equal(await fsp.readFile(path.join(dir, 'herald', 'output-mode'), 'utf8'), 'compact-v1\n', 'the herald recorded the mode in this world\'s own new directory');
  await w.stop('requested'); assert.equal(stops, 1);
});

test('compact herald output: a herald that ignores the option (an old binary) is never used — the start fails and the world is stopped whole', { timeout: 120000 }, async t => {
  const { c } = await standIns(t, { heraldMode: 'ignores-output' }); c.heraldOutput = HERALD_OUTPUT_MODE; let stops = 0;
  await assert.rejects(startWorld(c, wallet, 0, () => { stops++; }), e => e.code === 'HeraldOutputNotCompact');
  const dir = await worldDir(c), procs = await json(path.join(dir, 'processes.json')).catch(() => ({ pids: [] }));
  await until('the world\'s processes end', async () => procs.pids.every(pid => !alive(pid)));
  assert.equal(stops, 1, 'stopped by the same path as an unready herald');
  for (const p of Object.values(worldPorts(c.worldPort, 0))) assert.equal(await portFree(p), true, `port ${p} is free again`);
});

// ---- the conquest lane: what a start proves of itself, and to whom it is handed
const CITY = { p: '129', q: '0', site: 3, tile: 43 }, PLAY_PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
/** An artefact file for the stand-ins (the launcher reads it; the stand-in runner only echoes its sha256): `markers` are written once each. → `{artifact, artifactSha}`. */
async function artefact(tmp, markers = CONQUEST_ARTIFACT_MARKERS, name = 'program.so') {
  const file = path.join(tmp, 'bin', name), bytes = Buffer.concat([Buffer.from('\x7fELF stand-in, not a program\n'), ...markers.map(m => Buffer.from(`\0${m}\0`)), Buffer.alloc(64, 7)]);
  await fsp.writeFile(file, bytes); return { artifact: file, artifactSha: createHash('sha256').update(bytes).digest('hex') };
}
const relayArgsOf = async dir => JSON.parse((await fsp.readFile(path.join(dir, 'relay.out'), 'utf8')).split('\n')[0]).args;
const conquestOf = async dir => json(path.join(dir, 'conquest.json'));
const has = async (dir, file) => (await fsp.readdir(dir)).includes(file);
/** A stand-in checkout asked for the conquest preset, prepared fast (the Free City is known only once the destination is open). */
async function conquestStandIns(t, options = {}, markers = CONQUEST_ARTIFACT_MARKERS) {
  const x = await standIns(t, { lead: 30, ...options, guard: { preparePaceMs: 40, conquestStatementMs: 3000, ...options.guard } });
  Object.assign(x.c, await artefact(x.tmp, markers), { worldPreset: CONQUEST_WORLD_PRESET, prepareScale: 30 });
  return x;
}
/** What the stand-in runner states of itself (the runner owner's published shape, with its evidence). */
const stated = (c, rpc) => ({ schema: 'frontier-local-play-conquest-capability-v1', artifact_sha256: c.artifactSha, markers: ['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD'], program: PLAY_PROGRAM, season: SEASON,
  rpc: `http://127.0.0.1:${rpc}`, world_preset: 'local-conquest-test-v1', free_city: CITY, free_city_count: 1,
  evidence: { consume_ring_seed: 'stand-in-a', set_rules: 'stand-in-b', open_province: 'stand-in-c', province_sha256_at_open: '11'.repeat(32), rules_config_sha256: '22'.repeat(32), province_sha256_read: '11'.repeat(32), read_slot: 9 }, not_claimed: 'a stand-in: nothing of a chain' });

test('without the explicit preset no world is a conquest world: the runner is not asked for one, the relay never gets a conquest CLI, the page is told nothing', { timeout: 120000 }, async t => {
  // (also when a conquest CLI is configured, the world is prepared, and the runner states a conquest world by itself)
  const { c } = await standIns(t, { mode: 'claims-preset', guard: { preparePaceMs: 40 }, lead: 30 }); Object.assign(c, await artefact(c.root), { conquest: '/abs/conquest-prepare', prepareScale: 30 });
  const w = await startWorld(c, wallet, 0, () => {}); const dir = await worldDir(c);
  assert.equal(w.conquestWorld, undefined); assert.deepEqual(Object.keys(w).sort(), ['expiry', 'herald', 'keeper', 'prepared', 'stop']); assertExpiry(w.expiry);
  const runnerArgs = (await json(path.join(dir, 'metadata.json'))).args; assert.ok(!runnerArgs.includes('--world-preset'), 'the runner was started as for any world'); assert.equal(runnerArgs.length, 14);
  assert.ok((await fsp.readFile(path.join(dir, 'runner.out'), 'utf8')).includes('"conquest_world"'), '(the stand-in did state one)');
  const relayArgs = await relayArgsOf(dir); assert.ok(!relayArgs.includes('--conquest-bin') && !relayArgs.includes('--conquest-capability')); assert.equal(relayArgs.length, 23, 'the relay\'s arguments as ever');
  assert.equal((await fsp.readdir(dir)).some(f => f.startsWith('conquest')), false, 'nothing is recorded as a conquest world');
  await w.stop('requested');
});

// ---- round 14 (compact-v2): the word asked is the word recorded, or the world is stopped whole; an existing world is never touched
/** Every file under `dir` with its bytes' sha256, sorted (an existing world's tree before and after). */
const treeOf = async dir => { const out = []; const walk = async d => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(`${path.relative(dir, p)} ${createHash('sha256').update(await fsp.readFile(p)).digest('hex')}`); } }; await walk(dir); return out.sort(); };
/** An existing world's directory beside the one a start makes (its own output-mode compact-v1 and a store file). */
const oldWorld = async c => { const d = path.join(c.data, 'old-world-kept'); await fsp.mkdir(path.join(d, 'herald', 'findex', 'archive'), { recursive: true });
  await fsp.writeFile(path.join(d, 'herald', 'output-mode'), 'compact-v1\n'); await fsp.writeFile(path.join(d, 'herald', 'findex', 'archive', 'manifest.json'), '{"version":1}');
  await fsp.writeFile(path.join(d, 'stopped.json'), '{"reason":"launcher-closing"}'); return d; };
const newWorldDir = async (c, old) => { const ds = (await fsp.readdir(c.data)).map(x => path.join(c.data, x)).filter(x => x !== old); assert.equal(ds.length, 1, 'one new world directory'); return ds[0]; };
/** A start that must fail: every process of the new world ends, every port is free again, the existing world unchanged. */
const failsWhole = async (t, heraldMode, word, codeOk) => {
  const { c } = await standIns(t, { heraldMode }); c.heraldOutput = word; let stops = 0;
  const old = await oldWorld(c), before = await treeOf(old);
  await assert.rejects(startWorld(c, wallet, 0, () => { stops++; }), codeOk);
  const dir = await newWorldDir(c, old), procs = await json(path.join(dir, 'processes.json')).catch(() => ({ pids: [] }));
  await until('the new world\'s processes end', async () => procs.pids.every(pid => !alive(pid)));
  assert.equal(stops, 1, 'stopped once, whole');
  for (const p of Object.values(worldPorts(c.worldPort, 0))) assert.equal(await portFree(p), true, `port ${p} is free again`);
  assert.deepEqual(await treeOf(old), before, 'the existing world is not touched');
  return { dir };
};

test('compact-v2 (test worlds): the herald is asked for compact-v2, and the world is handed over only once it recorded compact-v2', { timeout: 120000 }, async t => {
  const { c } = await standIns(t); c.heraldOutput = 'compact-v2'; let stops = 0;
  const old = await oldWorld(c), before = await treeOf(old);
  const w = await startWorld(c, wallet, 0, () => { stops++; });
  const dir = await newWorldDir(c, old), ports = worldPorts(c.worldPort, 0);
  const heraldArgs = JSON.parse((await request(ports.herald, 'GET', '/h/season', null, { origin: 'http://localhost:41920' })).body).args;
  assert.deepEqual(heraldArgs.slice(-2), ['--output', 'compact-v2'], 'its word, last, exactly');
  assert.equal(await fsp.readFile(path.join(dir, 'herald', 'output-mode'), 'utf8'), 'compact-v2\n');
  await w.stop('requested'); assert.equal(stops, 1);
  assert.deepEqual(await treeOf(old), before, 'the existing world is not touched');
});

test('compact-v2: a herald that records another word (compact-v1) is never used — stopped whole, nothing else touched', { timeout: 120000 }, async t => {
  const { dir } = await failsWhole(t, 'records-v1', 'compact-v2', e => e.code === 'HeraldOutputNotCompact');
  assert.equal(await fsp.readFile(path.join(dir, 'herald', 'output-mode'), 'utf8'), 'compact-v1\n', 'its record is kept as the evidence of the refusal');
});

test('compact-v2: an old herald that ignores the option is never used — stopped whole, nothing else touched', { timeout: 120000 }, async t => {
  const { dir } = await failsWhole(t, 'ignores-output', 'compact-v2', e => e.code === 'HeraldOutputNotCompact');
  assert.equal(await fsp.readFile(path.join(dir, 'herald', 'output-mode'), 'utf8').catch(() => null), null, 'no record');
});

test('compact-v2: a herald that ends before it answers HTTP — the start fails and every process of the world ends', { timeout: 120000 }, async t => {
  await failsWhole(t, 'dies-early', 'compact-v2', e => typeof e.code === 'string' && e.code !== 'HeraldOutputNotCompact');
});

test('a start that proves itself a conquest world: the page\'s statement beside the herald, the relay\'s capability kept, and the relay started last', { timeout: 120000 }, async t => {
  // (the runner states its conquest world on a line of its own, here 0.7 s after it opened the destination: waited for)
  const { c } = await conquestStandIns(t, { mode: 'late-statement' }); const ports = worldPorts(c.worldPort, 0);
  const w = await startWorld(c, wallet, 0, () => {}); const dir = await worldDir(c);
  // to the page: exactly the five fields flocalplay-conquest.mjs reads, of this start's own program and Season
  assert.deepEqual(w.conquestWorld, { schema: 'frontier-local-play-conquest-world-v1', program: PLAY_PROGRAM, season: SEASON, world_preset: 'local-conquest-test-v1', free_city: CITY });
  assert.deepEqual(Object.keys(w).sort(), ['conquestWorld', 'expiry', 'herald', 'keeper', 'prepared', 'stop']); assertExpiry(w.expiry); assert.equal(w.prepared.accelerated, true);
  // the runner was asked for the preset in words, after its usual arguments
  const runnerArgs = (await json(path.join(dir, 'metadata.json'))).args; assert.deepEqual(runnerArgs.slice(-2), ['--world-preset', 'local-conquest-test-v1']); assert.equal(runnerArgs.length, 16);
  // the record: what the runner stated (whole, with its evidence), the relay's statement made of it — which the relay's
  // OWN checker accepts for this relay's pins — and why it was (not) handed over
  const kept = await conquestOf(dir), relay = await import('../src/frontier/local-play-conquest.mjs');
  assert.deepEqual(kept.stated, stated(c, ports.rpc));
  assert.deepEqual(kept.capability, { schema: 'frontier-local-play-conquest-capability-v1', artifact_sha256: c.artifactSha, markers: ['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD'], program: PLAY_PROGRAM, season: SEASON,
    rpc: `http://127.0.0.1:${ports.rpc}`, world_preset: 'local-conquest-test-v1', free_city: CITY }, 'the eight fields, none of the evidence');
  assert.deepEqual(relay.conquestCapabilityProblems(kept.capability, { program: PLAY_PROGRAM, season: SEASON, rpc: `http://127.0.0.1:${ports.rpc}` }), [], 'the relay\'s own check of it');
  assert.ok(relay.conquestCapabilityProblems(kept.stated, { program: PLAY_PROGRAM, season: SEASON, rpc: `http://127.0.0.1:${ports.rpc}` }).length > 0, '(the runner\'s statement as it is, with its evidence, is not the relay\'s exact shape: the launcher makes that)');
  assert.ok(relay.conquestCapabilityProblems(kept.capability, { program: PLAY_PROGRAM, season: SEASON, rpc: 'http://127.0.0.1:41904' }).length > 0, 'and it is not another runner\'s');
  assert.deepEqual(relay.CONQUEST_MARKERS, CONQUEST_ARTIFACT_MARKERS); assert.equal(relay.CONQUEST_WORLD_PRESET, CONQUEST_WORLD_PRESET); assert.equal(kept.capability.schema, CONQUEST_CAPABILITY_SCHEMA); assert.equal(w.conquestWorld.schema, CONQUEST_WORLD_SCHEMA);
  assert.deepEqual(kept.world, w.conquestWorld); assert.deepEqual(kept.why, []); assert.equal(kept.preset, 'local-conquest-test-v1');
  assert.deepEqual(await json(path.join(dir, 'conquest-capability.json')), kept.capability, 'this start\'s capability, written once');
  // no conquest CLI was configured: the relay is the plain one
  assert.equal(kept.gateway.pass, false); assert.deepEqual(kept.gateway.why, ['no conquest prepare CLI was configured (--conquest)']);
  const relayArgs = await relayArgsOf(dir); assert.ok(!relayArgs.includes('--conquest-bin') && !relayArgs.includes('--conquest-capability')); assert.equal(relayArgs.length, 23);
  // the relay was started last: after the preparation was recorded, and it is among the world's processes
  const stat = async f => fsp.stat(path.join(dir, f)); assert.ok((await stat('relay.out')).birthtimeMs >= (await stat('prepare.json')).mtimeMs - 5, 'after the preparation'); assert.ok((await stat('relay.out')).birthtimeMs >= (await stat('herald.out')).birthtimeMs);
  const { pids } = await json(path.join(dir, 'processes.json')); assert.equal(pids.length, 3); assert.ok(pids.every(alive));
  // the clock was touched as in any prepared world: fast once, back to 1x once
  assert.deepEqual((await rpcLog(c.root)).filter(x => x.method === 'frontier_setScale').map(x => x.params[0]), [30, 1]);
  await w.stop('requested'); assert.ok(pids.every(pid => !alive(pid)));
});

test('the capability reaches the relay only when the relay\'s own decision passes: then as a file of this start, beside the conquest CLI', { timeout: 120000 }, async t => {
  const asked = [];
  const { c } = await conquestStandIns(t, { guard: { conquestGateway: async (config, capability, relayArgs) => { asked.push({ capability, relayArgs }); return { pass: true, why: [] }; } } }); c.conquest = '/abs/conquest-prepare';
  const w = await startWorld(c, wallet, 0, () => {}); const dir = await worldDir(c), kept = await conquestOf(dir), file = path.join(dir, 'conquest-capability.json');
  assert.equal(asked.length, 1); assert.deepEqual(asked[0].capability, kept.capability); assert.equal(kept.gateway.pass, true);
  const relayArgs = await relayArgsOf(dir);
  assert.deepEqual(relayArgs.slice(relayArgs.indexOf('--resident-bin'), relayArgs.indexOf('--cu-limit')), ['--resident-bin', '/abs/resident', '--conquest-bin', '/abs/conquest-prepare', '--conquest-capability', file]); assert.equal(relayArgs.length, 27);
  assert.deepEqual(asked[0].relayArgs, relayArgs, 'the decision was asked about the very arguments the relay then got');
  // those arguments and that file, given to the checkout's REAL relay modules: its own parser takes them, its own
  // reader reads the file, and its own checker accepts what it read for the pins the arguments give
  const server = await import('../src/frontier/local-play-relay-server.mjs'), relay = await import('../src/frontier/local-play-conquest.mjs'), parsed = server.parseArgs(relayArgs);
  assert.equal(parsed.conquestBin, '/abs/conquest-prepare'); assert.equal(parsed.conquestCapability, file); assert.equal(parsed.cfg.rpc, kept.capability.rpc); assert.equal(parsed.cfg.season, SEASON);
  assert.deepEqual(server.readConquestCapability(file), kept.capability); assert.deepEqual(relay.conquestCapabilityProblems(server.readConquestCapability(file), parsed.cfg), []);
  assert.ok((await fsp.stat(file)).size <= server.CONQUEST_CAPABILITY_MAX_BYTES, 'within the relay\'s bound for that file');
  assert.deepEqual(await json(file), kept.capability); assert.deepEqual(w.conquestWorld.free_city, CITY);
  await w.stop('requested');
  // a decision that passes cannot hand over what was not proved (the runner stated nothing: waited for, bounded), nor a CLI that was not configured
  const lesser = await conquestStandIns(t, { mode: 'no-statement', guard: { conquestStatementMs: 400, conquestGateway: async () => ({ pass: true, why: [] }) } }); lesser.c.conquest = '/abs/conquest-prepare';
  const w2 = await startWorld(lesser.c, wallet, 0, () => {}); const dir2 = await worldDir(lesser.c), kept2 = await conquestOf(dir2);
  assert.equal(w2.conquestWorld, undefined); assert.ok(!(await relayArgsOf(dir2)).includes('--conquest-bin')); assert.equal(await has(dir2, 'conquest-capability.json'), false);
  assert.equal(kept2.gateway.pass, false); assert.equal(kept2.stated, null); assert.deepEqual(kept2.why, ['the runner states no conquest world']);
  await w2.stop('requested');
  const bare = await conquestStandIns(t, { guard: { conquestGateway: async () => ({ pass: true, why: [] }) } });
  const w3 = await startWorld(bare.c, wallet, 0, () => {}); const dir3 = await worldDir(bare.c);
  assert.ok(w3.conquestWorld); assert.ok(!(await relayArgsOf(dir3)).includes('--conquest-bin'), 'no CLI configured: nothing to hand over'); assert.equal((await conquestOf(dir3)).gateway.pass, false);
  await w3.stop('requested');
  // and a capability with a configured CLI still reaches no relay while the decision is no: here the launcher's own
  // decision (no stand-in for it), over a checkout whose relay has no conquest module at all
  const closed = await conquestStandIns(t); closed.c.conquest = '/abs/conquest-prepare';
  const w4 = await startWorld(closed.c, wallet, 0, () => {}); const dir4 = await worldDir(closed.c), kept4 = await conquestOf(dir4), args4 = await relayArgsOf(dir4);
  assert.ok(w4.conquestWorld, 'the world is proven'); assert.deepEqual(kept4.why, []); assert.ok(kept4.capability); assert.deepEqual(await json(path.join(dir4, 'conquest-capability.json')), kept4.capability);
  assert.deepEqual(kept4.gateway, { pass: false, why: ['the relay\'s conquest module cannot be read'] }); assert.ok(!args4.includes('--conquest-bin') && !args4.includes('--conquest-capability')); assert.equal(args4.length, 23);
  await w4.stop('requested');
});

test('a world that proves less is not a conquest world: it runs as any world, and the record says what was missing', { timeout: 120000 }, async t => {
  const lesser = async (options, markers, reason) => {
    const { c } = await conquestStandIns(t, options, markers);
    const w = await startWorld(c, wallet, 0, () => {}); const dir = await worldDir(c), kept = await conquestOf(dir);
    assert.equal(w.conquestWorld, undefined, reason); assert.equal(kept.world, null); assert.equal(kept.capability, null); assert.ok(kept.why.some(x => x.includes(reason)), `${reason}: ${JSON.stringify(kept.why)}`);
    assert.equal(await has(dir, 'conquest-capability.json'), false); assert.ok(!(await relayArgsOf(dir)).includes('--conquest-bin'));
    assert.equal((await request(worldPorts(c.worldPort, 0).herald, 'GET', '/h/status', null, {})).status, 200, 'the world itself runs');
    await w.stop('requested'); return { kept, c };
  };
  // an expedition-only artefact (one marker), whatever the runner states
  let { kept, c } = await lesser({}, ['PSF_LOCALNET_EXPEDITION_SBF_BUILD'], 'does not carry PSF_LOCALNET_CONQUEST_SBF_BUILD exactly once');
  assert.deepEqual(kept.why, ['the artefact does not carry PSF_LOCALNET_CONQUEST_SBF_BUILD exactly once']); assert.equal(kept.stated.artifact_sha256, c.artifactSha, 'what the runner stated is kept in the record');
  // the runner's own "opened" line shows the rule without a Free City, whatever its statement says
  ({ kept } = await lesser({ mode: 'no-free-city-rule' }, CONQUEST_ARTIFACT_MARKERS, 'rules give it no Free City')); assert.equal(kept.why.length, 1);
});

test('a preset that cannot be had is refused before or at the runner: never a world that only looks like one', { timeout: 120000 }, async t => {
  // asked for without the preparation, or by another name: nothing is started at all
  { const { c } = await standIns(t); Object.assign(c, await artefact(c.root), { worldPreset: CONQUEST_WORLD_PRESET });
    await assert.rejects(startWorld(c, wallet, 0, () => {}), e => e.code === 'WorldPresetNeedsPrepare' && e.status === 503); assert.deepEqual(await fsp.readdir(c.data), []); }
  { const { c } = await standIns(t); Object.assign(c, { worldPreset: 'conquest', prepareScale: 30 });
    await assert.rejects(startWorld(c, wallet, 0, () => {}), e => e.code === 'InvalidWorldPreset'); assert.deepEqual(await fsp.readdir(c.data), []); }
  // a runner that does not know the preset (a plain build) does not start: no world
  { const { c } = await conquestStandIns(t, { mode: 'refuses-preset' }); let stops = 0;
    await assert.rejects(startWorld(c, wallet, 0, () => { stops++; }), e => e.code === 'RunnerNotReady' && e.status === 503); assert.equal(stops, 1);
    const dir = await worldDir(c); assert.deepEqual((await fsp.readdir(dir)).sort(), ['runner.err', 'runner.out', 'stopped.json'], 'neither the herald nor the relay was started');
    assert.ok((await fsp.readFile(path.join(dir, 'runner.err'), 'utf8')).includes('--world-preset'));
    for (const p of Object.values(worldPorts(c.worldPort, 0))) assert.equal(await portFree(p), true); }
  // the runner opened the province and found no Free City in it: it states nothing and says its task stopped. The
  // preparation halts on that line, the clock is set back to 1x, and the world is ended: no world, not a lesser one
  { const { c } = await conquestStandIns(t, { mode: 'no-city-stopped' }); let stops = 0;
    await assert.rejects(startWorld(c, wallet, 0, () => { stops++; }), e => e.code === 'PrepareHalted' && e.status === 503); assert.equal(stops, 1);
    const dir = await worldDir(c); assert.equal((await json(path.join(dir, 'stopped.json'))).reason, 'startup-failed:PrepareHalted');
    assert.equal(await has(dir, 'conquest.json'), false); assert.equal(await has(dir, 'relay.out'), false, 'its relay was never started');
    const scales = (await rpcLog(c.root)).filter(x => x.method === 'frontier_setScale').map(x => x.params[0]); assert.equal(scales[0], 30); assert.equal(scales.at(-1), 1, 'back to 1x before the world was ended');
    for (const p of Object.values(worldPorts(c.worldPort, 0))) assert.equal(await portFree(p), true); }
});

test('the proof itself: only the runner\'s own statement counts, every reason is given; the relay\'s own modules decide the hand-over, and today they keep it closed', { timeout: 60000 }, async t => {
  const { c, tmp } = await standIns(t); Object.assign(c, await artefact(tmp), { worldPreset: CONQUEST_WORLD_PRESET, prepareScale: 30 });
  const meta = { schema: 'frontier-localnet-expedition-play-v1', program: PLAY_PROGRAM, season: SEASON, rpc_url: 'http://127.0.0.1:41924', artifact: { sha256: c.artifactSha, marker: 'PSF_LOCALNET_EXPEDITION_SBF_BUILD' }, wide_destination: { dest: [129, 0] } };
  const opened = { schema: 'frontier-local-play-wide-destination-v1', step: 'opened', detail: { dest: [129, 0], ring: 129, rules: { keep_holder: 1, free_city: 2, camp: 1, region: 1 } } };
  const statement = stated(c, 41924), line = (s = statement) => ({ schema: 'frontier-localnet-expedition-play-v1', conquest_world: s });
  const good = await conquestProof({ c, meta, lines: [opened, line()] });
  assert.deepEqual(good.why, []); assert.deepEqual(Object.keys(good.capability), ['schema', 'artifact_sha256', 'markers', 'program', 'season', 'rpc', 'world_preset', 'free_city']); assert.deepEqual(Object.keys(good.world), ['schema', 'program', 'season', 'world_preset', 'free_city']);
  assert.deepEqual(good.stated, statement); assert.deepEqual(good.capability.free_city, CITY); assert.deepEqual(good.world.free_city, CITY);
  assert.notEqual(good.capability.free_city, good.world.free_city, 'two statements, not one object shared'); assert.notEqual(good.capability.free_city, statement.free_city);
  // the key is read wherever the runner's public lines carry it: also on its first line, and said twice alike it is one statement
  assert.deepEqual((await conquestProof({ c, meta: { ...meta, conquest_world: statement }, lines: [opened] })).why, []);
  assert.deepEqual((await conquestProof({ c, meta: { ...meta, conquest_world: statement }, lines: [opened, line(), line({ ...statement })] })).why, []);
  const none = async (over, reason) => {
    const r = await conquestProof({ c: { ...c, ...over.c }, meta: over.meta === undefined ? meta : over.meta, lines: over.lines === undefined ? [opened, line()] : over.lines });
    assert.equal(r.capability, null, reason); assert.equal(r.world, null); assert.ok(r.why.some(x => x.includes(reason)), `${reason}: ${JSON.stringify(r.why)}`); return r;
  };
  // NOTHING ELSE stands in for the statement: not a preset named on the first line, not a Free City written into the "opened" line (an earlier draft of this launcher read those; the runner never printed them)
  let r = await none({ meta: { ...meta, world_preset: 'local-conquest-test-v1' }, lines: [{ ...opened, detail: { ...opened.detail, free_city: CITY } }] }, 'the runner states no conquest world'); assert.equal(r.why.length, 1); assert.equal(r.stated, null);
  await none({ lines: [opened, { schema: 'frontier-localnet-expedition-play-v1', detail: { conquest_world: statement } }] }, 'the runner states no conquest world');   // (not a top-level key)
  r = await none({ lines: [opened, line(), line({ ...statement, free_city: { ...CITY, site: 4 } })] }, 'more than one conquest world'); assert.equal(r.stated, null);
  for (const s of [null, 'local-conquest-test-v1', [statement], { ...statement, schema: 'frontier-local-play-conquest-world-v1' }, { free_city: CITY }]) await none({ lines: [opened, line(s)] }, 'not a conquest capability');
  await none({ c: { worldPreset: undefined } }, 'no explicit world preset'); await none({ lines: [opened, line({ ...statement, world_preset: 'S1_LOCAL_7D' })] }, 'does not state the conquest preset');
  await none({ lines: [opened, line({ ...statement, artifact_sha256: 'ff'.repeat(32) })] }, 'states another artefact');
  for (const markers of [[...CONQUEST_ARTIFACT_MARKERS].reverse(), ['PSF_LOCALNET_EXPEDITION_SBF_BUILD'], [...CONQUEST_ARTIFACT_MARKERS, 'X'], 'both']) await none({ lines: [opened, line({ ...statement, markers })] }, 'states other markers');
  for (const other of [{ program: SEASON }, { season: PLAY_PROGRAM }, { rpc: 'http://127.0.0.1:41904' }, { rpc: 'http://localhost:41924' }]) await none({ lines: [opened, line({ ...statement, ...other })] }, 'of another world');
  for (const city of [null, [], { ...CITY, extra: 1 }, { p: 129, q: '0', site: 3, tile: 43 }, { p: '129', q: '0', site: 3 }, { ...CITY, site: -1 }, { ...CITY, site: 12 }, { ...CITY, tile: 61 }, { ...CITY, site: 3.5 }, { ...CITY, p: '0129' }]) await none({ lines: [opened, line({ ...statement, free_city: city })] }, 'position');
  await none({ lines: [opened, line({ ...statement, free_city: { ...CITY, q: '1' } })] }, 'not in the destination province');
  // the destination's own "opened" line: there, for this destination, its rules showing the Free City rule
  await none({ lines: [line()] }, 'not opened'); await none({ lines: [{ ...opened, detail: { ...opened.detail, dest: [130, 0] } }, line()] }, 'not opened'); await none({ lines: [{ ...opened, step: 'rules-set' }, line()] }, 'not opened');
  await none({ lines: [{ ...opened, detail: { ...opened.detail, rules: { ...opened.detail.rules, free_city: 1 } } }, line()] }, 'no Free City'); await none({ lines: [{ ...opened, detail: { dest: [129, 0] } }, line()] }, 'no Free City');
  // the artefact and the first line
  await none({ c: { artifact: path.join(tmp, 'bin/none.so') } }, 'cannot be read'); await none({ c: { artifactSha: '00'.repeat(32) } }, 'not the one named'); await none({ meta: { ...meta, artifact: { sha256: 'ff'.repeat(32) } } }, 'reports another artefact');
  await none({ meta: { ...meta, program: SEASON } }, 'does not name this world');
  const many = await none({ c: { worldPreset: undefined, artifactSha: '00'.repeat(32) }, lines: [] }, 'not opened'); assert.ok(many.why.length >= 4, 'every reason, not the first');

  // the hand-over: no capability or no CLI → no; with both, the relay's own modules of the checkout decide, on the very arguments
  const args = (rpc = 'http://127.0.0.1:41924') => ['--local-play', '--rpc', rpc, '--program', PLAY_PROGRAM, '--season', SEASON, '--wallet', wallet, '--ruleset-hash', 'ab'.repeat(32), '--prepare-bin', '/abs/depart', '--preview-bin', '/abs/preview', '--resident-bin', '/abs/resident',
    '--conquest-bin', '/abs/conquest-prepare', '--conquest-capability', path.join(tmp, 'conquest-capability.json'), '--cu-limit', '1000000', '--loaded-limit', '67108864', '--listen-port', '41927'];
  assert.deepEqual(await conquestGateway({ root, conquest: '/abs/conquest-prepare' }, null, args()), { pass: false, why: ['this start has no capability'] });
  assert.deepEqual(await conquestGateway({ root }, good.capability, args()), { pass: false, why: ['no conquest prepare CLI was configured (--conquest)'] });
  const relay = await import('../src/frontier/local-play-conquest.mjs'), server = await import('../src/frontier/local-play-relay-server.mjs');
  const closed = Object.entries(relay.CONQUEST_OPEN_CONDITIONS).filter(([, ok]) => ok !== true).map(([k]) => k);
  let takesFlag = true; try { server.parseArgs(args()); } catch { takesFlag = false; }
  const decided = await conquestGateway({ root, conquest: '/abs/conquest-prepare' }, good.capability, args());
  assert.equal(decided.pass, closed.length === 0 && takesFlag, 'exactly what the relay\'s own modules say'); for (const name of closed) assert.ok(decided.why.some(x => x.includes(name)), `${name} is named`);
  assert.equal(decided.why.some(x => x.includes('--conquest-capability')), !takesFlag); assert.ok(!decided.why.some(x => x.includes('own check refuses')), 'the capability itself is one the relay\'s checker accepts');
  // (2026-11-12: the relay's command line takes --conquest-capability; heapConfirmed and pageBinding are not established: closed)
  if (closed.includes('heapConfirmed')) assert.equal(decided.pass, false, 'while the heap frame is unconfirmed on a real program, nothing is handed to the relay');
  // a checkout whose relay has no conquest module: closed
  assert.deepEqual(await conquestGateway({ root: tmp, conquest: '/abs/conquest-prepare' }, good.capability, args()), { pass: false, why: ['the relay\'s conquest module cannot be read'] });
  // a relay as it would be once it takes the flag (stand-in modules over the checkout's REAL checker and parser): the
  // decision passes only with every condition established and the capability being that relay's own
  const future = async (conditions, name) => {
    const at = path.join(tmp, name, 'permutation-gateway/src/frontier'); await fsp.mkdir(at, { recursive: true });
    const real = f => JSON.stringify(pathToFileURL(path.join(root, 'permutation-gateway/src/frontier', f)).href);
    await fsp.writeFile(path.join(at, 'local-play-conquest.mjs'), `export { conquestCapabilityProblems } from ${real('local-play-conquest.mjs')};\nexport const CONQUEST_OPEN_CONDITIONS = Object.freeze(${JSON.stringify(conditions)});\n`);
    await fsp.writeFile(path.join(at, 'local-play-relay-server.mjs'), `import { parseArgs as real } from ${real('local-play-relay-server.mjs')};\nexport function parseArgs(argv) { const i = argv.indexOf('--conquest-capability'); if (i < 0) return real(argv); const rest = [...argv]; const [, file] = rest.splice(i, 2); if (typeof file !== 'string' || !file.startsWith('/')) throw new Error('--conquest-capability'); return { ...real(rest), conquestCapability: file }; }\n`);
    return { root: path.join(tmp, name), conquest: '/abs/conquest-prepare' };
  };
  const open = await future({ dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: true, pageBinding: true }, 'open');
  assert.deepEqual(await conquestGateway(open, good.capability, args()), { pass: true, why: [] });
  r = await conquestGateway(open, good.capability, args('http://127.0.0.1:41904')); assert.equal(r.pass, false); assert.ok(r.why.length === 1 && r.why[0].includes('own check refuses') && r.why[0].includes('rpc'), 'a capability of another runner than the relay\'s');
  r = await conquestGateway(open, { ...good.capability, evidence: {} }, args()); assert.equal(r.pass, false); assert.ok(r.why[0].includes('own check refuses'));
  r = await conquestGateway(open, good.capability, args().filter(x => x !== '--local-play').concat('--surprise', 'x')); assert.equal(r.pass, false); assert.ok(r.why.some(x => x.includes('command line')));
  r = await conquestGateway(await future({ dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: true }, 'heap'), good.capability, args()); assert.deepEqual(r, { pass: false, why: ['the relay\'s opening conditions are not established: heapConfirmed'] });
  assert.equal(CONQUEST_STATEMENT_MS, 10000);

  // The relay's WHOLE start-time path of this checkout over what the launcher would give it (a synthetic capability
  // of the dedicated program's own Season on a relay-acceptable port; nothing is started, nothing is sent):
  // its parser, its bounded reader, its constructor. Today the constructor refuses, and for the conditions alone.
  const pins = await import('../src/frontier/local-play-relay.mjs');
  assert.equal(pins.LOCAL_PLAY_RULESET_HASH, '234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d', 'the ruleset hash the launcher gives every relay is the relay\'s own');
  assert.equal(pins.LOCAL_PLAY_PROGRAM, PLAY_PROGRAM);
  const season11 = seasonAddresses(PLAY_PROGRAM, String(pins.LOCAL_PLAY_SEASON_ID)).season, synthetic = { ...good.capability, season: season11, rpc: 'http://127.0.0.1:41944' };
  const capabilityFile = path.join(tmp, 'synthetic-capability.json'); await fsp.writeFile(capabilityFile, JSON.stringify(synthetic));
  const given = ['--local-play', '--rpc', synthetic.rpc, '--program', PLAY_PROGRAM, '--season', season11, '--wallet', wallet, '--ruleset-hash', pins.LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/abs/depart', '--preview-bin', '/abs/preview', '--resident-bin', '/abs/resident',
    '--conquest-bin', '/abs/conquest-prepare', '--conquest-capability', capabilityFile, '--cu-limit', '1000000', '--loaded-limit', '67108864', '--listen-port', '41947'];
  const parsed = server.parseArgs(given);
  assert.deepEqual(pins.localPlayRelayConfigProblems(parsed.cfg), [], 'the relay\'s own configuration check takes the pins the launcher gives');
  assert.deepEqual(server.readConquestCapability(parsed.conquestCapability), synthetic); assert.deepEqual(relay.conquestCapabilityProblems(server.readConquestCapability(parsed.conquestCapability), parsed.cfg), []);
  if (closed.length) assert.throws(() => server.conquestFromArgs(parsed), e => closed.every(name => e.message.includes(name)) && !e.message.includes('world capability') && !e.message.includes(capabilityFile), 'refused at start, for the conditions alone');
  assert.deepEqual(await conquestGateway({ root, conquest: '/abs/conquest-prepare' }, synthetic, given), { pass: closed.length === 0, why: closed.length ? [`the relay's opening conditions are not established: ${closed.join(', ')}`] : [] }, 'and the launcher\'s decision over the same: the same single reason');
  // another runner's capability in that file: the relay's checker says so for these pins, and the launcher's decision names it
  const foreign = await conquestGateway({ root, conquest: '/abs/conquest-prepare' }, { ...synthetic, rpc: 'http://127.0.0.1:41949' }, given);
  assert.equal(foreign.pass, false); assert.ok(foreign.why.some(x => x.includes('own check refuses') && x.includes('rpc')));
});

test('over HTTP: the start\'s answer carries the page\'s statement only for a world that proved itself', { timeout: 120000 }, async t => {
  const { c } = await conquestStandIns(t); const { server, manager } = createLauncherServer(c);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  t.after(async () => { await manager.close(); await new Promise(r => server.close(r)); });
  const h = { host: 'localhost:41920', origin: 'http://localhost:41920', 'content-type': 'application/json' };
  const body = JSON.parse((await request(port, 'POST', '/local-play/start', JSON.stringify({ wallet }), h)).body);
  assert.deepEqual(Object.keys(body).sort(), ['conquestWorld', 'expiry', 'herald', 'prepared']); assertExpiry(body.expiry);
  assert.deepEqual(body.conquestWorld, { schema: 'frontier-local-play-conquest-world-v1', program: PLAY_PROGRAM, season: SEASON, world_preset: 'local-conquest-test-v1', free_city: CITY });
  assert.deepEqual(JSON.parse((await request(port, 'POST', '/local-play/start', JSON.stringify({ wallet }), h)).body), body, 'the same address: the same world, the same statement');
  // the list of worlds says nothing of it (public addresses, where, since when, state), and nothing of the evidence leaves the launcher
  const listed = JSON.parse((await request(port, 'POST', '/local-play/worlds', '{}', h)).body).worlds; assert.deepEqual(Object.keys(listed[0]).sort(), ['expiry', 'herald', 'startedAt', 'state', 'wallet']); assert.deepEqual(listed[0].expiry, body.expiry, 'the list: the same fixed end');
  assert.ok(!JSON.stringify(body).includes('stand-in-a') && !JSON.stringify(body).includes('artifact'));
  await manager.close();
});

test('a world ends itself, whole, when one of its processes ends, when its time is over, or past its output limit', { timeout: 120000 }, async t => {
  { const { c } = await standIns(t); let stops = 0; await startWorld(c, wallet, 0, () => { stops++; });
    const dir = await worldDir(c), { pids } = await json(path.join(dir, 'processes.json'));
    process.kill(pids[2], 'SIGTERM');   // the herald dies
    await until('the world stopping itself', () => stops === 1); assert.ok(pids.every(pid => !alive(pid)), 'the runner and the relay went with it'); assert.equal((await json(path.join(dir, 'stopped.json'))).reason, 'herald-exited'); }
  // (the limits are shortened here through `guard`, which only a test can set: a life of 3 s, 16 KiB of output)
  { const { c } = await standIns(t, { guard: { ttlMs: 3000, everyMs: 50 } }); let stops = 0; const at = Date.now(); await startWorld(c, wallet, 0, () => { stops++; });
    const dir = await worldDir(c), { pids } = await json(path.join(dir, 'processes.json')); assert.equal(stops, 0); assert.ok(pids.every(alive));
    await until('the time limit', () => stops === 1); assert.ok(Date.now() - at >= 3000); assert.ok(pids.every(pid => !alive(pid))); assert.equal((await json(path.join(dir, 'stopped.json'))).reason, 'ttl'); }
  { const { c } = await standIns(t, { guard: { outputMax: 16384, everyMs: 50 } }); let stops = 0; await startWorld(c, wallet, 0, () => { stops++; });
    const dir = await worldDir(c), { pids } = await json(path.join(dir, 'processes.json'));
    await new Promise(r => setTimeout(r, 200)); assert.equal(stops, 0, 'under the limit it goes on'); assert.ok(pids.every(alive));
    await fsp.mkdir(path.join(dir, 'herald')); await fsp.writeFile(path.join(dir, 'herald', 'records.bin'), Buffer.alloc(32768));
    await until('the output limit', () => stops === 1); assert.ok(pids.every(pid => !alive(pid))); assert.equal((await json(path.join(dir, 'stopped.json'))).reason, 'output-limit'); }
});

test('a world that cannot start leaves nothing behind: a taken port, too little disk, a runner that is not this world\'s, an abort', { timeout: 120000 }, async t => {
  { const { c } = await standIns(t); const ports = worldPorts(c.worldPort, 0);
    const squatter = net.createServer(); squatter.listen(ports.relay, '127.0.0.1'); await once(squatter, 'listening');
    await assert.rejects(startWorld(c, wallet, 0, () => {}), e => e.code === 'PortBusy' && e.status === 503);
    assert.deepEqual(await fsp.readdir(c.data), [], 'nothing was started or written'); await new Promise(r => squatter.close(r)); }
  { const { c } = await standIns(t, { guard: { diskFloor: Number.MAX_VALUE } });
    await assert.rejects(startWorld(c, wallet, 0, () => {}), e => e.code === 'DiskFloor' && e.status === 503); assert.deepEqual(await fsp.readdir(c.data), []); }
  // a runner that is not this world's: another program, another player's address, another artifact than the one named
  for (const mode of ['other-program', 'other-wallet', 'other-artifact']) { const { c } = await standIns(t, { mode }); const ports = worldPorts(c.worldPort, 0); let stops = 0;
    await assert.rejects(startWorld(c, wallet, 0, () => { stops++; }), e => e.code === 'RunnerNotReady' && e.status === 503, mode);
    assert.equal(stops, 1, 'stopped before the refusal is answered'); for (const p of Object.values(ports)) assert.equal(await portFree(p), true);
    const dir = await worldDir(c); assert.deepEqual((await fsp.readdir(dir)).sort(), ['runner.err', 'runner.out', 'stopped.json'], 'neither the relay nor the herald was started'); assert.equal((await json(path.join(dir, 'stopped.json'))).reason, 'startup-failed:RunnerNotReady'); }
  { const { c } = await standIns(t); const abort = new AbortController(); let stops = 0;
    const starting = startWorld(c, wallet, 0, () => { stops++; }, abort.signal); setTimeout(() => abort.abort('requested'), 60);
    await assert.rejects(starting, e => ['RunnerNotReady', 'WorldStopped', 'HeraldNotReady'].includes(e.code)); assert.equal(stops, 1);
    for (const p of Object.values(worldPorts(c.worldPort, 0))) assert.equal(await portFree(p), true); }
});

test('a process that ignores the polite stop is killed: a stop always ends', { timeout: 120000 }, async t => {
  const { c } = await standIns(t, { mode: 'deaf' }); const w = await startWorld(c, wallet, 0, () => {});
  const { pids } = await json(path.join(await worldDir(c), 'processes.json')); const at = Date.now();
  await w.stop('requested'); assert.ok(pids.every(pid => !alive(pid))); assert.ok(Date.now() - at >= 2900, 'after the grace time');
});

test('the launcher end to end over HTTP with stand-in worlds: two worlds, the refusal with its list, the chosen stop, the freed place', { timeout: 120000 }, async t => {
  const { c } = await standIns(t); const { server, manager } = createLauncherServer(c);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  t.after(async () => { await manager.close(); await new Promise(r => server.close(r)); });
  const h = { host: 'localhost:41920', origin: 'http://localhost:41920', 'content-type': 'application/json' };
  const post = (route, body) => request(port, 'POST', route, JSON.stringify(body), h).then(r => ({ status: r.status, body: JSON.parse(r.body) }));
  const [a, again, b] = await Promise.all([post('/local-play/start', { wallet }), post('/local-play/start', { wallet }), post('/local-play/start', { wallet: other })]);
  assert.deepEqual(Object.keys(a.body).sort(), ['expiry', 'herald']); assertExpiry(a.body.expiry);
  assert.deepEqual({ ...a, body: { herald: a.body.herald } }, { status: 200, body: { herald: `http://localhost:${worldPorts(c.worldPort, 0).herald}` } }); assert.deepEqual(again, a, 'the same address: the same world (and the same fixed end)');
  assert.deepEqual(Object.keys(b.body).sort(), ['expiry', 'herald']); assertExpiry(b.body.expiry);
  assert.deepEqual({ ...b, body: { herald: b.body.herald } }, { status: 200, body: { herald: `http://localhost:${worldPorts(c.worldPort, 1).herald}` } });
  assert.equal((await fsp.readdir(c.data)).length, 2, 'two worlds, not three');
  const full = await post('/local-play/start', { wallet: third });
  assert.equal(full.status, 409); assert.equal(full.body.error, 'WorldLimit'); assert.deepEqual(full.body.worlds.map(w => [w.wallet, w.herald, w.state]), [[wallet, a.body.herald, 'running'], [other, b.body.herald, 'running']]);
  assert.equal((await request(worldPorts(c.worldPort, 0).herald, 'GET', '/h/status', null, {})).status, 200, 'and both worlds go on');
  assert.equal((await request(worldPorts(c.worldPort, 1).herald, 'GET', '/h/status', null, {})).status, 200);
  assert.deepEqual(await post('/local-play/stop', { wallet: third }), { status: 404, body: { error: 'WorldNotFound' } });
  // asked, the launcher lists the same two; the asking stops nothing
  let asked = await post('/local-play/worlds', {});
  assert.equal(asked.status, 200); assert.deepEqual(asked.body.worlds.map(w => [w.wallet, w.herald, w.state]), [[wallet, a.body.herald, 'running'], [other, b.body.herald, 'running']]);
  assert.equal((await request(worldPorts(c.worldPort, 0).herald, 'GET', '/h/status', null, {})).status, 200);
  assert.deepEqual(await post('/local-play/stop', { wallet }), { status: 200, body: { stopped: true } });
  asked = await post('/local-play/worlds', {}); assert.deepEqual(asked.body.worlds.map(w => w.wallet), [other], 'the stopped world is gone from the list');
  for (const p of Object.values(worldPorts(c.worldPort, 0))) assert.equal(await portFree(p), true, `the stopped world's port ${p} is free`);
  assert.equal((await request(worldPorts(c.worldPort, 1).herald, 'GET', '/h/status', null, {})).status, 200, 'the other world was not touched');
  const freed = await post('/local-play/start', { wallet: third });
  assert.deepEqual(Object.keys(freed.body).sort(), ['expiry', 'herald']); assertExpiry(freed.body.expiry);
  assert.ok(freed.body.expiry.startedAt >= a.body.expiry.startedAt, 'a new world: its own TTL origin');
  assert.deepEqual({ ...freed, body: { herald: freed.body.herald } }, { status: 200, body: { herald: a.body.herald } }, 'the new world takes the freed place');
  await manager.close();
  for (const slot of [0, 1]) for (const p of Object.values(worldPorts(c.worldPort, slot))) assert.equal(await portFree(p), true, `closing the launcher frees port ${p}`);
});

// ---- the opt-in preparation (--prepare-scale): bounded, through the runner's own time control, back at 1x before the hand-over
const FAST = { preparePaceMs: 40 };
const setScales = log => log.filter(x => x.method === 'frontier_setScale').map(x => x.params[0]);

test('without --prepare-scale the launcher never asks anything of a world\'s clock', { timeout: 120000 }, async t => {
  const { c, tmp } = await standIns(t); const w = await startWorld(c, wallet, 0, () => {});
  assert.equal(w.prepared, undefined); await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(await rpcLog(tmp), [], 'no status read, no scale set: the natural 1x world as before');
  assert.equal((await fsp.readdir(await worldDir(c))).includes('prepare.json'), false);
  await w.stop('requested');
});

test('the preparation: the clock is fast only until the runner has opened the destination, is read back at 1x, and is never touched again', { timeout: 120000 }, async t => {
  const { c, tmp } = await standIns(t, { guard: FAST, lead: 45 }); c.prepareScale = 30; const ports = worldPorts(c.worldPort, 0);
  const at = Date.now(), w = await startWorld(c, wallet, 0, () => {}), took = Date.now() - at;
  assert.ok(took < 15000, `a 45-second wait took ${took} ms`);
  // what the page is told, and what is kept in the world's record
  assert.deepEqual(Object.keys(w.prepared).sort(), ['accelerated', 'chainSeconds', 'scale', 'wallMs']); assert.equal(w.prepared.accelerated, true); assert.equal(w.prepared.scale, 30);
  assert.ok(w.prepared.chainSeconds >= 45 && w.prepared.chainSeconds < PREPARE_CHAIN_MAX, `chain seconds ${w.prepared.chainSeconds}`); assert.ok(w.prepared.wallMs > 0 && w.prepared.wallMs <= took);
  const dir = await worldDir(c), kept = await json(path.join(dir, 'prepare.json'));
  assert.deepEqual(kept.clock, { scale: 1, pendingScale: null, paused: false }, 'handed over at 1x'); assert.deepEqual(kept.dest, [129, 0]); assert.equal(kept.keeper.resident, true); assert.deepEqual(kept.herald, { dest: 'captured' }); assert.equal(kept.scale, 30);
  // the order of what was asked of the runner: a look first, fast once, back to 1x once, and only looks after that
  const log = await rpcLog(tmp), methods = log.map(x => x.method);
  assert.equal(methods[0], 'frontier_status'); assert.deepEqual(log[0].result.scale, 1);
  assert.deepEqual(setScales(log), [30, 1], 'one scale up, one scale down');
  const down = log.findIndex(x => x.method === 'frontier_setScale' && x.params[0] === 1);
  assert.ok(log.slice(down + 1).length > 0 && log.slice(down + 1).every(x => x.method === 'frontier_status'), 'after the restore: only reads');
  assert.equal(log.at(-1).result.scale, 1); assert.equal(log.at(-1).result.pendingScale, null);
  assert.deepEqual([...new Set(methods)].sort(), ['frontier_setScale', 'frontier_status'], 'no other method of the runner is called: nothing is written, paused or put in');
  // the world it handed over goes on at 1x, and the launcher asks nothing more of its clock
  const before = log.length; await new Promise(r => setTimeout(r, 600));
  assert.equal((await rpcLog(tmp)).length, before, 'never again after the hand-over');
  assert.equal((await request(ports.herald, 'GET', '/h/status', null, {})).status, 200);
  const route = JSON.parse((await request(ports.herald, 'GET', '/h/world/wide/route?at=129%2C0', null, {})).body); assert.equal(route.asked, '/h/world/wide/route?at=129%2C0'); assert.equal(route.route[0].state, 'captured');
  await w.stop('requested');
});

test('the preparation does nothing to a clock when the destination is already open', { timeout: 120000 }, async t => {
  const { c, tmp } = await standIns(t, { guard: FAST, lead: 0 }); c.prepareScale = 30;
  const w = await startWorld(c, wallet, 0, () => {});
  assert.equal(w.prepared.accelerated, false); assert.equal(w.prepared.scale, 1);
  const log = await rpcLog(tmp); assert.deepEqual(setScales(log), [], 'no scale was set'); assert.ok(log.every(x => x.method === 'frontier_status' && x.result.scale === 1));
  await w.stop('requested');
});

test('a preparation that cannot finish ends the world, with its clock set back to 1x first: bound passed, runner task stopped, not settled, no time control', { timeout: 120000 }, async t => {
  const failing = async (options, code, check = () => {}) => {
    const { c, tmp } = await standIns(t, options); c.prepareScale = options.scale ?? 60; const ports = worldPorts(c.worldPort, 0); let stops = 0;
    await assert.rejects(startWorld(c, wallet, 0, () => { stops++; }), e => e.code === code && e.status === 503, `${JSON.stringify(options)} → ${code}`);
    assert.equal(stops, 1, 'the world was ended before the refusal'); for (const p of Object.values(ports)) assert.equal(await portFree(p), true, `port ${p}`);
    const dir = await worldDir(c); assert.equal((await json(path.join(dir, 'stopped.json'))).reason, `startup-failed:${code}`); assert.equal((await fsp.readdir(dir)).includes('prepare.json'), false, 'nothing is recorded as prepared');
    const { pids } = await json(path.join(dir, 'processes.json')); assert.ok(pids.every(pid => !alive(pid)), 'no process of it is left');
    const log = await rpcLog(tmp); check(log); return log;
  };
  // the destination never opens: the bound in chain seconds is reached, the clock goes back, then the world ends
  const restoredThenRead = log => { const down = log.findIndex(x => x.method === 'frontier_setScale' && x.params[0] === 1); assert.ok(down > 0, 'set back to 1x'); const next = log.slice(down + 1).find(x => x.method === 'frontier_status' && x.result.scale === 1 && x.result.pendingScale === null); assert.ok(next, 'and read back at 1x'); };
  let log = await failing({ mode: 'never-opens', guard: { ...FAST, prepareChainMax: 90, prepareSlackMs: 5000 } }, 'PrepareTimeout', restoredThenRead);
  assert.deepEqual(setScales(log), [60, 1]);
  const fast = log.filter(x => x.method === 'frontier_status' && x.result.scale === 60).map(x => x.result.unixTimestamp);
  assert.ok(Math.max(...fast) - log[0].result.unixTimestamp < 90 + 2 * 3 + 5, 'the clock ran fast for the bound and a look or two, not on');
  // real time is bounded too: a clock that takes the call but does not run faster is given the time the bound would take at the scale asked, and a little
  const began = Date.now();
  await failing({ mode: 'stalled', guard: { ...FAST, prepareChainMax: 90, prepareSlackMs: 300 } }, 'PrepareTimeout', log2 => { restoredThenRead(log2); assert.deepEqual(setScales(log2), [60, 1]);
    assert.ok(Math.max(...log2.filter(x => x.method === 'frontier_status').map(x => x.result.unixTimestamp)) - log2[0].result.unixTimestamp < 30, 'the chain bound was not what ended it'); });
  assert.ok(Date.now() - began < 20000, 'ended by the bound in real time');
  // the runner's own task says it stopped
  await failing({ mode: 'wide-stops', guard: FAST }, 'PrepareHalted', log2 => { restoredThenRead(log2); assert.deepEqual(setScales(log2), [60, 1]); });
  // back at 1x but the keeper's next line does not show the home resident, or the herald does not serve the destination
  await failing({ mode: 'not-resident', lead: 30, guard: { ...FAST, prepareSettleMs: 700 } }, 'PrepareNotSettled', log2 => { restoredThenRead(log2); assert.equal(log2.at(-1).result.scale, 1); });
  await failing({ heraldMode: 'no-capture', lead: 30, guard: { ...FAST, prepareSettleMs: 700 } }, 'PrepareNotSettled', restoredThenRead);
  // the scale was changed but the answer to that call was lost: still set back and read back at 1x before the world ends
  await failing({ mode: 'answer-lost', guard: FAST }, 'RunnerRpcRefused', log2 => { restoredThenRead(log2); assert.deepEqual(setScales(log2), [60, 1]); });
  // a runner that names no time control: nothing is asked of its clock at all
  await failing({ mode: 'no-time-control', guard: FAST }, 'PrepareUnavailable', log2 => assert.deepEqual(log2, []));
});

test('a clock that cannot be read back at 1x is never handed over: the world ends', { timeout: 120000 }, async t => {
  const { c, tmp } = await standIns(t, { mode: 'sticky', lead: 30, guard: FAST }); c.prepareScale = 30; let stops = 0;
  await assert.rejects(startWorld(c, wallet, 0, () => { stops++; }), e => e.code === 'PrepareClockNotRestored' && e.status === 503);
  assert.equal(stops, 1); const dir = await worldDir(c), { pids } = await json(path.join(dir, 'processes.json'));
  assert.ok(pids.every(pid => !alive(pid)), 'the runner with the fast clock is gone'); assert.equal((await json(path.join(dir, 'stopped.json'))).reason, 'startup-failed:PrepareClockNotRestored');
  const log = await rpcLog(tmp); assert.ok(setScales(log).filter(x => x === 1).length >= 2, 'asked for 1x more than once'); assert.ok(log.filter(x => x.method === 'frontier_status').every(x => !(x.result.scale === 1 && x.result.pendingScale === null) || log.indexOf(x) === 0), 'it never read 1x again');
  assert.equal(log.filter(x => x.method === 'frontier_status').at(-1).result.scale, 30, 'the clock it gave up on was still fast: that world could not be handed over');
});

test('a world ended by its player while it is being prepared is simply ended', { timeout: 120000 }, async t => {
  const { c } = await standIns(t, { mode: 'never-opens', guard: FAST }); c.prepareScale = 30; const abort = new AbortController(); let stops = 0;
  const starting = startWorld(c, wallet, 0, () => { stops++; }, abort.signal);
  await until('the preparation under way', async () => (await fsp.readdir(c.data)).length === 1 && (await fsp.readdir(await worldDir(c))).includes('processes.json'));
  await new Promise(r => setTimeout(r, 200)); abort.abort('requested');
  await assert.rejects(starting, e => e.status === 503); assert.equal(stops, 1);
  const { pids } = await json(path.join(await worldDir(c), 'processes.json')); assert.ok(pids.every(pid => !alive(pid)));
  for (const p of Object.values(worldPorts(c.worldPort, 0))) assert.equal(await portFree(p), true);
});

test('over HTTP: the page is told how its world was prepared, and the launcher page\'s address always says whether worlds are prepared fast', { timeout: 120000 }, async t => {
  const { c } = await standIns(t, { guard: FAST, lead: 30 }); c.prepareScale = 30;
  const { server, manager } = createLauncherServer(c);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  t.after(async () => { await manager.close(); await new Promise(r => server.close(r)); });
  const h = { host: 'localhost:41920', origin: 'http://localhost:41920', 'content-type': 'application/json' };
  const page = '/frontier/frontier/index.html';
  // the root, and any launcher page asked for without (or with another) `prepare`, go to the address that says it
  assert.equal((await request(port, 'GET', '/', null, h)).headers.location, `${page}?localPlay=1&launcher=1&devWallet=off&prepare=accelerated`);
  for (const [query, to] of [['localPlay=1&launcher=1&devWallet=off', 'localPlay=1&launcher=1&devWallet=off&prepare=accelerated'], ['localPlay=1&launcher=1&prepare=natural', 'localPlay=1&launcher=1&prepare=accelerated'], ['launcher=1&prepare=', 'launcher=1&prepare=accelerated'], ['launcher=1&prepare=accelerated&prepare=x', null]]) {
    const r = await request(port, 'GET', `${page}?${query}`, null, h);
    if (to === null) { assert.ok([200, 404].includes(r.status)); continue; }
    assert.equal(r.status, 302, query); assert.equal(r.headers.location, `${page}?${to}`);
  }
  // (a page that is not the launcher's is not sent anywhere: in this stand-in checkout there is no such file, so 404)
  assert.equal((await request(port, 'GET', `${page}?localPlay=1`, null, h)).status, 404); assert.equal((await request(port, 'GET', `${page}?localPlay=1&launcher=1&devWallet=off&prepare=accelerated`, null, h)).status, 404);
  // the start: the same answer as before, and beside it what was done to prepare the world
  const r = await request(port, 'POST', '/local-play/start', JSON.stringify({ wallet }), h); assert.equal(r.status, 200);
  const body = JSON.parse(r.body); assert.deepEqual(Object.keys(body).sort(), ['expiry', 'herald', 'prepared']); assertExpiry(body.expiry); assert.equal(body.herald, `http://localhost:${worldPorts(c.worldPort, 0).herald}`);
  assert.equal(body.prepared.accelerated, true); assert.equal(body.prepared.scale, 30); assert.ok(body.prepared.chainSeconds >= 30);
  // a second press for the same address: the same world and the same record, no second preparation
  const again = JSON.parse((await request(port, 'POST', '/local-play/start', JSON.stringify({ wallet }), h)).body); assert.deepEqual(again, body);
  assert.deepEqual(setScales(await rpcLog(c.root)), [30, 1]);
  // without the option the launcher page's address carries no `prepare`, and one that does is sent to the plain one
  const plain = createLauncherServer({ port: 41920, worldPort: 41924, web: path.join(root, 'permutation-server/web') }, { start: async () => ({ herald: 'http://localhost:41926' }), close() {} });
  plain.server.listen(0, '127.0.0.1'); await once(plain.server, 'listening'); const p2 = plain.server.address().port; t.after(() => new Promise(x => plain.server.close(x)));
  assert.equal((await request(p2, 'GET', '/', null, h)).headers.location, `${page}?localPlay=1&launcher=1&devWallet=off`);
  let moved = await request(p2, 'GET', `${page}?localPlay=1&launcher=1&devWallet=off&prepare=accelerated`, null, h); assert.equal(moved.status, 302); assert.equal(moved.headers.location, `${page}?localPlay=1&launcher=1&devWallet=off`);
  assert.equal((await request(p2, 'GET', `${page}?localPlay=1&launcher=1&devWallet=off`, null, h)).status, 200, 'the plain launcher page is served as it is');
  assert.equal((await request(p2, 'GET', `${page}?localPlay=1&prepare=accelerated`, null, h)).status, 200, 'a page without launcher=1 is the operator\'s own: not this launcher\'s to rewrite');
  assert.deepEqual(JSON.parse((await request(p2, 'POST', '/local-play/start', JSON.stringify({ wallet }), h)).body), { herald: 'http://localhost:41926' }, 'and its answer is the one field as before');
});

test('the command line: fixed keys, absolute paths, ports inside 41000-41999 and never 41904-41907', { timeout: 120000 }, async t => {
  const { c, tmp } = await standIns(t); const so = path.join(tmp, 'bin/program.so'); await fsp.writeFile(so, 'x');
  const base = { root: tmp, data: path.join(tmp, 'data2'), runner: c.runner, herald: c.herald, depart: c.runner, preview: c.runner, resident: c.runner, artifact: so, 'artifact-sha': 'cd'.repeat(32) };
  const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);
  const good = await parseConfig(argv(base));
  assert.equal(good.port, 41920); assert.equal(good.worldPort, 41924); assert.equal(good.artifactSha, 'cd'.repeat(32)); assert.equal(good.web, path.join(tmp, 'permutation-server/web')); assert.equal(good.guard, undefined, 'the limits are not the command line\'s to change');
  assert.deepEqual([0, 1].map(s => Object.values(worldPorts(good.worldPort, s))), [[41924, 41925, 41926, 41927, 41928], [41929, 41930, 41931, 41932, 41933]]);
  assert.equal((await parseConfig(argv({ ...base, port: 41950, 'world-port': 41960 }))).worldPort, 41960);
  const refused = async (o, code) => assert.rejects(parseConfig(Array.isArray(o) ? o : argv(o)), e => e.code === code, `${JSON.stringify(o).slice(0, 120)} → ${code}`);
  // the conquest lane, in words: the one preset, which needs the preparation; a conquest CLI only with it
  assert.equal(good.conquest, undefined); assert.equal(good.worldPreset, undefined);
  const lane = await parseConfig(argv({ ...base, 'world-preset': 'local-conquest-test-v1', 'prepare-scale': 30, conquest: c.herald }));
  assert.equal(lane.worldPreset, 'local-conquest-test-v1'); assert.equal(lane.conquest, c.herald, 'the conquest CLI: an absolute path of a file, on the command line only'); assert.equal(lane.prepareScale, 30);
  assert.equal((await parseConfig(argv({ ...base, 'world-preset': 'local-conquest-test-v1', 'prepare-scale': 30 }))).conquest, undefined, 'a preset world without a conquest CLI: the page may be told, the relay is the plain one');
  await refused({ ...base, 'world-preset': 'local-conquest-test-v1' }, 'WorldPresetNeedsPrepare');
  for (const name of ['conquest', 'local-conquest-test-v2', 'LOCAL-CONQUEST-TEST-V1', 'S1_LOCAL_7D', 'true', '1']) await refused({ ...base, 'world-preset': name, 'prepare-scale': 30 }, 'InvalidWorldPreset');
  await refused({ ...base, conquest: c.herald }, 'ConquestNeedsWorldPreset'); await refused({ ...base, conquest: c.herald, 'prepare-scale': 30 }, 'ConquestNeedsWorldPreset');
  for (const [port, worldPort] of [[41904, 41924], [41907, 41924], [41920, 41900], [41920, 41898], [41920, 41907], [41926, 41924], [41933, 41924], [40999, 41924], [42000, 41924], [41920, 41991], [41920, 40995], [8080, 41924], ['41920x', 41924], [41920.5, 41924], [41920, 'abc']]) await refused({ ...base, port, 'world-port': worldPort }, 'InvalidPorts');
  for (const k of ['root', 'data', 'runner', 'herald', 'depart', 'preview', 'resident', 'artifact']) { await refused({ ...base, [k]: 'relative/path' }, 'AbsolutePathRequired'); const less = { ...base }; delete less[k]; await refused(less, 'AbsolutePathRequired'); }
  for (const sha of ['', 'xyz', 'AB'.repeat(32), 'ab'.repeat(31)]) await refused([...argv({ ...base, 'artifact-sha': 'ab'.repeat(32) }).slice(0, -1), sha].filter((x, i, a) => !(x === '' && i === a.length - 1)), sha === '' ? 'InvalidArguments' : 'ArtifactHashRequired');
  await refused({ ...base, runner: path.join(tmp, 'bin/none') }, 'MissingFile'); await refused({ ...base, artifact: tmp }, 'MissingFile');
  await refused({ ...base, 'world-preset': 'local-conquest-test-v1', 'prepare-scale': 30, conquest: 'bin/conquest' }, 'AbsolutePathRequired'); await refused({ ...base, 'world-preset': 'local-conquest-test-v1', 'prepare-scale': 30, conquest: path.join(tmp, 'bin/none') }, 'MissingFile');
  // the preparation's scale: off unless given, a whole number inside its range, and nothing else of the preparation is the command line's
  assert.equal(good.prepareScale, undefined); assert.deepEqual([PREPARE_SCALE_MIN, PREPARE_SCALE_MAX, PREPARE_CHAIN_MAX], [10, 60, 1200]);
  for (const n of [10, 30, 60]) assert.equal((await parseConfig(argv({ ...base, 'prepare-scale': n }))).prepareScale, n);
  for (const n of ['9', '61', '100', '1000', '0', '1', '-30', '30.5', '3e1', '030', '0x1e', ' 30', '30 ', 'fast', 'true']) await refused({ ...base, 'prepare-scale': n }, 'InvalidPrepareScale');
  for (const extra of [['--prepare-chain-max', '99999'], ['--prepare', 'accelerated'], ['--scale', '30'], ['--prepare-settle', '1'], ['--conquest-capability', '/x'], ['--free-city', '129,0,3,43'], ['--heap-confirmed', '1'], ['--markers', 'x']]) await refused([...argv(base), ...extra], 'InvalidArguments');
  for (const extra of [['--command', 'x'], ['--exec', '/bin/sh'], ['--shell', '1'], ['--host', '0.0.0.0'], ['--listen', '0.0.0.0:41920'], ['--guard', '{}'], ['--key', 'x'], ['runner', '/x'], ['--port']]) await refused([...argv(base), ...extra], 'InvalidArguments');
  await refused([...argv(base), '--port', '41921', '--port', '41922'], 'InvalidArguments');
});

// ---- the LOCAL TEST CANDIDATE lane (localnet-conquest-nft-sbf; not an allocation): opt-in, exact id and version, the NFT
//      pass's setup once and its mint page stopped with the world; without the option nothing changes
async function candidateStandIns(t, options = {}) {
  const x = await conquestStandIns(t, options);
  const script = async (name, source) => { const f = path.join(x.tmp, 'bin', name); await fsp.writeFile(f, source); return f; };
  const setupMode = options.setup ?? 'ok';
  const nftSetup = await script('nft-setup.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(x.tmp, 'setup-args.json'))}, JSON.stringify(process.argv.slice(2))); process.exit(${setupMode === 'fails' ? 1 : 0});\n`);
  const mintPort = x.c.worldPort + WORLD_LIMIT * 5 + 1;
  const mint = await script('mint.mjs', `import http from 'node:http'; process.on('SIGINT', () => process.exit(0)); const a = k => process.argv[process.argv.indexOf(k) + 1];
http.createServer((q, r) => { r.writeHead(${options.mint === 'not-ready' ? 503 : 200}, { 'content-type': 'application/json' }); r.end(JSON.stringify({ program: a('--program'), rpc: a('--rpc') })); }).listen(Number(a('--port')), '127.0.0.1');\n`);
  Object.assign(x.c, { laneCandidate: 'localnet-conquest-nft-sbf', residentSo: '/abs/resident.so', coreSo: '/abs/core.so', nftSetup, mint, mintPort, guard: { ...x.c.guard, nftSetupMs: 5000, mintReadyMs: 3000 } });
  return x;
}

test('candidate: the runner is asked for it; exact id and version; the setup once with the runner\'s own facts; the mint page is a child of the world and stops with it', { timeout: 120000 }, async t => {
  const { c, tmp } = await candidateStandIns(t);
  const w = await startWorld(c, wallet, 0, () => {}); const dir = await worldDir(c), meta = await json(path.join(dir, 'metadata.json'));
  assert.deepEqual(meta.args.slice(meta.args.indexOf('--lane-candidate')), ['--lane-candidate', 'localnet-conquest-nft-sbf', '--resident-so', '/abs/resident.so', '--core-so', '/abs/core.so', '--authority-seed-dir', dir]);
  assert.equal(meta.program, CANDIDATE_PROGRAM); assert.equal(meta.program_version, '0xc804');
  assert.deepEqual(await json(path.join(tmp, 'setup-args.json')), ['--rpc', meta.rpc_url, '--frontier', CANDIDATE_PROGRAM, '--resident', meta.resident_program, '--authority-seed-file', path.join(dir, 'candidate-authority.seed'), '--test-sale']);
  const r = await fetch(`http://127.0.0.1:${c.mintPort}/mint/config`); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { program: meta.resident_program, rpc: meta.rpc_url });
  assert.ok((await json(path.join(dir, 'processes.json'))).ports.includes(c.mintPort));
  await w.stop('requested');
  await assert.rejects(fetch(`http://127.0.0.1:${c.mintPort}/mint/config`, { signal: AbortSignal.timeout(1000) }), 'the mint page stopped with the world');
});

test('candidate refusals: another id, another version, a seed outside the world, a setup that fails, a mint page that never answers; a plain start refuses a runner that mentions a candidate', { timeout: 180000 }, async t => {
  for (const [mode, code] of [['candidate-plain-program', 'RunnerNotReady'], ['candidate-other-version', 'RunnerNotReady'], ['seed-outside', 'RunnerNotReady']]) {
    const { c } = await candidateStandIns(t, { mode });
    await assert.rejects(startWorld(c, wallet, 0, () => {}), e => e.code === code, mode);
  }
  const failing = await candidateStandIns(t, { setup: 'fails' });
  await assert.rejects(startWorld(failing.c, wallet, 0, () => {}), e => e.code === 'nft-setup-failed');
  const deaf = await candidateStandIns(t, { mint: 'not-ready' });
  await assert.rejects(startWorld(deaf.c, wallet, 0, () => {}), e => e.code === 'MintNotReady');
  // without the option: a runner that mentions a candidate is not taken
  const plain = await conquestStandIns(t, { mode: 'plain-mentions-candidate' });
  await assert.rejects(startWorld(plain.c, wallet, 0, () => {}), e => e.code === 'RunnerNotReady');
  // the candidate only on the conquest preset's one world
  const second = await candidateStandIns(t);
  await assert.rejects(startWorld(second.c, wallet, 1, () => {}), e => e.code === 'CandidateNeedsConquestOneWorld');
  assert.equal(candidateMetaAgrees({ program: 'x' }, false, '/d'), true, 'a plain runner names none of the candidate keys');
  assert.equal(candidateMetaAgrees({ program: 'x', program_version: '0x4804' }, false, '/d'), true, 'the real runner\'s own version line, as ever');
  assert.equal(candidateMetaAgrees({ program: 'x', program_version: '0xc804' }, false, '/d'), false, 'a plain start never takes the candidate version');
  assert.equal(candidateMetaAgrees({ program: 'x', program_version: 18436 }, false, '/d'), false);
});

test('candidate options: all or none, exactly its word, the conquest preset only, absolute files, a mint port of its own', async t => {
  const { c } = await standIns(t);
  const files = {}; for (const k of ['resident-so', 'core-so', 'nft-setup', 'mint']) { files[k] = path.join(c.root, 'bin', k); await fsp.writeFile(files[k], 'x'); }
  const base = ['--root', c.root, '--data', c.data, '--runner', c.runner, '--herald', c.herald, '--depart', c.runner, '--preview', c.runner, '--resident', c.runner, '--artifact', c.runner, '--artifact-sha', 'ab'.repeat(32), '--world-preset', 'local-conquest-test-v1', '--prepare-scale', '30'];
  const cand = (over = {}) => Object.entries({ 'lane-candidate': 'localnet-conquest-nft-sbf', ...files, 'mint-port': '41990', ...over }).filter(([, v]) => v !== null).flatMap(([k, v]) => [`--${k}`, v]);
  const ok = await parseConfig([...base, ...cand()]);
  assert.deepEqual([ok.laneCandidate, ok.mintPort, ok.nftSetup], ['localnet-conquest-nft-sbf', 41990, files['nft-setup']]);
  const plain = await parseConfig(base); assert.equal(plain.laneCandidate, undefined, 'none given: no candidate');
  const bad = async (args, code) => assert.rejects(parseConfig(args), e => e.code === code, code);
  await bad([...base, ...cand({ mint: null })], 'InvalidLaneCandidate');
  await bad([...base, ...cand({ 'lane-candidate': 'localnet-nft-sbf' })], 'InvalidLaneCandidate');
  await bad([...base.slice(0, -4), ...cand()], 'CandidateNeedsConquestPreset');
  await bad([...base, ...cand({ 'nft-setup': 'relative.mjs' })], 'AbsolutePathRequired');
  for (const p of ['41920', '41924', '41905', '42000', '4199']) await bad([...base, ...cand({ 'mint-port': p })], 'InvalidPorts');
});

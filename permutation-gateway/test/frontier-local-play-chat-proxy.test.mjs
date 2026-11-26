// The local-play world proxy and the herald's nation chat (frontier-node/crates/herald/src/chat.rs; owner Q-PT-11 (a)):
// the page's three chat POSTs (each with its preflight), the chat's public info read and its live socket are passed on
// to the HERALD (never the relay); the operator's `/h/chat/admin/*` paths, a GET of a chat write and any other chat path
// are not. Ports 41530–41533 (the nation-chat run's range), never the launcher tests' 41920–41989.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createWorldProxy, WORLD_CHAT_POST_ROUTES, WORLD_CHAT_WS_ROUTE, WORLD_CHAT_INFO_ROUTE, WORLD_POST_ROUTES } from '../src/frontier/local-play-launcher.mjs';

const PROXY = 41530, HERALD = 41531, LAUNCHER = 41532, RELAY = 41533;
const ORIGIN = `http://localhost:${LAUNCHER}`;

function listen(server, port) { return new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); }); }
function close(server) { return new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }); }

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PROXY, method, path, headers: { host: `localhost:${PROXY}`, ...headers, ...(body !== null ? { 'content-length': Buffer.byteLength(body) } : {}) }, agent: false }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); r.end(body ?? undefined);
  });
}

async function setup(t) {
  const seen = { herald: [], relay: [], upgrades: [] };
  const fake = name => http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { seen[name].push({ method: req.method, url: req.url, headers: req.headers, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, from: name })); });
  });
  const herald = fake('herald'), relay = fake('relay');
  herald.on('upgrade', (req, socket) => { seen.upgrades.push(req.url); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); });
  await listen(herald, HERALD); await listen(relay, RELAY);
  const proxy = createWorldProxy({ port: PROXY, targetPort: HERALD, launcherPort: LAUNCHER, relayPort: RELAY });
  await listen(proxy, PROXY);
  t.after(async () => { await proxy.closeNow(); await close(herald); await close(relay); });
  return seen;
}

function upgrade(path, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PROXY, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${PROXY}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let got = ''; s.setEncoding('utf8');
    s.on('data', d => { got += d; if (got.includes('\r\n\r\n')) { s.destroy(); resolve(got.split(' ')[1]); } });
    s.on('error', reject); s.on('close', () => resolve(got.split(' ')[1] ?? 'closed'));
  });
}

test('world proxy: the nation chat\'s POSTs, info and socket go to the herald; its operator paths do not', { timeout: 60000 }, async t => {
  const seen = await setup(t);
  assert.deepEqual([...WORLD_CHAT_POST_ROUTES], ['/h/chat/post', '/h/chat/read', '/h/chat/report']);
  assert.ok(!WORLD_CHAT_POST_ROUTES.some(r => WORLD_POST_ROUTES.includes(r)), 'the relay\'s list is unchanged');
  for (const route of WORLD_CHAT_POST_ROUTES) {
    let r = await request('OPTIONS', route, null, { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' });
    assert.equal(r.status, 204, route); assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
    seen.herald.length = 0; seen.relay.length = 0;
    r = await request('POST', route, '{"token":1}', { origin: ORIGIN, 'content-type': 'application/json', cookie: 'x=1', authorization: 'Bearer x' });
    assert.equal(r.status, 200, route); assert.equal(JSON.parse(r.body).from, 'herald');
    assert.equal(seen.relay.length, 0); assert.equal(seen.herald[0].url, route); assert.equal(seen.herald[0].body, '{"token":1}');
    assert.equal(seen.herald[0].headers.authorization, undefined); assert.equal(seen.herald[0].headers.cookie, undefined);
    assert.equal((await request('GET', route, null, { origin: ORIGIN })).status, 405, `${route} is not a read`);
    // another site's page
    assert.equal((await request('POST', route, '{}', { origin: 'http://evil.example', 'content-type': 'application/json' })).status, 403);
  }
  // the public info read
  seen.herald.length = 0;
  let r = await request('GET', WORLD_CHAT_INFO_ROUTE, null, { origin: ORIGIN });
  assert.equal(r.status, 200); assert.equal(seen.herald[0].url, '/h/chat/info');
  // the operator's paths and anything else under /h/chat/: not passed on
  for (const [m, p] of [['GET', '/h/chat/admin/reports'], ['POST', '/h/chat/admin/delete'], ['POST', '/h/chat/admin/dismiss'], ['GET', '/h/chat/ws'], ['GET', '/h/chat/other'], ['POST', '/h/chat/other']]) {
    seen.herald.length = 0;
    r = await request(m, p, m === 'POST' ? '{}' : null, { origin: ORIGIN, ...(m === 'POST' ? { 'content-type': 'application/json' } : {}) });
    assert.equal(r.status, 404, `${m} ${p}`); assert.equal(JSON.parse(r.body).error, 'WorldRouteDenied'); assert.equal(seen.herald.length, 0);
  }
  // the sockets: the chat's is passed on under its own path; another chat path or another origin is not
  assert.equal(await upgrade(WORLD_CHAT_WS_ROUTE), '101'); assert.deepEqual(seen.upgrades, ['/h/chat/ws']);
  assert.equal(await upgrade('/h/ws'), '101'); assert.deepEqual(seen.upgrades, ['/h/chat/ws', '/h/ws']);
  assert.equal(await upgrade('/h/chat/admin/reports'), '404');
  assert.equal(await upgrade(WORLD_CHAT_WS_ROUTE, 'http://evil.example'), '403');
  assert.equal(seen.upgrades.length, 2);
});

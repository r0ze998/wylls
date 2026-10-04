// citizens/serve.mjs (unit AC5; contract §8.3, §1.3 C6): PUB as /h/ai/* with the pinned cache headers and CORS,
// path safety (dot segments, encodings, symlinks, real paths, key-looking files), the council page and its CSP,
// same-origin forwarding to a fake herald (unchanged) and a fake social service (X-Forwarded-For), the port rule.
// Everything on 127.0.0.1:0; nothing here needs a stack or a model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServe, assertAiPort, cacheControlFor, clientIp, parseTarget, findKeyLikeFiles, looksLikeKeypairJson, PAGE_CSP, IMMUTABLE, SHORT, MAX_BODY } from '../citizens/serve.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-serve-'));
const aiDir = path.join(tmp, 'ai');
const pub = path.join(aiDir, 'pub');
const pageDir = path.join(tmp, 'web-frontier');
const outside = path.join(tmp, 'outside');
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

// ------------------------------------------------------------------ fixtures on disk
write(path.join(pub, 'commitments.json'), '{"v":1}');
write(path.join(pub, 'talk', '402.json'), '{"bell":402,"root":"00","records":[]}');
write(path.join(pub, 'talk', 'latest.json'), '{"bell":402}');
write(path.join(pub, 'council', '48-3.json'), '{"period":48}');
write(path.join(pub, 'memory', '00aa', 'episodes.json'), '{"v":1}');
write(path.join(pub, 'notes.txt'), 'plain');
write(path.join(pub, 'empty.json'), '');
write(path.join(pub, 'page.html'), '<script>alert(1)</script>');
write(path.join(pub, 'registrar.json'), '{"not":"served"}');
write(path.join(pub, 'bytes.json'), JSON.stringify(Array.from({ length: 64 }, (_, i) => i * 3 % 256)));
write(path.join(pub, 'pem.txt'), '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n');
write(path.join(pub, '.hidden.json'), '{}');
write(path.join(outside, 'secret.json'), '{"outside":true}');
write(path.join(outside, 'dir', 'x.json'), '{"outside":true}');
fs.symlinkSync(path.join(outside, 'secret.json'), path.join(pub, 'link.json'));
fs.symlinkSync(path.join(pub, 'commitments.json'), path.join(pub, 'inside-link.json'));
fs.symlinkSync(path.join(outside, 'dir'), path.join(pub, 'linkdir'));
write(path.join(pageDir, 'council.html'), '<!doctype html><title>council</title>');
write(path.join(pageDir, 'council', 'main.mjs'), 'export const x = 1;');
write(path.join(pageDir, 'council', 'council.css'), 'body{}');
write(path.join(pageDir, 'app.mjs'), 'export const app = 1;'); // not the council's: never served locally
fs.symlinkSync(path.join(outside, 'secret.json'), path.join(pageDir, 'council', 'evil.json'));

// ------------------------------------------------------------------ fake herald and social service
const heraldHits = [];
const socialHits = [];
const gzBody = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x03, 0x01, 0x02]);
const upstream = (hits, name) => http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    hits.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url.startsWith('/h/season')) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-from': name, 'set-cookie': ['a=1', 'b=2'] }); return res.end('{"cluster":"localnet"}'); }
    if (req.url.startsWith('/h/bell/')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'cache-control': IMMUTABLE }); return res.end(gzBody); }
    if (req.url.startsWith('/h/nothing')) { res.writeHead(404, { 'content-type': 'application/json', 'x-from': name }); return res.end('{"ok":false,"code":"NotYet"}'); }
    if (req.url.startsWith('/frontier/')) { res.writeHead(200, { 'content-type': 'text/javascript', etag: '"abc"', 'content-security-policy': "default-src 'self'" }); return res.end('export {};'); }
    if (req.url.startsWith('/gw/') || req.url.startsWith('/f/ai/')) { res.writeHead(201, { 'content-type': 'application/json', 'x-echo-len': String(body.length) }); return res.end(JSON.stringify({ url: req.url, method: req.method, body: body.toString('latin1') })); }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  });
});
const heraldSrv = upstream(heraldHits, 'herald');
const socialSrv = upstream(socialHits, 'social');
// The herald's live feed: a 101 and an echo, to see the upgrade is a byte pipe.
heraldSrv.on('upgrade', (req, sock) => {
  heraldHits.push({ method: 'UPGRADE', url: req.url, headers: req.headers });
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  sock.on('data', d => sock.write(Buffer.concat([Buffer.from('echo:'), d])));
});
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

let serve, base, port, heraldPort, socialPort;
before(async () => {
  heraldPort = await listen(heraldSrv);
  socialPort = await listen(socialSrv);
  serve = createServe({ aiDir, herald: `http://127.0.0.1:${heraldPort}`, social: `http://127.0.0.1:${socialPort}`, port: 0, pageDir });
  port = await serve.listen();
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await serve.close();
  heraldSrv.closeAllConnections?.(); socialSrv.closeAllConnections?.();
  await Promise.all([heraldSrv, socialSrv].map(s => new Promise(r => s.close(r))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A request whose target is sent exactly as written (fetch would normalise dot segments). */
const raw = (target, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const sock = net.connect(port, '127.0.0.1');
  const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  if (body !== null) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  sock.write(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  if (body !== null) sock.write(body);
  const chunks = [];
  sock.on('data', c => chunks.push(c));
  sock.on('error', () => {}); // an early 413 may reset the upload; the answer is still read
  sock.on('close', () => {
    const buf = Buffer.concat(chunks);
    const at = buf.indexOf('\r\n\r\n');
    if (at < 0) return reject(new Error('no answer'));
    const head = buf.subarray(0, at).toString('latin1').split('\r\n');
    const headers2 = {};
    for (const l of head.slice(1)) { const i = l.indexOf(':'); headers2[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
    let body = buf.subarray(at + 4);
    if (headers2['transfer-encoding'] === 'chunked') { // decode
      const parts = [];
      for (let i = 0; i < body.length;) {
        const e = body.indexOf('\r\n', i);
        const n = parseInt(body.subarray(i, e).toString(), 16);
        if (!n) break;
        parts.push(body.subarray(e + 2, e + 2 + n));
        i = e + 2 + n + 2;
      }
      body = Buffer.concat(parts);
    }
    resolve({ status: Number(head[0].split(' ')[1]), headers: headers2, body });
  });
});
const get = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, headers: r.headers, text: await r.text() }; };

// ------------------------------------------------------------------ the pure helpers
test('cache headers: <digits>.json and <digits>-<digits>.json are immutable, everything else lives 2 s', () => {
  for (const n of ['0.json', '402.json', '48-3.json', '12-0.json']) assert.equal(cacheControlFor(n), IMMUTABLE, n);
  for (const n of ['latest.json', 'current.json', 'a1.json', '402.txt', '1-2-3.json', '-3.json', '12-.json', 'index.json', '402.json.bak']) assert.equal(cacheControlFor(n), SHORT, n);
  assert.equal(IMMUTABLE, 'public, max-age=31536000, immutable');
  assert.equal(SHORT, 'public, max-age=2');
});

test('the port rule: 41901..41999 only (0 is the tests\' ephemeral port); loopback hosts and URLs only', () => {
  for (const p of [41902, 41980, 41999, 41901]) assert.equal(assertAiPort(p), p);
  for (const p of [41900, 41899, 41100, 41041, 41300, 41000, 4185, 4190, 4191, 4194, 18899, 17799, 28899, 27799, 26699, 5185, 5191, 42000, 80, 65535, -1, 1.5, NaN]) {
    assert.throws(() => assertAiPort(p), /outside 41901-41999|not an integer/, String(p));
  }
  assert.throws(() => assertAiPort(0, { allowZero: false }), /outside/);
  const ok = { aiDir, herald: 'http://127.0.0.1:41940', social: 'http://127.0.0.1:41981', pageDir };
  assert.doesNotThrow(() => createServe({ ...ok, port: 41902 }));
  assert.throws(() => createServe({ ...ok, port: 41900 }), /outside/);
  assert.throws(() => createServe({ ...ok, port: 41300 }), /outside/);
  assert.throws(() => createServe({ ...ok, port: 4190 }), /outside/);
  assert.throws(() => createServe({ ...ok, port: 41902, host: '0.0.0.0' }), /not a loopback/);
  assert.throws(() => createServe({ ...ok, port: 41902, host: '192.168.1.5' }), /not a loopback/);
  assert.throws(() => createServe({ ...ok, port: 41902, herald: 'http://example.com:41940' }), /loopback/);
  assert.throws(() => createServe({ ...ok, port: 41902, social: 'http://10.0.0.2:41981' }), /loopback/);
  assert.throws(() => createServe({ ...ok, port: 41902, herald: 'https://127.0.0.1:41940' }), /loopback/);
  assert.throws(() => createServe({ ...ok, port: 41902, herald: 'http://127.0.0.1' }), /no port/);
  assert.doesNotThrow(() => createServe({ ...ok, port: 41902, herald: 'http://[::1]:41940' }));
  assert.throws(() => createServe({ ...ok, port: 41902, aiDir: undefined }), /aiDir/);
});

test('parseTarget refuses the dangerous shapes and decodes the rest', () => {
  for (const t of ['/a/../b', '/a/%2e%2e/b', '/a/%2E%2E/b', '/a/./b', '/a/%2e/b', '/a%2fb', '/a%5cb', '/a\\b', '/a%00b', '/a\u0000b', '//x', 'a/b', 'http://x/y', '/a//b', '/a%zz', '/a b', '/a#x', '/a?b c', '/a\tb']) {
    assert.ok(parseTarget(t).error, JSON.stringify(t));
  }
  assert.deepEqual(parseTarget('/h/ai/talk/402.json?x=1').segs, ['h', 'ai', 'talk', '402.json']);
  assert.equal(parseTarget('/h/ai/talk/402.json?x=1').search, '?x=1');
  assert.deepEqual(parseTarget('/h/ai/').segs, ['h', 'ai', '']);
  assert.deepEqual(parseTarget('/').segs, ['']);
  assert.deepEqual(parseTarget('/a%20b/c').segs, ['a b', 'c']);
});

test('clientIp: the peer, or the last X-Forwarded-For address when the peer is this machine', () => {
  assert.equal(clientIp('127.0.0.1', undefined), '127.0.0.1');
  assert.equal(clientIp('::ffff:127.0.0.1', undefined), '127.0.0.1');
  assert.equal(clientIp('127.0.0.1', '10.1.1.1, 203.0.113.9'), '203.0.113.9');
  assert.equal(clientIp('127.0.0.1', 'garbage'), '127.0.0.1');
  assert.equal(clientIp('::1', '2001:db8::1'), '2001:db8::1');
  assert.equal(clientIp('203.0.113.7', '1.2.3.4'), '203.0.113.7', 'a non-loopback peer cannot set it');
});

test('findKeyLikeFiles flags key names, keypair arrays and PEM text, and links', () => {
  assert.ok(looksLikeKeypairJson(JSON.stringify(Array.from({ length: 64 }, () => 7))));
  assert.ok(!looksLikeKeypairJson(JSON.stringify(Array.from({ length: 63 }, () => 7))));
  assert.ok(!looksLikeKeypairJson(JSON.stringify(Array.from({ length: 64 }, () => 300))));
  assert.ok(!looksLikeKeypairJson('{"a":1}'));
  const found = findKeyLikeFiles(pub).map(p => path.relative(pub, p)).sort();
  assert.deepEqual(found, ['bytes.json', 'inside-link.json', 'link.json', 'linkdir', 'pem.txt', 'registrar.json']);
});

// ------------------------------------------------------------------ /h/ai/*
test('/h/ai/*: PUB files with content type, CORS * and the pinned cache headers', async () => {
  let r = await get('/h/ai/commitments.json');
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"v":1}');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('cache-control'), SHORT);
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  r = await get('/h/ai/talk/402.json');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  r = await get('/h/ai/council/48-3.json');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  r = await get('/h/ai/talk/latest.json');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=2');
  r = await get('/h/ai/memory/00aa/episodes.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=2');
  r = await get('/h/ai/notes.txt');
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  r = await get('/h/ai/empty.json');
  assert.equal(r.status, 200);
  assert.equal(r.text, '');
});

test('/h/ai/*: HEAD, OPTIONS, ETag revalidation, missing files, directories, other extensions, other methods', async () => {
  let r = await fetch(`${base}/h/ai/commitments.json`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), '7');
  assert.equal(await r.text(), '');
  r = await fetch(`${base}/h/ai/commitments.json`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-methods'), /GET/);
  const first = await fetch(`${base}/h/ai/commitments.json`);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  await first.text();
  r = await fetch(`${base}/h/ai/commitments.json`, { headers: { 'if-none-match': etag } });
  assert.equal(r.status, 304);
  for (const p of ['/h/ai/nope.json', '/h/ai/', '/h/ai', '/h/ai/talk/', '/h/ai/talk', '/h/ai/page.html']) {
    r = await fetch(base + p);
    assert.equal(r.status, 404, p);
    assert.equal((await r.json()).ok, false);
  }
  r = await fetch(`${base}/h/ai/commitments.json`, { method: 'DELETE' });
  assert.equal(r.status, 405);
  // /h/ai/* is never forwarded to the herald, not even when the file is missing.
  assert.equal(heraldHits.filter(h => h.url.startsWith('/h/ai')).length, 0);
});

test('path safety: dot segments, encodings, backslash, NUL, dot files, symlinks and real paths outside PUB', async () => {
  const bad = [
    '/h/ai/../outside/secret.json', '/h/ai/%2e%2e/outside/secret.json', '/h/ai/talk/../commitments.json', '/h/ai/./commitments.json',
    '/h/ai/talk%2f402.json', '/h/ai/talk%5c402.json', '/h/ai/talk\\402.json', '/h/ai/commitments.json%00.txt', '/h/ai/%00',
    `/h/ai/..%2f..%2foutside%2fsecret.json`, '/h/ai//commitments.json',
  ];
  for (const p of bad) {
    const r = await raw(p);
    assert.equal(r.status, 400, `${JSON.stringify(p)} → ${r.status}`);
    assert.doesNotMatch(r.body.toString(), /outside|"v":1/);
  }
  // Well-formed but not servable: a dot file, a link to a file outside, a link to a file inside, a link to a directory outside, a link under it.
  for (const p of ['/h/ai/.hidden.json', '/h/ai/link.json', '/h/ai/inside-link.json', '/h/ai/linkdir/x.json', '/h/ai/linkdir', '/h/ai/bytes.json', '/h/ai/registrar.json', '/h/ai/pem.txt']) {
    const r = await raw(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body.toString(), /outside|not.*served|BEGIN/);
  }
  // The page directory, too: a council file that is a link out is refused.
  const r = await raw('/council/evil.json');
  assert.equal(r.status, 404);
});

test('a PUB root that is itself reached through a link still serves (the real root is resolved once per request)', async () => {
  const linkRoot = path.join(tmp, 'ai-link');
  fs.symlinkSync(aiDir, linkRoot);
  const s2 = createServe({ aiDir: linkRoot, herald: `http://127.0.0.1:${heraldPort}`, social: `http://127.0.0.1:${socialPort}`, pageDir });
  const p2 = await s2.listen();
  try {
    const r = await fetch(`http://127.0.0.1:${p2}/h/ai/commitments.json`);
    assert.equal(r.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${p2}/h/ai/link.json`)).status, 404);
  } finally { await s2.close(); }
});

test('a file swapped for a link after the first request is refused on the next', async () => {
  const f = path.join(pub, 'swap.json');
  write(f, '{"a":1}');
  assert.equal((await fetch(`${base}/h/ai/swap.json`)).status, 200);
  fs.rmSync(f);
  fs.symlinkSync(path.join(outside, 'secret.json'), f);
  assert.equal((await fetch(`${base}/h/ai/swap.json`)).status, 404);
  fs.rmSync(f);
});

// ------------------------------------------------------------------ the page
test('the council page: its own files, no-cache, a self-only CSP; the web files are not served locally', async () => {
  for (const p of ['/council.html', '/frontier/council.html']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /council/);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('content-security-policy'), PAGE_CSP);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
  for (const p of ['/council/main.mjs', '/frontier/council/main.mjs']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
  }
  assert.equal((await get('/council/council.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await get('/council/missing.mjs')).status, 404);
  assert.equal((await get('/council.html/x')).status, 404);
  // The CSP: this origin only, no inline script, no eval, nothing framed.
  assert.match(PAGE_CSP, /default-src 'self'/);
  assert.match(PAGE_CSP, /connect-src 'self'/);
  assert.match(PAGE_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(PAGE_CSP, /unsafe-inline|(?<!wasm-)unsafe-eval|\*|https?:/);
  // /frontier/app.mjs is the herald's (forwarded), not the page directory's file of the same name.
  heraldHits.length = 0;
  const r = await get('/frontier/app.mjs');
  assert.equal(r.text, 'export {};');
  assert.equal(heraldHits.length, 1);
  // The root goes to the page.
  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/council.html');
});

// ------------------------------------------------------------------ forwarding
test('/h/*, /gw/* and /frontier/* reach the herald unchanged: method, target, status, headers, body', async () => {
  heraldHits.length = 0;
  let r = await raw('/h/season?x=1&y=%20z', { headers: { accept: 'application/json', authorization: 'Bearer secret', cookie: 'k=v', 'x-extra': '1', 'if-none-match': '"q"' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), '{"cluster":"localnet"}');
  assert.equal(r.headers['x-from'], 'herald');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['content-type'], 'application/json');
  const h = heraldHits.at(-1);
  assert.equal(h.method, 'GET');
  assert.equal(h.url, '/h/season?x=1&y=%20z');
  assert.equal(h.headers.accept, 'application/json');
  assert.equal(h.headers['if-none-match'], '"q"');
  assert.equal(h.headers.authorization, undefined, 'nothing but the whitelist is handed on');
  assert.equal(h.headers.cookie, undefined);
  assert.equal(h.headers['x-extra'], undefined);
  assert.equal(h.headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(h.headers.host, `127.0.0.1:${heraldPort}`);
  // A gzip body stays gzip, a 404 stays a 404.
  r = await raw('/h/bell/7/region/0', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.ok(r.body.equals(gzBody));
  assert.equal(r.headers['cache-control'], IMMUTABLE);
  r = await raw('/h/nothing/here');
  assert.equal(r.status, 404);
  assert.equal(r.headers['x-from'], 'herald');
  assert.equal(JSON.parse(r.body).code, 'NotYet');
  // The herald's own web files and CSP.
  r = await raw('/frontier/herald.mjs');
  assert.equal(r.status, 200);
  assert.equal(r.headers.etag, '"abc"');
  assert.equal(r.headers['content-security-policy'], "default-src 'self'");
  // /gw: a POST body arrives byte for byte.
  r = await raw('/gw/relay?a=b', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"k":"vé"}' });
  assert.equal(r.status, 201);
  const echo = JSON.parse(r.body);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.url, '/gw/relay?a=b');
  assert.equal(heraldHits.at(-1).body.toString('utf8'), '{"k":"vé"}');
  assert.equal(heraldHits.at(-1).headers['content-type'], 'application/json');
  // HEAD and OPTIONS pass too.
  r = await raw('/h/season', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 0);
});

test('/f/ai/* and /gw/f/ai/* reach the social service as /f/ai/* with X-Forwarded-For set here', async () => {
  socialHits.length = 0; heraldHits.length = 0;
  let r = await raw('/f/ai/talk?after=3&channel=0&limit=50');
  assert.equal(r.status, 201);
  let s = socialHits.at(-1);
  assert.equal(s.url, '/f/ai/talk?after=3&channel=0&limit=50');
  assert.equal(s.headers['x-forwarded-for'], '127.0.0.1');
  // A loopback peer in front of us (a tunnel) hands its client on; a spoofed value from a far peer cannot reach here (serve binds loopback).
  r = await raw('/gw/f/ai/ballot', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: '{"bytes_b64":"AA==","sig_b64":"AA=="}' });
  assert.equal(r.status, 201);
  s = socialHits.at(-1);
  assert.equal(s.url, '/f/ai/ballot');
  assert.equal(s.method, 'POST');
  assert.equal(s.headers['x-forwarded-for'], '203.0.113.9');
  assert.equal(s.body.toString(), '{"bytes_b64":"AA==","sig_b64":"AA=="}');
  r = await raw('/f/ai/council?faction=3');
  assert.equal(socialHits.at(-1).url, '/f/ai/council?faction=3');
  assert.equal(heraldHits.length, 0, 'the social routes never touch the herald');
  // A pact route would simply be the social service's 404 (the contract builds none); /f/ai alone is not a route here.
  r = await raw('/f/ai');
  assert.equal(r.status, 404);
  assert.equal(socialHits.length, 3);
});

test('forwarding refuses oversize bodies, bad paths and unknown routes; an upstream that is down is a 502', async () => {
  const big = 'x'.repeat(MAX_BODY + 1);
  let r = await raw('/f/ai/talk', { method: 'POST', body: big });
  assert.equal(r.status, 413);
  r = await raw('/gw/relay', { method: 'POST', body: big });
  assert.equal(r.status, 413);
  const n = heraldHits.length;
  for (const p of ['/h/../etc/passwd', '/gw/%2e%2e/x', '/frontier/..%2f..%2fx', '/f/ai/%2e%2e/talk']) assert.equal((await raw(p)).status, 400, p);
  assert.equal(heraldHits.length, n);
  for (const p of ['/x', '/hh/season', '/f/other', '/h', '/H/season', '/serve', '/.git/config']) assert.equal((await raw(p)).status, 404, p);
  assert.equal((await raw('/h/season', { method: 'DELETE' })).status, 405);
  assert.equal((await raw('/h/season', { method: 'PUT', body: 'x' })).status, 405);
  // A dead social service.
  const dead = net.createServer().listen(0, '127.0.0.1');
  await new Promise(res => dead.once('listening', res));
  const deadPort = dead.address().port;
  await new Promise(res => dead.close(res));
  const s2 = createServe({ aiDir, herald: `http://127.0.0.1:${deadPort}`, social: `http://127.0.0.1:${deadPort}`, pageDir });
  const p2 = await s2.listen();
  try {
    const x = await fetch(`http://127.0.0.1:${p2}/h/season`);
    assert.equal(x.status, 502);
    assert.equal((await x.json()).code, 'UpstreamUnavailable');
    assert.equal((await fetch(`http://127.0.0.1:${p2}/f/ai/talk`)).status, 502);
    assert.equal((await fetch(`http://127.0.0.1:${p2}/h/ai/commitments.json`)).status, 200, 'PUB does not need the herald');
  } finally { await s2.close(); }
});

test('the herald\'s live feed /h/ws is a byte pipe; no other path upgrades', async () => {
  heraldHits.length = 0;
  const sock = net.connect(port, '127.0.0.1');
  const got = [];
  sock.on('data', c => got.push(c));
  sock.write('GET /h/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\nCookie: nope=1\r\n\r\n');
  await new Promise(r => setTimeout(r, 150));
  sock.write('ping');
  await new Promise(r => setTimeout(r, 150));
  sock.destroy();
  const text = Buffer.concat(got).toString();
  assert.match(text, /^HTTP\/1\.1 101/);
  assert.match(text, /echo:ping/);
  const up = heraldHits.find(h => h.method === 'UPGRADE');
  assert.equal(up.url, '/h/ws');
  assert.equal(up.headers.cookie, undefined);
  assert.equal(up.headers['x-forwarded-for'], '127.0.0.1');
  const s2 = net.connect(port, '127.0.0.1');
  const got2 = [];
  s2.on('data', c => got2.push(c));
  s2.write('GET /f/ai/talk HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await new Promise(r => setTimeout(r, 150));
  s2.destroy();
  assert.match(Buffer.concat(got2).toString(), /^HTTP\/1\.1 404/);
});

test('serve writes nothing and holds no key: no write API, no key, no outside URL in the source', () => {
  const src = fs.readFileSync(new URL('../citizens/serve.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /writeFile|appendFile|createWriteStream|mkdir|rename\(|unlink|rmSync|copyFile|truncate|\.write\(.*fs/);
  assert.doesNotMatch(src, /anthropic|openai|devnet|https?:\/\/(?!127\.0\.0\.1|\[::1\]|localhost)/i);
  assert.doesNotMatch(src, /^import .* from '(?!node:)/m, 'node builtins only (it runs under the permission model)');
});

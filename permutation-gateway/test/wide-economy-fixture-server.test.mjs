// Key-free tests of the wide-economy fixture server: same bytes, exact allowlist, read-only, no traversal.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, cleanPath, BINARY_ROUTES, FIXTURE_PREFIX, WEB_PREFIX, ART_PREFIX, INDEX_PATH as INDEX } from '../screens/wide-economy-fixture/server.mjs';
import { CASE_NAMES, FILE_NAMES, FIXTURE_DIR, fixtureRoute } from '../screens/wide-economy-fixture/model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const disk = rel => readFile(join(ROOT, ...rel.split('/')));

// raw request: node:http does not normalise the path, so traversal text reaches the server as written
// `headers` override the defaults; the default Host is the valid 127.0.0.1:port, a value of null removes a header
function raw(origin, method, path, headers = {}) {
  return new Promise((ok, fail) => {
    const { port } = new URL(origin);
    const merged = { host: `127.0.0.1:${port}`, ...headers };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: merged, setHost: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('exactly 40 binary routes', () => {
  assert.equal(BINARY_ROUTES.size, 40);
  assert.equal(CASE_NAMES.length * FILE_NAMES.length, 40);
});

test('serves the 40 originals byte-for-byte, GET and HEAD, with the CSP', async () => {
  const s = await startServer();
  try {
    for (const c of CASE_NAMES) for (const f of FILE_NAMES) {
      const route = fixtureRoute(c, f);
      const want = await disk(route.slice(1));
      const got = await raw(s.origin, 'GET', route);
      assert.equal(got.status, 200, route);
      assert.ok(want.equals(got.body), `${route} differs`);
      assert.match(got.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(got.headers['cache-control'], 'no-store');
      const head = await raw(s.origin, 'HEAD', route);
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers['content-length']), want.length);
      assert.equal(head.body.length, 0);
    }
  } finally { await s.close(); }
});

test('serves model.mjs and the production parser files at their repo paths', async () => {
  const s = await startServer();
  try {
    for (const rel of ['permutation-gateway/screens/wide-economy-fixture/model.mjs', 'permutation-server/web/frontier/fwide.mjs', 'permutation-server/web/frontier/fcodec.mjs', 'permutation-server/web/frontier/faddr.mjs']) {
      const r = await raw(s.origin, 'GET', `/${rel}`);
      assert.equal(r.status, 200, rel);
      assert.ok((await disk(rel)).equals(r.body), rel);
      assert.match(r.headers['content-type'], /javascript/);
    }
    // the page files of the UI pass are allowed but may not exist yet
    for (const n of ['index.html', 'fixture.mjs', 'fixture.css', 'manifest.mjs']) {
      const r = await raw(s.origin, 'GET', FIXTURE_PREFIX + n);
      assert.ok([200, 404].includes(r.status), n);
    }
    // the generator is never served
    assert.equal((await raw(s.origin, 'GET', `${FIXTURE_PREFIX}make-manifest.mjs`)).status, 404);
    const root = await raw(s.origin, 'GET', '/');
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, `${FIXTURE_PREFIX}index.html`);
  } finally { await s.close(); }
});

test('listens on loopback only', async () => {
  const s = await startServer();
  try { assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/); } finally { await s.close(); }
});

test('write methods are refused', async () => {
  const s = await startServer();
  try {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
      const r = await raw(s.origin, m, fixtureRoute('harvest', 'record.bin'));
      assert.equal(r.status, 405, m);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
  } finally { await s.close(); }
});

test('unknown routes, other repo files and non-allowlisted fixture files are refused', async () => {
  const s = await startServer();
  try {
    const refused = [
      '/nope', '/package.json', '/README.md', '/.git/config', '/.env',
      `/${FIXTURE_DIR}/README.md`, `/${FIXTURE_DIR}/harvest/other.bin`, `/${FIXTURE_DIR}/harvest/`, `/${FIXTURE_DIR}/unknown/record.bin`,
      `/${FIXTURE_DIR}/harvest`, `/${FIXTURE_DIR}/harvest/record.bin/extra`,
      `${FIXTURE_PREFIX}server.mjs`, `${FIXTURE_PREFIX}README.md`,
      `${WEB_PREFIX}secret.key`, `${WEB_PREFIX}frontier/nonexistent.mjs`, `${WEB_PREFIX}`, '/permutation-server/package.json',
      '/frontier-node/Cargo.toml', '/permutation-frontier/src/lib.rs',
    ];
    for (const p of refused) {
      const r = await raw(s.origin, 'GET', p);
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    }
  } finally { await s.close(); }
});

test('traversal and malformed paths are refused', async () => {
  const s = await startServer();
  try {
    const bad = [
      `${WEB_PREFIX}../package.json`, `${WEB_PREFIX}frontier/../../package.json`, `${FIXTURE_PREFIX}../../../package.json`,
      `/${FIXTURE_DIR}/harvest/../../../../../../package.json`,
      `${WEB_PREFIX}%2e%2e/package.json`, `${WEB_PREFIX}%2E%2E%2Fpackage.json`, `${WEB_PREFIX}frontier%2ffwide.mjs`,
      `${WEB_PREFIX}frontier\\fwide.mjs`, `${WEB_PREFIX}frontier/fwide.mjs%00.png`, `${WEB_PREFIX}frontier//fwide.mjs`,
      `//etc/passwd`, `${WEB_PREFIX}.hidden.mjs`, `/${FIXTURE_DIR}/harvest/%72ecord.bin`,
    ];
    for (const p of bad) {
      const r = await raw(s.origin, 'GET', p);
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    }
  } finally { await s.close(); }
});

test('Host must be exactly the listening 127.0.0.1:port; foreign, malformed and missing Host are refused before any response', async () => {
  const s = await startServer();
  try {
    const { port } = new URL(s.origin);
    const bad = [`localhost:${port}`, `127.0.0.1`, `127.0.0.1:${port + 1}`, `evil.example:${port}`, `evil.example`, `127.0.0.1:${port}.evil.example`,
      `[::1]:${port}`, `0.0.0.0:${port}`, `user@127.0.0.1:${port}`, `127.0.0.1:${port}, evil.example`, '', 'http://127.0.0.1:' + port];
    for (const host of bad) for (const path of ['/', INDEX, fixtureRoute('harvest', 'record.bin'), `${WEB_PREFIX}frontier/fwide.mjs`]) {
      for (const method of ['GET', 'HEAD']) {
        const r = await raw(s.origin, method, path, { host });
        assert.equal(r.status, 403, `${JSON.stringify(host)} ${method} ${path} -> ${r.status}`);
        assert.equal(r.headers.location, undefined, 'no redirect for a refused Host');
      }
    }
    // a missing Host (HTTP/1.0 style) is refused too
    const missing = await raw(s.origin, 'GET', '/', { host: null });
    assert.ok([400, 403].includes(missing.status), `missing Host -> ${missing.status}`);
    assert.equal(missing.headers.location, undefined);
    // the valid Host still works, for the redirect and for HEAD
    assert.equal((await raw(s.origin, 'GET', '/')).status, 302);
    assert.equal((await raw(s.origin, 'HEAD', `${WEB_PREFIX}frontier/fwide.mjs`)).status, 200);
  } finally { await s.close(); }
});

test('Fetch Metadata: cross-site and same-site are refused; same-origin, user navigation (none) and absent are served', async () => {
  const s = await startServer();
  try {
    for (const site of ['cross-site', 'same-site', 'bogus', '', 'same-origin, cross-site']) {
      for (const path of ['/', INDEX, `${WEB_PREFIX}frontier/fwide.mjs`]) {
        const r = await raw(s.origin, 'GET', path, { 'sec-fetch-site': site });
        assert.equal(r.status, 403, `${JSON.stringify(site)} ${path} -> ${r.status}`);
        assert.equal(r.headers.location, undefined);
      }
    }
    for (const site of ['same-origin', 'none']) {
      assert.equal((await raw(s.origin, 'GET', '/', { 'sec-fetch-site': site })).status, 302, site);
      assert.equal((await raw(s.origin, 'GET', `${WEB_PREFIX}frontier/fwide.mjs`, { 'sec-fetch-site': site, 'sec-fetch-mode': 'cors' })).status, 200, site);
      assert.equal((await raw(s.origin, 'HEAD', `${WEB_PREFIX}frontier/fwide.mjs`, { 'sec-fetch-site': site })).status, 200, site);
    }
    assert.equal((await raw(s.origin, 'GET', `${WEB_PREFIX}frontier/fwide.mjs`)).status, 200);
  } finally { await s.close(); }
});

test('the page-relative art route serves the same bytes as frontier/art and nothing else', async () => {
  const s = await startServer();
  try {
    const rel = 'permutation-server/web/frontier/art/ui/icons.svg';
    const want = await disk(rel);
    const viaArt = await raw(s.origin, 'GET', `${ART_PREFIX}ui/icons.svg`);
    assert.equal(viaArt.status, 200);
    assert.ok(want.equals(viaArt.body), 'sprite bytes differ');
    assert.match(viaArt.headers['content-type'], /image\/svg\+xml/);
    assert.ok((await raw(s.origin, 'GET', `/${rel}`)).body.equals(viaArt.body));
    assert.equal((await raw(s.origin, 'HEAD', `${ART_PREFIX}ui/icons.svg`)).status, 200);
    const refused = [
      `${ART_PREFIX}../index.html`, `${ART_PREFIX}ui/../../frontier.css`, `${ART_PREFIX}../../../../../package.json`, `${ART_PREFIX}%2e%2e/model.mjs`,
      `${ART_PREFIX}ui%2ficons.svg`, `${ART_PREFIX}ui\\icons.svg`, `${ART_PREFIX}ui//icons.svg`, `${ART_PREFIX}.hidden.svg`, `${ART_PREFIX}ui/.x.svg`,
      `${ART_PREFIX}`, `${ART_PREFIX}ui/`, `${ART_PREFIX}ui`, `${ART_PREFIX}ui/icons.svg%00.png`, `${ART_PREFIX}ui/nonexistent.svg`,
      `${ART_PREFIX}ui/icons.txt`, `${ART_PREFIX}node_modules/x.png`,
    ];
    for (const p of refused) {
      const r = await raw(s.origin, 'GET', p);
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    }
    assert.equal((await raw(s.origin, 'POST', `${ART_PREFIX}ui/icons.svg`)).status, 405);
    // the page itself names the sprite by absolute href for the panel close button
    const page = (await raw(s.origin, 'GET', INDEX)).body.toString('utf8');
    assert.ok(page.includes('href="/permutation-server/web/frontier/art/ui/icons.svg#close"'));
    assert.match(page, /<link rel="icon" href="data:image\/svg\+xml,/);
  } finally { await s.close(); }
});

test('cleanPath judges the raw text', () => {
  assert.equal(cleanPath('/a/b.mjs'), '/a/b.mjs');
  assert.equal(cleanPath('/a/b.mjs?x=1'), '/a/b.mjs');
  assert.equal(cleanPath('/'), '/');
  for (const p of ['a', '//a', '/a/../b', '/a/./b', '/a%2fb', '/a\\b', '/a//b', '/a/', 'http://x/a', '/a\u0000b', '/.a']) assert.equal(cleanPath(p), null, p);
  assert.equal(cleanPath(undefined), null);
});

test('the server source has no write, proxy, relay or socket-upgrade paths', async () => {
  const src = await readFile(join(HERE, '..', 'screens', 'wide-economy-fixture', 'server.mjs'), 'utf8');
  for (const bad of ['writeFile', 'appendFile', 'createWriteStream', 'unlink', 'rename', 'mkdir', 'WebSocket', 'http.request', 'https', 'net.connect', 'fetch(', 'child_process']) {
    assert.ok(!src.includes(bad), `server.mjs mentions ${bad}`);
  }
});

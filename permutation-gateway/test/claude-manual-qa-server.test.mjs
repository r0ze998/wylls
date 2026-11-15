// The manual-QA server (screens/claude-manual-qa/server.mjs) without a browser: what it serves, what it refuses.
// Loopback requests to the server under test only; the web directory and one golden record are read, nothing is
// written. No wallet, key, worker, kernel or page runs here: what the page then shows is the manual check's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { createQaServer, BIND, CSP, PLAYER_PAGE, APP_TAG, QA_TAGS, LABEL } from '../screens/claude-manual-qa/server.mjs';
import { SESSION_GUARD, TEST_WALLET } from '../screens/ws07/nokey-page.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url), 'utf8'));
const qa = await createQaServer();
const base = await qa.listen(0);
const port = Number(new URL(base).port);
after(() => qa.close());

/** One request to the server under test, with the method, path and Host given as they are (no redirect followed). */
const ask = (path, { method = 'GET', host = `${BIND}:${port}`, body = null } = {}) => new Promise((done, fail) => {
  const r = request({ host: BIND, port, path, method, headers: { host, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
    const parts = [];
    res.on('data', c => parts.push(c));
    res.on('end', () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8'), bytes: Buffer.concat(parts) }));
  });
  r.on('error', fail);
  r.end(body ?? undefined);
});

test('it listens on the loopback address only, on the port it was given', () => {
  const a = qa.server.address();
  assert.equal(a.address, '127.0.0.1'); assert.equal(a.family, 'IPv4'); assert.ok(a.port > 0);
  assert.equal(base, `http://127.0.0.1:${a.port}`);
});

test('the player page is the original page, with the dev wallet off, the policy unchanged and one script added before the app', async () => {
  for (const path of ['/', '/frontier/', PLAYER_PAGE, `${PLAYER_PAGE}?at=4,0,0,1`, `${PLAYER_PAGE}?devWallet=on`]) {
    const r = await ask(path);
    assert.equal(r.status, 302, path);
    assert.match(r.headers.location, /^\/frontier\/index\.html\?(.*&)?devWallet=off$/, path);
  }
  assert.equal((await ask(`${PLAYER_PAGE}?at=4,0,0,1`)).headers.location, `${PLAYER_PAGE}?at=4%2C0%2C0%2C1&devWallet=off`, 'the link\'s own place is kept');
  const page = await ask(`${PLAYER_PAGE}?devWallet=off`);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.doesNotMatch(CSP, /'unsafe-inline'|'unsafe-eval'|\*|https?:/, 'no inline script or style, no other origin');
  assert.match(CSP, /worker-src 'none'/);
  const disk = readFileSync(new URL('../../permutation-server/web/frontier/index.html', import.meta.url), 'utf8');
  assert.equal(page.text, disk.replace(APP_TAG, QA_TAGS + APP_TAG), 'the file on disk, plus the QA tags and nothing else');
  assert.equal(page.text.split(QA_TAGS).length, 2);
  assert.ok(page.text.indexOf(QA_TAGS) < page.text.indexOf(APP_TAG), 'the wallet and the guard stand before the app');
  // another page of the site is served as it is
  const watch = await ask('/frontier/spectate.html');
  assert.equal(watch.status, 200); assert.equal(watch.headers['content-security-policy'], CSP);
  assert.equal(watch.text, readFileSync(new URL('../../permutation-server/web/frontier/spectate.html', import.meta.url), 'utf8'));
});

test('the added script is the keyless wallet of ws07 with the record\'s public address; its signers refuse', async () => {
  const r = await ask('/__qa/client.mjs');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /^text\/javascript/);
  assert.ok(r.text.includes(JSON.stringify(GOLDEN.wallet)), 'the viewer is the golden record\'s public address');
  assert.ok(r.text.includes(JSON.stringify(TEST_WALLET)));
  assert.match(r.text, /this test wallet has no key and signs nothing/);
  assert.match(r.text, /'solana:signMessage': \{ version: '1\.0\.0', signMessage: refuse \}/);
  assert.match(r.text, /signTransaction: refuse/);
  for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey']) assert.ok(r.text.includes(`'${m}'`), `WebCrypto ${m} is refused`);
  assert.match(r.text, /worker blocked/);
  assert.doesNotMatch(r.text, /ps-dev-wallet|ps-fsession|secretKey|privateKey|mnemonic/i, 'no seed, session or key material is named');
  assert.ok(r.text.includes(LABEL.ja) && r.text.includes(LABEL.en), 'the strip says recorded, not sending, not live');
  assert.match(LABEL.ja, /保存済み.*送信無効.*ライブではありません/);
  const latest = Number(GOLDEN.stages.grown['/h/season'].body.latestUnix);
  assert.equal(qa.fixedMs, latest * 1000 + 500); assert.ok(r.text.includes(`"fixedMs":${qa.fixedMs}`));
  assert.equal((await ask('/__qa/qa.css')).status, 200);
});

test('web/session.mjs is served with its key functions refusing', async () => {
  const r = await ask('/session.mjs');
  const disk = readFileSync(new URL('../../permutation-server/web/session.mjs', import.meta.url), 'utf8');
  assert.equal(r.status, 200); assert.equal(r.text, disk + SESSION_GUARD);
  assert.match(SESSION_GUARD, /keyFromSeed = async \(\) => \{[^}]*throw/); assert.match(SESSION_GUARD, /publicKeyOf = async \(\) => \{[^}]*throw/);
  // (the frontier's own session module is another file and is served as it is)
  const f = await ask('/frontier/fsession.mjs');
  assert.equal(f.text, readFileSync(new URL('../../permutation-server/web/frontier/fsession.mjs', import.meta.url), 'utf8'));
});

test('the herald\'s reads are the golden stage\'s, bytes and status as recorded; an unknown read is NotFound', async () => {
  const season = await ask('/h/season');
  assert.equal(season.status, GOLDEN.stages.grown['/h/season'].status);
  assert.deepEqual(JSON.parse(season.text), GOLDEN.stages.grown['/h/season'].body);
  const me = await ask(`/h/me/${GOLDEN.wallet}`);
  assert.deepEqual(JSON.parse(me.text), GOLDEN.stages.grown[`/h/me/${GOLDEN.wallet}`].body);
  const binary = Object.entries(GOLDEN.stages.grown).find(([, a]) => a.body?.b64 !== undefined);
  assert.ok(binary, 'the stage has a binary read');
  const bin = await ask(binary[0]);
  assert.equal(bin.headers['content-type'], 'application/octet-stream');
  assert.ok(bin.bytes.equals(Buffer.from(binary[1].body.b64, 'base64')));
  assert.equal(GOLDEN.stages.grown['/h/not-in-the-record'], undefined);
  assert.deepEqual(JSON.parse((await ask('/h/not-in-the-record')).text), { ok: false, code: 'NotFound' }, 'what the record does not hold is not made up');
  assert.equal((await ask('/gw/f/expedition/preview')).status, 404);
});

test('every write is refused and counted; nothing but GET and HEAD is answered', async () => {
  const before = qa.stats.refusedWrites.length;
  const tries = [['POST', '/gw/f/submit'], ['POST', '/gw/f/expedition/preview'], ['POST', '/gw/f/reveal'], ['PUT', '/h/season'], ['DELETE', '/frontier/index.html'], ['PATCH', '/__qa/status'], ['POST', '/']];
  for (const [method, path] of tries) {
    const r = await ask(path, { method, body: '{"x":1}' });
    assert.equal(r.status, 405, `${method} ${path}`);
    assert.equal(r.headers.allow, 'GET, HEAD');
    assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'ReadOnlyFixture' });
  }
  assert.deepEqual(qa.stats.refusedWrites.slice(before), tries.map(([m, p]) => `${m} ${p}`));
  const status = JSON.parse((await ask('/__qa/status')).text);
  assert.equal(status.readOnly, true); assert.equal(status.live, false);
  assert.deepEqual(status.refusedWrites.slice(before), tries.map(([m, p]) => `${m} ${p}`));
  const head = await ask(`${PLAYER_PAGE}?devWallet=off`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
});

test('only the web directory is served: no way out of it, no dot file, no worker, no other host name', async () => {
  for (const path of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/Cargo.toml', '/frontier/..%2f..%2f..%2fREADME.md', '/.env', '/frontier/.git/config', '/frontier/seal-worker.mjs', '/%00']) {
    const r = await ask(path);
    assert.ok([400, 403, 404].includes(r.status), `${path}: ${r.status}`);
    assert.doesNotMatch(r.text, /"name"|\[package\]|# Wylls/, path);
  }
  assert.equal((await ask('/frontier/seal-worker.mjs')).status, 403);
  assert.equal((await ask('/.env')).status, 403);
  for (const host of ['wylls.test', 'example.com', `evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
    const r = await ask('/h/season', { host });
    assert.equal(r.status, 421, host); assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'QaWrongHost' });
  }
  assert.equal((await ask('/h/season', { host: `localhost:${port}` })).status, 200);
});

test('the server\'s own source opens no outbound connection and reads no secret', () => {
  const src = readFileSync(new URL('../screens/claude-manual-qa/server.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /\bfetch\s*\(|node:https|node:net|node:tls|node:dgram|node:child_process|node:worker_threads|WebSocket|process\.env/);
  assert.doesNotMatch(code, /writeFile|appendFile|mkdir|unlink|rename|createWriteStream/, 'nothing is written');
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../ws07/nokey-page.mjs', 'node:fs', 'node:fs/promises', 'node:http', 'node:path', 'node:url']);
  assert.match(code, /server\.listen\(port, BIND,/);
  assert.equal(BIND, '127.0.0.1');
});

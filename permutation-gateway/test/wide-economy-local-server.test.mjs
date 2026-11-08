// Focused loopback HTTP and fail-closed controller tests. Fake host only; no child or external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createFakeBridge } from '../screens/wide-economy-local/fake-host.mjs';
import { loadInitial, PROTOCOL } from '../screens/wide-economy-local/local-model.mjs';
import { FIXTURE_DIR } from '../screens/wide-economy-fixture/model.mjs';
import { createController, startLocalServer, cleanPath, parseCanonicalJson, mutationHeaderProblem } from '../screens/wide-economy-local/local-server.mjs';
const rd = async f => new Uint8Array(await readFile(new URL(`../../${FIXTURE_DIR}/harvest/${f}`, import.meta.url)));
const pre = { season: await rd('season.bin'), citizen: await rd('citizen_pre.bin'), holding: await rd('holding_pre.bin'), province: await rd('province_pre.bin') };
const post = { season: pre.season, citizen: await rd('citizen_post.bin'), holding: await rd('holding_post.bin'), province: await rd('province_post.bin') };
const record = await rd('record.bin'), initial = loadInitial(pre);
const fake = () => createFakeBridge({ pre, post, record });

test('request gates reject traversal, noncanonical bodies and cross-origin headers', () => {
  for (const p of ['/../a', '/%2e/a', '//a', '/a?x=1', '/a\\b', '/.git/config']) assert.equal(cleanPath(p), null);
  for (const body of ['{"x":1,"x":2}', '{ "x":1}', '{"x":1.0}']) assert.throws(() => parseCanonicalJson(Buffer.from(body)));
  const headers = { origin: 'http://127.0.0.1:1', 'x-wylls-local-action': PROTOCOL, 'content-type': 'application/json', 'content-length': '2' };
  assert.equal(mutationHeaderProblem(headers, headers.origin), 0);
  assert.equal(mutationHeaderProblem({ ...headers, origin: 'https://evil.invalid' }, headers.origin), 403);
  assert.equal(mutationHeaderProblem({ ...headers, 'content-length': '513' }, headers.origin), 413);
});

test('idle host death clears cached state and disables all mutations', async () => {
  const bridge = fake(), c = createController({ bridge, initial });
  assert.equal((await c.start()).status, 200);
  bridge.alive = false; bridge.deadReason = 'Exit';
  assert.equal(c.state().body.view.uncertain, true);
  assert.equal(c.state().body.view.reply, null);
  assert.equal((await c.mutate({ kind: 'harvest', rev: 0 })).status, 503);
  assert.deepEqual(bridge.calls, ['get']);
});

test('wrong startup command and malformed receipt metadata stop the controller', async () => {
  for (const mutate of [r => ({ ...r, command: 'reset' }), r => ({ ...r, auth: 'SIGNED' })]) {
    const bridge = fake(); bridge.hook = mutate;
    assert.equal((await createController({ bridge, initial }).start()).status, 502);
    assert.equal(bridge.closed, true);
  }
  for (const mutate of [r => ({ ...r, recordHex: null }), r => ({ ...r, action: 'train' }), r => ({ ...r, command: 'get', action: null })]) {
    const bridge = fake(), c = createController({ bridge, initial }); await c.start(); bridge.hook = mutate;
    assert.equal((await c.mutate({ kind: 'harvest', rev: 0 })).status, 502);
    assert.equal(c.view().reply, null); assert.equal(bridge.closed, true);
  }
});

test('loopback server serves browser allowlist, gates mutations, rejects duplicate revisions', async t => {
  const bridge = fake(), server = await startLocalServer({ bridge, initial });
  t.after(() => server.close());
  const get = path => fetch(server.origin + path, { redirect: 'manual' });
  assert.equal((await get('/api/state')).status, 200);
  for (const name of ['local-server.mjs', 'host-bridge.mjs', 'fake-host.mjs', 'README.md']) assert.equal((await get('/permutation-gateway/screens/wide-economy-local/' + name)).status, 404);
  const page = await get('/permutation-gateway/screens/wide-economy-local/index.html');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  const headers = { 'Content-Type': 'application/json', Origin: server.origin, 'X-Wylls-Local-Action': PROTOCOL };
  const body = JSON.stringify({ expectedRevision: 0, action: 'harvest' });
  assert.equal((await fetch(server.origin + '/api/action', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body })).status, 403);
  const results = await Promise.all([1, 2].map(() => fetch(server.origin + '/api/action', { method: 'POST', headers, body })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(bridge.calls, ['get', 'act 0 harvest']);
});

// node:http preserves actual browser Fetch Metadata headers (fetch itself overwrites Sec-Fetch-Mode).
test('cross-site link navigation may load static documents but cannot read APIs or mutate', async t => {
  const bridge = fake(), server = await startLocalServer({ bridge, initial });
  t.after(() => server.close());
  const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const call = (path, { method = 'GET', headers = nav } = {}) => new Promise((resolve, reject) => {
    const req = request(server.origin + path, { method, headers }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }); req.on('error', reject); req.end();
  });
  const page = '/permutation-gateway/screens/wide-economy-local/index.html';
  assert.equal((await call('/')).status, 302);
  assert.equal((await call(page)).status, 200);
  assert.equal((await call(page, { method: 'HEAD' })).status, 200);
  assert.equal((await call(page)).headers['access-control-allow-origin'], undefined);
  for (const path of ['/api/state', '/api/action', '/api/advance', '/api/reset']) {
    assert.equal((await call(path)).status, 403);
    assert.equal((await call(path, { method: 'POST' })).status, 403);
  }
  for (const headers of [
    { ...nav, 'sec-fetch-mode': 'cors' }, { ...nav, 'sec-fetch-dest': 'iframe' },
    { ...nav, 'sec-fetch-dest': 'script' }, { ...nav, host: 'evil.invalid' },
  ]) assert.equal((await call(page, { headers })).status, 403);
  assert.equal((await call(page, { method: 'POST' })).status, 403);
  assert.deepEqual(bridge.calls, ['get']);
});

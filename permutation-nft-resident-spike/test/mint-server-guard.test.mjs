// The mint page's companion server on a shared deployment: the test knobs (/mock/*) are off unless asked for, /rpc
// forwards only the methods the page sends (never an open proxy to the RPC provider), and a request body is capped.
// A fake adapter records what reaches it. No chain, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createMintHandler, MAX_BODY_BYTES, PAGE_RPC_METHODS } from '../src/mint-server.mjs';

function fakeAdapter() {
  const calls = [];
  return {
    calls, kind: 'rpc', knobs: { dropSendResponse: false, hideStatuses: false }, sent: [],
    async handle(req) { calls.push(req.method); return { jsonrpc: '2.0', id: req.id, result: 'ok' }; },
    async airdrop() { calls.push('airdrop'); return '1'; },
  };
}
async function serve(opts) {
  const server = createServer(createMintHandler(opts));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { post, close: () => new Promise(r => server.close(r)) };
}

test('without testKnobs the /mock routes do not exist (404) and change nothing', async () => {
  const a = fakeAdapter();
  const s = await serve({ adapter: a });
  try {
    for (const p of ['/mock/airdrop', '/mock/knobs', '/mock/state', '/mock/price']) {
      const r = await s.post(p, { address: 'x', lamports: '1', dropSendResponse: true });
      assert.equal(r.status, 404, p);
    }
    assert.deepEqual(a.knobs, { dropSendResponse: false, hideStatuses: false });
    assert.deepEqual(a.calls, []);
  } finally { await s.close(); }
});

test('/rpc forwards only the page\'s methods; anything else, or a batch, is refused before the adapter', async () => {
  const a = fakeAdapter();
  const s = await serve({ adapter: a });
  try {
    for (const m of PAGE_RPC_METHODS) assert.equal((await s.post('/rpc', { jsonrpc: '2.0', id: 1, method: m, params: [] })).status, 200, m);
    for (const m of ['requestAirdrop', 'getProgramAccounts', 'getTransaction', 'simulateTransaction', 'minimumLedgerSlot']) {
      const r = await s.post('/rpc', { jsonrpc: '2.0', id: 2, method: m, params: [] });
      assert.equal(r.status, 403, m);
      assert.equal((await r.json()).error.code, -32601);
    }
    assert.equal((await s.post('/rpc', [{ jsonrpc: '2.0', id: 3, method: 'getBalance', params: [] }])).status, 403, 'a batch');
    assert.deepEqual(a.calls, [...PAGE_RPC_METHODS]);
  } finally { await s.close(); }
});

test('a body over the cap is refused (413)', async () => {
  const s = await serve({ adapter: fakeAdapter() });
  try {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['x'.repeat(MAX_BODY_BYTES)] });
    assert.equal((await s.post('/rpc', big)).status, 413);
  } finally { await s.close(); }
});

test('with testKnobs (local tests only) the knobs answer', async () => {
  const a = fakeAdapter();
  const s = await serve({ adapter: a, testKnobs: true });
  try {
    assert.equal((await s.post('/mock/knobs', { hideStatuses: true })).status, 200);
    assert.equal(a.knobs.hideStatuses, true);
  } finally { await s.close(); }
});

test('every RPC method the page calls is allowed, and only the local launchers turn the knobs on', () => {
  const page = readFileSync(new URL('../web/mint.mjs', import.meta.url), 'utf8');
  const used = [...new Set([...page.matchAll(/rpc\('([a-zA-Z]+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(used, [...PAGE_RPC_METHODS].sort());
  const demo = readFileSync(new URL('../src/mint-demo.mjs', import.meta.url), 'utf8');
  assert.equal(demo.match(/testKnobs: true/g)?.length, 3, 'mock, localnet and attach: local tests');
});

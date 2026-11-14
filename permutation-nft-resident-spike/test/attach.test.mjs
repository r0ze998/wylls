// The mint page attached read-only to a chain someone else configured (src/mint-demo.mjs
// attachMintStack): loopback only, and it refuses a chain without the resident program or its
// config. A fake JSON-RPC on 127.0.0.1 (no validator, no keys); the happy path on real programs is
// in localnet-nft-lane.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { attachMintStack, loopbackRpc } from '../src/mint-demo.mjs';
import { TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { CONFIG, pdas } from '../src/resident-ix.mjs';
import { pubkeyBytes } from '../src/crypto.mjs';

test('only a loopback http RPC', () => {
  assert.equal(loopbackRpc('http://127.0.0.1:41010/'), 'http://127.0.0.1:41010');
  assert.equal(loopbackRpc('http://localhost:41010'), 'http://localhost:41010');
  assert.equal(loopbackRpc('http://[::1]:41010'), 'http://[::1]:41010');
  for (const bad of ['https://api.devnet.solana.com', 'https://api.mainnet-beta.solana.com', 'http://10.0.0.2:8899', 'https://127.0.0.1:41010', 'http://127.0.0.1.evil.test:41010', 'not a url']) {
    assert.throws(() => loopbackRpc(bad), /--rpc/, bad);
  }
});

async function fakeRpc(accounts) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const result = method === 'getHealth' ? 'ok' : method === 'getGenesisHash' ? 'FakeGenesis1111111111111111111111111111111'
        : method === 'getAccountInfo' ? { context: { slot: 1 }, value: accounts[params[0]] ?? null } : null;
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
const acct = (data, executable = false) => ({ owner: TEST_PROGRAM_ID, lamports: 1, executable, rentEpoch: 0, data: [Buffer.from(data).toString('base64'), 'base64'] });

test('a chain without the resident program, or without its config, is refused; a configured one is read, not written', async () => {
  const none = await fakeRpc({});
  await assert.rejects(attachMintStack({ rpcUrl: none.url }), /no resident program/);
  await none.close();
  const bare = await fakeRpc({ [TEST_PROGRAM_ID]: acct([0], true) });
  await assert.rejects(attachMintStack({ rpcUrl: bare.url }), /config is not initialized/);
  await bare.close();
  const cfg = new Uint8Array(CONFIG.LEN);
  cfg[CONFIG.MAGIC] = CONFIG.MAGIC_VALUE;
  const collection = 'DDFwQtLXdBQNAD1WPaYPPLviGsYATyaCJWWyLyLQSmx2';
  cfg.set(pubkeyBytes(collection), CONFIG.COLLECTION);
  new DataView(cfg.buffer).setBigUint64(CONFIG.PRICE, 123n, true);
  const ok = await fakeRpc({ [TEST_PROGRAM_ID]: acct([0], true), [pdas(TEST_PROGRAM_ID).config]: acct(cfg) });
  const stack = await attachMintStack({ rpcUrl: ok.url });
  assert.equal(stack.world.collection, collection);
  assert.equal(stack.world.priceLamports, 123n);
  assert.equal(stack.adapter.kind, 'rpc');
  await ok.close();
});

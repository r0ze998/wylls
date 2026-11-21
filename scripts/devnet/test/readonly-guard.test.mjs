// Tests of the read-only devnet guard (scripts/devnet/readonly-guard.mjs).
// Offline: the guard is started with a devnet upstream it never reaches,
// because every request here is refused before forwarding. Port 41492.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_METHODS, checkUpstream, lieResult } from '../readonly-guard.mjs';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../readonly-guard.mjs');

test('only devnet https upstreams, only read methods', () => {
  assert.ok(checkUpstream('https://api.devnet.solana.com'));
  assert.ok(checkUpstream('https://solana-devnet.api.onfinality.io/public'));
  for (const bad of ['http://api.devnet.solana.com', 'https://api.mainnet-beta.solana.com', 'https://api.testnet.solana.com', 'https://rpc.example.com']) {
    assert.throws(() => checkUpstream(bad), bad);
  }
  for (const m of ['sendTransaction', 'simulateTransaction', 'requestAirdrop', 'sendRawTransaction']) {
    assert.equal(READ_METHODS.has(m), false, m);
  }
  for (const m of ['getSignaturesForAddress', 'getTransaction', 'getBlock', 'getGenesisHash']) {
    assert.equal(READ_METHODS.has(m), true, m);
  }
});

test('the deliberate lies only touch getSignaturesForAddress', () => {
  const rows = [{ signature: 'a', slot: 30 }, { signature: 'b', slot: 20 }, { signature: 'c', slot: 10 }];
  assert.deepEqual(lieResult('getSignaturesForAddress', rows, { 'truncate-before-slot': '15' }).map((r) => r.signature), ['a', 'b']);
  assert.deepEqual(lieResult('getSignaturesForAddress', rows, { 'drop-sig': 'b' }).map((r) => r.signature), ['a', 'c']);
  assert.equal(lieResult('getTransaction', rows, { 'drop-sig': 'b' }), rows);
});

test('writes, airdrops and batches are refused without reaching the upstream', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-'));
  const budget = path.join(dir, 'budget.json');
  const p = spawn(process.execPath, [GUARD, '--listen', '41492=https://api.devnet.solana.com', '--budget', '5', '--budget-file', budget, '--log', path.join(dir, 'log.jsonl')], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((ok, bad) => {
      p.stderr.on('data', (d) => String(d).includes('127.0.0.1:41492') && ok());
      p.on('exit', (c) => bad(new Error(`guard exited ${c}`)));
    });
    const post = (body) => fetch('http://127.0.0.1:41492', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    for (const method of ['sendTransaction', 'requestAirdrop', 'simulateTransaction']) {
      const r = await post({ jsonrpc: '2.0', id: 7, method, params: ['AA=='] });
      assert.equal(r.error.code, -32601, method);
      assert.equal(r.id, 7);
    }
    const b = await post([{ jsonrpc: '2.0', id: 1, method: 'getSlot' }]);
    assert.equal(b.error.code, -32600);
    assert.equal(existsSync(budget), false, 'nothing was forwarded');
    const log = readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 4);
    assert.ok(log.every((r) => r.refused));
  } finally {
    p.kill('SIGTERM');
  }
});

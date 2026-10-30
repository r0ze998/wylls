// The seam to ④'s run ledger: the local adapter passes the port's conformance; nothing passes for ④'s ledger
// that is not ④'s (a MOCK must say so), and asking for ④'s adapter in this build fails instead of falling back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalReceiptPort, assertReceiptPort, receiptPortFor } from '../src/receipt-port.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { portConformance } from './port-conformance.mjs';
import { client, connect, server, world } from './fixture.mjs';

test('the local adapter passes the RunReceipt port conformance, and labels itself a MOCK', () => {
  const p = new LocalReceiptPort();
  assert.deepEqual([p.contract, p.real], ['wylls.mock-run-receipt/0', false]);
  portConformance(assertReceiptPort(p));
});

test('no adapter for ④\'s ledger in this build: asking for one fails at start; a fixture cannot pass as ④\'s', () => {
  assert.equal(receiptPortFor('local').contract, 'wylls.mock-run-receipt/0');
  assert.throws(() => receiptPortFor('ws04'), /no adapter in this build/);
  const local = new LocalReceiptPort();
  const disguised = { receipt: o => local.receipt(o), cancellation: (l, o) => local.cancellation(l, o), arrival: o => local.arrival(o), contract: 'wylls.run-receipt/1', real: false };
  assert.throws(() => assertReceiptPort(disguised), /must name a mock contract/);
  assert.throws(() => assertReceiptPort({ contract: 'x', real: true }), /receipt\(\) is missing/);
  assert.throws(() => createWyllsMcp({ auth: {}, game: {}, store: { state: {} }, receipts: disguised }), /mock contract/);
});

test('the server answers through the port: the receipts it gives carry the port\'s contract', async () => {
  const w = await world();
  const s = await server(w);
  try {
    assert.deepEqual(s.mcp.receipts, { contract: 'wylls.mock-run-receipt/0', real: false });
    const m = client(s, (await connect(s, w)).access_token);
    const list = (await m.tool('list_operations')).structuredContent;
    assert.deepEqual(list.operations, []);
  } finally { await s.close(); }
});

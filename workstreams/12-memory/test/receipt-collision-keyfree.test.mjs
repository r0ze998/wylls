// ingestReceipts: a receipt whose own event fact collides writes nothing more (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// Pure adapter boundary checks, as receipt-integrity-keyfree.test.mjs: a fake memory (`observe` only), the recorded
// ws04 fixture read as JSON, no memory journal, signing fixture, crypto keys, network or subprocesses.
//   R1 a settle that collides (another body under the same kind|subject: the first stands) does not write its
//      caravan_credited: the credit of the body that lost never stands beside the kept settle; the receipt is listed
//   R2 unchanged: a duplicate settle (same event read twice) still offers its credit (a duplicate too)
//   R3 an identity alias collision stops nothing (the alias does not depend on the receipt's body)
//   R4 the rest of the feed is still read after a collision
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJsonU64, ingestReceipts } from '../adapters/ws04-receipts.mjs';

function fixture(name = 'happy') {
  const v = JSON.parse(readFileSync(new URL(`../fixtures/ws04-receipts/${name}.json`, import.meta.url)));
  return { receipts: v.receipts.map(r => ({ ...r, body: parseJsonU64(r.body_json) })),
    ctx: { partition: 'fixture-world', observedBell: 100, finalizedSlot: 100,
      bellOfSlot: s => s, runSpecs: Object.fromEntries(Object.entries(v.run_specs_json).map(([k, s]) => [k, parseJsonU64(s)])),
      resolveOwner: () => ({ principal: 'fixture-owner', source: 'fixture-resolver' }) } };
}
/** A fake memory: `status(kind)` decides the answer per fact kind; every offered fact is recorded. */
const fake = status => { const seen = []; return { seen, observe(f) { seen.push(f.kind); return { status: status(f.kind) }; } }; };

test('R1 a colliding settle does not write its credit; the receipt is listed with the reason', () => {
  const { receipts, ctx } = fixture();
  const settle = receipts.find(r => r.kind === 'caravan_settled');
  assert.ok(Array.isArray(settle.body.credited), 'the fixture settle carries credited (P1, simulated)');
  const m = fake(k => (k === 'caravan_settled' ? 'collision' : 'added'));
  const out = ingestReceipts(m, [settle], ctx);
  assert.deepEqual(m.seen, ['identity_alias', 'caravan_settled'], 'caravan_credited is never offered');
  assert.deepEqual([out.added, out.collision, out.duplicate, out.refused], [1, 1, 0, 0]);
  assert.equal(out.held.length, 1);
  assert.match(out.held[0].why, /^collision:caravan_settled; not written: caravan_credited$/);
});

test('R2 unchanged: a duplicate settle still offers its credit', () => {
  const { receipts, ctx } = fixture();
  const settle = receipts.find(r => r.kind === 'caravan_settled');
  const m = fake(() => 'duplicate');
  const out = ingestReceipts(m, [settle], ctx);
  assert.deepEqual(m.seen, ['identity_alias', 'caravan_settled', 'caravan_credited']);
  assert.deepEqual([out.duplicate, out.collision, out.held.length], [3, 0, 0]);
});

test('R3 an identity alias collision stops nothing', () => {
  const { receipts, ctx } = fixture();
  const settle = receipts.find(r => r.kind === 'caravan_settled');
  const m = fake(k => (k === 'identity_alias' ? 'collision' : 'added'));
  const out = ingestReceipts(m, [settle], ctx);
  assert.deepEqual(m.seen, ['identity_alias', 'caravan_settled', 'caravan_credited']);
  assert.deepEqual([out.added, out.collision, out.held.length], [2, 1, 0]);
});

test('R4 the rest of the feed is still read after a collision', () => {
  const { receipts, ctx } = fixture();
  const m = fake(k => (k === 'caravan_settled' ? 'collision' : 'added'));
  const out = ingestReceipts(m, receipts, ctx);
  assert.ok(m.seen.includes('caravan_sent'), 'the send is still written');
  assert.ok(!m.seen.includes('caravan_credited'));
  assert.equal(out.held.filter(h => /^collision:/.test(h.why)).length, 1);
  assert.ok(out.held.some(h => h.why === 'not_a_memory_input'), 'facility_used is held as before');
});

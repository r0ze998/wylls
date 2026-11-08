// Pure adapter boundary checks. No memory/signing fixture, crypto keys, network or subprocesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receiptToFacts, parseJsonU64, ingestReceipts } from '../adapters/ws04-receipts.mjs';

function fixture(name = 'happy') {
  const v = JSON.parse(readFileSync(new URL(`../fixtures/ws04-receipts/${name}.json`, import.meta.url)));
  return { receipts: v.receipts.map(r => ({ ...r, body: parseJsonU64(r.body_json) })),
    ctx: { partition: 'fixture-world', observedBell: 100, finalizedSlot: 100,
      bellOfSlot: s => s, runSpecs: Object.fromEntries(Object.entries(v.run_specs_json).map(([k, s]) => [k, parseJsonU64(s)])),
      resolveOwner: () => ({ principal: 'fixture-owner', source: 'fixture-resolver' }) } };
}
function changed(kind, change, name = 'happy') {
  const { receipts, ctx } = fixture(name);
  const r = structuredClone(receipts.find(r => r.kind === kind));
  change(r, ctx);
  return { r, ctx };
}
function held(r, ctx) {
  const out = receiptToFacts(r, ctx);
  assert.ok(out.held, 'inconsistent receipt must be held, not turned into a verified fact');
  assert.deepEqual(out.facts, [], 'do not leak an identity alias or credited fact from a held receipt');
  let writes = 0;
  const ingested = ingestReceipts({ observe() { writes++; return { status: 'added' }; } }, [r], ctx);
  assert.equal(writes, 0);
  assert.equal(ingested.held.length, 1);
}
for (const name of ['happy', 'crash', 'raid', 'lost-response']) {
  test(`unchanged recorded ws04 ${name} vectors are accepted`, () => {
    const { receipts, ctx } = fixture(name);
    for (const r of receipts.filter(r => r.kind !== 'facility_used')) assert.equal(receiptToFacts(r, ctx).held, null);
  });
}
for (const kind of ['caravan_settled', 'caravan_raided']) {
  for (const [label, mutate] of [
    ['different owner', r => r.body.key.owner = '120'],
    ['different sequence', r => r.body.key.seq = 1],
    ['missing key', r => delete r.body.key],
    ['unfinalized body slot hidden by envelope', r => r.body.slot = 101],
    ['missing body slot', r => delete r.body.slot],
  ]) test(`${kind}: ${label}`, () => {
    const { r, ctx } = changed(kind, mutate, kind === 'caravan_raided' ? 'raid' : 'happy'); held(r, ctx);
  });
}
for (const [label, mutate] of [
  ['negative envelope slot', r => { r.slot = -1; r.body.slot = -1; }],
  ['negative finalized slot', (_, c) => c.finalizedSlot = -1],
  ['negative world bell', (_, c) => c.bellOfSlot = () => -1],
  ['invalid observed bell', (_, c) => c.observedBell = NaN],
]) test(label, () => { const { r, ctx } = changed('caravan_settled', mutate); held(r, ctx); });
test('sent sequence is not coerced from null', () => {
  const { r, ctx } = changed('caravan_sent', r => r.body.seq = null); held(r, ctx);
});
test('exact large u64 owner matches subject; rounded owner does not', () => {
  const { r, ctx } = changed('caravan_settled', r => {
    r.subject = 'cv:fedcba9876543210:0'; r.body.key.owner = '18364758544493064720';
  });
  assert.equal(receiptToFacts(r, ctx).held, null);
  r.body.key.owner = Number(r.body.key.owner); held(r, ctx);
});

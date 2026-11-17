// T5 (moved from continuing.test.mjs so that it runs without loading the keyed local world): long-running cost state.
// KEY-FREE: imports run-cost.mjs and inference.mjs only; no relay, no chain, no key, nothing signed, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionRegistry } from '../src/inference.mjs';
import { KEY_RETENTION_DAYS, RunCostMock } from '../src/run-cost.mjs';

test('T5 long-running state: 60 days of calls compact to per-day sums with exact caps; undecided costs are never compacted; snapshots round-trip; memory stays bounded', () => {
  let clock = Date.UTC(2027, 0, 1);
  const now = () => clock;
  const a = new RunCostMock({ available: '1000000000', caps: { total: '1000000000', perDay: '100000' }, now });
  const twin = new RunCostMock({ available: '1000000000', caps: { total: '1000000000', perDay: '100000' }, now });
  const keysByDay = [];
  for (let d = 0; d < 60; d++) {
    const ks = [];
    for (let i = 0; i < 200; i++) {
      const k = `d05-${d}-${i}#0`;
      for (const c of [a, twin]) { c.reserve(k, '100'); c.calling(k); if (d === 0 && i < 3) c.undecided(k, 'timeout'); else if (i % 10 === 0) c.release(k, 'not sent'); else c.settle(k, '70'); }
      ks.push(k);
    }
    keysByDay.push(ks);
    a.compact({ beforeDay: new Date(clock).toISOString().slice(0, 10) });
    clock += 86_400_000;
  }
  // 12,000 items in the twin; the compacted ledger keeps today's and the undecided ones only.
  assert.equal(twin.items.size, 12_000);
  assert.ok(a.items.size <= 200 + 3, `items kept: ${a.items.size}`);
  assert.deepEqual(a.classes(), twin.classes(), 'every class sums the same');
  assert.equal(a.classes().undecided, '300');
  for (const k of ['d05-0-0#0', 'd05-0-1#0', 'd05-0-2#0']) assert.equal(a.items.get(k).state, 'undecided');
  // The caps see the folded days: the same answers as the uncompacted twin.
  for (const amt of ['1', '100000']) assert.deepEqual(a.check(amt), twin.check(amt));
  // Keys are remembered for KEY_RETENTION_DAYS: a recent one cannot be reserved again; a key older than that is forgotten.
  assert.ok(a.archive.keys.size <= (KEY_RETENTION_DAYS + 1) * 200);
  assert.throws(() => a.reserve(keysByDay[58][5], '1'), e => e.code === 'DuplicateKey');
  assert.equal(a.archive.keys.has(keysByDay[1][5]), false);
  // A snapshot round-trips (and applies the restart rule to anything in flight).
  const b = RunCostMock.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), { now });
  assert.deepEqual(b.classes(), a.classes());
  assert.ok(a.log.length <= 2_000, 'the debug log is bounded');
  // The decision registry keeps a bounded number of finished decisions.
  const r = new DecisionRegistry({ maxDone: 100 });
  for (let i = 0; i < 1_000; i++) r.remember(`k${i}`, { i });
  assert.equal(r.done.size, 100);
  assert.ok(r.done.has('k999') && !r.done.has('k0'));
});


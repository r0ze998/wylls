// node --test workstreams/08-persistence/sim/coop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCoop, COOP_BASE, STAGES, net } from './coop.mjs';
import { CASES, measureCoop, population } from './coop-run.mjs';

const P = (o = {}) => ({ ...COOP_BASE, ...o });
const go = (caseId, o, seed = 1) => {
  const params = P(o);
  const spec = CASES[caseId].specs(params);
  const w = runCoop(params, spec, seed);
  return { w, m: measureCoop(w, spec, CASES[caseId]), spec };
};

test('coop: deterministic per seed', () => {
  const a = JSON.stringify(go('equal', { objective: 'COOP' }, 3).m);
  const b = JSON.stringify(go('equal', { objective: 'COOP' }, 3).m);
  assert.equal(a, b);
});

test('coop: capacity and demand are respected; a unit uses one provider per function', () => {
  for (const obj of ['CMP', 'TRD', 'COOP']) {
    const { w } = go('monoOwner', { objective: obj });
    for (const d of w.log) {
      assert.ok(d.delivered <= w.P.nations * w.P.demand);
      const used = new Map();
      for (const c of d.chains) {
        assert.equal(c.members.length, 3);
        c.members.forEach((id, i) => used.set(`${id}:${i}`, (used.get(`${id}:${i}`) || 0) + 1));
        assert.ok(c.prices.reduce((a, x) => a + x, 0) <= w.P.value + 1e-9);
      }
      for (const [k, n] of used) {
        const [id, i] = k.split(':').map(Number);
        assert.ok(n <= w.parts[id].cap[STAGES[i]], `capacity of ${id} in ${STAGES[i]}`);
      }
    }
  }
});

test('coop: CMP keeps every chain inside the buyer nation; a coalition never mixes with outsiders', () => {
  const { w } = go('equal', { objective: 'CMP' });
  for (const d of w.log) for (const c of d.chains) for (const id of c.members) assert.equal(w.parts[id].nation, c.buyer);
  const k = go('cartel4', { objective: 'TRD' }).w;
  for (const d of k.log) for (const c of d.chains) {
    const kinds = new Set(c.members.map((id) => k.parts[id].cartel));
    assert.equal(kinds.size, 1);
    if (k.parts[c.members[0]].cartel !== null) assert.ok(c.buyer <= 3);
  }
});

test('coop: round trips change counts, never real output', () => {
  const plain = population(P());
  const washed = plain.map((x) => ({ ...x }));
  washed[1].wash = 19;
  washed[19].wash = 1;
  for (const obj of ['CMP', 'TRD', 'COOP']) {
    const a = runCoop(P({ objective: obj }), plain, 2);
    const b = runCoop(P({ objective: obj }), washed, 2);
    const del = (w) => w.log.map((d) => d.delivered).join();
    const trades = (w) => w.log.reduce((x, d) => x + d.trades, 0);
    assert.equal(del(a), del(b), obj);
    assert.ok(trades(b) > trades(a), obj);
  }
});

test('coop: the shared pool only redistributes unless someone decides on it', () => {
  const t = go('equal', { objective: 'TRD' }, 4).m;
  const c = go('equal', { objective: 'COOP' }, 4).m;
  assert.equal(t.delivered, c.delivered);
  // with the assumed reluctance to help another nation, a large enough pool changes what is delivered
  const tr = go('equal', { objective: 'TRD', foreignThreshold: 0.6 }, 4).m;
  const cr = go('equal', { objective: 'COOP', foreignThreshold: 0.6 }, 4).m;
  assert.ok(cr.delivered > tr.delivered);
});

test('coop: pool split by recorded trades rewards round trips, by value it does not more than their share', () => {
  const byTrades = go('inflate', { objective: 'COOP', allocation: 'trades' }, 5).m;
  const byValue = go('inflate', { objective: 'COOP', allocation: 'value' }, 5).m;
  assert.ok(byTrades.washerPoolShare > byValue.washerPoolShare);
  assert.ok(byTrades.washerPoolShare > byTrades.washerPoolShareFair);
});

test('coop: net is revenue - cost + surplus + shared + solo', () => {
  const { w } = go('optOut', { objective: 'COOP' }, 6);
  for (const p of w.parts) assert.ok(Math.abs(net(p) - (p.revenue - p.costPaid + p.surplus + p.shared + p.solo)) < 1e-9);
  for (const p of w.parts) if (p.policy === 'solo') assert.equal(p.units, 0);
});

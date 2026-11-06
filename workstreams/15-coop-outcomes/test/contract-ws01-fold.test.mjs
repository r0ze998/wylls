// Contract test against ①'s real fold() output: scenarios/fixtures/ws01-fold-3f3c8478.json
// holds what ①'s own `fold()` and `arrivalOf()` (3f3c8478, the newest ① on GitHub)
// returned for fixed records (gen-ws01-fold.mjs). No key, no signature: fold()
// does not verify `sig`, and the wallets are fixed public addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromWs01Arrivals, fromWs01Board } from '../src/adapters/ws01.mjs';
import { baseState } from '../scenarios/world.mjs';

const fx = JSON.parse(readFileSync(new URL('../scenarios/fixtures/ws01-fold-3f3c8478.json', import.meta.url), 'utf8'));
const WHO = { [fx.wallets.A]: 'n1-0', [fx.wallets.B]: 'n2-0', [fx.wallets.C]: 'n3-0', [fx.wallets.D]: 'n4-0' };
const T0 = 1790000000;
const map = {
  projectOf: r => ({ project: `P-${r.id.slice(0, 8)}`, goal: 'own', structure: 'palisade', steward: r.requester }),
  actorOf: w => WHO[w] ?? null,
  bellOf: t => Math.floor((t - T0) / 600),
  bellOfArrival: () => 40,
};
const tagB = fx.ownerTags.B;
const tagC = fx.ownerTags.C;
const judge = (state, arrivals) => {
  const b = fromWs01Board(state, map);
  const r = fromWs01Arrivals(arrivals, b.links, map);
  const st = { ...baseState(), streams: { ws01: { from: 0 }, 'ws01-arrival': { from: 0 } } };
  return { b, r, v: evaluate(RULESETS.B, { state: st, events: [...b.events, ...r.events] }) };
};

test('fold()\'s own answer: 9 records kept; repeats, others\' caravans, a closed request and another season refused by ①', () => {
  assert.equal(fx.state.accepted.length, 9);
  assert.deepEqual(fx.state.rejected.map(x => x.why), [
    '自分の依頼には応答できない', '同じ記録が二度', '隊商の持ち主がこの署名の人ではない',
    'この隊商はもう結び付けられている', '依頼が開いていない（取消・期限切れの後は結び付けない。隊商はそのまま届く）', '別のシーズンの記録',
  ]);
  assert.equal(Array.isArray(fx.state.requests), false, 'requests is an object keyed by id');
  assert.ok(fx.records.every(r => r.record.sig === 'unsigned'), 'no record was signed');
});

test('u64: ①\'s owner tags pass 2^53 and stay exact decimal strings through the adapter', () => {
  for (const t of [tagB, tagC]) {
    assert.equal(typeof t, 'string');
    assert.ok(BigInt(t) > 2n ** 53n && BigInt(t) < 2n ** 64n);
    assert.notEqual(String(Number(t)), t, 'a JSON number would have rounded it');
  }
  const { b, r } = judge(fx.state, fx.arrivals);
  assert.deepEqual([...b.links.keys()].sort(), [`${tagB}:0`, `${tagB}:2`, `${tagC}:0`].sort());
  assert.ok(r.events.some(e => e.ship === `cv:${tagB}:0:wood`));
  assert.ok(r.events.every(e => !e.ship || e.ship.includes(tagB) || e.ship.includes(tagC)));
});

test('the board as ① folded it: two projects, three links, nothing the adapter has to refuse', () => {
  const { b } = judge(fx.state, fx.arrivals);
  assert.equal(b.events.filter(e => e.kind === 'project.open').length, 2);
  assert.deepEqual(b.rejected, []);
  const cancelled = Object.values(fx.state.requests).find(q => q.state === 'cancelled');
  assert.equal(cancelled.links.length, 0, 'the link after the cancel was refused by fold(), not by ⑮');
});

test('quantities: village arrivals are lower bounds; the lost caravan brings nothing; only chain-log records count', () => {
  const { r, v } = judge(fx.state, fx.arrivals);
  assert.deepEqual(r.events.filter(e => e.kind === 'ship.arrive').map(e => `${e.ship.split(':').slice(2).join(':')}:${e.qty}:${e.qtyKind}`).sort(),
    ['0:stone:200:lower_bound', '0:wood:180:lower_bound']);
  assert.ok(r.events.some(e => e.kind === 'ship.lost' && e.ship === `cv:${tagB}:2:wood`));
  assert.equal(v.resources.wood.arrived.lowerBound, 180);
  assert.equal(v.resources.stone.arrived.lowerBound, 200);
  assert.equal(v.resources.wood.lost, 20);
  // a storehouse arrival (① proves no amount) is unknown, never a number
  const store = { ...fx.arrivals[0], verifiedQty: null, qtyKind: undefined };
  const u = judge(fx.state, [store]).r.events.find(e => e.kind === 'ship.arrive');
  assert.equal(u.qtyKind, 'unknown');
  // a herald-only copy is not counted
  const herald = { ...fx.arrivals[0], source: 'herald-ended' };
  assert.equal(judge(fx.state, [herald]).r.events.length, 0);
});

test('the same fold() output fed twice, or in another order, gives one count and one verdict', () => {
  const once = judge(fx.state, fx.arrivals).v;
  const twice = judge(fx.state, [...fx.arrivals, ...fx.arrivals]).v;
  assert.equal(twice.resources.wood.arrived.lowerBound, 180);
  const back = judge(fx.state, [...fx.arrivals].reverse()).v;
  assert.equal(back.verdictHash, once.verdictHash);
});

test('the board carries no game fact: no award, score or prize comes from fold() alone', () => {
  const b = fromWs01Board(fx.state, map);
  const st = { ...baseState(), streams: { ws01: { from: 0 } } };
  const v = evaluate(RULESETS.B, { state: st, events: b.events });
  assert.equal(v.awards.length, 0);
  assert.equal(v.prize.status, 'not_decided');
  assert.equal(v.world.ends, false);
});

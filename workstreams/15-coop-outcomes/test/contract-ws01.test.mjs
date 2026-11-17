// Contract test against ①'s real output: scenarios/fixtures/ws01-3f3c8478.json
// holds what ①'s own `arrivalOf` / `creditedOf` (coop/arrival.mjs at 3f3c8478)
// returned (gen-ws01.mjs). The request is in fold()'s shape (an object by id).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromWs01Arrivals, fromWs01Board } from '../src/adapters/ws01.mjs';
import { baseState } from '../scenarios/world.mjs';

const fx = JSON.parse(readFileSync(new URL('../scenarios/fixtures/ws01-3f3c8478.json', import.meta.url), 'utf8'));
const WHO = { 'W-n1-0': 'n1-0', 'W-88': 'n2-0' };
const map = {
  projectOf: r => ({ project: `P-${r.id}`, goal: 'own', structure: 'palisade', steward: r.requester }),
  actorOf: w => WHO[w] ?? null,
  bellOf: t => Math.floor((t - 1789990000) / 600),
  bellOfArrival: () => 50,
};

test('①\'s arrival records: the states ① produced, and which carry a quantity', () => {
  const a = fx.arrivals;
  assert.deepEqual(Object.fromEntries(Object.entries(a).map(([k, x]) => [k, `${x.state}/${x.source}/${x.qtyKind ?? '-'}`])), {
    'chain village (lower bound)': 'delivered/chain-log/lower-bound',
    'chain storehouse at the address (unverified)': 'misdelivered/chain-log/-',
    'chain lost': 'lost/chain-log/-',
    'chain elsewhere': 'misdelivered/chain-log/-',
    'chain burned': 'raided-burned/chain-log/-',
    'chain taken': 'raided-taken/chain-log/-',
    'herald only (no chain read)': 'delivered/herald-ended/-',
    'chain has nothing yet': 'unknown/none/-',
  });
  assert.equal(fx.creditedOf.storehouse.qty, null, '① does not prove a storehouse amount');
});

function judged(arrivals) {
  const board = { requests: { [fx.request.id]: fx.request } };
  const b = fromWs01Board(board, map);
  const r = fromWs01Arrivals(arrivals, b.links, map);
  const state = { ...baseState(), streams: { ws01: { from: 0 }, 'ws01-arrival': { from: 0 } } };
  return { b, r, v: evaluate(RULESETS.B, { state, events: [...b.events, ...r.events] }) };
}

test('only chain-log arrivals count: the village as a lower bound; herald-only and raided ones not at all', () => {
  const { b, r, v } = judged(Object.values(fx.arrivals));
  assert.equal(b.events.length, 1, 'fold()\'s object of requests opens one project');
  // The fixture links caravan 88:0 twice (its herald-only case reuses ①'s herald entry); the first by `n` is kept,
  // as ①'s fold() itself would only ever link it once.
  assert.equal(b.links.size, 7);
  assert.deepEqual(b.rejected.map(r => r.why), ['duplicateOf']);
  const arr = r.events.filter(e => e.kind === 'ship.arrive');
  assert.deepEqual(arr.map(e => `${e.ship}:${e.qty}:${e.qtyKind}`), ['cv:88:0:wood:114:lower_bound']);
  const pend = Object.fromEntries(r.pending.map(p => [p.caravan, p.why]));
  assert.equal(pend['88:0'], 'herald only: not counted', 'the herald copy of 88:0 is not counted; its chain record is (once)');
  assert.ok(r.pending.some(p => p.source === 'herald-ended' && /herald only/.test(p.why)));
  assert.ok(['88:5', '88:2'].every(k => k in pend), 'raided caravans bring nothing to the project');
  const wood = v.resources.wood;
  assert.equal(wood.arrived.lowerBound, 114);
  assert.equal(wood.inProjects['P-req-a'], 114, 'the arrival went into the request\'s project');
  assert.equal(v.achievements.personal.find(p => p.goal === 'P-supplier' && p.subject === 'n2-0'), undefined, 'not credited: the structure was never completed');
});

test('settled elsewhere: lost with the cause unconfirmed, no one named, no amount', () => {
  const { r } = judged([fx.arrivals['chain elsewhere']]);
  const lost = r.events.filter(e => e.kind === 'ship.lost');
  assert.deepEqual(lost.map(e => e.cause), ['unconfirmed']);
  assert.ok(!r.events.some(e => e.kind === 'ship.raid'));
});

test('a link made while the request was open stays valid after it is cancelled (①: the caravan still arrives)', () => {
  const cancelled = { ...fx.request, state: 'cancelled', cancel: { reason: 'self', at: 1790050000 } };
  const b = fromWs01Board({ requests: { [cancelled.id]: cancelled } }, map);
  assert.equal(b.links.size, 7);
  assert.deepEqual(b.rejected.map(r => r.why), ['duplicateOf'], 'only the repeated caravan, never the cancelled state');
});

test('the same caravan fed twice (two adapters, two streams) is counted once', () => {
  const one = fx.arrivals['chain village (lower bound)'];
  const board = { requests: { [fx.request.id]: fx.request } };
  const b = fromWs01Board(board, map);
  const r1 = fromWs01Arrivals([one], b.links, map, { stream: 'a' });
  const r2 = fromWs01Arrivals([one], b.links, map, { stream: 'b' });
  const state = { ...baseState(), streams: { ws01: { from: 0 }, a: { from: 0 }, b: { from: 0 } } };
  const v = evaluate(RULESETS.B, { state, events: [...b.events, ...r1.events, ...r2.events] });
  assert.equal(v.resources.wood.arrived.lowerBound, 114);
  assert.ok(v.records.refused.some(x => x.code === 'conflict' || x.code === 'already_settled'));
});

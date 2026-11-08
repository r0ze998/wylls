// Contract test against ①'s end-to-end output at 48f34e77 (scenarios/fixtures/ws01-e2e-48f34e77.json,
// gen-ws01-e2e.mjs): ①'s board in its ws01-board v1 form (boardForEvaluators), the S1 records of the same run (①'s
// fake chain, read with the game's decodePage) and what ① counted itself. ①'s points (2026-11-08): (a) requests as an
// array, (b) caravan keys with their context, (c) only the request's own destination is its arrival, (d) a settle that
// logs 0 still ends the caravan, (e) request states are 'open' and 'cancelled'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromWs01Board } from '../src/adapters/ws01.mjs';
import { fromS1Records } from '../src/adapters/s1-chain.mjs';
import { baseState } from '../scenarios/world.mjs';

const fx = JSON.parse(readFileSync(new URL('../scenarios/fixtures/ws01-e2e-48f34e77.json', import.meta.url), 'utf8'));
const ACTOR = { A: 'n0-0', B: 'n2-0', C: 'n1-0' }; // ①'s script: the Citizens' nations 0, 2, 1
const CTX = `${fx.contexts[0].programId}/${fx.contexts[0].seasonId}`;
const T0 = 1_800_000_000;
const goal = RULESETS.B.joint[0].id;
const map = {
  projectOf: q => ({ project: `P-${fx.labels[q.id]}`, goal, structure: 'fort', steward: q.requester }),
  actorOf: w => ACTOR[fx.wallets[w]] ?? null,
  bellOf: t => Math.max(0, Math.floor((t - T0) / 10)),
};
const page = fx.page.map(x => ({ ...x, seq: Number(x.seq), record: { ...x.record, cargo: x.record.cargo && Uint8Array.from(x.record.cargo), taken: x.record.taken && Uint8Array.from(x.record.taken) } }));
const sentOf = new Map();
function run({ board = fx.board, records = page, context = CTX, twice = false } = {}) {
  const b = fromWs01Board(board, map);
  const resolve = { actorOfTag: t => ACTOR[fx.tags[String(t)]] ?? null, destination: b.linkResolver(() => null), projectOfStructure: () => null, cargoSent: (t, s) => sentOf.get(`${t}:${s}`) ?? null };
  const s1 = fromS1Records(records, resolve, { context });
  const events = [...b.events, ...s1.events, ...(twice ? [...b.events, ...fromS1Records(records, resolve, { context }).events] : [])];
  return { b, s1, v: evaluate(RULESETS.B, { state: baseState(), events }) };
}
const label = id => fx.labels[id];

test('(a) ①\'s ws01-board v1: requests as an array, links with their caravanKey; five projects, nothing refused or unresolved', () => {
  assert.equal(fx.board.v, 1);
  assert.ok(Array.isArray(fx.board.requests));
  const { b, s1 } = run();
  assert.equal(b.events.filter(e => e.kind === 'project.open').length, 5);
  assert.deepEqual(b.rejected, []);
  assert.deepEqual(s1.unresolved, []);
  assert.throws(() => fromWs01Board({ ...fx.board, v: 2 }, map), /v1/);
});

test('quantities equal ①\'s own count per resource: wood 209, stone 200 (lower bounds); 50 stone burned', () => {
  assert.deepEqual(fx.countedBy1, { wood: 209, stone: 200 });
  const { v } = run();
  assert.equal(v.resources.wood.arrived.lowerBound, fx.countedBy1.wood);
  assert.equal(v.resources.stone.arrived.lowerBound, fx.countedBy1.stone);
  assert.equal(v.resources.wood.arrived.exact, 0);
  assert.equal(v.resources.stone.raidedBurned, 50);
});

test('(c) settled at another village (r4, no raid): not the request\'s arrival — lost, cause unconfirmed, no amount named', () => {
  const r4 = fx.arrivalsBy1.find(a => label(a.requestId) === 'r4');
  assert.equal(r4.state, 'misdelivered', '① calls it misdelivered and does not count it');
  const { s1, v } = run();
  const ship = `cv:${r4.caravanId.ownerTag}:${r4.caravanId.seq}:wood`;
  assert.deepEqual(s1.events.filter(e => e.ship === ship).map(e => `${e.kind}:${e.cause ?? ''}`), ['ship.send:', 'ship.lost:unconfirmed']);
  assert.equal(v.resources.wood.arrived.lowerBound + v.resources.wood.arrived.unverified, 209, 'the 30 wood is not an arrival');
});

test('(b) the context: another season\'s caravan with the same tag and seq is not this request\'s', () => {
  const other = 'OtherProgram111111111111111111111111111111/92';
  const { s1 } = run({ context: other });
  assert.ok(s1.unresolved.length > 0, 'nothing of season 91\'s board matches season 92\'s records');
  // without a context, a tag:seq matches only when one link on the board has it (one context here)
  assert.equal(run({ context: null }).v.resources.wood.arrived.lowerBound, 209);
  const two = { ...fx.board, contexts: [...fx.board.contexts, { programId: 'OtherProgram111111111111111111111111111111', seasonId: '92' }],
    requests: [...fx.board.requests, ...fx.board.requests.slice(0, 1).map(q => ({ ...q, id: `${q.id}-92`, links: q.links.map(l => ({ ...l, caravan: { ...l.caravan, ctx: other }, caravanKey: `${other}:${l.caravan.ownerTag}:${l.caravan.seq}` })) }))] };
  fx.labels[`${fx.board.requests[0].id}-92`] = 'r1-92';
  const amb = run({ board: two, context: null });
  assert.ok(amb.s1.unresolved.length > 0, 'two contexts with the same tag:seq: neither is guessed');
  assert.equal(run({ board: two, context: CTX }).v.resources.wood.arrived.lowerBound, 209);
});

test('(d) a settle whose logged cargo rounds to 0 still ends the caravan: at least 0, not left in transit', () => {
  const zeroed = page.map(x => (x.record.name === 'CARAVAN_SETTLED' && Number(x.record.outcome) === 0 && x === page.find(y => y.record.name === 'CARAVAN_SETTLED' && Number(y.record.outcome) === 0)
    ? { ...x, record: { ...x.record, cargo: new Uint8Array(32) } } : x));
  const { s1, v } = run({ records: zeroed });
  const z = zeroed.find(x => x.record.name === 'CARAVAN_SETTLED' && x.record.cargo.every(b => b === 0));
  const arr = s1.events.filter(e => e.kind === 'ship.arrive' && e.ship.startsWith(`cv:${z.record.owner_tag}:${z.record.seq}:`));
  assert.ok(arr.length > 0 && arr.every(e => e.qty === 0 && e.qtyKind === 'lower_bound'));
  assert.ok(!v.world.inTransit?.some?.(s => s.startsWith(`cv:${z.record.owner_tag}:${z.record.seq}:`)));
});

test('(e) request states are open and cancelled; the same run read twice counts once', () => {
  assert.ok(fx.board.requests.every(q => ['open', 'cancelled'].includes(q.state)));
  const once = run().v;
  const again = run({ twice: true }).v;
  assert.ok(again.diagnostics.duplicates.length > 0);
  assert.deepEqual(again.resources, once.resources);
  assert.equal(again.verdictHash, once.verdictHash);
});

// Contract test against ④'s real output: its runexec demo at d0949fd4 (simulated
// canonical world, MOCK), as SQLite holds it, dumped by workstream 12
// (scenarios/fixtures/ws04-runexec-d0949fd4/, copied byte for byte). ④'s receipt
// writers are unchanged up to its newest commit 8e96f24d (source.json).
//
// Where a case needs what the demo does not show (a kept resource, a u64 tag past
// 2^53, a missing `credited`), the test makes one textual edit on ④'s own JSON
// text and says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromRunexecDump, fromRunReceipts, parseExact, quantityOf } from '../src/adapters/ws04.mjs';
import { baseState } from '../scenarios/world.mjs';

const dir = new URL('../scenarios/fixtures/ws04-runexec-d0949fd4/', import.meta.url);
const raw = name => readFileSync(new URL(`${name}.json`, dir), 'utf8');
const source = JSON.parse(raw('source'));
const dump = name => JSON.parse(raw(name));
const TAGS = { 119: 'n2-0', 85: 'n3-0', '18446744073709551557': 'n4-0', '9223372036854775809': 'n0-1' };
const map = {
  bellOfSlot: s => s,
  actorOfTag: t => TAGS[t] ?? null,
  destination: dst => (Number(dst.kind) === 2 && Number(dst.p) === 1 ? { actor: 'n1-0' } : { actor: 'elsewhere' }),
};
const read = (d, outcomes) => { const { receipts, runs } = fromRunexecDump(d, outcomes); return fromRunReceipts(receipts, runs, map); };
/** One textual edit on ④'s JSON text of every receipt body, spec, subject and source. */
const edit = (d, pairs) => {
  const sub = t => pairs.reduce((s, [a, b]) => s.split(a).join(b), t);
  return { ...d, receipts: d.receipts.map(r => ({ ...r, subject: sub(r.subject), source: sub(r.source), body_json: sub(r.body_json) })),
    run_specs_json: Object.fromEntries(Object.entries(d.run_specs_json).map(([k, v]) => [k, sub(v)])) };
};
const WOOD = [['[0,0,0,0,0,0,3,0]', '[0,3,0,0,0,0,0,0]']]; // the demo's cargo moved from slot 6 (Science) to slot 1 (Wood)
const judge = (events, through) => {
  const state = { ...baseState(), streams: { ws04: { from: 0, ...(through === undefined ? {} : { through }) } } };
  return evaluate(RULESETS.B, { state, events });
};

test('the fixtures are ④\'s bytes (sha256 as recorded), from d0949fd4; the dump has no run outcome', () => {
  for (const [f, h] of Object.entries(source.sha256)) assert.equal(createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex'), h, f);
  for (const n of ['happy', 'crash', 'raid', 'lost-response']) {
    const d = dump(n);
    assert.equal(d.provenance.commit, 'd0949fd417180b11704de5690ab0dfb6e5ef3148');
    assert.ok(d.receipts.every(r => typeof r.body_json === 'string'), 'bodies are raw JSON text');
    assert.ok(Object.values(fromRunexecDump(d).runs).every(r => r.outcome === undefined));
  }
});

test('the demo ships Science (slot 6), which the evaluator does not keep: reported, not counted, and no gap', () => {
  const { events, skipped } = read(dump('happy'));
  assert.deepEqual(events.map(e => e.kind), ['position', 'position', 'position']);
  assert.equal(skipped.filter(s => /science 3 \(slot 6\)/.test(s.why)).length, 2);
  const v = judge(events);
  assert.equal(v.records.gaps?.length ?? 0, 0);
  assert.equal(v.resources.wood.sent, 0);
});

test('a storehouse with `credited` (④ §3 Recorded, case B) is a lower bound [b, b+1)', () => {
  const { events } = read(edit(dump('happy'), WOOD));
  assert.deepEqual(events.filter(e => e.kind.startsWith('ship.')).map(e => `${e.kind}:${e.ship}:${e.qty}:${e.qtyKind ?? ''}:${e.verified}`),
    ['ship.send:cv:119:0:wood:3::chain', 'ship.arrive:cv:119:0:wood:3:lower_bound:chain_lower_bound']);
  const v = judge(events);
  assert.equal(v.resources.wood.arrived.lowerBound, 3);
});

test('without `credited` the amount is unknown [0, cargo+1); a run outcome KnownZero is zero; LOST is zero', () => {
  const noCredit = edit(dump('happy'), [...WOOD, [',"credited":[0,3,0,0,0,0,0,0]', '']]);
  assert.deepEqual(read(noCredit).events.filter(e => e.kind === 'ship.arrive').map(e => `${e.qty}:${e.qtyKind}`), ['3:unknown']);
  const zero = read(edit(dump('happy'), WOOD), { 'demo-happy': { verification: 'KnownZero', delivered: [0, 0, 0, 0, 0, 0, 0, 0] } });
  assert.deepEqual(zero.events.filter(e => e.kind === 'ship.arrive').map(e => `${e.qty}:${e.qtyKind}`), ['0:zero']);
  const settle = parseExact(dump('happy').receipts.find(r => r.kind === 'caravan_settled').body_json);
  assert.equal(quantityOf({ ...settle, outcome: 1 }, null).kind, 'zero');
});

test('three runs report the same caravan (happy, crash, lost-response): read once, counted once', () => {
  const all = ['happy', 'crash', 'lost-response'].map(n => edit(dump(n), WOOD));
  const merged = { receipts: all.flatMap(d => d.receipts), run_specs_json: Object.assign({}, ...all.map(d => d.run_specs_json)) };
  const { events, skipped } = read(merged);
  assert.equal(events.filter(e => e.kind === 'ship.send').length, 1);
  assert.equal(events.filter(e => e.kind === 'ship.arrive').length, 1);
  assert.equal(skipped.filter(s => s.why === 'same record from another source').length, 4);
  const v = judge(events);
  assert.equal(v.resources.wood.arrived.lowerBound, 3, 'not 9');
  // the order the receipts come in does not change the verdict
  const back = read({ ...merged, receipts: [...merged.receipts].reverse() });
  assert.equal(judge(back.events).verdictHash, v.verdictHash);
});

test('the raid run: the take goes to the raider; mixing it with a settled world refuses the second end, never counts twice', () => {
  const raid = read(edit(dump('raid'), WOOD));
  assert.deepEqual(raid.events.filter(e => e.kind === 'ship.raid').map(e => `${e.raider}:${e.taken}:${e.burned}`), ['n3-0:3:0']);
  // happy and raid are separate simulated worlds that reuse one caravan key; fed together, the
  // same kind|subject differs only by kind, so the evaluator sees a settle and a raid for one ship.
  const both = ['happy', 'raid'].map(n => edit(dump(n), WOOD));
  const r = read({ receipts: both.flatMap(d => d.receipts), run_specs_json: Object.assign({}, ...both.map(d => d.run_specs_json)) });
  const v = judge(r.events);
  assert.ok(v.records.refused.some(x => x.code === 'already_settled'));
  assert.ok(v.resources.wood.arrived.lowerBound + v.resources.wood.raidedTaken <= 3);
});

test('u64: owner 2^64-59 and raider 2^63+1 stay exact with parseExact; a rounded number is a gap, not someone else', () => {
  const big = [['"owner":119', '"owner":18446744073709551557'], ['cv:77:', 'cv:ffffffffffffffc5:'], ['"raider":85', '"raider":9223372036854775809']];
  const d = edit(dump('raid'), [...WOOD, ...big]);
  const { events } = read(d);
  assert.deepEqual(events.filter(e => e.kind.startsWith('ship.')).map(e => `${e.kind}:${e.ship}:${e.from ?? e.raider}`),
    ['ship.send:cv:18446744073709551557:0:wood:n4-0', 'ship.raid:cv:18446744073709551557:0:wood:n0-1']);
  // read with plain JSON.parse, the same text rounds both tags: the settle's owner no longer matches its subject
  const plain = { receipts: d.receipts.map(r => ({ ...r, body: JSON.parse(r.body_json) })), runs: {} };
  for (const [k, v] of Object.entries(d.run_specs_json)) plain.runs[k] = { spec: JSON.parse(v) };
  const p = fromRunReceipts(plain.receipts, plain.runs, map);
  assert.ok(p.skipped.some(s => /not exact/.test(s.why)));
  assert.ok(!p.events.some(e => e.kind === 'ship.raid'), 'no raider is guessed');
});

test('a body whose key names another caravan than its subject is left as a gap', () => {
  const d = edit(dump('happy'), [...WOOD, ['"key":{"owner":119,"seq":0}', '"key":{"owner":119,"seq":9}']]);
  const { skipped, events } = read(d);
  assert.ok(skipped.some(s => /another caravan/.test(s.why)));
  assert.ok(!events.some(e => e.kind === 'ship.arrive'));
  assert.ok(judge(events, 2).records.gaps.length > 0, 'with the stream\'s end stated (3 records), the missing settle is a gap');
});

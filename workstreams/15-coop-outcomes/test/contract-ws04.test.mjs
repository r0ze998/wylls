// Contract test against ④'s types at a967f5f1 (Receipt, Settle, Raid, RunSpec,
// Outcome) and its quantity contract. ④ has committed no JSON from a run: the
// fixture is written in the JSON form of those serde types (labelled so).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/ledger.mjs';
import { caravanOfSubject, fromRunReceipts, quantityOf } from '../src/adapters/ws04.mjs';

const fx = JSON.parse(readFileSync(new URL('../scenarios/fixtures/ws04-types-a967f5f1.json', import.meta.url), 'utf8'));
const TAGS = { 21: 'n2-0', 31: 'n3-0', 66: 'n0-2', '10320661741101281076': 'n4-0' };
const map = {
  bellOfSlot: s => s,
  actorOfTag: t => TAGS[t] ?? null,
  destination: dst => (Number(dst.p) === 3 ? { actor: 'n1-0', project: 'P-north' } : { actor: 'elsewhere' }),
};
const run = () => fromRunReceipts(fx.receipts, fx.runs, map);
const by = (events, kind) => events.filter(e => e.kind === kind);

test('owners come from the subject\'s hex (exact); the JSON number is not exact above 2^53', () => {
  assert.deepEqual(caravanOfSubject('cv:8f3a5b2c1d4e6f34:4'), { owner: '10320661741101281076', seq: 4 });
  const body = fx.receipts.find(r => r.subject === 'cv:8f3a5b2c1d4e6f34:4' && r.kind === 'caravan_settled').body;
  assert.equal(Number.isSafeInteger(body.key.owner), false);
  const { events } = run();
  assert.ok(by(events, 'ship.send').some(e => e.ship === 'cv:10320661741101281076:4:stone'));
});

test('RuleDerived (a village) is a lower bound; the same record from feed and history is read once', () => {
  const { events, skipped } = run();
  const village = by(events, 'ship.arrive').filter(e => e.ship.startsWith('cv:21:1:'));
  assert.deepEqual(village.map(e => `${e.ship}:${e.qty}:${e.qtyKind}`), ['cv:21:1:stone:300:lower_bound', 'cv:21:1:gold:50:lower_bound']);
  assert.ok(skipped.some(s => s.why === 'same record from another source'));
});

test('Unverifiable (a storehouse) is unknown; KnownZero by a burn record is a burn; DestinationMismatch names no one', () => {
  const { events } = run();
  assert.deepEqual(by(events, 'ship.arrive').filter(e => e.ship.startsWith('cv:31:1:')).map(e => `${e.qty}:${e.qtyKind}`), ['200:unknown']);
  const burn = by(events, 'ship.raid').find(e => e.ship.startsWith('cv:31:2:'));
  assert.deepEqual([burn.taken, burn.burned, burn.raider], [0, 20, 'n0-2']);
  const elsewhere = events.filter(e => e.ship?.startsWith('cv:31:3:'));
  assert.deepEqual(elsewhere.map(e => `${e.kind}:${e.cause ?? ''}`), ['ship.send:', 'ship.lost:unconfirmed']);
});

test('a raider tag beyond 2^53 is left as a gap, not guessed', () => {
  const { skipped } = run();
  assert.ok(skipped.some(s => /beyond 2\^53/.test(s.why)));
});

test('one kind and subject with other content: both kept under one id, set aside as a conflict', () => {
  const r = fx.receipts.find(x => x.kind === 'caravan_settled' && x.subject === 'cv:1f:1');
  const other = { ...r, source: 'history:h9', body: { ...r.body, cargo: [0, 190, 0, 0, 0, 0, 0, 0] } };
  const { events } = fromRunReceipts([...fx.receipts, other], fx.runs, map);
  const n = normalize(events, {});
  assert.ok(n.notes.conflicts.length > 0);
  assert.ok(n.notes.gaps.some(g => g.stream === 'ws04'));
});

test('④ §3: quantities from a run outcome, or from the settle record alone', () => {
  const st = (kind, extra = {}) => ({ outcome: 0, dst: { kind }, cargo: [0, 7, 0, 0, 0, 0, 0, 0], credited: null, ...extra });
  assert.equal(quantityOf(st(1), null).kind, 'lower_bound');
  assert.equal(quantityOf(st(2), null).kind, 'unknown');
  assert.equal(quantityOf(st(2, { credited: [0, 5, 0, 0, 0, 0, 0, 0] }), null).kind, 'lower_bound');
  assert.equal(quantityOf(st(1, { outcome: 1 }), null).kind, 'zero');
  assert.equal(quantityOf(st(1), { verification: 'KnownZero' }).kind, 'zero');
  assert.equal(quantityOf(st(1), { verification: 'Unverifiable', cargo_logged: [0, 7, 0, 0, 0, 0, 0, 0] }).kind, 'unknown');
  assert.equal(quantityOf(st(2), { verification: 'Recorded', delivered: [0, 5, 0, 0, 0, 0, 0, 0] }).kind, 'lower_bound');
});

test('facility use is not a goal stage here: it holds its position only', () => {
  const { events } = run();
  assert.ok(events.some(e => e.kind === 'position' && e.src.run === 'run-x'));
});

// Contract test against ④'s chain flow at cf517b55 (scenarios/fixtures/ws04-chain-flow-cf517b55/, copied byte for
// byte): an NFT pass joined with the game program's own JoinResident, then that Citizen's caravan shipped by the run
// executor. The same store was read by ⑫'s adapters (c-memory.json) and by the old ⑮ adapter (d-outcome.json).
// Here: ⑮'s current adapter on the store, checked against ⑫'s facts for the same caravan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.mjs';
import { normalize } from '../src/ledger.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromRunexecDump, fromRunReceipts } from '../src/adapters/ws04.mjs';
import { baseState } from '../scenarios/world.mjs';

const dir = new URL('../scenarios/fixtures/ws04-chain-flow-cf517b55/', import.meta.url);
const json = f => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const source = json('source.json');
const A = json('a-join.json');
const store = json('b-store-dump.json');
const C = json('c-memory.json');
const D = json('d-outcome.json');
// The actor is whoever ⑫'s identity read ties the Citizen's tag to (identity_alias): the pass, not a wallet.
const alias = C.facts.find(f => f.kind === 'identity_alias').data;
const ACTOR = `pass:${alias.principal}`;
const map = {
  bellOfSlot: s => s, // ④'s MOCK clock (bell = slot), as stated in its fixtures
  actorOfTag: t => (BigInt(t).toString(16).padStart(16, '0') === alias.tag ? ACTOR : null),
  destination: () => ({ actor: ACTOR }), // stage B ships to the Citizen's own storehouse
};
const read = (opts = {}, m = map) => { const { receipts, runs } = fromRunexecDump(store); return fromRunReceipts(receipts, runs, m, { epoch: A.season_id, ...opts }); };
const judge = (events, through) => evaluate(RULESETS.B, {
  state: { ...baseState({ extraActors: [{ id: ACTOR, nation: 'n1', kind: 'human', stock: false }] }), streams: { ws04: { from: 0, ...(through === undefined ? {} : { through }) } } },
  events,
});

test('the fixtures are ④\'s bytes at cf517b55; the Citizen tag passes 2^53', () => {
  for (const [f, h] of Object.entries(source.sha256)) assert.equal(createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex'), h, f);
  assert.ok(BigInt(A.citizen_tag) > 2n ** 53n);
  assert.equal(BigInt(A.citizen_tag).toString(16), A.citizen_tag_hex);
});

test('the Citizen sends 4 wood and 4 arrive; ④\'s Recorded outcome is a lower bound [4, 5), not exact', () => {
  const { events, skipped, held } = read();
  const ships = events.filter(e => e.kind.startsWith('ship.'));
  assert.deepEqual(ships.map(e => `${e.kind}:${e.ship}:${e.qty}:${e.qtyKind ?? ''}:${e.verified}`), [
    `ship.send:cv:7:${A.citizen_tag}:0:wood:4::chain`,
    `ship.arrive:cv:7:${A.citizen_tag}:0:wood:4:lower_bound:chain_lower_bound`,
  ]);
  assert.equal(ships[0].from, ACTOR);
  assert.deepEqual(skipped, []);
  assert.deepEqual(held, []);
  const n = normalize(events, {});
  assert.deepEqual([n.notes.rejected.length, n.notes.conflicts.length, n.notes.gaps.length], [0, 0, 0]);
  const v = judge(events);
  assert.equal(v.resources.wood.sent, 4);
  assert.equal(v.resources.wood.arrived.lowerBound, 4);
});

test('⑮ and ⑫ read the same caravan the same way: sender tag, seq, cargo, credited amount, bells', () => {
  const { events } = read();
  const sent = C.facts.find(f => f.kind === 'caravan_sent');
  const settled = C.facts.find(f => f.kind === 'caravan_settled');
  const credited = C.facts.find(f => f.kind === 'caravan_credited');
  const send = events.find(e => e.kind === 'ship.send');
  const arrive = events.find(e => e.kind === 'ship.arrive');
  assert.equal(BigInt(send.ship.split(':')[2]).toString(16).padStart(16, '0'), sent.sender);
  assert.equal(Number(send.ship.split(':')[3]), sent.data.caravan.seq);
  assert.deepEqual({ [send.resource]: send.qty }, sent.data.cargo);
  assert.deepEqual({ wood: arrive.qty }, credited.data.credited);
  assert.equal(credited.data.unit, 'whole_units', '⑫ reads whole units: the same lower bound as ⑮');
  assert.deepEqual([send.at, arrive.at], [sent.bell, settled.bell]);
});

test('④\'s old stage D call and its proposed mapping still run, and no longer lose the send or name an undefined seq', () => {
  const { receipts, runs } = fromRunexecDump(store);
  const old = fromRunReceipts(receipts, map, { epoch: A.season_id }); // (receipts, map, opts): stages-cde.mjs D1
  assert.ok(Array.isArray(old.events));
  assert.match(D.as_is.finding, /skipped as unresolved/);
  assert.ok(D.proposed_mapping.events.some(e => /:undefined:/.test(e.ship)), 'the old adapter wrote seq "undefined"');
  // ④'s D2 adds owner_tag, dst and verification to the bodies; the current adapter reads the subject, the run spec
  // and the run outcome instead, so the extra fields change nothing.
  const mapped = receipts.map(r => ({ ...r, body: { ...r.body, owner_tag: '1', verification: 'RuleDerived' } }));
  assert.deepEqual(fromRunReceipts(mapped, runs, map, { epoch: A.season_id }).events.map(e => e.ship ?? e.kind), read().events.map(e => e.ship ?? e.kind));
  assert.ok(!read().events.some(e => /undefined/.test(e.ship ?? '')));
});

test('finality: receipts after the finalized slot are held (not a gap); the slot order keeps the judged positions', () => {
  const r = read({ finalizedSlot: 10 });
  assert.deepEqual(r.events.map(e => e.kind), ['ship.send']);
  assert.deepEqual(r.held.map(h => h.slot), [22]);
  const later = read({ finalizedSlot: 22 });
  assert.equal(later.events[0].id, r.events[0].id, 'the send keeps its id when the settle comes in');
  assert.equal(judge(r.events).records.gaps.length, 0);
});

test('a slot the clock cannot place is a gap, never a guessed bell', () => {
  const r = read({}, { ...map, bellOfSlot: s => (s === 22 ? null : s) });
  assert.ok(r.skipped.some(s => /not placed/.test(s.why)));
  const v = judge(r.events, 1);
  assert.ok(v.records.gaps.length > 0);
  assert.equal(v.resources.wood.arrived.lowerBound, 0);
});

test('the facts carry no outcome of their own: no award, no prize, the world goes on', () => {
  const v = judge(read().events);
  assert.equal(v.awards.length, 0);
  assert.equal(v.prize.status, 'not_decided');
  assert.equal(v.world.ends, false);
});

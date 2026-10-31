// The world does not end at a window's close (the 2026-10-31 correction).
// One continuous log, two evaluation windows given as input: what was under
// way at the boundary carries on, each achievement is credited once, goods
// balance at the boundary, and a world saved at the boundary and resumed
// (a restart) reaches the same state as one replayed from the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateSeries } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { hashOf } from '../src/canon.mjs';
import { buildWorld, snapshotOf } from '../src/world.mjs';
import { normalize } from '../src/ledger.mjs';
import { load } from './helpers.mjs';

const input = load('boundary-crossing');
const byId = (s, id) => s.verdicts.find(v => v.window.id === id);
const joint = v => v.achievements.joint[0];

test('at the boundary: caravans in transit, the open project and all goods carry on; nothing is lost or made', () => {
  const s = evaluateSeries(RULESETS.B, input);
  assert.equal(s.worldEnds, false);
  const [b] = s.boundaries;
  assert.equal(b.at, 240);
  assert.deepEqual(b.inTransit, ['c-n3-arms', 'c-n3-gold', 'c-n3-stone', 'c-n3-wood', 'c-n4-food', 'c-n5-ore']);
  assert.deepEqual(b.openProjects, ['P-north']);
  assert.equal(b.balanced, true);
  assert.equal(b.goods.wood.transit, 200);
  assert.equal(b.restartMatches, true);
  for (const v of s.verdicts) assert.equal(v.world.ends, false);
});

test('a project begun in W1 and finished in W2 is achieved in W2, with W1\'s inputs, and only once', () => {
  const s = evaluateSeries(RULESETS.B, input);
  const w1 = byId(s, 'W1');
  const w2 = byId(s, 'W2');
  assert.equal(joint(w1).status, 'not_achieved');
  assert.ok(joint(w1).reasons.some(r => r.code === 'stage_completion'), 'not built yet: not "late", not "lost"');
  assert.equal(joint(w2).status, 'achieved');
  assert.equal(joint(w2).achievedAt, 280);
  const p = joint(w2).projects[0];
  assert.equal(p.stages.inputs.perResource.wood.credited, 500, 'n1-0\'s W1 wood counts with n3-0\'s W2 wood');
  const all = s.verdicts.flatMap(v => v.awards);
  const jointAwards = all.filter(a => a.goal === 'J-north-fort');
  assert.deepEqual(jointAwards.map(a => a.slot.split('|')[1]), ['W2', 'W2', 'W2']);
  // The palisade of W1 and the fort of W2 each give their supplier award in their own window, once.
  assert.deepEqual(all.filter(a => a.goal === 'P-supplier').map(a => `${a.slot.split('|')[1]}:${a.beneficiary}`).sort(), ['W1:n2-1', 'W2:n1-0', 'W2:n2-0', 'W2:n3-0']);
});

test('a later window does not re-award what an earlier one achieved', () => {
  const twice = { ...input, windows: [...input.windows, { id: 'W3', opensAt: 480, endsAt: 720 }] };
  const s = evaluateSeries(RULESETS.B, twice);
  const w3 = byId(s, 'W3');
  assert.equal(joint(w3).status, 'achieved_earlier');
  assert.equal(w3.awards.length, 0);
  assert.equal(s.boundaries[1].balanced, true);
  assert.deepEqual(s.boundaries[1].inTransit, ['c-n5-ore'], 'still moving: never cancelled by a window\'s close');
});

test('the world does not depend on where windows fall; only the window an achievement is credited to does', () => {
  const other = { ...input, windows: [{ id: 'X1', opensAt: 0, endsAt: 275 }, { id: 'X2', opensAt: 275, endsAt: 480 }] };
  const a = evaluateSeries(RULESETS.B, input);
  const b = evaluateSeries(RULESETS.B, other);
  assert.equal(a.finalDigest, b.finalDigest);
  assert.equal(joint(byId(b, 'X2')).status, 'achieved');
  assert.equal(b.boundaries[0].balanced, true);
  assert.deepEqual(b.boundaries[0].openProjects, [], 'built at 260, waiting for its second user at the boundary');
});

test('a series verdict equals the same window judged alone (no hidden state between windows)', () => {
  const s = evaluateSeries(RULESETS.B, input);
  for (const id of ['W1', 'W2']) assert.equal(evaluate(RULESETS.B, input, { window: id }).verdictHash, byId(s, id).verdictHash, id);
});

test('restart at the boundary: resume from a saved snapshot, then the rest of the log, equals the full replay', () => {
  const norm = normalize(input.events, input.state.streams);
  const jointGoals = { 'J-north-fort': RULESETS.B.joint[0] };
  const opts = { state: input.state, costs: RULESETS.B.costs, jointGoals, taint: norm.taint, gapFrom: norm.gapFrom };
  const full = buildWorld({ ...opts, events: norm.events });
  const before = buildWorld({ ...opts, events: norm.events.filter(e => e.at < 240) });
  const saved = JSON.parse(JSON.stringify(snapshotOf(before))); // as written to disk
  const resumed = buildWorld({ ...opts, events: norm.events.filter(e => e.at >= 240), resume: saved });
  assert.equal(hashOf(snapshotOf(resumed)), hashOf(snapshotOf(full)));
  // Replaying an event from before the snapshot onto it is refused, not applied twice.
  const again = buildWorld({ ...opts, events: norm.events.filter(e => e.at >= 230), resume: saved });
  assert.ok(again.outcomes.some(o => !o.ok && o.code === 'replayed'));
  assert.equal(hashOf(snapshotOf(again)), hashOf(snapshotOf(full)), 'replayed records change nothing');
  assert.ok(again.settledShips.has('c-n3-wood'), 'arrived once: settled, out of the live state');
  assert.equal(again.ships.size, full.ships.size);
});

test('C closes only the evaluation window, never the world; the rest of the window is reported, not filled in', () => {
  const b = evaluateSeries(RULESETS.B, input);
  const c = evaluateSeries(RULESETS.C, input);
  const w2 = byId(c, 'W2');
  assert.equal(w2.window.closedBy, 'joint:J-north-fort');
  assert.equal(w2.window.closeAt, 304);
  assert.deepEqual(w2.window.unevaluated, { from: 304, to: 480 });
  assert.equal(c.finalDigest, b.finalDigest, 'the same world');
  assert.equal(w2.world.ends, false);
  assert.equal(RULESETS.C.status, 'comparison-only');
  assert.equal(w2.prize.status, 'not_decided');
});

test('the raid after the boundary on a caravan sent before it is credited to W2, once', () => {
  const s = evaluateSeries(RULESETS.B, input);
  const r = s.verdicts.flatMap(v => v.achievements.personal.filter(p => p.goal === 'P-raider' && p.subject === 'n0-2').map(p => `${v.window.id}:${p.status}`));
  assert.deepEqual(r, ['W2:achieved']);
});

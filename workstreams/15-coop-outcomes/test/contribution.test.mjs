// Required checks: the reason for a contribution is not a trade count or a
// delivered quantity; resources are not added together; material input,
// completion and actual use are separate stages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { codes, joint, load, personal, project, withEvents, without } from './helpers.mjs';

const coop = load('coop-north-fort');

test('round trips and self-trades: 12 trades and 1,600 wood delivered, 100 credited', () => {
  const input = load('round-trip-wash');
  const v = evaluate(RULESETS.B, input);
  const trades = input.events.filter(e => e.kind === 'ship.send' && /^(wash|self)/.test(e.ship));
  assert.equal(trades.length, 12);
  assert.equal(trades.reduce((s, e) => s + e.qty, 0), 1_600);
  assert.equal(v.resources.wood.sent >= 1_600, true);
  const pal = v.achievements.personal.find(p => p.goal === 'P-supplier' && p.subject === 'n2-2');
  assert.equal(pal.perResource.wood, 100, 'only what went into the completed palisade');
  // The trading partner and the alternate account got no credit for the trades.
  assert.equal(personal(v, 'P-supplier', 'n3-2'), undefined);
  assert.equal(personal(v, 'P-supplier', 'alt-n2-2'), undefined);
  // The joint fort's credit is unchanged by the trades.
  assert.deepEqual(project(v).stages.inputs.perResource, project(evaluate(RULESETS.B, coop)).stages.inputs.perResource);
});

test('delivering is not contributing: a caravan that arrives but is never built into anything credits nothing', () => {
  const v = evaluate(RULESETS.B, load('coop-north-fort'));
  const deliveredOnly = v.resources.food;
  assert.equal(deliveredOnly.inputs, 0);
  const noBuild = evaluate(RULESETS.B, without(coop, e => e.kind === 'build.complete' || e.kind === 'use'));
  assert.equal(joint(noBuild).status, 'not_achieved');
  assert.deepEqual(codes(joint(noBuild).reasons).filter(c => c.startsWith('stage_')), ['stage_completion', 'stage_use']);
  assert.equal(noBuild.awards.filter(a => a.track === 'joint').length, 0);
  assert.equal(noBuild.achievements.personal.filter(p => p.goal === 'P-supplier').length, 0, 'no supplier award before completion');
});

test('resources are kept apart: surplus wood does not make up for missing stone', () => {
  const input = withEvents(without(coop, e => e.ship === 'c-n2-stone' || e.ship === 'c-n3-stone'), out => {
    out.push({ id: 'x-wood', stream: 'x', seq: 0, at: 50, kind: 'contribute', verified: 'chain', project: 'P-north', actor: 'n1-0', lot: 'init:n1-0:wood', qty: 100 });
    return out;
  });
  const v = evaluate(RULESETS.B, { ...input, state: { ...input.state, streams: { ...input.state.streams, x: { from: 0 } } } });
  const t = project(v).stages.inputs.perResource;
  assert.equal(t.stone.credited, 300);
  assert.equal(t.wood.credited, 500);
  assert.equal(t.wood.surplus, 100);
  assert.equal(project(v).stages.inputs.met, false);
  assert.equal(project(v).stages.inputs.scarcestBps, 3_750, 'one number = the scarcest share, not a sum');
  assert.equal(joint(v).status, 'not_achieved');
  for (const r of Object.values(v.resources)) assert.equal(typeof r.sent, 'number');
  assert.equal('total' in v.resources, false);
});

test('three stages are judged apart: inputs met, built, then used', () => {
  const v = evaluate(RULESETS.B, coop);
  const st = project(v).stages;
  assert.equal(st.inputs.met, true);
  assert.equal(st.completion.done, true);
  assert.equal(st.completion.at, 100);
  assert.equal(st.use.met, true);
  assert.equal(st.use.at, 120);
  assert.equal(joint(v).achievedAt, 120);
  // Built but used by one nation only: not achieved, and the reason is the use stage.
  const one = evaluate(RULESETS.B, without(coop, e => e.kind === 'use' && e.actor === 'n2-1'));
  assert.equal(joint(one).status, 'not_achieved');
  assert.deepEqual(codes(joint(one).reasons), ['stage_use']);
  assert.deepEqual(project(one).stages.use.nations, ['n1']);
});

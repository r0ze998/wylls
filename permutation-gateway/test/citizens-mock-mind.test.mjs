// The stand-in mind (citizens/probe/mock-mind.mjs): a fixed rule over the brain's candidates, answers in wire v1. It is a
// check of the brain's S1 path without a model, never an AI citizen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { choose, answerOf, paramsOf } from '../citizens/probe/mock-mind.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/ai-decide-v1.json', import.meta.url), 'utf8'));

test('the rule prefers an S1 caravan, then an escort or ambush, then a favourable camp, then the economy, then the routine', () => {
  const c = (id, kind, facts = {}, params = {}) => ({ id, kind, label: kind, facts, params });
  const base = [c('c1', 'autopilot'), c('c2', 'hold'), c('c3', 'march', { target_kind: 'camp', ratio: 'favourable' }, { stance: ['hold', 'assault'], retreat: [0, 5000] }),
    c('c4', 'build:workshop'), c('c5', 'train:spearman')];
  const req = (cands, extra = {}) => ({ ai: { tag: 'aa' }, bell: 50, candidates: cands, own_marches: [], ...extra });
  assert.deepEqual(choose(req([...base, c('c6', 'caravan:1,0,2')])), { id: 'c6', why: 's1-caravan' });
  const last = new Map([['aa', 45]]);
  assert.equal(choose(req([...base, c('c6', 'caravan:1,0,2')]), last).id, 'c3', 'a caravan at most every 12 turns');
  assert.deepEqual(choose(req([...base, c('c7', 'march', { target_kind: 'ambush' })])), { id: 'c7', why: 's1-ambush' });
  assert.equal(choose(req([...base, c('c7', 'march', { target_kind: 'ambush' }), c('c8', 'march', { target_kind: 'escort' })])).id, 'c8', 'an escort before an ambush');
  assert.equal(choose(req(base)).id, 'c3');
  assert.equal(choose(req(base, { own_marches: [{ opened: null }] })).id, 'c4', 'no second camp march while one is on the road');
  assert.equal(choose(req([c('c1', 'autopilot'), c('c5', 'train:spearman')])).id, 'c5');
  assert.deepEqual(choose(req([c('c1', 'autopilot'), c('c2', 'hold')])), { id: 'c1', why: 'routine' });
  assert.deepEqual(paramsOf(base[2]), { stance: 'hold', retreat: 0 });
});

test('its answers are wire v1 as the golden fixture\'s', () => {
  const req = FIX.request;
  const pick = choose(req);
  const a = answerOf(req, pick, 7);
  for (const k of Object.keys(FIX.answer)) assert.ok(k in a, k);
  assert.equal(a.v, 1);
  assert.equal(a.decision_id, 'mock-7');
  assert.match(a.reason, /^mock:/, 'every answer says it is the stand-in');
  assert.deepEqual(a.choice.ids, [pick.id]);
  const auto = answerOf(req, { id: 'c1', why: 'routine' }, 8);
  assert.deepEqual([auto.mode, auto.choice.params], ['autopilot', {}]);
});

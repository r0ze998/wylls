// World goal ② research by the operator AI residents (plan §8, owner r0ze 2026-11-25 08:56: the players' rules): the
// effects of the nation's techs first, then the village's science (≥ 10) to the tech the nation has least left to pay
// for (ties: the lower id), never past the rest; a refusal cools down. Reads the judge's fogged view only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { researchDecision, decideNext, noteOutcome, createResidentMemory, RESEARCH_MIN_SCIENCE } from '../src/frontier/local-play-operator-policy.mjs';
import * as J from '../src/frontier/world-research.mjs';
import { decodeResearchWorld, decodeNationResearch } from '../../permutation-server/web/frontier/flocalplay-research.mjs';
import { worldBytes, nationBytes } from './research-fixtures.mjs';

const ME = 2;
const viewFor = (mine = {}) => {
  const world = decodeResearchWorld(worldBytes({ startBell: 1 }));
  const nations = Array.from({ length: 6 }, (_, f) => decodeNationResearch(nationBytes(f, f === ME ? mine : {})));
  return J.viewOf(world, nations, ME);
};
const resident = (mask = null) => ({ joined: true, faction: ME, holding: Object.defineProperty({ p: 1, q: 0, site: 3, tile: 5 }, 'researchMask', { value: mask, enumerable: false }), wide: 0 });
const H = { p: 1, q: 0, site: 3 };

test('the least left to pay first, then the lower id; never past the rest; at least 10 science', () => {
  const m = createResidentMemory(0, ME);
  const v = viewFor({ pledged: { 2: 290, 1: 100 } });
  const d = researchDecision(m, resident(), { view: v, science: 50 }, H);
  assert.equal(d.name, 'ResearchPledge');
  assert.deepEqual(d.fields, { tech: 2, amount: 10 }, 'bronze has 10 left: only 10 is sent');
  assert.equal(researchDecision(m, resident(), { view: v, science: RESEARCH_MIN_SCIENCE - 1 }, H), null);
  const fresh = researchDecision(m, resident(), { view: viewFor(), science: 40 }, H);
  assert.deepEqual(fresh.fields, { tech: 0, amount: 40 }, 'all equal: the lowest id');
  assert.deepEqual(fresh.v, { holding: H, nation: ME });
});

test('the effects first: a tech the nation knows that the village lacks is applied before any pledge', () => {
  const m = createResidentMemory(0, ME);
  const v = viewFor({ learned: { 1: 9 } });
  assert.equal(researchDecision(m, resident({ techs: 0, nation: null, rebased: false }), { view: v, science: 99 }, H).name, 'ResearchApply');
  assert.equal(researchDecision(m, resident({ techs: 0b10, nation: ME, rebased: true }), { view: v, science: 99 }, H).name, 'ResearchPledge');
  // a captured village's mask (another nation's) counts as nothing
  assert.equal(researchDecision(m, resident({ techs: 0b10, nation: 4, rebased: true }), { view: v, science: 99 }, H).name, 'ResearchApply');
});

test('a refusal cools the research order down; decideNext asks research after the war step and before the rotation', () => {
  const m = createResidentMemory(0, ME);
  const d = researchDecision(m, resident(), { view: viewFor(), science: 40 }, H);
  noteOutcome(m, d, 'refused', { programCode: 21 });
  assert.equal(researchDecision(m, resident(), { view: viewFor(), science: 40 }, H), null);
  const m2 = createResidentMemory(0, ME);
  const n = decideNext(m2, resident(), { homes: [], research: { view: viewFor(), science: 40 } });
  assert.equal(n.name, 'ResearchPledge');
  // no research view (no judge, or research not started): the old rotation, untouched
  assert.notEqual(decideNext(createResidentMemory(0, ME), resident(), { homes: [] }).name, 'ResearchPledge');
});

test('paused or nothing open: nothing asked', () => {
  const m = createResidentMemory(0, ME);
  assert.equal(researchDecision(m, resident(), { view: { ...viewFor(), paused: true }, science: 40 }, H), null);
  const all = viewFor({ learned: { 0: 2, 1: 3, 2: 4, 3: 5 } });
  assert.equal(researchDecision(m, resident({ techs: 0b1111, nation: ME, rebased: true }), { view: all, science: 40 }, H), null);
});

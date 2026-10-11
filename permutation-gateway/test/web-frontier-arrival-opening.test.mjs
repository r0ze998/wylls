import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { factsOf, onboardingState, ARRIVAL_STEPS, FLAG } from '../../permutation-server/web/frontier/onboarding.mjs';
import { objectiveModel, render } from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { tabs } from '../../permutation-server/web/frontier/screens/shell.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { trainCost, maxTrain, buildOffers } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { trainDraft } from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const home = { p: 2, q: 0, site: 1, gen: 0, tile: 20, state: 2, tier: 0, flags: 2, faction: 0, production: baseProduction(0), reserve: Array(8).fill(0), queue: [], transit: [] };
const armyId = hostId({ ...home, seq: 1 });
const army = { id: armyId, unit: 0, state: 1, faction: 0, tile: 20, troops: 200000, readyBell: 10, staminaValue: 120, staminaBell: 10, pendOp: 0, fromBell: 10 };
const world = (h = home, entries = [], extra = {}) => ({
  mode: 'play', sample: { territory: { mode: 'arrival-control', authority: 'local-preview' } },
  season: { programVersion: 2 }, citizen: { faction: 0, explores: 0, arrivals: 0 }, holdings: [h], land: { stage: 'final' },
  provinces: new Map([['2,0', { province: { p: 2, q: 0, entries, resolvedNext: 10 } }]]),
  nowBell: 10, chain: { now: () => 1000 }, ui: { dismissed: [] }, ...extra,
});
const built = () => ({ ...home, flags: 0, production: baseProduction(0).map((v, i) => i === 0 ? v + 12000n : v) });
const stage = fs => onboardingState(factsOf(fs));

test('arrival opening follows build, resources, army, move and own capture without requiring scouts or practice', () => {
  assert.deepEqual(stage(world()).steps.map(x => x.id), ARRIVAL_STEPS);
  assert.equal(stage(world()).current, 'build');
  assert.equal(stage(world(built())).current, 'train');
  const reserve = Array(8).fill(0); reserve[0] = 200;
  assert.equal(stage(world({ ...built(), reserve })).current, 'muster');
  assert.equal(stage(world(built(), [army])).current, 'march');
  const moving = world({ ...built(), transit: [{ state: 1 }] });
  assert.equal(stage(moving).current, 'claim');
  moving.provinces.get('2,0').sampleTerritory = { history: [{ tile: 19, to: 0, reason: 'arrival', hostId: String(armyId) }], changes: [] };
  assert.equal(stage(moving).complete, true);
  assert.match(String(render(moving)), /最初の領土を確保しました/);
});

test('starting territory and a nation mate capture never complete this player’s opening', () => {
  const fs = world({ ...built(), transit: [{ state: 1 }] });
  const env = fs.provinces.get('2,0');
  env.sampleTerritory = { owners: Array(61).fill(0), history: [], changes: [] };
  assert.equal(stage(fs).current, 'claim');
  env.sampleTerritory.history = [{ tile: 19, to: 0, reason: 'arrival', hostId: String(hostId({ ...home, site: 2, seq: 1 })) }];
  assert.equal(stage(fs).current, 'claim');
  env.sampleTerritory.history[0].hostId = String(armyId);
  env.sampleTerritory.history[0].to = 1;
  assert.equal(stage(fs).current, 'claim');
  env.sampleTerritory.history[0].to = 0;
  env.sampleTerritory.history[0].hostId = 'invalid';
  assert.equal(stage(fs).current, 'claim');
});

test('skipping the opening never announces a capture that did not happen', () => {
  const fs = world();
  fs.ui.dismissed = ARRIVAL_STEPS.map(FLAG.skip);
  assert.equal(onboardingState(factsOf(fs), fs.ui.dismissed).complete, true);
  assert.doesNotMatch(String(render(fs)), /最初の領土を確保しました/);
  assert.match(String(render(fs)), /はじめ|完了/);
});

test('the next action opens the correct village hand and formation waits before composing a march', () => {
  const duringBuild = world({ ...home, queue: [{ kind: 1, arg: 0, delta: 12000n, doneAt: 1060 }] });
  assert.equal(stage(duringBuild).current, 'build');
  assert.equal(guideTarget(duringBuild).kind, 'train');
  assert.equal(objectiveModel(duringBuild).go.act, 'ob-go');
  assert.equal(guideTarget(world(built())).kind, 'train');
  const reserve = Array(8).fill(0); reserve[0] = 200;
  assert.equal(guideTarget(world({ ...built(), reserve })).kind, 'muster');
  const forming = objectiveModel(world(built(), [{ ...army, state: 2, fromBell: 11, readyBell: 11 }]));
  assert.deepEqual(forming.go.data, { tab: 'hosts' });
  const ready = objectiveModel(world(built(), [army]));
  assert.deepEqual(ready.go, { act: 'compose', data: { host: String(armyId), stay: 'map' }, label: '移動する土地を選ぶ' });
  assert.ok(tabs(world()).some(x => x.id === 'territory'));
  assert.ok(!tabs({ ...world(), sample: null }).some(x => x.id === 'territory'));
});

test('first construction and horse training quotes agree with the selected rules in the village hand', () => {
  const offers = buildOffers(home, { now: 1000, have: Array(8).fill(2000) });
  assert.equal(offers[0].secs, 60); assert.equal(offers[6].secs, 14400);
  assert.equal(buildOffers({ ...home, flags: 0 })[0].secs, 5400);
  assert.deepEqual(trainCost(2, 200, 1), [120, 0, 0, 60, 0, 30, 0, 0]);
  assert.deepEqual(trainCost(2, 200, 3), [120, 0, 0, 40, 0, 20, 0, 0]);
  const have = [120, 0, 0, 40, 0, 20, 0, 0];
  assert.equal(maxTrain(2, have, 1), 100); assert.equal(maxTrain(2, have, 3), 200);
  assert.equal(trainDraft({ season: { programVersion: 3 }, hand: { unit: 2, n: 200 } }, { m: { have } }).n, 200);
});

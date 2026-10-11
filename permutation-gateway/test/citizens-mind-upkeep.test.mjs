// integ-A review: the call site of AC2's memory rules (trust decay, the daily reset of the model's trust cap, goal progress).
// Real ledger, real persona library, real goal functions; the situation is the brain's (hosts, home, own_marches).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../citizens/memory/store.mjs';
import { createUpkeep, factsFor, REQUIRES } from '../citizens/mind/upkeep.mjs';
import { LIBRARY, personaOf } from '../citizens/persona/deal.mjs';
import { GOALS } from '../citizens/persona/goals.mjs';

const TAG = '0123456789abcdef';
const NEIGHBOUR = 'aaaaaaaaaaaaaaa1';
const entry = (persona, temperament) => ({ persona, creed_variant: 0, temperament: { aggression: 50, loyalty: 50, ambition: 50, honesty: 50, risk: 50, sociability: 50, grudge: 50, ...temperament } });

function setup(personaId = 'guardian', temperament = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-upkeep-'));
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const persona = personaOf(entry(personaId, temperament));
  const ledger = stores.ledger(TAG, { goals: persona.goals, bell: 100 });
  const own = { tag: TAG, faction: 2, persona, ledger, episodes: stores.episodes(TAG) };
  const doc = ledger.s;
  return { stores, own, doc, ledger };
}
const request = (bell, { walls = 300, hosts, troops = 800, dayStart = 1000, marches = [] } = {}) => ({
  situation: {
    bell,
    me: {
      faction: 2, home: { final: true, p: 1, q: 1, walls, tier: 'town' }, home_troops: troops, home_troops_day_start: dayStart,
      hosts: hosts ?? [{ unit: 'spearman', at: { p: 1, q: 1 }, in_transit: false, troops: 500 }, { unit: 'scout', at: { p: 1, q: 1 }, in_transit: false, troops: 100 }],
    },
  },
  own_marches: marches,
});

test('every goal key of the persona library has an entry in REQUIRES (no goal can be silently dropped from the table)', () => {
  const keys = LIBRARY.personas.flatMap((p) => p.goals.map((g) => g.key));
  for (const k of keys) assert.ok(k in REQUIRES, `REQUIRES lacks ${k}`);
  for (const k of Object.keys(REQUIRES)) assert.ok(k in GOALS, `${k} is not a goal function`);
});

test('the first step of a new game day decays trust by temperament and resets the day\'s model deltas; the same day does nothing', () => {
  const { own, doc, ledger } = setup('guardian', { grudge: 50, loyalty: 0 });
  const e = ledger._entry(NEIGHBOUR);
  Object.assign(e, { t_code: 30, t_model: -12, model_today: 15 });
  const up = createUpkeep({ roster: { byTag: () => ({ faction: 4 }) } });
  up.run({ own, doc, bell: 100, request: request(100) }); // day 0, the day the ledger was made
  assert.deepEqual([e.t_code, e.t_model, e.model_today], [30, -12, 15], 'same game day: no decay, no reset');
  up.run({ own, doc, bell: 150, request: request(150) }); // day 1
  // grudge 50: d = ceil((100 - 50) / 20) = 3 toward 0, for a citizen of another nation
  assert.deepEqual([e.t_code, e.t_model, e.model_today], [27, -9, 0]);
  up.run({ own, doc, bell: 151, request: request(151) });
  assert.deepEqual([e.t_code, e.t_model], [27, -9], 'once per day');
  // the cap works across days: +15 in day 1 is allowed again (it was reset)
  const out = ledger.applyModelDeltas([{ who: NEIGHBOUR, delta: 10 }, { who: NEIGHBOUR, delta: 10 }], { bell: 160 });
  assert.equal(out.reduce((s, x) => s + x.applied, 0), 15, 'at most +-15 per handle per game day');
  up.run({ own, doc, bell: 300, request: request(300) }); // day 2
  assert.equal(e.model_today, 0, 'a new day: the cap is back');
  assert.equal(e.t_model, -9 + 15 - 3);
});

test('a citizen of the AI\'s own nation decays more slowly by loyalty (max(1, d - floor(loyalty/34)))', () => {
  const { own, doc, ledger } = setup('guardian', { grudge: 0, loyalty: 100 });
  const mate = ledger._entry('bbbbbbbbbbbbbbb2');
  const other = ledger._entry(NEIGHBOUR);
  Object.assign(mate, { t_code: 20, t_model: 0 });
  Object.assign(other, { t_code: 20, t_model: 0 });
  const nation = { bbbbbbbbbbbbbbb2: 2, [NEIGHBOUR]: 5 };
  const up = createUpkeep({ roster: { byTag: (t) => ({ faction: nation[t] }) } });
  up.run({ own, doc, bell: 100, request: request(100) });
  up.run({ own, doc, bell: 244, request: request(244) });
  // grudge 0: d = 5; own nation: max(1, 5 - floor(100/34)=2) = 3
  assert.equal(other.t_code, 15);
  assert.equal(mate.t_code, 17);
});

test('goal progress is computed by code and is non-zero where its facts exist (guardian: walls, home floor, army at home per step, threats met)', () => {
  const { own, doc, ledger } = setup('guardian');
  const up = createUpkeep({ roster: { byTag: () => null } });
  const away = [{ unit: 'spearman', at: { p: 1, q: 1 }, in_transit: true, troops: 500 }];
  up.run({ own, doc, bell: 100, request: request(100, { walls: 300, troops: 300, dayStart: 1000 }) });
  up.run({ own, doc, bell: 101, request: request(101, { walls: 300, troops: 300, dayStart: 1000 }) });
  up.run({ own, doc, bell: 102, request: request(102, { walls: 300, troops: 300, dayStart: 1000, hosts: away }) });
  up.run({ own, doc, bell: 103, request: request(103, { walls: 300, troops: 300, dayStart: 1000 }) });
  const byId = Object.fromEntries(ledger.s.goals.map((g) => [g.id, g.progress]));
  assert.equal(byId.G1, 50, 'walls 300 of 600');
  assert.equal(byId.G2, 60, 'home troops 300 against half of the day-start 1000 (100 * 300 / 500)');
  assert.equal(byId.G3, 75, 'an army stood at home at 3 of 4 steps');
  assert.equal(byId.G4, 100, 'no remembered threat: nothing outstanding');
  assert.deepEqual(doc.upkeep.home_army_bells, [100, 101, 103]);
  // a remembered threat that arrived at bell 102 (army away) is a miss; one that arrived at 103 is met
  own.episodes.add([
    { v: 1, id: 't102', bell: 99, created_bell: 100, kind: 'threat', entities: [], text: { en: 'x', ja: 'x' }, importance: 5, src: [], facts: { arrive_bell: 102 } },
    { v: 1, id: 't103', bell: 99, created_bell: 100, kind: 'threat', entities: [], text: { en: 'y', ja: 'y' }, importance: 5, src: [], facts: { arrive_bell: 103 } },
  ]);
  up.run({ own, doc, bell: 104, request: request(104, { walls: 600, troops: 300, dayStart: 1000 }) });
  const after = Object.fromEntries(ledger.s.goals.map((g) => [g.id, g.progress]));
  assert.equal(after.G1, 100);
  assert.equal(after.G4, 50, 'one of two arrived threats met');
});

test('goals whose facts have no producer here are null ("not computed"), never a 0 that looks measured; the card and the memory block say so', () => {
  const { own, doc, ledger, stores } = setup('diplomat');
  const up = createUpkeep({ roster: { byTag: () => null } });
  up.run({ own, doc, bell: 100, request: request(100) });
  const goals = ledger.s.goals;
  const keys = Object.fromEntries(own.persona.goals.map((g) => [g.id, g.key]));
  for (const g of goals) {
    if (['talk_neighbours', 'move_option', 'build_three'].includes(keys[g.id])) assert.equal(g.progress, null, keys[g.id]);
  }
  assert.equal(goals.find((g) => keys[g.id] === 'trust_neighbours').progress, 100, 'computed from the ledger: no neighbour below zero');
  assert.ok(up.stats.not_computed >= 3 && up.stats.computed >= 1);
  // the renderers print "not computed", not "progress 0%" or "null%"
  const snap = ledger.snapshot();
  assert.equal(snap.goals.find((g) => keys[g.id] === 'talk_neighbours').progress, null);
});

test('conqueror: combat hosts, marches today (from the brain\'s marchbook) and camps cleared today feed G1 to G3', () => {
  const { own, doc, ledger } = setup('conqueror');
  const up = createUpkeep({ roster: { byTag: () => null } });
  const hosts = [{ unit: 'spearman', at: { p: 1, q: 1 }, in_transit: false, troops: 500 }, { unit: 'archer', at: { p: 1, q: 1 }, in_transit: false, troops: 300 }, { unit: 'scout', at: { p: 1, q: 1 }, in_transit: false, troops: 100 }];
  up.run({ own, doc, bell: 200, request: request(200, { hosts, marches: [{ host_id: 1, depart_bell: 150, arrive_bell: 160 }] }) }); // day 1 starts at 144
  const byKey = Object.fromEntries(own.persona.goals.map((g) => [g.key, ledger.s.goals.find((x) => x.id === g.id).progress]));
  assert.equal(byKey.two_armies, 100, 'two combat hosts (the scout does not count)');
  assert.equal(byKey.march_daily, 100, 'a march departed in bell 150, day 1');
  const f = factsFor({ me: request(200).situation.me, request: request(200, { marches: [{ depart_bell: 100 }] }), episodes: [], bell: 200, dayStart: { home_troops: 1000 }, log: {} });
  assert.equal(f.marches_today, 0, 'a march of day 0 is not today\'s');
});

test('a failure inside the upkeep never reaches the decision (it is counted, not thrown)', () => {
  const errors = [];
  const up = createUpkeep({ onError: (e) => errors.push(e) });
  assert.equal(up.run({ own: { ledger: { advanceDay() { throw new Error('boom'); } }, persona: { temperament: { grudge: 1 } }, tag: TAG }, doc: {}, bell: 10, request: request(10) }), null);
  assert.equal(up.stats.errors, 1);
  assert.equal(errors.length, 1);
  assert.equal(up.run({ own: {}, doc: {}, bell: 10, request: {} }), null, 'no ledger, no situation: nothing to do');
});

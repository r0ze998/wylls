// Goal progress (contract §2.2): every goal function, each memory-based (M) goal over the episodes or the ledger it reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY, personaOf } from '../citizens/persona/deal.mjs';
import { GOALS, allProgress, goalProgress } from '../citizens/persona/goals.mjs';
import { Ledger } from '../citizens/memory/ledger.mjs';
import { tagHex } from '../citizens/persona/names.mjs';

const ep = (kind, bell, facts = {}, entities = []) => ({ v: 1, id: `${kind}${bell}`, kind, bell, created_bell: bell + 1, importance: 5, entities, facts, text: { en: '', ja: '' }, src: [] });
const g = (key, input) => goalProgress(key, input);

test('every goal key of the library has a function and every function is used by a persona', () => {
  const keys = new Set(LIBRARY.personas.flatMap(p => p.goals.map(x => x.key)));
  assert.deepEqual([...keys].sort(), Object.keys(GOALS).sort());
});

test('conqueror: G1 two armies, G2 a march a day, G3 three camps (from the camp_cleared_own episodes), G4 (M) answer a camp taken first within 24 bells', () => {
  assert.deepEqual([0, 1, 2, 3].map(n => g('two_armies', { facts: { combat_hosts: n } })), [0, 50, 100, 100]);
  assert.equal(g('march_daily', { facts: { marches_today: 0 } }), 0);
  assert.equal(g('march_daily', { facts: { marches_today: 2 } }), 100);
  const cleared = n => Array.from({ length: n }, (_, i) => ep('camp_cleared_own', 10 + i));
  assert.deepEqual([0, 1, 2, 3, 4].map(n => g('clear_three_camps', { episodes: cleared(n) })), [0, 33, 67, 100, 100]);
  assert.equal(g('clear_three_camps', { facts: { camps_cleared: 2 }, episodes: [] }), 67);
  // G4 (M): a camp_taken_by at bell 100
  const taken = ep('camp_taken_by', 100, { nation: 2 });
  assert.equal(g('answer_camp_taken', { bellNow: 110, episodes: [taken] }), 100, 'pending (24 bells not over): nothing outstanding counted');
  assert.equal(g('answer_camp_taken', { bellNow: 130, episodes: [taken] }), 0, 'unanswered after 24 bells');
  assert.equal(g('answer_camp_taken', { bellNow: 130, episodes: [taken, ep('camp_cleared_own', 120)] }), 100, 'answered at bell 120');
  assert.equal(g('answer_camp_taken', { bellNow: 130, episodes: [taken, ep('camp_cleared_own', 124)] }), 100, 'answered at bell 124 (the last bell inside 24)');
  assert.equal(g('answer_camp_taken', { bellNow: 130, episodes: [taken, ep('camp_cleared_own', 125)] }), 0, 'bell 125 is 25 bells later: too late');
  assert.equal(g('answer_camp_taken', { bellNow: 140, episodes: [taken, ep('camp_cleared_own', 120), ep('camp_taken_by', 90, {})] }), 50, 'a clear at 120 answers the memory of bell 100 (window 100..124) but not the one of bell 90 (window 90..114)');
  assert.equal(g('answer_camp_taken', { bellNow: 130, episodes: [taken, ep('camp_cleared_own', 99)] }), 0, 'a clear BEFORE the memory does not answer it');
});

test('guardian: G1 walls, G2 half the day-start troops, G3 an army home every bell, G4 (M) meet each threat', () => {
  assert.deepEqual([0, 300, 600, 900].map(w => g('walls_600', { facts: { walls: w } })), [0, 50, 100, 100]);
  assert.equal(g('home_floor_half', { facts: { home_troops: 500, home_troops_day_start: 1000 } }), 100);
  assert.equal(g('home_floor_half', { facts: { home_troops: 250, home_troops_day_start: 1000 } }), 50);
  assert.equal(g('home_floor_half', { facts: { home_troops: 10, home_troops_day_start: 0 } }), 100);
  assert.equal(g('army_home_every_bell', { facts: { bells_with_army_home_today: 30, bells_elapsed_today: 40 } }), 75);
  assert.equal(g('army_home_every_bell', { facts: {} }), 100);
  const threat = a => ep('threat', 100, { arrive_bell: a, nation: 2 });
  assert.equal(g('meet_threats', { bellNow: 110, facts: { home_army_bells: [] }, episodes: [threat(120)] }), 100, 'not arrived yet: pending');
  assert.equal(g('meet_threats', { bellNow: 130, facts: { home_army_bells: [118, 120, 121] }, episodes: [threat(120)] }), 100, 'a combat army was home at the arrival bell');
  assert.equal(g('meet_threats', { bellNow: 130, facts: { home_army_bells: [118] }, episodes: [threat(120)] }), 0, 'nobody home at 120');
  assert.equal(g('meet_threats', { bellNow: 130, facts: { home_army_bells: [120] }, episodes: [threat(120), threat(125)] }), 50);
});

test('diplomat: G1 two talks, G2 a motion a period, G3 (M) trust >= 0 with neighbours it holds no grievance against, G4 three builds', () => {
  assert.deepEqual([0, 1, 2, 5].map(n => g('talk_neighbours', { facts: { neighbour_talks_today: n } })), [0, 50, 100, 100]);
  assert.equal(g('move_option', { facts: { motions_this_period: 1 } }), 100);
  assert.equal(g('move_option', { facts: {} }), 0);
  assert.deepEqual([0, 1, 2, 3, 4].map(n => g('build_three', { facts: { builds_today: n } })), [0, 33, 67, 100, 100]);
  // G3 (M) reads the ledger
  const led = Ledger.create({ tag: tagHex(1n), goals: [] });
  const [a, b, c, d] = [tagHex(11n), tagHex(12n), tagHex(13n), tagHex(14n)];
  led.apply({ id: 't1', kind: 'trust', who: a, part: 'code', amount: 10, bell: 1 });
  led.apply({ id: 't2', kind: 'trust', who: b, part: 'code', amount: -20, bell: 1 });
  led.apply({ id: 't3', kind: 'trust', who: c, part: 'code', amount: -15, bell: 1 });
  led.apply({ id: 't4', kind: 'trust', who: d, part: 'code', amount: -5, bell: 1 });
  // c has an open grievance against it: it is not considered; d's trust is negative, b's negative, a's positive
  led.apply({ id: 'gr1', kind: 'grievance', against: c, nation: 2, event: 'e1', bell: 5, weight: 8 });
  assert.equal(g('trust_neighbours', { ledger: led.snapshot() }), 33, 'considered a, b, d: only a is >= 0');
  led.apply({ id: 'm', kind: 'trust', who: b, part: 'code', amount: 20, bell: 2 });
  led.apply({ id: 'm2', kind: 'trust', who: d, part: 'code', amount: 5, bell: 2 });
  assert.equal(g('trust_neighbours', { ledger: led.snapshot() }), 100);
  assert.equal(g('trust_neighbours', { ledger: led.snapshot(), facts: { neighbour_tags: [a, c] } }), 100, 'c is excluded (open grievance), a is fine');
  assert.equal(g('trust_neighbours', { ledger: Ledger.create({ tag: tagHex(1n) }).snapshot() }), 100, 'no neighbours known: nothing outstanding');
});

test('avenger: G1 (M) answered within 12 bells, G2 half the troops home, G3 (M) a council option aimed at a grievance nation, G4 two armies', () => {
  const led = Ledger.create({ tag: tagHex(1n) });
  const w = tagHex(9n);
  led.apply({ id: 'gA', kind: 'grievance', against: w, nation: 2, event: 'e1', bell: 100, weight: 8 });
  assert.equal(g('answer_grievances', { bellNow: 105, ledger: led.snapshot() }), 100, 'open inside its 12 bells: pending');
  assert.equal(g('answer_grievances', { bellNow: 120, ledger: led.snapshot() }), 0, 'open after 12 bells: failed');
  led.apply({ kind: 'answered', id: 'a1', grievance: 'gA', bell: 108 });
  assert.equal(g('answer_grievances', { bellNow: 120, ledger: led.snapshot() }), 100, 'answered at 108 (8 bells later)');
  led.apply({ id: 'gB', kind: 'grievance', against: tagHex(8n), nation: 3, event: 'e2', bell: 130, weight: 8 });
  led.apply({ kind: 'answered', id: 'a2', grievance: 'gB', bell: 150 });
  assert.equal(g('answer_grievances', { bellNow: 160, ledger: led.snapshot() }), 50, 'gB answered 20 bells later: too late');
  // G3 (M)
  const open = Ledger.create({ tag: tagHex(1n) });
  open.apply({ id: 'gC', kind: 'grievance', against: w, nation: 2, event: 'e3', bell: 10, weight: 8 });
  assert.equal(g('move_grievance_option', { ledger: open.snapshot(), facts: { motion_target_nations: [2] } }), 100);
  assert.equal(g('move_grievance_option', { ledger: open.snapshot(), facts: { motion_target_nations: [4] } }), 0);
  assert.equal(g('move_grievance_option', { ledger: open.snapshot(), facts: {} }), 0);
  assert.equal(g('move_grievance_option', { ledger: Ledger.create({ tag: tagHex(1n) }).snapshot(), facts: {} }), 100, 'no open grievance');
  assert.equal(g('home_half', { facts: { home_troops: 300, home_troops_day_start: 1000 } }), 60);
  assert.equal(g('two_armies', { facts: { combat_hosts: 2 } }), 100);
});

test('founder: G1 tier-up and three buildings, G2 explore daily, G3 Town, G4 (M) recover from a loss within 24 bells', () => {
  assert.equal(g('tier_up_three_builds', { facts: { tier: 0, buildings: 0 } }), 0);
  assert.equal(g('tier_up_three_builds', { facts: { tier: 1, buildings: 0 } }), 50);
  assert.equal(g('tier_up_three_builds', { facts: { tier: 0, buildings: 3 } }), 50);
  assert.equal(g('tier_up_three_builds', { facts: { tier: 2, buildings: 4 } }), 100);
  assert.equal(g('explore_daily', { facts: { explores_today: 1 } }), 100);
  assert.equal(g('explore_daily', { facts: {} }), 0);
  assert.equal(g('reach_town', { facts: { tier: 0 } }), 0);
  assert.equal(g('reach_town', { facts: { tier: 1 } }), 100);
  const loss = ep('attacked_own', 200, { lost: 100 });
  const series = (...pts) => ({ home_troops_series: pts });
  assert.equal(g('recover_from_loss', { bellNow: 210, facts: series([199, 1000], [201, 600]), episodes: [loss] }), 100, 'pending');
  assert.equal(g('recover_from_loss', { bellNow: 230, facts: series([199, 1000], [201, 600], [215, 1000]), episodes: [loss] }), 100, 'back to the earlier level at 215');
  assert.equal(g('recover_from_loss', { bellNow: 230, facts: series([199, 1000], [201, 600], [215, 900]), episodes: [loss] }), 0, 'only 900 of 1000 within 24 bells');
  assert.equal(g('recover_from_loss', { bellNow: 230, facts: series([199, 1000], [215, 1000]), episodes: [loss, ep('clash_own_loss', 205), ep('clash_own_win', 206)] }), 100);
  assert.equal(g('recover_from_loss', { bellNow: 300, facts: series([199, 1000], [201, 600], [226, 1000]), episodes: [loss] }), 0, 'recovered at 226 > 200 + 24');
});

test('opportunist: G1 two camps a day, G2 (M) strike the nation that has just moved, G3 weak stacks, G4 three builds', () => {
  assert.deepEqual([0, 1, 2, 3].map(n => g('clear_two_camps_daily', { facts: { camps_cleared_today: n } })), [0, 50, 100, 100]);
  const threat = ep('threat', 100, { nation: 2, arrive_bell: 108 });
  const taken = ep('camp_taken_by', 120, { nation: 4 });
  const field = (bell, nation) => ({ bell, kind: 'field', nation });
  assert.equal(g('strike_the_mover', { bellNow: 105, facts: {}, episodes: [threat] }), 100, 'pending');
  assert.equal(g('strike_the_mover', { bellNow: 120, facts: { own_marches: [] }, episodes: [threat] }), 0);
  assert.equal(g('strike_the_mover', { bellNow: 120, facts: { own_marches: [field(105, 2)] }, episodes: [threat] }), 100);
  assert.equal(g('strike_the_mover', { bellNow: 120, facts: { own_marches: [field(105, 3)] }, episodes: [threat] }), 0, 'another nation');
  assert.equal(g('strike_the_mover', { bellNow: 120, facts: { own_marches: [{ bell: 105, kind: 'camp', nation: 2 }] }, episodes: [threat] }), 0, 'a camp is not an open-field stack');
  assert.equal(g('strike_the_mover', { bellNow: 140, facts: { own_marches: [field(105, 2)] }, episodes: [threat, taken] }), 50);
  assert.equal(g('raid_weak_stacks', { facts: { own_marches: [{ kind: 'field', ratio: 'favourable', bell: 1 }] } }), 100);
  assert.equal(g('raid_weak_stacks', { facts: { own_marches: [{ kind: 'field', ratio: 'even', bell: 1 }] } }), 0);
  assert.equal(g('build_three', { facts: { builds_today: 3 } }), 100);
});

test('allProgress returns G1..G4 for every persona, always integers in 0..100, with empty input', () => {
  for (const p of LIBRARY.personas) {
    const progress = allProgress(personaOf({ persona: p.id, creed_variant: 0, temperament: p.temperament }), {});
    assert.deepEqual(Object.keys(progress), ['G1', 'G2', 'G3', 'G4']);
    for (const v of Object.values(progress)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, `${p.id}: ${v}`);
  }
  assert.throws(() => goalProgress('nope', {}));
});

test('redacted episodes are ignored by the memory goals', () => {
  const taken = { ...ep('camp_taken_by', 100, { nation: 2 }), redacted: true };
  assert.equal(g('answer_camp_taken', { bellNow: 200, episodes: [taken] }), 100);
});

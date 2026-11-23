// TEST-ONLY operator AI residents and the world's goals (flag-keeps-ai, design §10 F4): the fogged flag sight, the
// target weights, and chooseMarch with them. Pure: no process, no port, no network, no key, no launcher import (CI-able).
import test from 'node:test';
import assert from 'node:assert/strict';
import { flagSight, closeRivals, flagWeights, flagMarches, readGoals, STOP_RIVAL_BONUS, FLAG_BONUS, FLAG_MARCH_CAP, STOP_RIVAL_CAP } from '../src/frontier/local-play-operator-goals.mjs';
import { chooseMarch, strengthScore, warStep } from '../src/frontier/local-play-operator-war.mjs';
import { decideNext, createResidentMemory } from '../src/frontier/local-play-operator-policy.mjs';

// A judge's answer (local-play-world-goals.mjs answerOf shape): 6 flags, one per nation, need 3 — the local world's.
const answerOf = ({ flags, progress, need = 3 }) => ({ ok: true, v: 1, kind: 'world-goals', ruleset: 'flag-keeps-v1', bell: 100,
  flagKeeps: { round: 1, postedBell: 10, need, holdBells: 144, flags, progress } });
const F = (p, q, nation, holder = nation, extra = {}) => ({ p, q, nation, holder, since: 5, from: 10, longAt: 154, contender: null, progress: 0, required: 0, ...extra });
const prog = held => held.map((h, nation) => ({ nation, held: h, heldLong: 0, need: 3, reachAt: null }));
const keep = (p, q, holder, extra = {}) => ({ p, q, tile: 30, holder, troops: 100, contender: 7, progress: 0, ...extra });
const seen = list => new Map(list.map(k => [`${k.p},${k.q}`, k]));

test('flagSight: only what the resident\'s fogged keeps show — the judge\'s live holders are never read', () => {
  const answer = answerOf({ flags: [F(1, 0, 0, 3, { contender: 2, progress: 9 }), F(0, 1, 1, 4), F(-1, 1, 2)], progress: prog([0, 0, 1, 1, 1, 0]) });
  const s = flagSight({ answer, faction: 1, seenKeeps: seen([keep(0, 1, 4), { ...keep(-1, 1, 5), fog: 'memory', contender: 2, progress: 30 }]) });
  assert.deepEqual(s.flags.map(f => [f.seen, f.holder, f.contender, f.progress]), [['never', null, null, 0], ['live', 4, null, 0], ['memory', 5, null, 0]],
    'never seen: nothing (not the answer\'s holder 3 or its siege); last-known: the remembered holder, no contest; live: as seen');
  assert.deepEqual(s.nations.map(x => x.held), [0, 0, 1, 1, 1, 0], 'every nation\'s count: public on the card');
  assert.equal('reachAt' in s.nations[0], false, 'another nation\'s timer is not on the card: not read');
  assert.equal(flagSight({ answer: { ...answer, flagKeeps: null }, faction: 1, seenKeeps: new Map() }), null);
  assert.equal(flagSight({ answer: null, faction: 1, seenKeeps: new Map() }), null);
});

test('closeRivals: a nation holding need − 1 or more flag keeps (never the resident\'s own)', () => {
  const s = n => flagSight({ answer: answerOf({ flags: [], progress: prog(n) }), faction: 0, seenKeeps: new Map() });
  assert.deepEqual([...closeRivals(s([1, 1, 1, 1, 1, 1]), 0)], [], 'the local start: each nation its own flag, need 3');
  assert.deepEqual([...closeRivals(s([2, 1, 2, 3, 0, 1]), 0)], [2, 3]);
  assert.deepEqual([...closeRivals(s([3, 0, 0, 0, 0, 0]), 0)], [], 'its own nation is not a rival');
});

test('flagWeights: defend own flag under siege, stop the close rival, a small bonus otherwise; never-seen flags weigh nothing', () => {
  const flags = [F(1, 0, 0), F(0, 1, 1), F(-1, 1, 2), F(-1, 0, 3), F(0, -1, 4), F(1, -1, 5)];
  const answer = answerOf({ flags, progress: prog([1, 0, 2, 1, 1, 1]) });
  const sk = seen([keep(1, 0, 0, { contender: 1, progress: 12 }), keep(-1, 1, 2), keep(-1, 0, 3), keep(0, 1, 2)]);
  const w = flagWeights(flagSight({ answer, faction: 0, seenKeeps: sk }), 0);
  assert.deepEqual(Object.fromEntries([...w].map(([k, v]) => [k, v.goal])), { '1,0': 'defend-flag', '0,1': 'stop-rival', '-1,1': 'stop-rival', '-1,0': 'flag' },
    'nation 2 holds 2 (need 3): its flags are stop-rival; nation 3\'s is a plain flag; (0,-1) and (1,-1) never seen');
  assert.equal(w.get('0,1').bonus, STOP_RIVAL_BONUS);
  assert.equal(w.get('-1,0').bonus, FLAG_BONUS);
  const one = flagWeights(flagSight({ answer, faction: 0, seenKeeps: sk }), 0, { busy: FLAG_MARCH_CAP });
  assert.deepEqual(Object.fromEntries([...one].map(([k, v]) => [k, v.goal])), { '1,0': 'defend-flag', '0,1': 'stop-rival', '-1,1': 'stop-rival' },
    'anti all-in: one flag march already — no plain flag bonus, but a close rival still draws a second host (live ×60: a shared cap of 1 silenced it)');
  const two = flagWeights(flagSight({ answer, faction: 0, seenKeeps: sk }), 0, { busy: STOP_RIVAL_CAP });
  assert.deepEqual([...two.keys()], ['1,0'], 'two flag marches already: defence only');
  assert.equal(flagWeights(null, 0).size, 0);
});

const row = (p, q, troops, secs, extra = {}) => ({ p, q, tile: 30, holder: 2, troops, route: { hexes: 5, provinces: 2, secs }, origin: { p: 0, q: 3, tile: 5, host: '7', troops: 450 }, ...extra });
const W = obj => new Map(Object.entries(obj).map(([k, goal]) => [k, { goal, bonus: goal === 'stop-rival' ? STOP_RIVAL_BONUS : goal === 'flag' ? FLAG_BONUS : 0 }]));

test('chooseMarch with weights: defend-flag first, stop-rival over a stronger ordinary attack, never a weak march', () => {
  const ordinaryDefend = row(2, 2, 100, 100, { defend: true }), flagDefend = row(3, 3, 100, 900, { defend: true });
  const d = chooseMarch([ordinaryDefend, flagDefend], { weights: W({ '3,3': 'defend-flag' }) });
  assert.deepEqual([d.kind, d.goal, d.row.p], ['defend', 'defend-flag', 3], 'a flag under siege before a nearer ordinary keep');
  assert.equal(chooseMarch([ordinaryDefend, flagDefend]).row.p, 2, 'without weights: as before (nearest)');
  const easy = row(1, 1, 10, 100), rivalFlag = row(4, 4, 250, 800);   // 450 vs 10: score 20; 450 vs 250: 180 % → 4
  const a = chooseMarch([easy, rivalFlag], { weights: W({ '4,4': 'stop-rival' }) });
  assert.deepEqual([a.kind, a.goal, a.row.p, a.score], ['attack', 'stop-rival', 4, strengthScore(450, 250) + STOP_RIVAL_BONUS]);
  const tooStrong = row(5, 5, 400, 100);   // 450 < 1.5 × 400
  assert.equal(chooseMarch([tooStrong], { weights: W({ '5,5': 'stop-rival' }) }), null, 'the 1.5× safety is never weighted away');
  assert.equal(chooseMarch([easy, rivalFlag]).row.p, 1, 'without weights: the ordinary best');
});

test('chooseMarch with weights: the flag bonus only breaks near ties — ordinary war still wins on strength', () => {
  const weakish = row(1, 1, 300, 100), flag = row(2, 2, 300, 900);   // both 150 % → 4
  assert.equal(chooseMarch([weakish, flag], { weights: W({ '2,2': 'flag' }) }).row.p, 2, 'same step: the flag, though farther');
  const strong = row(3, 3, 200, 900);   // 225 % → 10 > 4 + 3
  const c = chooseMarch([strong, flag], { weights: W({ '2,2': 'flag' }) });
  assert.deepEqual([c.row.p, c.goal], [3, undefined], 'a clearly better ordinary attack beats a plain flag');
  const all = [weakish, flag, strong, row(4, 4, 10, 50)], w = W({ '2,2': 'flag', '4,4': 'stop-rival' });
  assert.deepEqual(chooseMarch(all, { weights: w }), chooseMarch([...all].reverse(), { weights: w }), 'deterministic in any order');
  assert.deepEqual(chooseMarch([flag], { weights: W({ '2,2': 'defend-flag' }) }).goal, undefined, 'a defend weight never boosts an attack row');
});

test('the goal rides through warStep and decideNext into the Depart decision', () => {
  const march = chooseMarch([row(4, 4, 10, 100)], { weights: W({ '4,4': 'stop-rival' }) });
  assert.equal(warStep({ march, reserve: 0, hostCount: 1 }).goal, 'stop-rival');
  const m = createResidentMemory(0, undefined, { war: true });
  const d = decideNext(m, { joined: true, faction: 1, holding: { p: 0, q: 3, site: 0, tile: 5 } }, { homes: [], war: { nowBell: 50, march, reserve: 0, hostCount: 1 } });
  assert.deepEqual([d.name, d.goal], ['Depart', 'stop-rival']);
  assert.match(d.why, /^stop-rival — attack/);
  const plain = decideNext(m, { joined: true, faction: 1, holding: { p: 0, q: 3, site: 0, tile: 5 } }, { homes: [], war: { nowBell: 50, march: chooseMarch([row(4, 4, 10, 100)]), reserve: 0, hostCount: 1 } });
  assert.equal(plain.goal, undefined);
});

test('flagMarches counts only live targets on posted flags', () => {
  const s = flagSight({ answer: answerOf({ flags: [F(1, 0, 0), F(0, 1, 1)], progress: prog([1, 1, 0, 0, 0, 0]) }), faction: 2, seenKeeps: new Map() });
  assert.equal(flagMarches({ '1,0': 120, '0,1': 90, '5,5': 200 }, s, 100), 1);
  assert.equal(flagMarches(undefined, s, 100), 0);
});

test('readGoals: loopback only, the judge\'s kind only, null on anything else', async () => {
  const ok = { ok: true, kind: 'world-goals', flagKeeps: null };
  const f = body => async () => ({ ok: true, json: async () => body });
  assert.deepEqual(await readGoals('http://127.0.0.1:41700/goals-world/41705/goals/state', { fetch: f(ok) }), ok);
  assert.equal(await readGoals('http://127.0.0.1:41700/goals-world/41705/goals/state', { fetch: f({ ok: true, kind: 'other' }) }), null);
  assert.equal(await readGoals('http://10.0.0.1:41700/goals-world/41705/goals/state', { fetch: f(ok) }), null);
  assert.equal(await readGoals('http://127.0.0.1:41700/goals-world/41705/goals/state', { fetch: async () => { throw new Error('down'); } }), null);
});

// (a deterministic measure of "no all-in": seeded scenarios of reachable keeps, one of them a plain flag; how often the
//  weighted choice differs from the ordinary one)
test('measure: a plain flag bonus changes few ordinary choices; a close rival draws the march when it is in reach', () => {
  let s = 0x9e3779b9;
  const rnd = n => { s = (s * 1103515245 + 12345) >>> 0; return s % n; };
  let changedPlain = 0, rivalChosen = 0, rivalPossible = 0;
  const N = 500;
  for (let i = 0; i < N; i++) {
    const rows = Array.from({ length: 2 + rnd(4) }, (_, j) => row(j, i % 7, 20 + rnd(400), 100 + rnd(900)));
    const flag = rows[rnd(rows.length)];
    const base = chooseMarch(rows), plain = chooseMarch(rows, { weights: W({ [`${flag.p},${flag.q}`]: 'flag' }) });
    if (base?.row !== plain?.row) changedPlain++;
    const rival = chooseMarch(rows, { weights: W({ [`${flag.p},${flag.q}`]: 'stop-rival' }) });
    if (flag.troops * 3 <= 450 * 2) { rivalPossible++; if (rival?.row === flag) rivalChosen++; }
  }
  assert.ok(changedPlain / N < 0.25, `plain flag bonus changed ${changedPlain}/${N} choices`);
  assert.equal(rivalChosen, rivalPossible, 'a close rival\'s flag in reach and beatable is always the march');
});

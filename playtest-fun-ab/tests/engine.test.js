// Automated checks of the prototype. Run: node --test tests/
// These check rules, determinism and measurement. They say nothing about
// whether the game is fun; only people can tell us that.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../proto/engine.js');
const B = require('../proto/bots.js');
const M = require('../proto/metrics.js');

const MILLI = E.MILLI;

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
function totalTroops(s) {
  let t = 0;
  for (const n of s.nations) {
    t += n.garrison;
    for (const u of E.UNIT_KEYS) t += n.reserve[u];
  }
  for (const h of s.hosts) t += h.troops;
  for (const k of s.keeps) t += k.troops;
  return t;
}
function died(s) { return s.nations.reduce((a, n) => a + n.stats.died, 0); }
function trained(s) { return s.nations.reduce((a, n) => a + n.stats.trained, 0) * MILLI; }

// A random player: tries random actions, legal or not (the engine must
// refuse the illegal ones without changing anything).
function randomActions(s, r) {
  const acts = [];
  const k = Math.floor(r() * 5);
  for (let i = 0; i < k; i++) {
    const p = r();
    const mine = s.hosts.filter(h => h.owner === 0);
    if (p < 0.2) acts.push({ type: 'build', kind: ['farm', 'lumber', 'quarry', 'mine', 'mint', 'workshop', 'walls', 'tier'][Math.floor(r() * 8)] });
    else if (p < 0.45) acts.push({ type: 'train', unit: E.UNIT_KEYS[Math.floor(r() * 6)], troops: 100 * (1 + Math.floor(r() * 6)) });
    else if (p < 0.55) acts.push({ type: 'garrison', troops: 100 * (1 + Math.floor(r() * 3)) });
    else if (p < 0.7) acts.push({ type: 'muster', unit: E.UNIT_KEYS[Math.floor(r() * 6)], troops: 100 * (1 + Math.floor(r() * 8)) });
    else if (p < 0.92 && mine.length) acts.push({ type: 'depart', host: mine[Math.floor(r() * mine.length)].id, dest: Math.floor(r() * 12), rounds: 1 + Math.floor(r() * 3), retreat: [0, 0, 1, 1.5][Math.floor(r() * 4)] });
    else if (mine.length) acts.push({ type: 'dissolve', host: mine[Math.floor(r() * mine.length)].id });
  }
  return acts;
}

test('combat: the prototype matches the game\'s own resolve_engagement on 400 cases', () => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures-combat-oracle.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 400);
  let n = 0;
  for (const line of lines) {
    const c = JSON.parse(line);
    const a = { unit: c.a.unit, troops: c.a.troops, str: E.UNITS[c.a.unit].str, city: false };
    const d = c.d.city ? { unit: null, troops: c.d.troops, str: 10, city: true } : { unit: c.d.unit, troops: c.d.troops, str: E.UNITS[c.d.unit].str, city: false };
    const [toDef, toAtt] = E.engagement(a, d, { rough: c.rough, exhausted: c.exhausted, walls: c.walls }, c.va, c.vd);
    assert.equal(toDef, c.toDef, `toDef ${line}`);
    assert.equal(toAtt, c.toAtt, `toAtt ${line}`);
    n += 1;
  }
  assert.equal(n, 400);
});

test('determinism: the same seed and actions give the same game; a log replays to the same hashes', () => {
  const play = () => {
    const s = E.newGame({ variant: 'B', seed: 42, policies: [null, 'balanced', 'raider'] });
    const log = M.newLog({ variant: 'B', seed: 42, policies: [null, 'balanced', 'raider'] });
    const r = rng(9);
    while (!s.over) {
      const bots = B.decideAll(s);
      const t = { round: s.round, ms: 1000, actions: [] };
      for (const a of randomActions(s, r)) { const x = E.apply(s, 0, a); t.actions.push({ ms: 0, a, ok: x.ok, err: x.err || null }); }
      log.turns.push(t);
      E.advance(s, bots);
      log.hashes[t.round] = M.stateHash(s);
    }
    return { s, log };
  };
  const one = play();
  const two = play();
  assert.equal(M.stateHash(one.s), M.stateHash(two.s));
  const rep = M.replay(one.log);
  assert.ok(rep.ok, JSON.stringify(rep.mismatch));
  assert.equal(M.stateHash(rep.final), M.stateHash(one.s));
  // A tampered log is caught.
  const bad = JSON.parse(JSON.stringify(one.log));
  const t = bad.turns.find(x => x.actions.some(y => y.ok && y.a.type === 'train'));
  t.actions.find(y => y.ok && y.a.type === 'train').a.troops += 100;
  assert.equal(M.replay(bad).ok, false);
});

test('invariants hold over 120 random games (bounds, troop conservation, stamina, positions)', () => {
  const pols = ['turtle', 'balanced', 'raider'];
  for (let g = 0; g < 120; g++) {
    const r = rng(1000 + g);
    const variant = g % 2 ? 'B' : 'A';
    const s = E.newGame({ variant, seed: g, policies: [null, pols[g % 3], pols[(g + 1) % 3]] });
    const start = totalTroops(s);
    while (!s.over) {
      const bots = B.decideAll(s);
      for (const a of randomActions(s, r)) E.apply(s, 0, a);
      E.advance(s, bots);
      for (const n of s.nations) {
        const cap = E.TIERS[n.tier].cap;
        for (const k of E.RES) {
          assert.ok(n.res[k] >= 0, `negative ${k} game ${g}`);
          assert.ok(n.res[k] <= cap, `over cap ${k} game ${g}`);
        }
        for (const u of E.UNIT_KEYS) assert.ok(n.reserve[u] >= 0);
        assert.ok(n.garrison >= 0);
      }
      for (const h of s.hosts) {
        assert.ok(h.troops >= 500, 'a destroyed host was left on the map');
        assert.ok(h.stamina >= 0 && h.stamina <= E.STAMINA_CAP);
        assert.ok(h.transit ? h.loc === -1 : (h.loc >= 0 && h.loc < 12));
      }
      for (const k of s.keeps) assert.ok(k.holder >= 0 && k.holder < 3 && k.troops >= 0);
      assert.equal(totalTroops(s) + died(s), start + trained(s), `troops not conserved, game ${g} round ${s.round}`);
    }
    assert.ok(s.winner && s.winner.nations.length >= 1);
  }
});

test('keeps: an undefended keep falls after exactly 72 turns held; a defender arriving resets it', () => {
  const s = E.newGame({ variant: 'A', seed: 3, policies: [null, null, null] });
  s.nations[0].res = { food: 2000, wood: 2000, stone: 2000, ore: 2000, gold: 2000, arms: 0 };
  assert.ok(E.apply(s, 0, { type: 'train', unit: 'spear', troops: 1000 }).ok);
  assert.ok(E.apply(s, 0, { type: 'muster', unit: 'spear', troops: 1000 }).ok);
  const h = s.hosts[0];
  assert.ok(E.apply(s, 0, { type: 'depart', host: h.id, dest: 10, rounds: 1, retreat: 0 }).ok); // 丘の砦 (yellow)
  let capturedAt = null;
  for (let i = 0; i < 8 && capturedAt == null; i++) {
    const rep = E.advance(s, []);
    const e = rep.events.find(x => x.t === 'captured');
    if (e) capturedAt = rep.round;
  }
  // Arrives at turn 12 (round 2 in the UI); held from turn 12; the 72nd held turn is turn 83, in round index 6.
  assert.equal(capturedAt, 6);
  assert.equal(E.keepAt(s, 10).holder, 0);

  // A weak defender that loses the field does not stop the contest (the
  // contest reads who stands there after the clash); a strong one does.
  const setup = () => {
    const t = E.newGame({ variant: 'A', seed: 3, policies: [null, null, null] });
    for (const n of t.nations) n.res = { food: 2000, wood: 2000, stone: 2000, ore: 2000, gold: 2000, arms: 0 };
    E.apply(t, 0, { type: 'train', unit: 'spear', troops: 1000 });
    E.apply(t, 0, { type: 'muster', unit: 'spear', troops: 1000 });
    E.apply(t, 0, { type: 'depart', host: t.hosts[0].id, dest: 10, rounds: 1, retreat: 0 });
    E.advance(t, []); E.advance(t, []); // contest running
    assert.equal(E.keepAt(t, 10).contender, 0);
    assert.equal(E.keepAt(t, 10).progress, 12);
    return t;
  };
  const send = (t, troops) => {
    E.apply(t, 2, { type: 'train', unit: 'spear', troops });
    E.apply(t, 2, { type: 'muster', unit: 'spear', troops });
    E.apply(t, 2, { type: 'depart', host: t.hosts.find(x => x.owner === 2).id, dest: 10, rounds: 1, retreat: 0 });
    E.advance(t, []); // departs
    return E.advance(t, []); // arrives
  };
  const weak = setup();
  send(weak, 100);
  assert.equal(E.keepAt(weak, 10).progress, 36, 'a defender that lost the field did not reset it');
  const strong = setup();
  const rep = send(strong, 3000);
  assert.ok(rep.events.some(x => x.t === 'contest_broken' && x.node === 10), 'a defender holding the keep breaks the contest');
  assert.equal(E.keepAt(strong, 10).contender, -1);
  assert.equal(E.keepAt(strong, 10).progress, 0);
});

test('orders: the engine refuses what the rules forbid', () => {
  const s = E.newGame({ variant: 'A', seed: 1, policies: [null, null, null] });
  s.nations[0].res = { food: 2000, wood: 2000, stone: 2000, ore: 2000, gold: 2000, arms: 0 };
  assert.equal(E.apply(s, 0, { type: 'train', unit: 'spear', troops: 150 }).ok, false, 'multiples of 100');
  assert.equal(E.apply(s, 0, { type: 'train', unit: 'pike', troops: 100 }).ok, false, 'pikemen need arms');
  assert.ok(E.apply(s, 0, { type: 'train', unit: 'horse', troops: 500 }).ok);
  assert.equal(E.apply(s, 0, { type: 'garrison', troops: 100 }).ok, false, 'only spearmen garrison');
  assert.ok(E.apply(s, 0, { type: 'muster', unit: 'horse', troops: 500 }).ok);
  const h = s.hosts[0];
  assert.equal(E.apply(s, 0, { type: 'depart', host: h.id, dest: 6, rounds: 1 }).ok, false, '6 provinces is beyond reach');
  assert.equal(E.apply(s, 0, { type: 'depart', host: h.id, dest: 4, rounds: 1 }).ok, false, 'shielded villages');
  assert.equal(E.apply(s, 0, { type: 'depart', host: h.id, dest: 2, rounds: 7 }).ok, false, 'at most 72 turns ahead');
  assert.ok(E.apply(s, 0, { type: 'depart', host: h.id, dest: 2, rounds: 1 }).ok);
  assert.equal(h.stamina, E.STAMINA_CAP - E.DEPART_STAMINA);
  E.advance(s, []);
  assert.equal(E.apply(s, 0, { type: 'depart', host: h.id, dest: 1, rounds: 1 }).ok, false, 'not enough stamina');
  // Build slots and growing cost.
  const c1 = E.buildCost(s.nations[0], 'farm');
  assert.ok(E.apply(s, 0, { type: 'build', kind: 'farm' }).ok);
  const c2 = E.buildCost(s.nations[0], 'farm');
  assert.ok(c2.wood > c1.wood, 'the second farm costs more');
  assert.ok(E.apply(s, 0, { type: 'build', kind: 'farm' }).ok);
  assert.equal(E.apply(s, 0, { type: 'build', kind: 'farm' }).ok, false, 'a hamlet has 2 build slots');
});

test('current rules, reproduced on purpose: dissolve + muster skips the 74-stamina wait', () => {
  // permutation-frontier/src/proc/host.rs: Dissolve returns the troops to
  // the home reserve at the next settle, wherever the host stands;
  // permutation-rules/src/frontier/host.rs `Host::muster` gives a new host
  // full stamina. The prototype keeps both, in A and in B.
  const s = E.newGame({ variant: 'A', seed: 1, policies: [null, null, null] });
  s.nations[0].res = { food: 2000, wood: 2000, stone: 2000, ore: 2000, gold: 2000, arms: 0 };
  E.apply(s, 0, { type: 'train', unit: 'horse', troops: 500 });
  E.apply(s, 0, { type: 'muster', unit: 'horse', troops: 500 });
  const id = s.hosts[0].id;
  E.apply(s, 0, { type: 'depart', host: id, dest: 2, rounds: 1 });
  E.advance(s, []); E.advance(s, []);
  const h = s.hosts.find(x => x.id === id);
  assert.equal(h.loc, 2);
  assert.ok(h.stamina < E.DEPART_STAMINA, 'tired after one march');
  assert.ok(E.apply(s, 0, { type: 'dissolve', host: id }).ok);
  E.advance(s, []);
  assert.equal(s.nations[0].reserve.horse, 500 * MILLI, 'all troops are home, with no travel');
  assert.ok(E.apply(s, 0, { type: 'muster', unit: 'horse', troops: 500 }).ok);
  const fresh = s.hosts[s.hosts.length - 1];
  assert.equal(fresh.stamina, E.STAMINA_CAP);
  assert.ok(E.apply(s, 0, { type: 'depart', host: fresh.id, dest: 11, rounds: 1 }).ok, 'marches again at once');
});

test('retreat order: a host that meets more than r times its strength turns back without losses', () => {
  const s = E.newGame({ variant: 'A', seed: 1, policies: [null, null, null] });
  s.nations[0].res = { food: 2000, wood: 2000, stone: 2000, ore: 2000, gold: 2000, arms: 0 };
  E.apply(s, 0, { type: 'train', unit: 'spear', troops: 100 });
  E.apply(s, 0, { type: 'muster', unit: 'spear', troops: 100 });
  // Keep 10 has 100 troops at strength 10 = the same as the host: ratio 1 does not retreat, 0.5 does.
  E.apply(s, 0, { type: 'depart', host: s.hosts[0].id, dest: 10, rounds: 1, retreat: 0.5 });
  E.advance(s, []); // on the way
  const rep = E.advance(s, []);
  assert.ok(rep.events.some(e => e.t === 'home' && e.why === 'retreated'));
  assert.equal(s.nations[0].reserve.spear, 100 * MILLI);
});

test('A/B isolation: with no keep changing hands, versions A and B play out identically', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const run = v => {
      const s = E.newGame({ variant: v, seed, policies: ['turtle', 'turtle', 'turtle'] });
      while (!s.over) E.advance(s, B.decideAll(s));
      return s;
    };
    const a = run('A'); const b = run('B');
    assert.equal(a.reports.flatMap(r => r.events).filter(e => e.t === 'captured').length, 0);
    assert.equal(M.stateHash(a), M.stateHash(b), `seed ${seed}`);
  }
  // And production differs exactly by the keep share once keeps differ.
  const s = E.newGame({ variant: 'B', seed: 1, policies: [null, null, null] });
  const base = E.productionPerRound(s, 0);
  s.keeps.find(k => k.node === 1).holder = 1;
  const after = E.productionPerRound(s, 0);
  assert.equal(after.ore, Math.floor(base.ore * 2 / 3));
  assert.equal(after.gold, Math.floor(base.gold * 2 / 3));
  assert.equal(after.food, Math.floor(base.food * 2 / 3));
  assert.equal(after.wood, base.wood);
  assert.equal(after.stone, base.stone);
  const s2 = E.newGame({ variant: 'A', seed: 1, policies: [null, null, null] });
  const base2 = E.productionPerRound(s2, 0);
  s2.keeps.find(k => k.node === 1).holder = 1;
  assert.deepEqual(E.productionPerRound(s2, 0), base2, 'in A keeps do not change production');
});

test('bots do not see hidden destinations', () => {
  const s = E.newGame({ variant: 'A', seed: 5, policies: [null, 'balanced', 'raider'] });
  for (let i = 0; i < 6; i++) E.advance(s, B.decideAll(s));
  s.nations[0].res = { food: 2000, wood: 2000, stone: 2000, ore: 2000, gold: 2000, arms: 0 };
  E.apply(s, 0, { type: 'train', unit: 'spear', troops: 900 });
  E.apply(s, 0, { type: 'muster', unit: 'spear', troops: 900 });
  const id = s.hosts.find(h => h.owner === 0).id;
  const x = E.clone(s); const y = E.clone(s);
  E.apply(x, 0, { type: 'depart', host: id, dest: 2, rounds: 2 });
  E.apply(y, 0, { type: 'depart', host: id, dest: 10, rounds: 2 });
  assert.deepEqual(B.decideAll(x), B.decideAll(y));
});

test('trigger definition: only moves aimed at the player\'s own places count as threats', () => {
  const t = M.triggers({ events: [
    { t: 'departed', owner: 1 },
    { t: 'arrived', owner: 2, destHolder: 1 }, // an attack on red: not a threat to the player
    { t: 'contest', holder: 1, contender: 2 },
    { t: 'captured', by: 0, from: 2 }, // the player took a keep: not a threat
  ] });
  assert.deepEqual(t, { threat: [], departed: true });
  const u = M.triggers({ events: [
    { t: 'arrived', owner: 2, destHolder: 0 },
    { t: 'contest', holder: 0, contender: 2 },
    { t: 'captured', by: 1, from: 0 },
    { t: 'departed', owner: 0 }, // the player's own departure
  ] });
  assert.deepEqual(u, { threat: ['arrived_at_mine', 'contest_on_mine', 'keep_lost'], departed: false });
});

test('measures: counts match a scripted game whose threats are known in advance', () => {
  // The opponents are scripted here (not the bots), so the threat rounds are
  // known without using the measuring code: yellow sends 1,000 spearmen to
  // the player's keep 梅 (node 11) in round 0; they arrive and start taking
  // it in round 1, so round 2 is the only threat round. The player builds
  // in round 0, waits in round 1, answers in round 2 and waits in round 3.
  const script = {
    0: [[2, [{ type: 'train', unit: 'spear', troops: 1000 }, { type: 'muster', unit: 'spear', troops: 1000 }, { type: 'depart', host: 200001, dest: 11, rounds: 1, retreat: 0 }]]],
  };
  const real = B.decideAll;
  B.decideAll = s => script[s.round] || [];
  try {
    const pol = [null, null, null];
    const log = M.newLog({ variant: 'A', seed: 11, policies: pol });
    const s = E.newGame({ variant: 'A', seed: 11, policies: pol });
    s.nations[2].res.food = 2000; s.nations[2].res.ore = 2000; s.nations[2].res.gold = 2000;
    const plan = [
      [{ type: 'build', kind: 'farm' }, { type: 'train', unit: 'spear', troops: 300 }],
      [],
      [{ type: 'muster', unit: 'spear', troops: 300 }, { type: 'depart', host: 1, dest: 11, rounds: 1 }, { type: 'train', unit: 'pike', troops: 100 }],
      [],
    ];
    plan.forEach((acts, r) => {
      const bots = B.decideAll(s);
      const t = { round: r, ms: (r + 1) * 1000, actions: acts.map(a => { const x = E.apply(s, 0, a); return { ms: 0, a, ok: x.ok, err: x.err || null }; }) };
      log.turns.push(t);
      E.advance(s, bots);
      log.hashes[r] = M.stateHash(s);
    });
    // The replay inside `measure` starts a new game, so give yellow the
    // same resources there too.
    const realNew = E.newGame;
    E.newGame = o => { const g = realNew(o); g.nations[2].res.food = 2000; g.nations[2].res.ore = 2000; g.nations[2].res.gold = 2000; return g; };
    let m;
    try { m = M.measure(log); } finally { E.newGame = realNew; }
    assert.equal(m.replayOk, true);
    assert.equal(m.rounds, 4);
    assert.equal(m.actions, 4); // build, train, muster, depart (the pikemen were refused)
    assert.equal(m.failedActions, 1);
    assert.equal(m.idleRounds, 2);
    assert.equal(m.militaryRounds, 1);
    assert.equal(m.moveRounds, 1);
    assert.equal(m.threatRounds, 1);
    assert.equal(m.threatMoveRate, 1);
    assert.equal(m.otherMoveRate, 0); // rounds 1 and 3
    assert.equal(m.reactionLift, 1);
    assert.equal(m.departRounds, 1); // round 1 (yellow left in round 0)
    assert.equal(m.departMoveRate, 0);
    assert.equal(m.quietMoveRate, 0.5); // rounds 2 and 3
    assert.equal(m.marches, 1);
    assert.equal(m.planMsTotal, 10000);
    assert.equal(m.planMsMedian, 2500);
  } finally {
    B.decideAll = real;
  }
});

test('hosts are capped at 30,000 troops, as in the game', () => {
  const s = E.newGame({ variant: 'A', seed: 1, policies: [null, null, null] });
  s.nations[0].reserve.spear = 31000 * MILLI;
  assert.equal(E.apply(s, 0, { type: 'muster', unit: 'spear', troops: 30100 }).ok, false);
  assert.ok(E.apply(s, 0, { type: 'muster', unit: 'spear', troops: 30000 }).ok);
});

test('balance checks (bots, 5 conditions): no policy wins almost always; the first capture does not decide the game', () => {
  const T = require('../tools/tournament.js');
  const POL = ['turtle', 'balanced', 'raider', 'counter'];
  for (const v of ['A', 'B']) {
    let first = 0; let withCap = 0;
    const wins = {}; const seats = {};
    for (const a of POL) for (const b of POL) for (const c of POL) for (let seed = 1; seed <= 5; seed++) {
      const g = T.play(v, [a, b, c], seed);
      assert.ok(g.winners.length >= 1, 'every game ends with a winner');
      if (g.caps.length) { withCap += 1; if (g.winners.includes(g.caps[0].by)) first += 1; }
      if (new Set([a, b, c]).size > 1) {
        [a, b, c].forEach((p, i) => { seats[p] = (seats[p] || 0) + 1; wins[p] = (wins[p] || 0) + (g.winners.includes(i) ? 1 / g.winners.length : 0); });
      }
    }
    for (const p of POL) assert.ok(wins[p] / seats[p] < 0.8, `${v}: ${p} wins ${(100 * wins[p] / seats[p]).toFixed(0)}% of its seats`);
    assert.ok(first / withCap < 0.8, `${v}: the first capturer won ${(100 * first / withCap).toFixed(0)}%`);
  }
});

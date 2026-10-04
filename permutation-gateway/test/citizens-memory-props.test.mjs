// Property tests of contract §10.2 G15 over seeded random scenarios (synthetic records, labelled as such):
//  (1) an episode made from a council close carries no option index, no ballot count and no coordinates;
//  (2) no motion/council_result episode ever names a target; a strike episode (the only one with the Call's (p,q))
//      is never created before S + 2 and never before the target's public CLASH row;
//  (3) every episode containing a live Call's (p,q) has created_bell >= the bell of that target's public REVEAL or CLASH;
//  (4) the result is a function of the records, not of the order they are listed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { tagHex } from '../citizens/persona/names.mjs';
import { clashFile, dec, fakeHerald, province, rng, row } from './fixtures/ai-ac2-synth.mjs';

const A = tagHex(1001n), E = tagHex(2002n), M = tagHex(4004n);
const AI = { tag: A, wallet: 'AIW', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] };

function scenario(seed) {
  const r = rng(seed);
  const pick = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const S = pick(200, 400), C0 = S - 12 + pick(0, 3);
  const tp = pick(-3, 3), tq = pick(-3, 3), tile = pick(1, 40);
  const withClash = r() < 0.7, ownPresent = r() < 0.5;
  const optionsAll = [1, 2, 3].map(o => ({ option: o, kind: ['strike', 'camp', 'raid'][o - 1], p: o === 2 ? tp : pick(-3, 3), q: o === 2 ? tq : pick(-3, 3), value: pick(100, 900) }));
  const council = [{
    faction: 3, period: 1, close_bell: C0 + 6, adopted: true, strike_bell: S, options: optionsAll,
    tally: { 1: pick(0, 5), 2: pick(2, 9), 3: pick(0, 5) }, ballots: [{ wallet: 'w1', option: 2 }, { wallet: 'w2', option: 2 }],
    open: { option: 2, p: tp, q: tq, tile },
  }];
  // the same council before it opened (no `open`): what the world knows at the close
  const talk = [
    { id: 1, bell: C0 + 1, tag: M, channel: 'nation', target: 3, kind: 1, ref: (1 << 8) | 2, inner: 'm1', origin: 0 },
    { id: 2, bell: C0 + 2, tag: E, channel: 'nation', target: 3, kind: 1, ref: (1 << 8) | 1, inner: 'm2', origin: 0 },
  ];
  const sites = [tile];
  const before = province({ p: tp, q: tq, sites, entries: [{ id: '6000001', faction: 1, tile, troops: 300 }] });
  const after = province({ p: tp, q: tq, sites, entries: [{ id: '6000001', faction: 1, tile, troops: 300 - pick(0, 100) }] });
  const clashBellRow = S + pick(1, 3);
  const events = [];
  const clashes = [];
  if (withClash) {
    const lostOwn = pick(0, 60), lostEnemy = pick(0, 200);
    const fighters = [{ id: '6000001', arrival: false, post: 300 - lostEnemy, engaged: true, tile }, ...(ownPresent ? [{ id: '5000001', arrival: true, post: 500 - lostOwn, engaged: true, tile }] : [])];
    clashes.push(clashFile({ p: tp, q: tq, bell: S, fighters, before, arrivals: ownPresent ? [{ id: '5000001', tag: dec(A), faction: 3, tile, troops: 500 }] : [] }));
    events.push(row(100, 'sigC', clashBellRow, 'CLASH', { p: tp, q: tq, bell: S }, { engagements: 2 }));
    events.push(row(90, 'sigR', S, 'REVEAL', { p: tp, q: tq, arrive: S, faction: 3, i: 0 }, { host_id: '5000001', tile }));
  }
  const h = fakeHerald({ provinces: { [`${tp},${tq},${S - 1}`]: before, [`${tp},${tq},${S}`]: after }, clashes });
  return { S, C0, tp, tq, withClash, clashBellRow, council, talk, events, h };
}
const ctxOf = (sc, bellNow) => ({ ai: AI, bellNow, owners: { citizenOfHost: id => (id === '5000001' ? A : id === '6000001' ? E : null) }, province: sc.h.province, clash: sc.h.clash, config: {} });
const mentions = (e, tp, tq) => e.entities.includes(`pq:${tp},${tq}`) || JSON.stringify([e.text, e.facts, e.src]).includes(`(${tp},${tq})`);

test('G15 property: council_result and motion episodes carry no option index of the adopted option, no ballot count and no coordinates (60 seeded scenarios)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const sc = scenario(seed);
    const res = episodes_from_events({ events: sc.events, talk: sc.talk, council: sc.council }, ctxOf(sc, Infinity));
    for (const e of res.episodes.filter(x => x.kind === 'council_result')) {
      assert.deepEqual(e.entities, ['nation:3'], `seed ${seed}`);
      assert.deepEqual(Object.keys(e.facts).sort(), ['adopted', 'period']);
      const digits = (e.text.en.match(/\d+/g) ?? []).map(Number);
      assert.deepEqual(digits, [e.bell], `seed ${seed}: only the bell number in the text: ${e.text.en}`);
      assert.ok(!/option/i.test(e.text.en) && !/案/.test(e.text.ja));
      assert.ok(e.src.every(s => /^council:\d+:\d+:close$/.test(s)));
      assert.ok(!mentions(e, sc.tp, sc.tq));
    }
    for (const e of res.episodes.filter(x => x.kind === 'motion')) {
      assert.ok(!e.entities.some(x => x.startsWith('pq:')), `seed ${seed}: a motion names no place`);
      assert.ok(!mentions(e, sc.tp, sc.tq));
    }
  }
});

test('G15 property: an episode containing the Call target\'s (p,q) has created_bell >= the bell of the target\'s public CLASH row, and a strike episode is never before S + 2 (60 seeded scenarios, random evaluation bells)', () => {
  let withStrike = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const sc = scenario(seed);
    for (const bellNow of [sc.C0, sc.C0 + 6, sc.S, sc.S + 2, sc.S + 3, sc.S + 6, sc.S + 14, sc.S + 15, sc.S + 40, Infinity]) {
      const res = episodes_from_events({ events: sc.events, talk: sc.talk, council: sc.council }, ctxOf(sc, bellNow));
      for (const e of res.episodes) {
        assert.ok(e.created_bell < bellNow, `seed ${seed}: created_bell ${e.created_bell} is not before bellNow ${bellNow}`);
        if (!mentions(e, sc.tp, sc.tq)) continue;
        // only `strike` and the own-march episodes (clash_own_*, camp_cleared_own) may name the target; each only once the clash is public
        assert.ok(['strike', 'clash_own_win', 'clash_own_loss', 'camp_cleared_own', 'attacked_own'].includes(e.kind), `seed ${seed}: ${e.kind} names the target`);
        if (sc.withClash) assert.ok(e.created_bell >= sc.clashBellRow, `seed ${seed} ${e.kind}: before the public CLASH row`);
        if (e.kind === 'strike') { assert.ok(e.created_bell >= sc.S + 2, `seed ${seed}: a strike episode before S + 2`); withStrike++; }
      }
      if (bellNow <= sc.S + 1) assert.ok(!res.episodes.some(e => mentions(e, sc.tp, sc.tq)), `seed ${seed}: nothing names the target at bellNow ${bellNow}`);
      if (bellNow <= sc.S + 2) assert.ok(!res.episodes.some(e => e.kind === 'strike'), `seed ${seed}: no strike episode at bellNow ${bellNow}`);
    }
  }
  assert.ok(withStrike > 100, `the property was exercised (${withStrike} strike episodes seen)`);
});

test('G15 property: the producer is a function of the records, not of their order (shuffled inputs, same ids; 40 seeds)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const sc = scenario(seed);
    const r = rng(seed * 31);
    const shuffle = a => a.map(x => [r(), x]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const a = episodes_from_events({ events: sc.events, talk: sc.talk, council: sc.council }, ctxOf(sc, Infinity));
    const b = episodes_from_events({ events: shuffle(sc.events), talk: shuffle(sc.talk), council: shuffle(sc.council) }, ctxOf(sc, Infinity));
    assert.deepEqual(b.episodes, a.episodes, `seed ${seed}`);
    assert.deepEqual(b.deltas, a.deltas, `seed ${seed}`);
  }
});

test('G15 property: no episode before its records are public — every created_bell is >= the bell of every record in its src (40 seeds)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const sc = scenario(seed);
    const res = episodes_from_events({ events: sc.events, talk: sc.talk, council: sc.council }, ctxOf(sc, Infinity));
    const bellOfSrc = s => {
      const ev = /^event:(\d+)$/.exec(s); if (ev) return sc.events.find(x => x.seq === ev[1])?.bell;
      const t = /^talk:(\w+)$/.exec(s); if (t) return sc.talk.find(x => x.inner === t[1])?.bell;
      return null;
    };
    for (const e of res.episodes) for (const s of e.src) { const b = bellOfSrc(s); if (b != null) assert.ok(e.created_bell >= b, `seed ${seed} ${e.kind} ${s}`); }
  }
});

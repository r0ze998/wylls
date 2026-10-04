// AC6: council options (contract 6.5 step 1) and the council job: candidate filter and ranking vectors, the ratio word, the three target
// kinds from synthetic province files in the real feed's shape, hashes, opening through AC4's real council store (voters, humans, the
// "every AI holds a final village" rule), the motion and ballot calls once each.
// Province files here are SYNTHETIC (test/fixtures/ai-watcher-kit.mjs): the captured herald files hold no council situation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import {
  ball, targetProvinces, largestEnemyStack, bestRaidVillage, rawTargets, rankOptions, ratioWord, ownStrengthNear, createCouncilGen, mapLimit,
  NEAR_RADIUS, OWN_FACTOR, MAX_OPTIONS,
} from '../citizens/watcher/council_gen.mjs';
import { createCensus } from '../citizens/watcher/census.mjs';
import { candidatesHash, optionsHash } from '../citizens/social/council.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { fakeHerald, makeCitizen, makeClock, tmpAiDir, SEASON } from './fixtures/ai-social-kit.mjs';
import { fakeFeed, fakeOwners, fakeRoster, host, province, siteTile } from './fixtures/ai-watcher-kit.mjs';

const own = (f, troops, tile = 20) => host({ owner: `a${f}`, faction: f, tile, troops });

// ---------------------------------------------------------------- pure vectors
test('ratioWord: own / enemy >= 2 favourable, >= 1 even, < 1 unfavourable, an empty enemy is favourable', () => {
  const v = [[200, 100, 'favourable'], [199, 100, 'even'], [100, 100, 'even'], [99, 100, 'unfavourable'], [0, 50, 'unfavourable'], [10, 0, 'favourable']];
  for (const [o, e, w] of v) assert.equal(ratioWord(o, e), w, `${o}/${e}`);
});

test('ball: 1, 7 and 19 provinces for radius 0, 1, 2, all within the radius', () => {
  assert.deepEqual([0, 1, 2, 3].map(r => ball(5, -2, r).length), [1, 7, 19, 37]);
  for (const c of ball(5, -2, 2)) assert.ok(hexDistance(5, -2, c.p, c.q) <= 2);
});

test('targetProvinces: within 2 provinces of at least 3 holdings, equal to a brute-force count', () => {
  const holdings = [{ p: 0, q: 0 }, { p: 1, q: 0 }, { p: 0, q: 1 }, { p: 4, q: -1 }, { p: 4, q: -1 }];
  const got = targetProvinces(holdings);
  const brute = [];
  for (const c of ball(0, 0, 7)) {
    const n = holdings.filter(h => hexDistance(h.p, h.q, c.p, c.q) <= NEAR_RADIUS).length;
    if (n >= 3) brute.push(c);
  }
  brute.sort((a, b) => a.p - b.p || a.q - b.q);
  assert.deepEqual(got, brute);
  assert.ok(got.length > 0);
  assert.ok(got.some(c => c.p === 0 && c.q === 0), 'the home cluster itself');
  // two holdings never make a target
  assert.deepEqual(targetProvinces([{ p: 0, q: 0 }, { p: 1, q: 0 }]), []);
  // one entry per village: two villages in one province count twice
  assert.ok(targetProvinces([{ p: 0, q: 0 }, { p: 0, q: 0 }, { p: 0, q: 0 }]).some(c => c.p === 0 && c.q === 0));
});

test('largestEnemyStack: one other nation, resident combat hosts on a non-site tile; scouts, site tiles, transit and own hosts never count', () => {
  const pv = province({
    p: 2, q: 0,
    hosts: [
      host({ faction: 3, tile: 20, troops: 300 }), host({ faction: 3, tile: 20, troops: 200 }), // stack 500 of nation 3
      host({ faction: 2, tile: 30, troops: 400 }), // a smaller stack
      host({ faction: 1, tile: 21, troops: 900 }), // own nation
      host({ faction: 3, tile: 22, troops: 800, unit: 6 }), // a scout
      host({ faction: 3, tile: siteTile(3), troops: 700 }), // on a village tile
      host({ faction: 3, tile: 23, troops: 650, state: 2 }), // in transit
      host({ faction: 6, tile: 24, troops: 600 }), // not a nation
    ],
  });
  assert.deepEqual(largestEnemyStack(pv, 1), { tile: 20, faction: 3, troops: 500_000, hosts: [pv.hosts[0].id, pv.hosts[1].id] });
  assert.equal(largestEnemyStack(province({ p: 0, q: 0, hosts: [host({ faction: 1, tile: 20, troops: 100 })] }), 1), null);
  // a tie goes to the smaller tile, then the smaller nation
  const tie = province({ p: 0, q: 0, hosts: [host({ faction: 4, tile: 31, troops: 100 }), host({ faction: 2, tile: 31, troops: 100 }), host({ faction: 5, tile: 30, troops: 100 })] });
  assert.deepEqual([largestEnemyStack(tie, 1).tile, largestEnemyStack(tie, 1).faction], [30, 5]);
});

test('rawTargets: strike (value = the stack), camp (half, rounded down), raid (0.8 of garrison plus residents; the target\'s shield must have ended); no reward, no capture', () => {
  const pv = province({
    p: 2, q: 0,
    villages: [{ site: 3, faction: 4, garrison: 200, shield_until_bell: 100 }, { site: 5, faction: 1, garrison: 999, shield_until_bell: 0 }],
    hosts: [host({ faction: 3, tile: 20, troops: 500 }), host({ faction: 4, tile: siteTile(3), troops: 100 }), host({ faction: 1, tile: siteTile(5), troops: 400 })],
    camp: { tile: 44, troops: 311 },
  });
  assert.deepEqual(rawTargets(pv, { faction: 1, strikeBell: 120 }), [
    { kind: 'strike', p: 2, q: 0, value: 500, enemy: 500, tile: 20 },
    { kind: 'camp', p: 2, q: 0, value: 155, enemy: 311, tile: 44 },
    { kind: 'raid', p: 2, q: 0, value: 240, enemy: 300, tile: siteTile(3) },
  ]);
  // the raid village's shield still stands at the arrival bell: no raid; the own nation's village is never a raid target
  assert.deepEqual(rawTargets(pv, { faction: 1, strikeBell: 99 }).map(r => r.kind), ['strike', 'camp']);
  assert.equal(bestRaidVillage(pv, 1, 120).faction, 4);
  assert.deepEqual(rawTargets(null, { faction: 1, strikeBell: 1 }), []);
  assert.deepEqual(rawTargets(province({ p: 0, q: 0, camp: { tile: 5, troops: 1 } }), { faction: 1, strikeBell: 1 }), [], 'a camp of 1 troop has value 0: not offered');
  for (const r of rawTargets(pv, { faction: 1, strikeBell: 120 })) assert.deepEqual(Object.keys(r).sort(), ['enemy', 'kind', 'p', 'q', 'tile', 'value']);
});

const ownAt = hosts => (p, q) => (p === 3 && q === 0 ? province({ p, q, hosts }) : null);

test('rankOptions: the 1.5 filter, ranking by value, distinct provinces, top three, ratio words (vector)', () => {
  // the nation's hosts near (3,0): 400, 300, 250, 200, 150 -> the four largest sum to 1,150
  const hosts = [400, 300, 250, 200, 150].map(t => own(1, t));
  const raws = [
    { kind: 'strike', p: 3, q: 0, value: 500, enemy: 500, tile: 20 }, // 1150 >= 750: offered, ratio 2.3 favourable
    { kind: 'raid', p: 3, q: 0, value: 240, enemy: 300, tile: 7 }, // same province, smaller value: dropped as a duplicate province
    { kind: 'camp', p: 3, q: 1, value: 150, enemy: 300, tile: 44 }, // 1150 >= 225
    { kind: 'camp', p: 3, q: -1, value: 130, enemy: 260, tile: 3 }, // 1150 >= 195
    { kind: 'camp', p: 4, q: 0, value: 120, enemy: 240, tile: 9 }, // fourth, cut by the top three
    { kind: 'strike', p: 5, q: 0, value: 900, enemy: 900, tile: 8 }, // 1150 < 1350: dropped by the filter
    { kind: 'camp', p: 5, q: 1, value: 100, enemy: 200, tile: 6 }, // no own hosts near (5,1): dropped
  ];
  const r = rankOptions({ faction: 1, raws, provinceOf: ownAt(hosts) });
  assert.deepEqual(r.options, [
    { option: 1, kind: 'strike', p: 3, q: 0, value: 500, own: 1150, ratio: 'favourable' },
    { option: 2, kind: 'camp', p: 3, q: 1, value: 150, own: 1150, ratio: 'favourable' },
    { option: 3, kind: 'camp', p: 3, q: -1, value: 130, own: 1150, ratio: 'favourable' },
  ]);
  assert.deepEqual(r.hints, { 1: { tile: 20 }, 2: { tile: 44 }, 3: { tile: 3 } });
  assert.equal(r.options.length, MAX_OPTIONS);
  assert.deepEqual(r.dropped.map(d => `${d.kind}@${d.p},${d.q}`), ['strike@5,0', 'camp@5,1']);
  assert.equal(OWN_FACTOR, 1.5);
});

test('rankOptions: ratio words even and unfavourable come from own / enemy, not from the 1.5 x value filter; ties by (p, q) then kind', () => {
  // own = 330 (three hosts of 110)
  const hosts = [110, 110, 110].map(t => own(1, t));
  const r = rankOptions({
    faction: 1, provinceOf: ownAt(hosts),
    raws: [
      { kind: 'camp', p: 3, q: 0, value: 200, enemy: 400, tile: 1 }, // 330 >= 300: offered; 330 / 400 = 0.825: unfavourable
      { kind: 'camp', p: 4, q: 0, value: 150, enemy: 300, tile: 2 }, // 330 >= 225; 330 / 300 = 1.1: even
      { kind: 'camp', p: 2, q: 0, value: 150, enemy: 300, tile: 3 }, // the same value: (p, q) order puts (2,0) before (4,0)
      { kind: 'strike', p: 3, q: 1, value: 150, enemy: 150, tile: 4 }, // the same value again, (3,1)
    ],
  });
  assert.deepEqual(r.options.map(o => [o.option, o.p, o.q, o.ratio]), [[1, 3, 0, 'unfavourable'], [2, 2, 0, 'even'], [3, 3, 1, 'favourable']]);
  // a kind tie in one province keeps the strike before the camp before the raid
  const k = rankOptions({ faction: 1, provinceOf: ownAt([own(1, 900)]), raws: [{ kind: 'raid', p: 3, q: 0, value: 100, enemy: 125, tile: 1 }, { kind: 'camp', p: 3, q: 0, value: 100, enemy: 200, tile: 2 }, { kind: 'strike', p: 3, q: 0, value: 100, enemy: 100, tile: 3 }] });
  assert.deepEqual(k.options.map(o => o.kind), ['strike']);
  assert.deepEqual(rankOptions({ faction: 1, raws: [], provinceOf: () => null }).options, []);
});

test('ownStrengthNear: the four largest resident combat hosts of the nation within 2 provinces; scouts, transit and other nations do not count', () => {
  const files = new Map([
    ['3,0', province({ p: 3, q: 0, hosts: [own(1, 100), own(1, 90), host({ owner: 'x', faction: 2, tile: 20, troops: 999 }), host({ faction: 1, tile: 20, troops: 500, unit: 6 })] })],
    ['4,0', province({ p: 4, q: 0, hosts: [own(1, 80), own(1, 70), own(1, 60), host({ faction: 1, tile: 21, troops: 400, state: 2 })] })],
    ['9,9', province({ p: 9, q: 9, hosts: [own(1, 5000)] })], // far away
  ]);
  assert.equal(ownStrengthNear(3, 0, { faction: 1, provinceOf: (p, q) => files.get(`${p},${q}`) ?? null }), 100 + 90 + 80 + 70);
});

test('mapLimit keeps the order and never runs more than n at once', async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async x => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return x * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3);
});

// ---------------------------------------------------------------- the job
const C0 = 24;
const CFG = { period: 24, offset: 0, strike_lead: 6, human_present: true };
const hex = i => String(i).padStart(16, '0');

function world({ finalAll = true, council = CFG } = {}) {
  const clock = makeClock({ bell: C0 });
  const dir = tmpAiDir();
  const wallets = { ai0: makeCitizen('ai0', { faction: 1 }), ai1: makeCitizen('ai1', { faction: 1 }), seat: makeCitizen('seat', { faction: 1 }), bot: makeCitizen('bot', { faction: 1 }), foe: makeCitizen('foe', { faction: 3 }) };
  const holdings = (n, tag, final = true) => Array.from({ length: n }, (_, i) => ({ p: i, q: 0, site: i, final, founded_bell: 1 }));
  const entries = {
    ai0: { tag: hex(10), wallet: wallets.ai0.b58, faction: 1, index: 1000, kind: 'ai', holdings: holdings(2, hex(10)) },
    ai1: { tag: hex(11), wallet: wallets.ai1.b58, faction: 1, index: 1001, kind: 'ai', holdings: [{ p: 0, q: 1, site: 0, final: finalAll }] },
    seat: { tag: hex(12), wallet: wallets.seat.b58, faction: 1, index: 1012, kind: 'seat', holdings: [{ p: 1, q: 1, site: 1, final: true }] },
    bot: { tag: hex(13), wallet: wallets.bot.b58, faction: 1, kind: 'script', holdings: [{ p: 1, q: -1, site: 2, final: true }] },
    foe: { tag: hex(14), wallet: wallets.foe.b58, faction: 3, holdings: [{ p: 3, q: 0, site: 0, final: true }] },
  };
  const owners = fakeOwners({ citizens: Object.values(entries) });
  const roster = fakeRoster({
    ai: [entries.ai0, entries.ai1].map(e => ({ index: e.index, tag: e.tag, wallet: e.wallet, faction: e.faction, name: { en: e.tag, ja: e.tag } })),
    seat: { index: 1012, wallet: wallets.seat.b58, tag: entries.seat.tag, faction: 1, kind: 'seat', scripted: false },
    script: [wallets.bot.b58],
  });
  const feed = fakeFeed({ owners, through: C0 - 1, head: C0 });
  for (const e of Object.values(entries)) feed.addEvent({ kind: 'SETTLE', bell: 3, seq: String(e.tag), citizen: e.tag, displaced: null });
  const herald = fakeHerald(Object.values(wallets));
  const rosterJson = { season: SEASON, ai: roster.ai, script: { wallets: [wallets.bot.b58] }, seat: roster.seat };
  const social = createSocial({ herald, aiDir: dir.dir, roster: rosterJson, clock, provenance: null, config: { council }, season: SEASON, random: n => new Uint8Array(n).fill(0x11) });
  // the world: nation 1 holds villages around (0,0) (6 holdings: ai0 x2, ai1, seat, bot ... counted by the census); a camp at (2,0), a stack of nation 3 at (1,1)
  const f2 = C0 - 2;
  const hostsOwn = [own(1, 500, 30), own(1, 400, 31)];
  feed.files.set(`2,0,${f2}`, province({ p: 2, q: 0, bell: f2, camp: { tile: 44, troops: 200 } }));
  feed.files.set(`1,1,${f2}`, province({ p: 1, q: 1, bell: f2, hosts: [...hostsOwn, host({ faction: 3, tile: 20, troops: 300 })] }));
  // every other province around exists and is served (empty): as in the interior of the map, so a missing file means "not served yet"
  for (const c of ball(0, 0, 5)) if (!feed.files.has(`${c.p},${c.q},${f2}`)) feed.files.set(`${c.p},${c.q},${f2}`, province({ p: c.p, q: c.q, bell: f2 }));
  const calls = [];
  const mind = { councilCall: async a => { calls.push(a); return { decision_id: `d${calls.length}`, mode: 'model', reason: 'ok', social: a.kind === 'motion' ? { motion: { item: 0, text: 'm' } } : { ballot: { item: 0 } } }; } };
  const clockG = { hasAnchor: () => true, bellStartReal: b => 1_000_000_000_000 + b * 60_000, marginMs: () => 6000 };
  const store = { calls: new Set(), dirty: false };
  const census = createCensus({ feed, roster });
  census.start();
  const pushed = [];
  const stats = {};
  const now = { t: 1e12 };
  const gen = createCouncilGen({ feed, social, roster, census, clock: clockG, mind: () => mind, store, config: { council }, stats, nowMs: () => now.t, outbox: { push: it => pushed.push(it) }, retryMs: 0 });
  return { clock, dir, wallets, entries, owners, roster, feed, social, mind, calls, gen, store, census, stats, pushed, f2, now };
}

test('councilCandidates reads the files of bell C0 - 2, offers camp and strike, hashes them like the council store, and options_hash ignores value, own and ratio', async () => {
  const w = world();
  const r = await w.gen.councilCandidates(1, C0);
  assert.deepEqual(r.candidates.map(o => [o.option, o.kind, o.p, o.q]), [[1, 'strike', 1, 1], [2, 'camp', 2, 0]]);
  // strike value 300, own 900 (500 + 400): 900 >= 450; camp value 100, own 900 near (2,0) (the host province (1,1) is within 2)
  assert.deepEqual(r.candidates[0], { option: 1, kind: 'strike', p: 1, q: 1, value: 300, own: 900, ratio: 'favourable' });
  assert.deepEqual(r.candidates[1], { option: 2, kind: 'camp', p: 2, q: 0, value: 100, own: 900, ratio: 'favourable' });
  assert.equal(r.candidates_hash, candidatesHash(r.candidates));
  assert.equal(r.options_hash, optionsHash(r.candidates));
  assert.equal(optionsHash(r.candidates.map(o => ({ ...o, value: 1, own: 2, ratio: 'even' }))), r.options_hash);
  assert.ok(w.feed.calls.length > 0 && w.feed.calls.every(c => Number(c.split(',')[2]) === w.f2), 'only the immutable files of bell C0 - 2 were asked for');
  assert.equal(r.meta.holdings, 5);
  assert.deepEqual(r.hints, { 1: { tile: 20 }, 2: { tile: 44 } });
  // the same inputs give the same options (no clock, no randomness)
  assert.deepEqual((await w.gen.councilCandidates(1, C0)).candidates, r.candidates);
  // a nation with no holdings has no options
  assert.deepEqual((await w.gen.councilCandidates(4, C0)).candidates, []);
});

test('a file that is not served for C0 - 2 falls back to the newest one within 4 bells and is counted', async () => {
  const w = world();
  const pv = w.feed.files.get(`2,0,${w.f2}`);
  w.feed.files.delete(`2,0,${w.f2}`);
  w.feed.files.set(`2,0,${w.f2 - 1}`, pv);
  const r = await w.gen.councilCandidates(1, C0);
  assert.ok(r.candidates.some(o => o.kind === 'camp'));
  assert.ok(r.meta.fallback >= 1);
});

test('tryOpen: in the first bell of the period a file of bell C0 - 2 that is not served yet is waited for; from C0 + 1 the newest served file within 4 bells is accepted and flagged', async () => {
  const w = world();
  const pv = w.feed.files.get(`2,0,${w.f2}`);
  w.feed.files.delete(`2,0,${w.f2}`);
  w.feed.files.set(`2,0,${w.f2 - 1}`, pv); // only the older file is served
  assert.equal(await w.gen.tryOpen(1, 1, C0, C0), 'waiting', 'bell C0: the strict file is the only source');
  assert.equal(w.social.council.periodOf(1, 1), null);
  assert.equal(w.stats.council_waiting_files, 1);
  assert.equal(await w.gen.tryOpen(1, 1, C0, C0 + 1), 'opened', 'bell C0 + 1: the fallback is allowed');
  assert.ok(w.social.council.periodOf(1, 1).candidates.some(o => o.kind === 'camp'));
  // when the strict files are all there, the period opens at once, at C0
  const v = world();
  assert.equal(await v.gen.tryOpen(1, 1, C0, C0), 'opened');
});

test('tryOpen: opens through the real council store with the exact voters, rule bots excluded, the seat as the human; idempotent', async () => {
  const w = world();
  assert.equal(await w.gen.tryOpen(1, 1, C0, C0), 'opened');
  const P = w.social.council.periodOf(1, 1);
  assert.equal(P.c0, C0);
  assert.equal(P.candidates.length, 2);
  assert.deepEqual([...P.eligible].sort(), [w.entries.ai0.wallet, w.entries.ai1.wallet, w.entries.seat.wallet].sort(), 'script bots never vote');
  assert.deepEqual(P.humans, [w.entries.seat.wallet], 'the seat is the eligible non-AI voter');
  assert.equal(await w.gen.tryOpen(1, 1, C0, C0), 'exists');
  assert.equal(w.stats.councils_opened, 1);
  assert.equal(w.social.council.publicState(1).options.length, 2);
});

test('tryOpen: a nation whose AI lacks a final village holds no council that period (final, counted); no options is skipped too; an incomplete feed waits', async () => {
  const w = world({ finalAll: false });
  assert.equal(await w.gen.tryOpen(1, 1, C0, C0), 'skipped:not_all_final');
  assert.equal(w.social.council.periodOf(1, 1), null);
  assert.equal(await w.gen.tryOpen(1, 1, C0, C0), 'skipped:not_all_final', 'the skip is final for the period');
  const v = world();
  v.feed.state.through = C0 - 3;
  assert.equal(await v.gen.tryOpen(1, 1, C0, C0), 'waiting', 'records of bell C0 - 1 are not all in hand');
  v.feed.state.through = C0 - 1;
  v.feed.files.clear();
  assert.equal(await v.gen.tryOpen(1, 1, C0, C0), 'waiting', 'nothing is served yet: waited for in the first bell');
  assert.equal(await v.gen.tryOpen(1, 1, C0, C0 + 1), 'skipped:no_options', 'from C0 + 1 the fallback applies and there is nothing: no council');
});

test('step: opens at C0, asks each AI member once for its motion (deadline bell_start(C0+3) - margin) and once for its ballot at C0 + 3; a repeat asks nobody', async () => {
  const w = world();
  await w.gen.step(C0);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(w.calls.map(c => [c.kind, c.tag, c.period, c.bell]).sort(), [['motion', hex(10), 1, C0], ['motion', hex(11), 1, C0]]);
  assert.equal(w.calls[0].deadline_unix_ms, 1_000_000_000_000 + (C0 + 3) * 60_000 - 6000);
  assert.equal(w.pushed.length, 2, 'the outputs go to the outbox for the brain');
  w.clock.set(C0);
  await w.gen.step(C0 + 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(w.calls.length, 2, 'asked once');
  // the ballot window
  w.clock.set(C0 + 3);
  await w.gen.step(C0 + 3);
  await new Promise(r => setTimeout(r, 20));
  const ballots = w.calls.filter(c => c.kind === 'ballot');
  assert.equal(ballots.length, 2);
  assert.equal(ballots[0].deadline_unix_ms, 1_000_000_000_000 + (C0 + 6) * 60_000 - 6000);
  assert.deepEqual([...w.store.calls].sort(), [`ballot:${hex(10)}:1`, `ballot:${hex(11)}:1`, `motion:${hex(10)}:1`, `motion:${hex(11)}:1`]);
  // a restart with the persisted calls asks nobody again
  const again = createCouncilGen({ feed: w.feed, social: w.social, roster: w.roster, census: w.census, clock: { hasAnchor: () => true, bellStartReal: b => b, marginMs: () => 1 }, mind: () => w.mind, store: w.store, config: { council: CFG }, stats: {}, nowMs: () => 1e12 });
  await again.step(C0 + 4);
  assert.equal(w.calls.length, 4);
});

test('step: no game clock yet means no council call (the mind has no anchor either); a failing call is counted and does not stop the others', async () => {
  const w = world();
  const noClock = createCouncilGen({ feed: w.feed, social: w.social, roster: w.roster, census: w.census, clock: { hasAnchor: () => false }, mind: () => w.mind, store: { calls: new Set(), dirty: false }, config: { council: CFG }, stats: {}, nowMs: () => 1e12 });
  await noClock.step(C0);
  assert.equal(w.calls.length, 0);
  const bad = world();
  let n = 0;
  bad.mind.councilCall = async a => { bad.calls.push(a); if (n++ === 0) throw new Error('llm down'); return { decision_id: 'x', mode: 'autopilot', reason: 'timeout', social: { motion: null, ballot: null } }; };
  await bad.gen.step(C0);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(bad.calls.length, 2);
  assert.equal(bad.stats.council_motion_errors, 1);
  assert.equal(bad.stats.council_motion_autopilot, 1);
  // the failed call is asked once more after the retry delay, then given up (a dead mind is not hammered every second)
  await bad.gen.step(C0 + 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(bad.calls.length, 2, 'not before the retry delay');
  bad.now.t += 6000;
  await bad.gen.step(C0 + 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(bad.calls.length, 3);
  assert.equal(bad.stats.council_motion_gave_up ?? 0, 0, 'the retry succeeded (n = 0 failures after it)');
});

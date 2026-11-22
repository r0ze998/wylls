// fix-loop8, LP8-6 / LP8-7: the ⑨/⑩ preview card (permutation-server/web/frontier/screens/custody.mjs) — models and markup,
// not source pins.
//   LP8-6  「使用中」 is the program's own count (capacity.rs Pool::peak over Occ::occupies), and the job list on the same card
//          says the same thing: a job whose conversion has ended holds no workshop and is no longer 「作業中」.
//   LP8-7  the grantee picker and the lot picker tell one nation's people apart (village name, tile, short address);
//          option values are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { custodyModel, renderCustody, poolBusy, jobPhase } from '../../permutation-server/web/frontier/screens/custody.mjs';
import { FIN } from '../../permutation-server/web/frontier/flocalplay-custody.mjs';
import { placeName } from '../../permutation-server/web/frontier/people/identity.mjs';

const NOW = 100_000;
const ME = 'MeCitizen1111111111111111111111111111AAAA';
const YOU = 'YouCitizen222222222222222222222222222BBBB';
const AI = 'AiCitizen3333333333333333333333333333CCCC';
const DUNMAR = 3;
const H = (citizen, site, extra = {}) => ({ p: 3, q: -2, site, gen: 0, tile: site + 10, state: 1, ownerCitizen: citizen, faction: DUNMAR, workshops: 0, lent: 0, ...extra });
const V = (citizen, tile) => ({ p: 3, q: -2, tile, gen: 0, ownerCitizen: citizen, faction: DUNMAR });
const FAC = { p: 3, q: -2, site: 4, gen: 0 };
const occ = (o) => ({ grant: 0, job: 0, units: 1, open: true, budget: 4000, ...o });
const job = (o) => ({ grant: 0, seq: 0, user: YOU, recipe: 1, units: 1, maxOutput: 4000, hopper: [8000, 4000], fin: FIN.open, finAt: 0, settled: 0, claimed: 0, ...o });

function world({ viewer = ME, rows = [], jobs = [], holdings, vaults } = {}) {
  holdings ??= [H(ME, 4, { workshops: 1, lent: 1 }), H(YOU, 7), H(AI, 9)];
  vaults ??= [V(ME, 1), V(YOU, 22), V(AI, 30)];
  const pool = { facility: FAC, owner: ME, lent: 1, ownerSeq: 1, lostAt: null, captor: null, lastGrantSeq: 0, grants: [{ seq: 0, user: YOU, maxUnits: 1, maxOutput: 40000, until: NOW + 86400, revokedAt: null, spent: 0, lastJobSeq: 0 }], occ: rows };
  return { chain: { now: () => NOW }, custody: { on: true, viewer, myTag: '1', read: 'ok', holdings, vaults,
    lots: new Map(), caravans: new Map(), pools: new Map([['pool', { pool }]]), jobs: new Map(jobs.map((j, i) => [`job${i}`, { facility: FAC, job: j, owner: ME }])) } };
}

test('LP8-6 poolBusy is capacity.rs Pool::peak(now, now, MAX) over Occ::occupies(now)', () => {
  // running (started, end_eff ahead): held
  assert.equal(poolBusy([occ({ start: NOW - 1800, end: NOW + 1800, endEff: NOW + 1800 })], NOW), 1);
  // booked, not started, hopper still empty (end_eff = start): the whole window is held
  assert.equal(poolBusy([occ({ start: NOW + 60, end: NOW + 3660, endEff: NOW + 60 })], NOW), 1);
  // conversion ended (end_eff passed) though the job is not settled yet: nothing held — what ReclaimCapacity allows
  assert.equal(poolBusy([occ({ start: NOW - 3700, end: NOW - 100, endEff: NOW - 100 })], NOW), 0);
  // a closed row holds until its end_eff
  assert.equal(poolBusy([occ({ open: false, start: NOW - 100, end: NOW + 900, endEff: NOW + 500 })], NOW), 1);
  // two jobs one after another: a peak of 2 units, not 2 + 2; overlapping: 2 + 1
  const a = occ({ units: 2, start: NOW - 10, end: NOW + 100, endEff: NOW + 100 }), b = occ({ job: 1, units: 2, start: NOW + 100, end: NOW + 200, endEff: NOW + 200 });
  assert.equal(poolBusy([a, b], NOW), 2);
  assert.equal(poolBusy([a, occ({ job: 1, units: 1, start: NOW + 50, end: NOW + 200, endEff: NOW + 200 })], NOW), 3);
});

test('LP8-6 jobPhase: waiting, working, made (conversion ended, not settled), and the final states', () => {
  const r = { endEff: NOW + 100 };
  assert.equal(jobPhase(job({ start: NOW + 5 }), r, NOW), 'waiting');
  assert.equal(jobPhase(job({ start: NOW - 5 }), r, NOW), 'working');
  assert.equal(jobPhase(job({ start: NOW - 5 }), { endEff: NOW }, NOW), 'made');
  assert.equal(jobPhase(job({ start: NOW - 5, fin: FIN.completed }), r, NOW), 'completed');
  assert.equal(jobPhase(job({ start: NOW - 5, fin: FIN.lost }), r, NOW), 'lost');
  assert.equal(jobPhase(job({ start: NOW - 5, fin: FIN.cancelled }), r, NOW), 'cancelled');
});

test('LP8-6 the lender\'s card: 使用中 and the job word agree while a job runs, and after its conversion ends', () => {
  const running = world({ rows: [occ({ start: NOW - 1800, end: NOW + 1800, endEff: NOW + 1800 })], jobs: [job({ start: NOW - 1800, end: NOW + 1800 })] });
  const m = custodyModel(running, NOW);
  assert.equal(m.owned[0].busy, 1); assert.equal(m.owned[0].jobs[0].phase, 'working'); assert.equal(m.owned[0].jobs[0].made, 2);
  const h = String(renderCustody(running));
  assert.match(h, /貸し出し中 1（使用中 1）/); assert.match(h, /兵器 2.*作業中/s);
  assert.doesNotMatch(h, /data-act="cap-reclaim"/);   // (nothing free to give back while the job holds it)
  // the play-through's case: 4 arms made, the hour over, not settled yet — free again, and no longer 「作業中」
  const done = world({ rows: [occ({ start: NOW - 3700, end: NOW - 100, endEff: NOW - 100 })], jobs: [job({ start: NOW - 3700, end: NOW - 100 })] });
  const d = custodyModel(done, NOW);
  assert.equal(d.owned[0].busy, 0); assert.equal(d.owned[0].jobs[0].made, 4); assert.equal(d.owned[0].jobs[0].phase, 'made');
  const dh = String(renderCustody(done));
  assert.match(dh, /使用中 0/); assert.match(dh, /作り終えた/); assert.doesNotMatch(dh, /作業中/);
  assert.match(dh, /data-act="cap-reclaim"[^>]*data-units="1"/);
  // booked, not started: held, and said as 開始待ち
  const booked = world({ rows: [occ({ start: NOW + 60, end: NOW + 3660, endEff: NOW + 3660 })], jobs: [job({ start: NOW + 60, end: NOW + 3660 })] });
  assert.equal(custodyModel(booked, NOW).owned[0].busy, 1);
  assert.match(String(renderCustody(booked)), /開始待ち/);
});

test('LP8-6 the user\'s own job says the same as the lender\'s card', () => {
  const fs = world({ viewer: YOU, rows: [occ({ start: NOW - 3700, end: NOW - 100, endEff: NOW - 100 })], jobs: [job({ start: NOW - 3700, end: NOW - 100 })] });
  const m = custodyModel(fs, NOW);
  assert.equal(m.myJobs[0].phase, 'made');
  assert.match(String(renderCustody(fs)), /作り終えた/);
});

test('LP8-7 the grantee picker names each player by village, storehouse tile and short address; the option value is the same', () => {
  const fs = world({ rows: [] });
  const users = custodyModel(fs, NOW).owned[0].users;
  assert.deepEqual(users.map(u => u.user), [YOU, AI]);
  assert.deepEqual(users.map(u => [u.tile, u.who]), [[22, 'YouC…BBBB'], [30, 'AiCi…CCCC']]);
  assert.equal(users[0].village, placeName(3, -2, 7).ja);
  const h = String(renderCustody(fs));
  const opts = [...h.matchAll(/<option data-user="([^"]+)">([^<]+)<\/option>/g)].map(x => [x[1], x[2]]);
  assert.equal(opts.length, 2); assert.equal(opts[0][0], YOU); assert.equal(opts[1][0], AI);
  assert.notEqual(opts[0][1], opts[1][1]);
  assert.match(opts[0][1], /YouC…BBBB/); assert.match(opts[0][1], /マス 22/); assert.ok(opts[0][1].includes(placeName(3, -2, 7).ja));
  // a storehouse owner without a village of its own in the Province: still told apart by tile and address
  const noVillage = world({ rows: [], holdings: [H(ME, 4, { workshops: 1, lent: 1 })] });
  const u2 = custodyModel(noVillage, NOW).owned[0].users;
  assert.equal(u2[0].village, null);
  assert.match(String(renderCustody(noVillage)), /の人（貯蔵庫 マス 22 · YouC…BBBB）/);
});

test('LP8-7 the lot picker rows differ by village name, tile and short address; the values stay indices with the same data', () => {
  const fs = world({ rows: [] });
  const ch = custodyModel(fs, NOW).openChoices;
  assert.deepEqual(ch.map(x => [x.owner, x.at, x.who, x.name]), [[YOU, 17, 'YouC…BBBB', placeName(3, -2, 7).ja], [AI, 19, 'AiCi…CCCC', placeName(3, -2, 9).ja]]);
  const h = String(renderCustody(fs));
  const opts = [...h.matchAll(/<option value="(\d+)" ([^>]*)>([^<]+)<\/option>/g)];
  assert.deepEqual(opts.map(x => x[1]), ['0', '1']);
  assert.match(opts[0][2], new RegExp(`data-owner="${YOU}"`)); assert.match(opts[0][2], /data-tile="1"/);
  assert.notEqual(opts[0][3], opts[1][3]);
  assert.match(opts[0][3], /マス 1 → .* の村 .*（マス 17 · YouC…BBBB）/);
});

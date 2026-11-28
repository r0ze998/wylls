// fix-tg8-pair-home (owner r0ze 2026-11-28 09:05, Q-TG8-1 (a); D-test-gaps-8-1): the `--demo --two` runner predicts where an
// unplaced second player's page will put its first village (itest capture_demo.rs `b_home_for` → `predict_pair_home`). The
// page's rule is home.mjs `planHomes` with `pair` and controller.mjs `homeSeed` "pair:{season}". Both sides run ONE shared
// vector table, frontier-node/crates/itest/tests/fixtures/pair-home-vectors.json:
//   - here: the table's inputs and expectations are generated again through the page's own planHomes and must equal the
//     committed file (a change to the page's pair placement alone fails this test);
//   - Rust (itest tests/test_gaps_8_pair.rs `the_shared_pair_home_vectors_hold_for_the_runner`): predict_pair_home /
//     predict_home must give the committed expectations (a change to the runner alone fails that test).
// Rewrite the table after an intended change to BOTH: WRITE_PAIR_HOME_VECTORS=1 node --test <this file>, then run both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { planHomes } from '../../permutation-server/web/frontier/home.mjs';
import { hash32 } from '../../permutation-server/web/frontier/fjoin.mjs';
import { ringProvinces, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';

const TABLE = new URL('../../frontier-node/crates/itest/tests/fixtures/pair-home-vectors.json', import.meta.url);

// deterministic draws (no Math.random): hash32 of a counter string
function draws(tag) { let i = 0; return n => hash32(`${tag}#${i++}`) % n; }

/** One vector: a nation's provinces (wedge placement), each with site states (0 free, 3 released-free, 1 held). */
function makeVector(k, { maxRing = 4, shape = 'random' } = {}) {
  const r = draws(`tg8-vec-${k}-${shape}`), faction = k % 6;
  const season = `Season${k}${'x'.repeat(k % 5)}`;
  const seed = `pair:${season}|0`;
  const provinces = [];
  for (let ring = 2; ring <= maxRing; ring++) {
    for (const pc of ringProvinces(ring)) {
      if (wedgeOf(pc.p, pc.q) !== faction) continue;
      const siteCount = 1 + r(12);
      const states = Array.from({ length: siteCount }, () => [0, 0, 3, 1][r(4)]);
      provinces.push({ p: pc.p, q: pc.q, siteCount, states });
    }
  }
  const order = provinces.filter(v => v.states.some(s => s === 0 || s === 3)).sort((a, b) => ringOf(a) - ringOf(b) || hash32(`${seed}|${a.p},${a.q}`) - hash32(`${seed}|${b.p},${b.q}`));
  // (one free site: the first free one, or site 0 when none is free)
  const one = v => { const f = Math.max(0, v.states.findIndex(s => s === 0 || s === 3)); v.states = v.states.map((s, i) => (i === f ? (s === 3 ? 3 : 0) : 1)); };
  const three = v => { v.siteCount = Math.max(v.siteCount, 3); v.states = Array.from({ length: v.siteCount }, (_, i) => (i < 3 ? 0 : 1)); };
  if (shape === 'only-singles') provinces.forEach(v => { if (v.states.some(s => s === 0 || s === 3)) one(v); });
  if (shape === 'first-single') one(order[0]);
  if (shape === 'cap-23' || shape === 'cap-24') {
    // every province read has one free site, except the one at read index 23 (the page's 24th read) or 24 (never read)
    const all = provinces.slice().sort((a, b) => ringOf(a) - ringOf(b) || hash32(`${seed}|${a.p},${a.q}`) - hash32(`${seed}|${b.p},${b.q}`));
    all.forEach(one);
    three(all[shape === 'cap-23' ? 23 : 24]);
  }
  return { name: `${shape}-${k}`, faction, season, seed, provinces };
}
const ringOf = v => Math.max(Math.abs(v.p), Math.abs(v.q), Math.abs(-v.p - v.q));

async function pageChoice(vec, pair) {
  const byKey = new Map(vec.provinces.map(v => [`${v.p},${v.q}`, v]));
  const rings = new Map();
  for (const v of vec.provinces) {
    const ring = ringOf(v);
    if (!rings.has(ring)) rings.set(ring, { ring, provinces: [] });
    rings.get(ring).provinces.push({ p: v.p, q: v.q, sites: v.states, owners: v.states.map(() => 7) });
  }
  const read = async (p, q) => {
    const v = byKey.get(`${p},${q}`);
    return { p, q, siteCount: v.siteCount, sites: v.states.map((_, i) => i), siteMirror: v.states.map(state => ({ state, gen: 0 })), ticketCohorts: [] };
  };
  // the page's seed for this role (controller homeSeed "pair:{seasonAddress}" / the wallet, rotation 0: pinned below; the
  // controller itself is not imported here — it reaches signing code, and a key-using test would not run in key-free CI)
  const seed = pair ? `pair:${vec.season}|0` : 'Wallet1|0';
  if (pair) assert.equal(seed, vec.seed);
  const { candidates } = await planHomes({ overviews: rings, read, faction: vec.faction, seed, pair });
  const c = candidates[0];
  return c ? { p: c.p, q: c.q, site: c.site } : null;
}

async function table() {
  const vecs = [];
  for (let k = 0; k < 18; k++) vecs.push(makeVector(k));
  for (let k = 0; k < 3; k++) vecs.push(makeVector(k, { shape: 'first-single' }));
  vecs.push(makeVector(1, { shape: 'only-singles' }));
  vecs.push(makeVector(2, { maxRing: 7, shape: 'cap-23' }));
  vecs.push(makeVector(2, { maxRing: 7, shape: 'cap-24' }));
  for (const v of vecs) {
    v.expect = { first: await pageChoice(v, 'first'), second: await pageChoice(v, 'second'), singleSeed: 'Wallet1|0', single: null };
    // the one-player choice (wallet seed), as the runner's predict_home sees it
    const one = { ...v, seed: 'Wallet1|0' };
    v.expect.single = await pageChoice(one, null);
  }
  return { about: 'fix-tg8-pair-home: home.mjs planHomes (pair first/second, and one player) on synthetic wedge-placed provinces; generated by permutation-gateway/test/web-frontier-pair-home-vectors.test.mjs, also run by itest tests/test_gaps_8_pair.rs. Site states: 0 free, 3 released-free, 1 held.', vectors: vecs };
}

test('the shared pair-home vector table is the page\'s own planHomes choice (pair first / second, one player)', async () => {
  const fresh = await table();
  const text = `${JSON.stringify(fresh, null, 1)}\n`;
  if (process.env.WRITE_PAIR_HOME_VECTORS === '1') writeFileSync(TABLE, text);
  const committed = JSON.parse(readFileSync(TABLE, 'utf8'));
  assert.deepEqual(committed, JSON.parse(text), 'the page and the shared table disagree: rewrite it only for an intended change to the page AND the runner');
  // the table exercises what matters: the two roles differ, the pair skips a one-site province, the read cap ends it
  const V = committed.vectors;
  assert.ok(V.every(v => !v.expect.first || !v.expect.second || (v.expect.first.p === v.expect.second.p && v.expect.first.q === v.expect.second.q && v.expect.first.site !== v.expect.second.site)));
  assert.ok(V.filter(v => v.expect.second && v.expect.single && JSON.stringify(v.expect.second) !== JSON.stringify(v.expect.single)).length >= 10, 'the one-player choice is not the pair\'s');
  // (first-single: the first province in the pair's order has one free site, so the pair skips it)
  const free = v => v.states.filter(x => x === 0 || x === 3).length;
  for (const v of V.filter(v => v.name.startsWith('first-single'))) {
    const first = v.provinces.filter(x => free(x) > 0).sort((a, b) => ringOf(a) - ringOf(b) || hash32(`${v.seed}|${a.p},${a.q}`) - hash32(`${v.seed}|${b.p},${b.q}`))[0];
    assert.equal(free(first), 1);
    assert.ok(v.expect.second && `${v.expect.second.p},${v.expect.second.q}` !== `${first.p},${first.q}`, v.name);
  }
  assert.equal(V.find(v => v.name.startsWith('only-singles')).expect.second, null, 'no province with two free sites: none');
  assert.notEqual(V.find(v => v.name.startsWith('cap-23')).expect.second, null, 'the 24th read is still read');
  assert.equal(V.find(v => v.name.startsWith('cap-24')).expect.second, null, 'the 25th province is never read');
});

test('the controller still seeds a pair with its Season and hands planHomes the role (the seed this table assumes)', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("if ((identity?.pair === 'first' || identity?.pair === 'second') && typeof identity.seasonAddress === 'string') return `pair:${identity.seasonAddress}`;"), 'homeSeed: pair:{seasonAddress}');
  assert.ok(src.includes('seed: `${homeSeed()}|${old.rotation ?? 0}`, rotation: old.rotation ?? 0, pair: homePairRole(),'), 'refreshHomes: seed |rotation, pair role');
  const role = src.slice(src.indexOf('export function homePairRole('), src.indexOf('export async function refreshHomes('));
  assert.ok(role.includes("? identity.pair : null"), 'homePairRole: the role itself');
});

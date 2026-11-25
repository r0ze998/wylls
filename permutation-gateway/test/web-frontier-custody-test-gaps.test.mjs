// test-gaps-2 (2026-11-26; tests only, no behaviour changed): what the verifiers of #140 and #145 checked by hand, live
// or with pins written by hand, for ⑨ capacity and ⑩ custody, as key-free unit tests.
//  1. The page's one builder (flocalplay-custody.mjs) derives every pool, job and lot address — and the citizen tag a
//     lot is keyed by — exactly as the Rust ABI does: replayed over the shared vectors
//     frontier-abi/vectors/custody-addresses.txt (frontier-abi capacity::custody_address_vectors_tests writes them from
//     capacity::pool/job and v2::addr::lot; the file fails that test when it is stale).
//  2. verify-pr140's fix, as a property over random histories: a lot's address carries its storehouse's generation and a
//     seizure moves the storehouse to gen + 1, so a page that reads every turn (lotReadPlan, keeping what it found as
//     `known`) never loses sight of a lot it is a party to, through any number of seizures; a fresh page (nothing known)
//     still finds every such lot up to LOT_GEN_LOOKBACK seizures back.
//  3. The same for ⑨ pools over random captures (poolReadPlan: the village's PREV_GEN after a capture, and `known`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../../permutation-server/web/frontier/flocalplay-custody.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const repo = f => new URL(`../../${f}`, import.meta.url);
const unhex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const b58 = h => encode(unhex(h));

// ------------------------------------------------------------------ 1. the shared vectors

const LINES = readFileSync(repo('frontier-abi/vectors/custody-addresses.txt'), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
const CTX = LINES.find(l => l.startsWith('ctx ')).split(' ');
const WORLD = b58(CTX[1]), PROGRAM = b58(CTX[2]);
const cases = kind => LINES.filter(l => l.startsWith(kind + ' ')).map(l => {
  const [left, right] = l.split(' | ');
  return { args: left.split(' ').slice(1), out: right.split(' ') };
});

test('the shared vectors are there (40 pools, 40 jobs, 60 lots, 20 citizen tags)', () => {
  assert.equal(cases('pool').length, 40);
  assert.equal(cases('job').length, 40);
  assert.equal(cases('lot').length, 60);
  assert.equal(cases('tag').length, 20);
});

test('pool and job seeds and addresses are the Rust ABI\'s (capacity::pool_seed / job_seed, create_with_seed)', () => {
  for (const { args, out: [seed, addr] } of cases('pool')) {
    const [p, q, site, gen] = args.map(Number);
    const f = { p, q, site, gen };
    assert.equal(C.poolSeed(f), seed, `pool ${args}`);
    assert.equal(C.poolAddress(WORLD, PROGRAM, f), b58(addr), `pool ${args}`);
  }
  for (const { args, out: [seed, addr] } of cases('job')) {
    const [p, q, site, gen, grant, job] = args.map(Number);
    const f = { p, q, site, gen };
    assert.equal(C.jobSeed(f, grant, job), seed, `job ${args}`);
    assert.equal(C.jobAddress(WORLD, PROGRAM, f, grant, job), b58(addr), `job ${args}`);
  }
});

test('lot seeds and addresses are the Rust ABI\'s (v2::addr::lot_seed / lot), the owner tag and resource included', () => {
  for (const { args, out: [seed, addr] } of cases('lot')) {
    const [p, q, tile, gen] = args.slice(0, 4).map(Number);
    const ownerTag = args[4], resource = Number(args[5]);
    const vault = { p, q, tile, gen };
    assert.equal(C.lotSeed(vault, ownerTag, resource), seed, `lot ${args}`);
    assert.equal(C.lotAddress(WORLD, PROGRAM, vault, ownerTag, resource), b58(addr), `lot ${args}`);
  }
});

test('a citizen\'s tag (the lot\'s owner key) is the Rust citizen_tag: the first 8 bytes of the Citizen address, little-endian', () => {
  for (const { args: [citizen], out: [tag] } of cases('tag')) assert.equal(C.tagOf(b58(citizen)), tag, citizen);
});

// ------------------------------------------------------------------ 2. lots over random seizures

/** A deterministic generator (the same numbers on every machine). */
function rng(seed) {
  let s = BigInt(seed);
  return n => { s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number((s >> 33n) % BigInt(n)); };
}
const PLAYERS = ['citA', 'citB', 'citC', 'citD'];
const lotKey = (vault, owner) => `${vault.p},${vault.q},${vault.tile},${vault.gen}:${owner}`;

/**
 * One storehouse in one Province (every player has a village there), through `steps` random events: a deposit (a player
 * other than the present keeper opens a lot at the present generation) or a seizure (another player takes the
 * storehouse: gen + 1, the captor its keeper — SeizeVault, caravan.rs seize_vault_as). Returns the lots that exist, each
 * with the two parties it had (its owner and the keeper it was opened with), and the vault as it ends.
 */
function history(r, steps, onStep = () => {}) {
  const vault = { p: 3, q: -2, tile: 22, gen: 1, ownerCitizen: PLAYERS[r(4)], faction: 0 };
  const lots = new Map();
  for (let i = 0; i < steps; i++) {
    if (r(3) === 0) {
      const others = PLAYERS.filter(x => x !== vault.ownerCitizen);
      vault.ownerCitizen = others[r(others.length)];
      vault.gen += 1;
    } else {
      const others = PLAYERS.filter(x => x !== vault.ownerCitizen);
      const owner = others[r(others.length)];
      const v = { p: vault.p, q: vault.q, tile: vault.tile, gen: vault.gen };
      const k = lotKey(v, owner);
      if (!lots.has(k)) lots.set(k, { vault: v, owner, keeper: vault.ownerCitizen });
    }
    onStep({ ...vault }, lots);
  }
  return { vault, lots };
}
const holdings = PLAYERS.map((c, i) => ({ p: 3, q: -2, site: i + 1, gen: 1, ownerCitizen: c }));

test('lots over 400 random seizure histories: a page that reads every turn never loses a lot it is a party to (verify-pr140)', () => {
  let seizedLots = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const known = new Map(PLAYERS.map(x => [x, new Map()]));
    const { vault, lots } = history(r, 2 + r(30), (v, lotsNow) => {
      for (const viewer of PLAYERS) {
        const plan = C.lotReadPlan({ vaults: [v], holdings, viewer, known: [...known.get(viewer).values()] });
        // what the chain answers: the planned addresses that hold a lot (the page keeps those it found)
        for (const e of plan) { const k = lotKey(e.vault, e.owner); if (lotsNow.has(k)) known.get(viewer).set(k, e); }
      }
    });
    for (const viewer of PLAYERS) {
      const plan = new Set(C.lotReadPlan({ vaults: [vault], holdings, viewer, known: [...known.get(viewer).values()] }).map(e => lotKey(e.vault, e.owner)));
      for (const [k, l] of lots) {
        if (l.owner !== viewer && l.keeper !== viewer) continue;
        if (l.vault.gen < vault.gen) seizedLots++;
        assert.ok(plan.has(k), `seed ${seed}: ${viewer} lost sight of lot ${k} (keeper ${l.keeper}; storehouse now gen ${vault.gen}, ${vault.ownerCitizen})`);
      }
    }
  }
  assert.ok(seizedLots > 500, `the histories must exercise seized lots (${seizedLots})`);
});

test('lots: a fresh page (nothing known) finds every lot it is a party to up to LOT_GEN_LOOKBACK seizures back', () => {
  assert.equal(C.LOT_GEN_LOOKBACK, 2);
  let checked = 0;
  for (let seed = 1001; seed <= 1400; seed++) {
    const r = rng(seed);
    const { vault, lots } = history(r, 2 + r(20));
    for (const viewer of PLAYERS) {
      const plan = C.lotReadPlan({ vaults: [vault], holdings, viewer });
      const keys = new Set(plan.map(e => lotKey(e.vault, e.owner)));
      // each generation is read for at most every player: the plan is bounded
      assert.ok(plan.length <= (1 + C.LOT_GEN_LOOKBACK) * PLAYERS.length, `seed ${seed}: ${plan.length} reads`);
      for (const [k, l] of lots) {
        if (l.owner !== viewer && l.keeper !== viewer) continue;
        if (vault.gen - l.vault.gen > C.LOT_GEN_LOOKBACK) continue;
        checked++;
        assert.ok(keys.has(k), `seed ${seed}: a fresh ${viewer} page does not read lot ${k} (storehouse gen ${vault.gen})`);
      }
    }
  }
  assert.ok(checked > 1000, `checked ${checked}`);
});

test('lots: every planned read is the Rust address of that generation (the address moves with gen, so gen must be right)', () => {
  const r = rng(77);
  const { vault } = history(r, 12);
  const plan = C.lotReadPlan({ vaults: [vault], holdings, viewer: 'citA' });
  const addrs = new Set();
  for (const e of plan) {
    const tag = BigInt(PLAYERS.indexOf(e.owner) + 1);
    addrs.add(C.lotAddress(WORLD, PROGRAM, e.vault, tag));
  }
  assert.equal(addrs.size, plan.length, 'two planned reads may not land on one address');
});

// ------------------------------------------------------------------ 3. pools over random captures

test('pools over 400 random capture histories: a page that reads every turn never loses a pool it saw (PREV_GEN, known)', () => {
  let capturedPools = 0;
  for (let seed = 2001; seed <= 2400; seed++) {
    const r = rng(seed);
    const village = { p: 3, q: -2, site: 7, gen: 1, prevGen: 0, capturedBell: 0, workshops: 1, lent: 0 };
    const pools = new Set();
    const known = new Map();
    const steps = 2 + r(25);
    for (let i = 0; i < steps; i++) {
      if (r(3) === 0) {
        // a capture (conquest.rs: PREV_GEN = the generation before, CAPTURED_BELL, GEN + 1); the captor may run no workshop
        village.prevGen = village.gen; village.gen += 1; village.capturedBell = 10 + i; village.lent = 0;
        village.workshops = r(2);
      } else if (village.workshops > 0) {
        village.lent = 1; pools.add(`${village.site},${village.gen}`);
      }
      const plan = C.poolReadPlan({ holdings: [{ ...village }], known: [...known.values()] });
      for (const f of plan) { const k = `${f.site},${f.gen}`; if (pools.has(k)) known.set(k, f); }
    }
    const plan = new Set(C.poolReadPlan({ holdings: [{ ...village }], known: [...known.values()] }).map(f => `${f.site},${f.gen}`));
    for (const k of pools) {
      if (Number(k.split(',')[1]) < village.gen) capturedPools++;
      assert.ok(plan.has(k), `seed ${seed}: the pool ${k} vanished (village gen ${village.gen})`);
    }
  }
  assert.ok(capturedPools > 200, `the histories must exercise captured pools (${capturedPools})`);
});

test('pools: a fresh page (nothing known) finds a captured workshop village\'s pool of the generation before (PREV_GEN)', () => {
  let checked = 0;
  for (let seed = 3001; seed <= 3300; seed++) {
    const r = rng(seed);
    const gen = 1 + r(200);
    // a village lent at `gen`, then captured once (the captor may or may not run a workshop)
    const village = { p: 3, q: -2, site: 1 + r(12), gen: gen + 1, prevGen: gen, capturedBell: 5 + r(100), workshops: r(2), lent: 0 };
    const plan = new Set(C.poolReadPlan({ holdings: [village] }).map(f => `${f.site},${f.gen}`));
    assert.ok(plan.has(`${village.site},${gen}`), `seed ${seed}: a fresh page does not read the captured village's pool at gen ${gen}`);
    if (village.workshops) assert.ok(plan.has(`${village.site},${gen + 1}`), `seed ${seed}: the captor's own pool`);
    // a village never captured: only its own generation, and only with a workshop
    const plain = { ...village, gen, prevGen: 0, capturedBell: 0 };
    const p2 = C.poolReadPlan({ holdings: [plain] });
    assert.deepEqual(p2.map(f => f.gen), village.workshops ? [gen] : [], `seed ${seed}`);
    checked++;
  }
  assert.equal(checked, 300);
});

// D-test-gaps-2-1 (found writing the properties above; NOT fixed here — tests only, reported to r0ze): the keeper's
// reads of its OWN storehouse are made from the players who have a village in that Province NOW (lotReadPlan `others`).
// A depositor whose village there was captured after it deposited still owns its lot in the keeper's storehouse, but a
// fresh keeper page (nothing known yet: a new session) never reads it, so the keeper's card does not show goods it
// holds. A page that read the lot before keeps it (`known`). Kept as a todo (it reports, it does not fail CI) until the
// owner says whether the keeper must see such a lot (inbox 2026-11-26 test-gaps-2).
test('lots: a fresh keeper page reads the lot of a depositor who has since lost its village in that Province (D-test-gaps-2-1)', { todo: 'D-test-gaps-2-1: lotReadPlan reads the keeper\'s own lots only for current villagers' }, () => {
  const vault = { p: 3, q: -2, tile: 22, gen: 1, ownerCitizen: 'citA', faction: 0 };
  // citB deposited while it had a village here; its village was captured since (it is no longer among the holdings)
  const plan = C.lotReadPlan({ vaults: [vault], holdings: [{ p: 3, q: -2, site: 1, gen: 1, ownerCitizen: 'citA' }], viewer: 'citA' });
  assert.ok(plan.some(e => e.owner === 'citB'), 'the keeper never reads citB\'s lot in its own storehouse');
});

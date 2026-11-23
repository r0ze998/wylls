// flag-keeps-slice-1: the world goals' first slice — the flag keeps judge (src/frontier/world-goals.mjs), its
// local-play mount (src/frontier/local-play-world-goals.mjs) and the page's card (web/frontier/hud/worldgoals.mjs).
// No chain, no key: Province / Season / Citizen accounts are encoded by the game's own codec and served by a fake RPC.
// No port is bound here (the launcher's option and route: frontier-world-goals-launcher.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { encode as base58 } from '../client/src/base58.mjs';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import * as G from '../src/frontier/world-goals.mjs';
import * as W from '../src/frontier/local-play-world-goals.mjs';
import * as UI from '../../permutation-server/web/frontier/hud/worldgoals.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const SEED = new Uint8Array(32).fill(7);
const SEED_HEX = Buffer.from(SEED).toString('hex');
const k = (p, q, holder, since = 0, extra = {}) => ({ p, q, ring: (Math.abs(p) + Math.abs(q) + Math.abs(p + q)) / 2, holder, since, heartland: false, troops: 100, tile: 1, contender: 255, progress: 0, required: 72, ...extra });
const wallet = n => base58(new Uint8Array(32).fill(n));

// A small world: nation 0 holds (1,0) (2,0) (3,0) + a heartland keep (4,0); nation 1 holds (0,1) (0,2) (-1,2); nation 2 holds (-1,0) (-2,0)
const KEEPS = [k(1, 0, 0), k(2, 0, 0), k(3, 0, 0), k(4, 0, 0, 0, { heartland: true }), k(0, 1, 1), k(0, 2, 1), k(-1, 2, 1), k(-1, 0, 2), k(-2, 0, 2)];

test('designate: two per nation, own non-heartland keeps only, border keeps first, deterministic by the seed', () => {
  const a = G.designate({ keeps: KEEPS, seed: SEED_HEX, round: 1 });
  assert.equal(a.length, 6);
  for (const n of [0, 1, 2]) assert.equal(a.filter(f => f.nation === n).length, 2, `nation ${n}`);
  assert.ok(!a.some(f => f.p === 4 && f.q === 0), 'a heartland keep is never a flag');
  assert.ok(a.every(f => KEEPS.find(x => x.p === f.p && x.q === f.q).holder === f.nation), 'a nation\'s flags are its own keeps');
  // (3,0) has no neighbour of another nation, (1,0) and (2,0) do: the border keeps are taken first
  assert.deepEqual(a.filter(f => f.nation === 0).map(f => `${f.p},${f.q}`).sort(), ['1,0', '2,0']);
  assert.deepEqual(G.designate({ keeps: KEEPS, seed: SEED_HEX, round: 1 }), a, 'same inputs, same flags');
  // order inside a nation follows sha256(seed ‖ round ‖ p ‖ q)
  const n1 = a.filter(f => f.nation === 1);
  assert.ok(n1[0].rank < n1[1].rank || n1[0].border !== n1[1].border);
  assert.equal(G.rankOf(SEED_HEX, 1, 1, 0), G.rankOf(SEED_HEX, 1, 1, 0));
  assert.notEqual(G.rankOf(SEED_HEX, 1, 1, 0), G.rankOf(SEED_HEX, 2, 1, 0));
  // a nation with one non-heartland keep gives one flag; a nation with none gives none
  assert.equal(G.designate({ keeps: [k(1, 0, 3), k(2, 0, 4, 0, { heartland: true })], seed: SEED_HEX, round: 1 }).length, 1);
});

test('roundSeed: round 1 is the Season seed; later rounds hash it with the round and the last achievement bell', () => {
  assert.equal(G.roundSeed(SEED, 1), SEED_HEX);
  const r2 = G.roundSeed(SEED, 2, 300);
  assert.match(r2, /^[0-9a-f]{64}$/);
  assert.notEqual(r2, G.roundSeed(SEED, 2, 301));
  assert.notEqual(r2, G.roundSeed(SEED, 3, 300));
  assert.throws(() => G.roundSeed(new Uint8Array(31), 1));
});

test('need: half of the flag keeps rounded up (6 of 12), or the TEST override (never more than the flags)', () => {
  assert.equal(G.needOf(12), 6);
  assert.equal(G.needOf(6), 3);
  assert.equal(G.needOf(5), 3);
  assert.equal(G.needOf(12, { ...G.FLAG_KEEPS_DEFAULTS, need: 2 }), 2);
  assert.equal(G.needOf(1, { ...G.FLAG_KEEPS_DEFAULTS, need: 4 }), 1);
});

test('progress and achievement: each keep counts from max(since, posted); the need-th hold time is the achievement bell', () => {
  const flags = [{ p: 1, q: 0, nation: 0 }, { p: 2, q: 0, nation: 0 }, { p: 0, q: 1, nation: 1 }, { p: 0, q: 2, nation: 1 }];
  const rules = { ...G.FLAG_KEEPS_DEFAULTS, holdBells: 144 };
  // nation 0 holds its two (since 0) and took (0,1) at bell 50: posted at 10
  const keeps = [k(1, 0, 0, 0), k(2, 0, 0, 0), k(0, 1, 0, 50), k(0, 2, 1, 0)];
  let pr = G.progressOf({ flags, keeps, bell: 100, postedBell: 10, rules });
  const n0 = pr.find(x => x.nation === 0);
  assert.equal(n0.need, 2);
  assert.equal(n0.held, 3);
  assert.equal(n0.heldLong, 0, 'nothing is held long before posted + hold');
  assert.equal(n0.reachAt, 154, 'two keeps counted from the posting (10 + 144)');
  assert.equal(G.achievementOf(pr, 153), null);
  pr = G.progressOf({ flags, keeps, bell: 160, postedBell: 10, rules });
  assert.deepEqual(G.achievementOf(pr, 160), { bell: 154, nations: [0] });
  // nation 1 holds one flag: no reach
  assert.equal(pr.find(x => x.nation === 1).reachAt, null);
  // a lost keep resets: since moves to the new holder's first bell
  const lost = [k(1, 0, 2, 150), k(2, 0, 0, 0), k(0, 1, 0, 50), k(0, 2, 1, 0)];
  pr = G.progressOf({ flags, keeps: lost, bell: 160, postedBell: 10, rules });
  assert.equal(pr.find(x => x.nation === 0).reachAt, 194, '(2,0) from 10 and (0,1) from 50: the second reaches at 194');
  // two nations at the same bell: a tie
  const tieFlags = [{ p: 1, q: 0, nation: 0 }, { p: 0, q: 1, nation: 1 }];
  const tie = G.progressOf({ flags: tieFlags, keeps: [k(1, 0, 0, 0), k(0, 1, 1, 0)], bell: 200, postedBell: 0, rules: { ...rules, need: 1 } });
  assert.deepEqual(G.achievementOf(tie, 200), { bell: 144, nations: [0, 1] });
  // no flags: never an achievement
  assert.equal(G.achievementOf(G.progressOf({ flags: [], keeps, bell: 1000, postedBell: 0, rules }), 1000), null);
});

test('step: round 1 posted at the first read; an achievement posts round 2 with a new seed and posting hash', () => {
  const rules = { ...G.FLAG_KEEPS_DEFAULTS, holdBells: 10, need: 2 };
  const r0 = G.step(null, { bell: 5, keeps: KEEPS, genesisSeed: SEED }, rules);
  assert.equal(r0.state.round, 1);
  assert.equal(r0.achieved, null);
  const posted = r0.state.rounds[0];
  assert.equal(posted.seed, SEED_HEX);
  assert.equal(posted.need, 2);
  assert.equal(posted.hash, G.postingHash(posted.posting));
  // every nation holds its own two flags from bell 5: all reach at 15 → a three-way tie
  const r1 = G.step(r0.state, { bell: 16, keeps: KEEPS, genesisSeed: SEED }, rules);
  assert.deepEqual(r1.achieved.nations, [0, 1, 2]);
  assert.equal(r1.achieved.bell, 15);
  assert.equal(r1.achieved.counted.length, 6);
  assert.equal(r1.state.round, 2);
  assert.notEqual(r1.state.rounds[1].seed, posted.seed);
  assert.equal(r1.state.rounds[1].postedBell, 16);
  // round 2 counts from its posting: no achievement until 26
  assert.equal(G.step(r1.state, { bell: 25, keeps: KEEPS, genesisSeed: SEED }, rules).achieved, null);
  assert.equal(G.step(r1.state, { bell: 26, keeps: KEEPS, genesisSeed: SEED }, rules).achieved.bell, 26);
});

const capture = (w, nation, p, q) => ({ kind: 'capture', wallet: w, nation, province: { p, q }, quantity: 1, bell: 40, signatures: ['s1'] });
const reinf = (w, nation, p, q, troops, supplierNation = nation) => ({ kind: 'reinforcement', wallet: w, nation, province: { p, q }, quantity: troops, bell: 41, signatures: [], detail: { supplierNation } });

test('points: capture 10, reinforcement 1 per 100 troops capped at 10 per wallet and keep, other nations and suppliers out', () => {
  const lines = [capture(wallet(1), 0, 1, 0), reinf(wallet(1), 0, 1, 0, 750), reinf(wallet(1), 0, 1, 0, 600), reinf(wallet(2), 0, 2, 0, 99), reinf(wallet(3), 0, 2, 0, 500, 1), capture(wallet(4), 1, 0, 1), { kind: 'capture', wallet: null, nation: 0, province: { p: 3, q: 0 } }];
  const { byWallet } = G.pointsOf(lines, { nations: [0] });
  assert.equal(byWallet.get(wallet(1)).points, 10 + 7 + 3, 'capture 10, then 7 + 6 capped at 10 per keep');
  assert.equal(byWallet.get(wallet(2)).points, 0, '99 troops: 0 points');
  assert.equal(byWallet.has(wallet(3)), false, 'a supplier from another nation earns nothing for this one');
  assert.equal(byWallet.has(wallet(4)), false, 'another nation\'s line');
});

test('simulated vault: one 25 test USDC pass per person, 80 % to the prize, all of it to hegemony while it is the only goal', () => {
  assert.equal(G.simulatedVault({ people: 3 }), 60_000_000n);
  assert.equal(G.simulatedVault({ people: 3, paidOut: 18_000_000n }), 42_000_000n);
  assert.equal(G.simulatedVault({ people: 0 }), 0n);
  assert.equal(G.units(60_000_000n), '60');
  assert.equal(G.units(1_234_567n), '1.234567');
  assert.equal(G.units(0n), '0');
});

test('split: share_amount floor by points among eligible people; operator AI earns points but no money; late members and dust stay in the vault', () => {
  const members = [
    { wallet: wallet(1), nation: 0, joinBell: 0 }, { wallet: wallet(2), nation: 0, joinBell: 0 },
    { wallet: wallet(3), nation: 0, joinBell: 0, operator: true }, { wallet: wallet(4), nation: 0, joinBell: 190 },
    { wallet: wallet(5), nation: 1, joinBell: 0 },
  ];
  const points = new Map([[wallet(1), { nation: 0, points: 20 }], [wallet(2), { nation: 0, points: 10 }], [wallet(3), { nation: 0, points: 30 }], [wallet(4), { nation: 0, points: 10 }]]);
  const s = G.splitPrize({ vault: 100_000_000n, nations: [0], members, points, bell: 200 });
  assert.equal(s.payout, 30_000_000n, '30 % of the hegemony vault');
  const row = w => s.rows.find(r => r.wallet === wallet(w));
  assert.equal(row(1).amount, 20_000_000n, '20 of 30 eligible points');
  assert.equal(row(2).amount, 10_000_000n);
  assert.equal(row(3).amount, 0n); assert.equal(row(3).why, 'operator-ai'); assert.equal(row(3).points, 30, 'the AI keeps its points (shown)');
  assert.equal(row(4).amount, 0n); assert.equal(row(4).why, 'member-too-recent', 'joined 10 bells before (needs 144)');
  assert.equal(s.rows.some(r => r.wallet === wallet(5)), false, 'another nation is not in this split');
  assert.equal(s.paid + s.returned, s.payout);
  assert.equal(s.returned, 0n);
  // floor: three equal points of 10 units → 3 each, 1 back to the vault (and the minimum payout holds amounts back)
  const f = G.splitPrize({ vault: 100n, nations: [0], members: members.slice(0, 2).concat([{ wallet: wallet(6), nation: 0, joinBell: 0 }]), points: new Map([[wallet(1), { nation: 0, points: 1 }], [wallet(2), { nation: 0, points: 1 }], [wallet(6), { nation: 0, points: 1 }]]), bell: 200, rules: { ...G.FLAG_KEEPS_DEFAULTS, prize: { ...G.FLAG_KEEPS_DEFAULTS.prize, minPayout: 0 } } });
  assert.deepEqual(f.rows.map(r => r.amount), [10n, 10n, 10n]);
  assert.equal(f.returned, 0n);
  const g = G.splitPrize({ vault: 1000n, nations: [0], members: members.slice(0, 2), points: new Map(), bell: 200 });
  assert.equal(g.rows[0].mode, 'equal', 'no points: an equal split among the eligible');
  assert.equal(g.paid, 0n, 'under the 0.01 minimum: nothing paid');
  assert.equal(g.returned, 300n);
  // a tie halves the payout between the nations; a nation with no eligible person returns its half
  const t = G.splitPrize({ vault: 100_000_000n, nations: [0, 1], members: [{ wallet: wallet(1), nation: 0, joinBell: 0 }, { wallet: wallet(3), nation: 1, joinBell: 0, operator: true }], points: new Map([[wallet(1), { nation: 0, points: 5 }]]), bell: 200 });
  assert.equal(t.rows.find(r => r.wallet === wallet(1)).amount, 15_000_000n);
  assert.equal(t.returned, 15_000_000n);
  // external AI: no money until the legal review
  const e = G.splitPrize({ vault: 100_000_000n, nations: [0], members: [{ wallet: wallet(1), nation: 0, joinBell: 0, external: true }], points: new Map(), bell: 200 });
  assert.equal(e.rows[0].why, 'external-ai-legal-review');
  assert.equal(G.shareAmount(10n, 0n, 1n, 1n), null);
});

// ------------------------------------------------------------------ the chain reader, over a fake RPC
function fakeChain({ keeps, citizens = [], bell = 200, seasonId = 11n }) {
  const programId = base58(new Uint8Array(32).fill(0x45));
  const A = new FrontierAddresses({ programId, seasonId });
  const accounts = new Map();
  const b64 = b => [Buffer.from(b).toString('base64'), 'base64'];
  accounts.set(A.season, encodeAccount('Season', { SEASON_ID: seasonId, LAYOUT_VERSION: 2, GENESIS_TS: 1_000_000n, BELL_SECS: 600, GENESIS_SEED: SEED, GENESIS_ROUND: 30943232n }, { profile: 2 }));
  const clock = Buffer.alloc(40); clock.writeBigInt64LE(BigInt(1_000_000 + bell * 600 + 5), 32);
  accounts.set(W.CLOCK_SYSVAR, clock);
  const fr = Buffer.alloc(80); fr.writeUInt16LE(5, 64); accounts.set(A.frontier, fr);
  for (const x of keeps) accounts.set(A.province(x.p, x.q), encodeAccount('Province', { SEASON_ID: seasonId, LAYOUT_VERSION: 2, P: x.p, Q: x.q, RING: x.ring, KEEP: [{ TILE: x.tile, HOLDER: x.holder, SINCE_BELL: x.since, FLAGS: x.heartland ? 1 : 0, CONTENDER: x.contender, TROOPS: x.troops, REQUIRED: 72 }] }, { profile: 2 }));
  const cits = citizens.map(c => ({ pubkey: A.citizen(c.wallet), account: { data: b64(encodeAccount('Citizen', { SEASON_ID: seasonId, LAYOUT_VERSION: 2, WALLET: Array.from(Buffer.from(new Uint8Array(32).fill(c.n))), FACTION: c.nation, JOIN_BELL: c.joinBell }, { profile: 2 })) } }));
  const calls = [];
  const call = async (method, params) => {
    calls.push(method);
    if (method === 'getAccountInfo') { const d = accounts.get(params[0]); return { value: d ? { data: b64(d) } : null }; }
    if (method === 'getMultipleAccounts') return { value: params[0].map(a => (accounts.get(a) ? { data: b64(accounts.get(a)) } : null)) };
    if (method === 'getProgramAccounts') return cits;
    if (method === 'getSignaturesForAddress') return [];
    if (method === 'getTransaction') return null;
    throw new Error(`unexpected ${method}`);
  };
  return { programId, A, call, calls };
}

test('chain reader: bell from the Clock and the Season; keeps from the Province accounts; members from the Citizens', async () => {
  const c = fakeChain({ keeps: KEEPS, citizens: [{ wallet: wallet(9), n: 9, nation: 0, joinBell: 3 }], bell: 200 });
  const r = W.chainReader({ call: c.call, programId: c.programId, seasonId: 11, herald: 'http://127.0.0.1:1', fetchImpl: async () => ({ ok: false }) });
  const s = await r.season();
  assert.equal(s.ts, 1_000_000);
  assert.equal(Buffer.from(s.seed).toString('hex'), SEED_HEX);
  assert.equal(await r.bell(), 200);
  const { keeps } = await r.keeps();
  assert.equal(keeps.length, KEEPS.length);
  assert.deepEqual(keeps.find(x => x.p === 4 && x.q === 0).heartland, true);
  assert.deepEqual(keeps.find(x => x.p === 0 && x.q === 1).holder, 1);
  assert.deepEqual(await r.members(), [{ wallet: wallet(9), nation: 0, joinBell: 3 }]);
});

test('openWorldGoals: judges over the fake chain, keeps its state in the world directory, settles an achievement with the simulated prize', async t => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-goals-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const people = [{ wallet: wallet(9), n: 9, nation: 0, joinBell: 0 }, { wallet: wallet(8), n: 8, nation: 0, joinBell: 0 }, { wallet: wallet(7), n: 7, nation: 1, joinBell: 0 }];
  await fsp.writeFile(path.join(dir, 'operators.json'), JSON.stringify({ wallets: [wallet(8)] }));
  let chain = fakeChain({ keeps: KEEPS, citizens: people, bell: 10 });
  const meta = { program: chain.programId, season_id: 11, rpc_url: 'http://127.0.0.1:41999' };
  const rules = W.goalRulesOf({ hold: '20', need: '3', member: '0' });
  const deps = { noTimer: true, call: (...a) => chain.call(...a), fetch: async () => ({ ok: false }) };
  const g = await W.openWorldGoals({ dir, meta, heraldPort: 41649, rules, deps });
  await g.tick();
  let a = g.answer();
  assert.equal(a.kind, 'world-goals'); assert.deepEqual(a.effects, { money: 'none', chain: 'none' });
  assert.equal(a.flagKeeps.round, 1); assert.equal(a.flagKeeps.need, 3); assert.equal(a.flagKeeps.flags.length, 6);
  assert.equal(a.bell, 10);
  assert.deepEqual(a.goals.map(x => [x.id, x.live]), [['flag-keeps', true], ['world-first-tech', false], ['wonder', false], ['unexplored-mark', false]]);
  assert.ok(UI.goodAnswer(a), 'the page accepts the answer');
  // nation 0 takes nation 1's two flags at bell 12, then holds them past 12 + 20
  const flags1 = a.flagKeeps.flags.filter(f => f.nation === 1);
  const taken = KEEPS.map(x => (flags1.some(f => f.p === x.p && f.q === x.q) ? { ...x, holder: 0, since: 12 } : x));
  chain = fakeChain({ keeps: taken, citizens: people, bell: 40 });
  await g.tick();
  a = g.answer();
  assert.equal(a.achievements.length, 1);
  const ach = a.achievements[0];
  assert.deepEqual(ach.nations, [0]);
  assert.equal(ach.bell, 32, 'the third flag (taken at 12) met its 20 bells at 32');
  assert.equal(ach.prize.simulated, true);
  assert.equal(ach.prize.people, 2, 'the operator AI is not a person');
  assert.equal(ach.prize.vaultBefore, '40000000');
  assert.equal(ach.prize.payout, '12000000');
  const me = ach.prize.rows.find(r => r.wallet === wallet(9));
  assert.equal(me.mode, 'equal', 'no ledger lines (no records to cite): an equal split among the eligible people');
  assert.equal(me.amount, '12000000', 'the operator AI is not paid: the one person takes the nation\'s part');
  assert.equal(ach.prize.rows.find(r => r.wallet === wallet(8)).why, 'operator-ai');
  assert.equal(a.flagKeeps.round, 2, 'the next round is posted at once');
  const kept = JSON.parse(await fsp.readFile(path.join(dir, W.WORLD_GOALS_FILE), 'utf8'));
  assert.equal(kept.state.history.length, 1);
  // a restarted judge reads its state back: the achievement is not judged twice
  const g2 = await W.openWorldGoals({ dir, meta, heraldPort: 41649, rules, deps });
  await g2.tick();
  assert.equal(g2.answer().achievements.length, 1);
  assert.equal(g2.answer().flagKeeps.round, 2);
  g.stop(); g2.stop();
});

test('goalRulesOf and the mount', () => {
  assert.equal(W.goalRulesOf({}).holdBells, 144);
  assert.equal(W.goalRulesOf({ hold: '30' }).holdBells, 30);
  assert.equal(W.goalRulesOf({ need: '2' }).need, 2);
  assert.equal(W.goalRulesOf({ member: '0' }).memberBells, 0);
  for (const bad of [{ hold: '0' }, { hold: 'x' }, { need: '13' }, { member: '-1' }]) assert.throws(() => W.goalRulesOf(bad));
  assert.deepEqual(W.goalsRouteOf('/goals-world/41618/goals/state'), { port: 41618, rest: '/goals/state' });
  for (const bad of ['/goals-world/abc/goals/state', '/goals-world/41618/../x', '/goals/state']) assert.equal(W.goalsRouteOf(bad), null, bad);
  assert.equal(W.goalsMount(41618), '/goals-world/41618');
});

// ------------------------------------------------------------------ the page's card
const FS0 = { season: { seasonId: '11' }, pin: { programId: 'P' }, citizen: { faction: 0 }, wallet: { address: wallet(9) } };
const answer = (over = {}) => ({
  ok: true, v: 1, kind: 'world-goals', ruleset: 'flag-keeps-v1', testOnly: true, season: { programId: 'P', seasonId: '11' }, effects: { money: 'none', chain: 'none' }, bell: 100, error: null,
  goals: G.GOAL_KINDS.map(x => ({ ...x })),
  flagKeeps: { round: 1, postedBell: 0, seed: SEED_HEX, hash: 'ab'.repeat(32), need: 3, holdBells: 144,
    flags: [{ p: -1, q: 1, nation: 0, holder: 0, since: 0, from: 0, longAt: 144, contender: null, progress: 0, required: 72 }, { p: 1, q: 0, nation: 4, holder: 0, since: 60, from: 60, longAt: 204, contender: 4, progress: 12, required: 72 }],
    progress: [{ nation: 0, held: 2, heldLong: 0, need: 3, reachAt: null }, { nation: 4, held: 0, heldLong: 0, need: 3, reachAt: null }] },
  achievements: [], ...over,
});
const text = m => String(m).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('page: the card shows the four goals, the flag keeps, the viewer\'s progress — in Japanese and English', () => {
  setLang('ja');
  const b = { read: 'ok', goals: answer() };
  let s = text(UI.render(FS0, b));
  assert.match(s, /世界の目標/); assert.match(s, /旗の砦（覇権）/); assert.match(s, /準備中/);
  assert.match(s, /あなたの国：旗の砦 2 \/ 2 を保持/);
  assert.match(s, /あと 1 個の旗の砦を取って/);
  assert.match(s, /満たすまで あと 44 ターン/);
  assert.match(s, /試算/);
  setLang('en');
  s = text(UI.render(FS0, b));
  assert.match(s, /World goals/); assert.match(s, /Flag keeps \(hegemony\)/); assert.match(s, /coming/);
  assert.match(s, /Your nation holds 2 \/ 2 flag keeps/);
  assert.match(s, /No prize is paid yet/);
  assert.doesNotMatch(s, /[぀-ヿ一-鿿]/, 'no Japanese left in English');
  setLang('ja');
  // another world, a 404, an answer that claims an effect: nothing / not shown
  assert.equal(UI.render({ ...FS0, season: { seasonId: '12' } }, b), '');
  assert.equal(UI.render(FS0, { read: 'absent' }), '');
  assert.equal(UI.goodAnswer(answer({ effects: { money: 'paid', chain: 'none' } })), false);
  assert.equal(UI.goodAnswer({ ...answer(), kind: 'ws15-coop-outcomes' }), false);
  assert.deepEqual(UI.mapFlags(FS0, b), [{ p: -1, q: 1, round: 1 }, { p: 1, q: 0, round: 1 }]);
  assert.deepEqual(UI.mapFlags({ ...FS0, season: { seasonId: '12' } }, b), []);
  assert.equal(UI.localGoalsBase('http://localhost:41618'), '/goals-world/41618');
  assert.equal(UI.localGoalsBase('https://example.test'), null);
});

test('page: after an achievement, "if prizes were on, you would have received X" for the viewer; the reason when not', () => {
  const rows = [{ wallet: wallet(9), nation: 0, kind: 'person', points: 20, eligible: true, why: null, mode: 'points', amount: '9000000', amountText: '9' },
    { wallet: wallet(8), nation: 0, kind: 'operator-ai', points: 10, eligible: false, why: 'operator-ai', mode: 'points', amount: '0', amountText: '0' }];
  const ach = { round: 1, bell: 150, readBell: 151, nations: [0], counted: [], ledger: [], prize: { simulated: true, asset: 'test USDC', decimals: 6, people: 2, vaultBefore: '40000000', payout: '12000000', nationPart: '12000000', paid: '9000000', returned: '3000000', vaultAfter: '31000000', rows } };
  const b = { read: 'ok', goals: answer({ achievements: [ach] }) };
  assert.ok(UI.goodAnswer(b.goals));
  setLang('ja');
  let s = text(UI.render(FS0, b));
  assert.match(s, /第 1 回：.*が達成（ターン 150）/);
  assert.match(s, /賞金が有効なら、あなたは 9 テスト USDC を受け取っていました/);
  assert.match(s, /あなたの貢献 20 点/);
  setLang('en');
  s = text(UI.render(FS0, b));
  assert.match(s, /If prizes were on, you would have received 9 test USDC/);
  assert.match(s, /Round 1: .* achieved it \(turn 150\)/);
  s = text(UI.render({ ...FS0, wallet: { address: wallet(8) } }, b));
  assert.match(s, /Even with prizes on, you would receive 0/);
  assert.match(s, /Operator AI residents earn points and titles but receive no prize/);
  assert.doesNotMatch(s, /[぀-ヿ一-鿿]/);
  setLang('ja');
  assert.equal(UI.usdc('9000000'), '9'); assert.equal(UI.usdc('1500000'), '1.5'); assert.equal(UI.usdc('0'), '0');
});

test('page: probeGoals reads <base>/goals/state; a 404 is "absent", a bad answer is unread', async () => {
  const resp = (status, body) => ({ status, ok: status < 300, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  let asked = null;
  assert.deepEqual(await UI.probeGoals({ base: '/goals-world/41618', fetch: async u => { asked = u; return resp(404, null); } }), { read: 'absent' });
  assert.equal(asked, '/goals-world/41618/goals/state');
  assert.equal((await UI.probeGoals({ fetch: async () => resp(200, answer()) })).read, 'ok');
  assert.deepEqual(await UI.probeGoals({ fetch: async () => resp(200, { ok: true }) }), { read: 'unread', code: 'BadGoals' });
  assert.deepEqual(await UI.probeGoals({ fetch: async () => { throw new Error('x'); } }), { read: 'unread', code: 'network' });
});

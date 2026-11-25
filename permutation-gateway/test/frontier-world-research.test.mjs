// World goal ② research judge (world-research.mjs; owner r0ze 2026-11-25 08:56, every Q-RS recommendation): the
// posting, the world first with ties, the cross-check that stops instead of guessing, the fog view (Q-RS-9 (1) (b)),
// the points (summed per citizen then ÷ 10, Q-RS-10 (d)) and the SIMULATED prize (science vault 20 %, era 1 pays 5 %).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../src/frontier/world-research.mjs';
import { decodeResearchWorld, decodeNationResearch } from '../../permutation-server/web/frontier/flocalplay-research.mjs';
import { worldBytes, nationBytes } from './research-fixtures.mjs';

const read = (w, ns) => ({ world: decodeResearchWorld(worldBytes(w)), nations: Array.from({ length: 6 }, (_, f) => decodeNationResearch(nationBytes(f, ns[f] ?? {}))) });

test('the posting: the open era-1 techs nobody knows, hashed', () => {
  const r = read({ first: { 1: 5 }, firstNations: { 1: 0b100 }, known: { 1: 0b100 } }, { 2: { learned: { 1: 5 } } });
  const p = J.postingOf(r.world);
  assert.deepEqual(p.techs.map(t => t.id), [0, 2, 3]);
  assert.match(p.hash, /^[0-9a-f]{64}$/);
  assert.equal(J.postingOf(r.world).hash, p.hash);
});

test('world firsts: the earliest learned bell, a tie at the same bell, checked against the world record', () => {
  const ok = read({ first: { 1: 5 }, firstNations: { 1: 0b10100 }, known: { 1: 0b10110 } }, { 2: { learned: { 1: 5 } }, 4: { learned: { 1: 5 } }, 1: { learned: { 1: 9 } } });
  const { firsts, problems } = J.firstsOf(ok.world, ok.nations);
  assert.deepEqual(firsts, [{ tech: 1, key: 'masonry', era: 1, bell: 5, nations: [2, 4] }]);
  assert.deepEqual(problems, []);
  // the world record says nation 1 was first too: the judge stops on that tech
  const bad = read({ first: { 1: 5 }, firstNations: { 1: 0b10110 }, known: { 1: 0b10110 } }, { 2: { learned: { 1: 5 } }, 4: { learned: { 1: 5 } }, 1: { learned: { 1: 9 } } });
  const b = J.firstsOf(bad.world, bad.nations);
  assert.deepEqual(b.firsts, []);
  assert.match(b.problems[0].why, /ResearchMismatch/);
});

test('fog (Q-RS-9 (1) (b)): known techs are public; the totals only for the asking nation', () => {
  const r = read({ first: { 0: 4 }, firstNations: { 0: 0b1 }, known: { 0: 0b1 } }, { 0: { learned: { 0: 4 }, pledged: { 0: 300 } }, 3: { pledged: { 0: 200, 2: 50 } } });
  const spectator = J.viewOf(r.world, r.nations, null);
  assert.ok(spectator.techs.every(t => !('mine' in t)));
  assert.deepEqual(spectator.techs[0].knownBy, [0]);
  const me = J.viewOf(r.world, r.nations, 3);
  assert.deepEqual(me.techs[0].mine, { known: false, pledged: 200, cost: 240, left: 40, learnedBell: null, refusal: null });
  assert.equal(me.techs[4].mine.refusal, 'EraClosed');
  // the AI's choice: the least left to pay, then the lower id
  assert.equal(J.aiTechOf(me).id, 0);
  assert.equal(J.aiTechOf(J.viewOf(r.world, r.nations, 5)).id, 0, 'all equal for a fresh nation but the discounted one');
});

test('points: summed per citizen, then ÷ 10; only the achieving nation, up to the learn', () => {
  const cit = n => new Uint8Array(32).fill(n);
  const rec = (citizen, nation, amount, bell, tech = 1) => ({ kind: 'pledge', tech, nation, amount, bell, citizen: cit(citizen) });
  const receipts = [rec(1, 2, 9, 3), rec(1, 2, 9, 4), rec(1, 2, 9, 5), rec(2, 2, 270, 5), rec(3, 4, 100, 5), rec(2, 2, 50, 6), rec(1, 2, 10, 4, 0)];
  const pts = J.pointsOfReceipts(receipts, { tech: 1, nations: [2], bell: 5, citizenWallet: c => `w${c[0]}` });
  assert.deepEqual([...pts].map(([w, x]) => [w, x.points, x.science]), [['w1', 2, 27], ['w2', 27, 270]]);
});

test('settle: the simulated science vault (20 %) pays 5 % in era 1, split by points among eligible persons', () => {
  const first = { tech: 1, key: 'masonry', era: 1, bell: 400, nations: [2] };
  const receipts = [{ kind: 'pledge', tech: 1, nation: 2, amount: 200, bell: 300, citizen: new Uint8Array(32).fill(1) }, { kind: 'pledge', tech: 1, nation: 2, amount: 100, bell: 390, citizen: new Uint8Array(32).fill(2) }];
  const members = [{ wallet: 'w1', nation: 2, joinBell: 1 }, { wallet: 'w2', nation: 2, joinBell: 1 }, { wallet: 'w3', nation: 0, joinBell: 1 }];
  const e = J.settleFirst({ first, receipts, members, operators: ['w2'], citizenWallet: c => `w${c[0]}` });
  // 2 persons × 25 USDC × 80 % × 20 % = 8 USDC; 5 % = 0.4
  assert.equal(e.prize.vaultBefore, 8_000_000n);
  assert.equal(e.prize.payout, 400_000n);
  const w1 = e.prize.rows.find(r => r.wallet === 'w1'), w2 = e.prize.rows.find(r => r.wallet === 'w2');
  assert.equal(w1.amount, 400_000n);
  assert.equal(w2.eligible, false); assert.equal(w2.why, 'operator-ai');
  assert.equal(e.ledger.find(l => l.wallet === 'w2').points, 10, 'an operator AI earns points like a person');
  assert.equal(e.attest.kind, 'science'); assert.equal(e.attest.goalId, 1); assert.match(e.attest.evidenceHash, /^[0-9a-f]{64}$/);
});

test('researchStep: only the firsts not yet settled are fresh', () => {
  const r = read({ first: { 0: 4, 1: 6 }, firstNations: { 0: 1, 1: 1 }, known: { 0: 1, 1: 1 } }, { 0: { learned: { 0: 4, 1: 6 } } });
  const s = J.researchStep({ history: [{ tech: 0 }] }, r);
  assert.deepEqual(s.fresh.map(f => f.tech), [1]);
});

test('receipts from the log lines', () => {
  const body = new Uint8Array(57); body[0] = 1; body[1] = 3;
  const line = `Program data: ${Buffer.from('PSR1').toString('base64')} ${Buffer.from(body).toString('base64')}`;
  const rs = J.receiptsOfLogs(['Program log: x', line, 'Program data: AAAA']);
  assert.equal(rs.length, 1); assert.equal(rs[0].tech, 3);
});

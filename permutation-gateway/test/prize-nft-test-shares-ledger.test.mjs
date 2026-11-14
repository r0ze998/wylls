// ⑰ (2026-11-15): the TEST ONLY shares ledger builder. Pure (no chain, no key). Checks that the ledger is labelled
// as a test fixture, refuses what the program would refuse, and that the page reads the pass's share from it and
// the program's arithmetic follows from it (the claim path the local E2E will drive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encode as b58 } from '../client/src/base58.mjs';
import { fromHex } from '../client/src/bytes.mjs';
import { leafResidentHash, POOL_STATE } from '../client/src/frontier/prize.mjs';
import { TEST_ONLY_LABEL, testSharesLedger } from '../scripts/prize-nft-test-shares-ledger.mjs';
import { passClaimModel, passShareOf } from '../../permutation-server/web/frontier/fprize.mjs';

// An independent sha256 (node:crypto), not the SDK's node hash: the proof check is a cross-check.
const sha256 = b => createHash('sha256').update(b).digest();
const k = n => b58(new Uint8Array(32).fill(n));
const prize = { program: k(0x50), pool: k(0x70), vault: k(0x71), mint: k(0x72) };
const P1 = k(0x5a), P2 = k(0x5b), C = k(0xc1);
const finalPool = (extra = {}) => ({ state: POOL_STATE.FINAL, winners: [1], area: [8, 10, 9, 9, 9, 9], ...extra });
const members = [{ asset: P1, nation: 1, points: 10 }, { asset: P2, nation: 1, points: 4 }, { wallet: C, nation: 1, points: 6 }];

test('the ledger is labelled TEST ONLY, has no achievement lines, and the totals/root follow from the members', () => {
  const { ledger, totals, root } = testSharesLedger({ prize, pool: finalPool(), members });
  assert.equal(ledger.testOnly, true);
  assert.equal(ledger.label, TEST_ONLY_LABEL);
  assert.match(ledger.label, /not derived from achievements; not a prize allocation/);
  assert.deepEqual(ledger.lines, [], 'no achievement line is claimed');
  assert.deepEqual(totals.map(String), ['0', '20', '0', '0', '0', '0']);
  assert.equal(ledger.shares.root.length, 64);
  assert.equal(root.length, 32);
  assert.deepEqual(ledger.shares.members.map(m => [m.wallet, m.asset, m.points]), [[`pass:${P1}`, P1, 10], [`pass:${P2}`, P2, 4], [C, null, 6]]);
});

test('it refuses a pool that is not Final, a loser nation, zero or oversized points, a duplicate, and a member that is neither or both', () => {
  assert.throws(() => testSharesLedger({ prize, pool: finalPool({ state: POOL_STATE.OPEN }), members }), /must be Final/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool({ state: POOL_STATE.SHARES }), members }), /must be Final/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool(), members: [{ asset: P1, nation: 0, points: 1 }] }), /not a winner/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool(), members: [{ asset: P1, nation: 1, points: 0 }] }), /points/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool(), members: [{ asset: P1, nation: 1, points: '18446744073709551616' }] }), /points/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool(), members: [{ asset: P1, nation: 1, points: 1 }, { asset: P1, nation: 1, points: 2 }] }), /twice/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool(), members: [{ nation: 1, points: 1 }] }), /exactly one of asset or wallet/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool(), members: [{ asset: P1, wallet: C, nation: 1, points: 1 }] }), /exactly one/);
  assert.throws(() => testSharesLedger({ prize, pool: finalPool(), members: [] }), /at least one/);
});

test('the page reads each pass\'s share from it, and the proof reaches the root the program would check', () => {
  const { ledger, root } = testSharesLedger({ prize, pool: finalPool(), members });
  const s = passShareOf(ledger, P1);
  assert.deepEqual([s.nation, s.points], [1, 10n]);
  // Verify the proof as the program does (sorted pairs).
  const node = (a, b) => {
    const [x, y] = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? [a, b] : [b, a];
    return new Uint8Array(sha256(Buffer.concat([Buffer.from([1]), Buffer.from(x), Buffer.from(y)])));
  };
  let h = leafResidentHash(prize.pool, P1, 1, 10n);
  for (const p of s.proof) h = node(h, fromHex(p));
  assert.deepEqual(Buffer.from(h), Buffer.from(root), 'the proof reaches the root');
  // The 賞金 panel offers the claim for the pass's current owner in shares mode.
  const pool = { decimals: 6, state: 'shares', prize: '40000000', winners: [1], shares: { mode: 'shares', shareNations: 1, totalPoints: ledger.shares.totalPoints },
    pass: { asset: P1, citizen: 'Citizen', faction: 1, entry: { paid: '25000000', paidBy: k(0xa1), claimed: false, claimedBy: null, claimGeneration: null } } };
  const m = passClaimModel({ prize: pool, prizeLedger: ledger, resident: { asset: P1, citizen: 'Citizen', generation: 1, joined: true, proof: {} }, wallet: { address: k(0xb2) } });
  assert.equal(m.state, 'claimable');
  assert.equal(m.offer.points, '10');
});


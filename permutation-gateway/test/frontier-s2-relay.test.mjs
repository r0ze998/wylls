// S2 stage 2a (S2-2A-CONTRACT §4.5): the relay's ticket shapes. Profile 4 is
// the S2 program (RULESET_HASH_V4): S1's tables and limits plus IssueTickets,
// GiveLot and CloseLot. IssueTickets may move an Issue's and a Lot's rent,
// GiveLot one Lot's, CloseLot nothing; the daily cap adds one issue and four
// lots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../client/src/frontier/abi-v2-presets.mjs';
import { budgetOf } from '../client/src/frontier/budgets.mjs';
import { ixOf, layoutOf } from '../client/src/frontier/codec.mjs';
import { profileForHash, profileForSeason, rulesetFor, isS1, isV2 } from '../client/src/frontier/profile.mjs';
import { rent } from '../client/src/frontier/fees.mjs';
import { allowanceFor, CARAVAN_COST, drainGuard, ISSUE_RENT, LOT_RENT, lamportsPerDay } from '../src/frontier/shapes.mjs';

const S2_TAGS = { IssueTickets: 0xC0, GiveLot: 0xC1, CloseLot: 0xC2, OpenShares: 0xC3, WithdrawShares: 0xC4, ClaimReceipt: 0xC6, WithdrawReceipt: 0xC7, UseRun: 0xC8 };

test('profile 4 is the S2 program: its hash, the v2 tables, S1\'s limits', () => {
  assert.equal(PRESETS.ruleset_hash_v4, '9733e01fac31d39eb8842640dcde5424ed4444341e62c99e8615aef61dabe928');
  assert.equal(profileForHash(PRESETS.ruleset_hash_v4), 4);
  assert.equal(rulesetFor(4), PRESETS.ruleset_hash_v4);
  assert.equal(profileForSeason({ RULESET_HASH: PRESETS.ruleset_hash_v4 }), 4);
  assert.equal(isV2(4), true);
  assert.equal(isS1(4), true);
  assert.equal(isS1(2), false);
  assert.equal(layoutOf('Issue', 4).size, 256);
  assert.equal(layoutOf('Lot', 4).size, 192);
  for (const [name, tag] of Object.entries(S2_TAGS)) {
    assert.equal(ixOf(tag, 4)?.name, name);
    assert.equal(ixOf(tag, 4).relay_player_shape, true, name);
  }
  for (const tag of [0xB0, 0xB1, 0xBB, 0xC0]) {
    assert.deepEqual(budgetOf(tag, 4), budgetOf(tag, 3));
  }
  assert.equal(ixOf(0xC5, 4).name, 'SettleDeposit');
  assert.equal(ixOf(0xC5, 4).relay_settle_shape, true);
  assert.equal(ixOf(0xC0, 1), null);
});

test('the S2 allowances: an issue and its first lot, one lot a gift, nothing a close', () => {
  assert.equal(ISSUE_RENT, rent(256));
  assert.equal(LOT_RENT, rent(192));
  assert.equal(allowanceFor({ tag: 0xC0 }, { season: {} }), ISSUE_RENT + LOT_RENT);
  assert.equal(allowanceFor({ tag: 0xC1 }, { season: {} }), LOT_RENT);
  assert.equal(allowanceFor({ tag: 0xC2 }, { season: {} }), 0n);
  // 2b: shares.
  assert.equal(allowanceFor({ tag: 0xC3 }, { season: {} }), ISSUE_RENT + LOT_RENT);
  assert.equal(allowanceFor({ tag: 0xC4 }, { season: {} }), CARAVAN_COST);
  assert.equal(allowanceFor({ tag: 0xC5 }, { season: {} }), LOT_RENT);
  // 2c: receipts.
  assert.equal(allowanceFor({ tag: 0xC6 }, { season: {} }), 0n);
  assert.equal(allowanceFor({ tag: 0xC7 }, { season: {} }), CARAVAN_COST);
  // 2d: a use run moves no lamports.
  assert.equal(allowanceFor({ tag: 0xC8 }, { season: {} }), 0n);
  const pre = 10n * LOT_RENT;
  assert.throws(() => drainGuard({ pre, post: pre - LOT_RENT - 1n, fee: 0n, allowance: LOT_RENT }), /relay refused/);
});

test('an S2 season\'s daily lamport cap adds one issue and four lots to S1\'s', () => {
  const mc = { MIN_REVEAL_PRIORITY_MILLI: 433, REVEAL_CU_LIMIT: 26_000, REVEAL_LOADED_LIMIT: 1_048_576, MARCH_FEE: 10_000n, SEAL_BOND: 20_000n, RULESET_HASH: PRESETS.ruleset_hash };
  const s1 = lamportsPerDay({ ...mc, RULESET_HASH: PRESETS.ruleset_hash_v3 });
  const s2 = lamportsPerDay({ ...mc, RULESET_HASH: PRESETS.ruleset_hash_v4 });
  assert.equal(s2, s1 + ISSUE_RENT + 4n * LOT_RENT);
});

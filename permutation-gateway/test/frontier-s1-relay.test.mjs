// S1 stage 1b (S1-1B-CONTRACT §4.5): the relay's vault and caravan shapes.
// Profile 3 is the S1 program (RULESET_HASH_V3): the v2 layouts and
// instructions at the S1 release's loaded limits; BuildVault may move a
// vault's rent, SendCaravan / RaidCaravan / DefaultRaid one caravan's rent
// and the settle fee, never more; a caravan counts like a Depart in the
// daily lamport cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../client/src/frontier/abi-v2-presets.mjs';
import { BUDGETS } from '../client/src/frontier/abi-v2-budgets.mjs';
import { TAGS } from '../client/src/frontier/abi-v2-tags.mjs';
import { budgetOf, CARAVAN_FEE } from '../client/src/frontier/budgets.mjs';
import { ixOf, layoutOf } from '../client/src/frontier/codec.mjs';
import { profileForHash, profileForSeason, rulesetFor, isV2 } from '../client/src/frontier/profile.mjs';
import { rent } from '../client/src/frontier/fees.mjs';
import { allowanceFor, CARAVAN_COST, drainGuard, lamportsPerDay, VAULT_RENT } from '../src/frontier/shapes.mjs';

const S1_TAGS = { BuildVault: 0xB0, SendCaravan: 0xB1, SettleCaravan: 0xB2, RaidCaravan: 0xB3, SeizeVault: 0xB4, CloseVault: 0xB5, DefaultRaid: 0xB6 };

test('profile 3 is the S1 program: its hash, the v2 tables, its own loaded limits', () => {
  assert.equal(profileForHash(PRESETS.ruleset_hash_v3), 3);
  assert.equal(rulesetFor(3), PRESETS.ruleset_hash_v3);
  assert.equal(profileForSeason({ RULESET_HASH: PRESETS.ruleset_hash_v3 }), 3);
  assert.equal(isV2(3), true);
  assert.equal(layoutOf('Vault', 3).size, 512);
  assert.equal(layoutOf('Caravan', 3).size, 320);
  for (const [name, tag] of Object.entries(S1_TAGS)) {
    assert.equal(ixOf(tag, 3)?.name, name);
    const row = BUDGETS.instructions.find(r => r.tag === tag);
    assert.equal(budgetOf(tag, 3).loadedLimit, row.loaded_limit_s1, name);
  }
  // Every kind's S1 limit covers the MC one (the S1 .so is larger).
  for (const row of BUDGETS.instructions) {
    assert.ok(budgetOf(row.tag, 3).loadedLimit >= budgetOf(row.tag, 2).loadedLimit, row.name);
  }
});

test('the S1 relay shapes: player and settle (the classifier reads the profile\'s rows)', () => {
  for (const t of [0xB0, 0xB1, 0xB3, 0xB4, 0xB5]) assert.equal(ixOf(t, 3).relay_player_shape, true, t.toString(16));
  for (const t of [0xB2, 0xB6]) assert.equal(ixOf(t, 3).relay_settle_shape, true, t.toString(16));
  assert.equal(TAGS.instructions.filter(i => i.tag >= 0xB0 && i.tag <= 0xB6).length, 7);
  // Not sponsored before S1's profile reads them (M1's table has no 0xB0).
  assert.equal(ixOf(0xB1, 1), null);
});

test('the S1 allowances: a vault rent, one caravan, never a larger fee', () => {
  assert.equal(CARAVAN_FEE, 50_000n);
  assert.equal(VAULT_RENT, rent(512));
  assert.equal(CARAVAN_COST, rent(320) + CARAVAN_FEE);
  assert.equal(allowanceFor({ tag: 0xB0 }, { season: {} }), VAULT_RENT);
  for (const tag of [0xB1, 0xB3, 0xB6]) assert.equal(allowanceFor({ tag }, { season: {} }), CARAVAN_COST);
  for (const tag of [0xB2, 0xB4, 0xB5]) assert.equal(allowanceFor({ tag }, { season: {} }), 0n);
  // A SendCaravan whose fee is above CARAVAN_FEE drains more: refused.
  const pre = 10n * CARAVAN_COST;
  assert.equal(drainGuard({ pre, post: pre - CARAVAN_COST, fee: 0n, allowance: CARAVAN_COST }), CARAVAN_COST);
  assert.throws(() => drainGuard({ pre, post: pre - CARAVAN_COST - 1n, fee: 0n, allowance: CARAVAN_COST }), /relay refused/);
});

test('an S1 season\'s daily lamport cap: caravans count like Departs, plus a vault', () => {
  const mc = { MIN_REVEAL_PRIORITY_MILLI: 433, REVEAL_CU_LIMIT: 26_000, REVEAL_LOADED_LIMIT: 1_048_576, MARCH_FEE: 10_000n, SEAL_BOND: 20_000n, RULESET_HASH: PRESETS.ruleset_hash };
  const s1 = { ...mc, RULESET_HASH: PRESETS.ruleset_hash_v3 };
  const base = lamportsPerDay(mc);
  assert.ok(lamportsPerDay(s1) >= base + VAULT_RENT);
  assert.ok(lamportsPerDay(s1) >= 24n * CARAVAN_COST + VAULT_RENT);
});
